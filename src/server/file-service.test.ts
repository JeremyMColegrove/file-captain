import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The usage cache lives in Postgres; tests keep it in memory.
const usageMap = vi.hoisted(() => new Map<string, number>());
vi.mock("./usage", () => ({
	getUsage: async (folder: string) => usageMap.get(folder) ?? 0,
	setUsage: async (folder: string, bytes: number) => {
		usageMap.set(folder, bytes);
	},
	addUsage: async (folder: string, delta: number) => {
		usageMap.set(folder, Math.max(0, (usageMap.get(folder) ?? 0) + delta));
	},
}));

// The search index lives in Postgres too; tests keep it in a Map keyed by
// "folder\0path".
type IndexRow = import("./search-index").IndexRow;
const index = vi.hoisted(() => ({
	rows: new Map<string, IndexRow>(),
	/** Paths passed to upsertEntries, to check unchanged rows aren't rewritten. */
	upserted: [] as string[],
}));
vi.mock("./search-index", () => {
	const key = (folder: string, p: string) => `${folder}\0${p}`;
	const inTree = (row: IndexRow, folder: string, p: string) =>
		row.folder === folder && (row.path === p || row.path.startsWith(`${p}/`));
	return {
		getEntry: async (folder: string, p: string) =>
			index.rows.get(key(folder, p)),
		getChildren: async (folder: string, parent: string, dirsOnly = false) =>
			[...index.rows.values()].filter(
				(r) =>
					r.folder === folder && r.parent === parent && (!dirsOnly || r.isDir),
			),
		upsertEntries: async (rows: IndexRow[]) => {
			for (const r of rows) {
				index.rows.set(key(r.folder, r.path), r);
				index.upserted.push(`${r.folder}${r.path}`);
			}
		},
		removeEntries: async (folder: string, paths: string[]) => {
			for (const p of paths) index.rows.delete(key(folder, p));
		},
		removeTree: async (folder: string, p: string) => {
			for (const [k, r] of index.rows) {
				if (inTree(r, folder, p)) index.rows.delete(k);
			}
		},
		moveTree: async (sf: string, src: string, df: string, dst: string) => {
			const moved = [...index.rows.entries()].filter(([, r]) =>
				inTree(r, sf, src),
			);
			for (const [k] of moved) index.rows.delete(k);
			for (const [, r] of moved) {
				const p = dst + r.path.slice(src.length);
				const isRoot = r.path === src;
				index.rows.set(key(df, p), {
					...r,
					folder: df,
					path: p,
					parent: isRoot
						? dst.slice(0, dst.lastIndexOf("/")) || "/"
						: dst + r.parent.slice(src.length),
					name: isRoot ? dst.slice(dst.lastIndexOf("/") + 1) : r.name,
				});
			}
		},
		folderSize: async (folder: string) =>
			[...index.rows.values()]
				.filter((r) => r.folder === folder && !r.isDir)
				.reduce((sum, r) => sum + r.size, 0),
		subdirSizes: async (folder: string, parent: string) => {
			const prefix = parent === "/" ? "/" : `${parent}/`;
			const sizes = new Map<string, number>();
			for (const r of index.rows.values()) {
				if (r.folder !== folder || r.isDir || !r.path.startsWith(prefix)) {
					continue;
				}
				const rest = r.path.slice(prefix.length);
				if (!rest.includes("/")) continue;
				const name = rest.slice(0, rest.indexOf("/"));
				sizes.set(name, (sizes.get(name) ?? 0) + r.size);
			}
			return sizes;
		},
		keepFolders: async (folders: string[]) => {
			for (const [k, r] of index.rows) {
				if (!folders.includes(r.folder)) index.rows.delete(k);
			}
		},
		search: async (folders: string[], query: string) => {
			const words = query.toLowerCase().split(/\s+/).filter(Boolean);
			return [...index.rows.values()].filter(
				(r) =>
					folders.includes(r.folder) &&
					r.path !== "/" &&
					words.every((w) => r.name.toLowerCase().includes(w)),
			);
		},
	};
});

// getConfig() is lazy, so pointing CONFIG_PATH at a temp config before the
// first call is enough.
const tmp = mkdtempSync(path.join(tmpdir(), "file-captain-"));
const dirs = {
	shared: path.join(tmp, "shared"),
	alice: path.join(tmp, "alice"),
	archive: path.join(tmp, "archive"),
	quota: path.join(tmp, "quota"),
	view: path.join(tmp, "view"),
};
const auditLog = path.join(tmp, "data", "audit.jsonl");
writeFileSync(
	path.join(tmp, "config.yaml"),
	`
server:
  cacheDir: ${path.join(tmp, "data", ".cache")}
  auditLog: ${auditLog}
  maxUploadSize: 1GB
users:
  - username: alice@example.com
    password: test-password
  - username: guest@example.com
    password: test-password
    readOnly: true
folders:
  - name: shared
    path: ${dirs.shared}
    users: all
  - name: alice
    path: ${dirs.alice}
    users: [alice@example.com]
  - name: archive
    path: ${dirs.archive}
    users: all
    readOnly: true
  - name: quota
    path: ${dirs.quota}
    users: all
    storageLimit: 256KB
  - name: view
    path: ${dirs.view}
    readOnlyUsers: [alice@example.com]
`,
);
process.env.CONFIG_PATH = path.join(tmp, "config.yaml");

const fs = await import("./file-service");
const { BadRequest, Conflict, Forbidden, NotFound } = await import("./errors");

const alice = {
	username: "alice@example.com",
	readOnly: false,
	ip: "203.0.113.5",
};
const guest = {
	username: "guest@example.com",
	readOnly: true,
	ip: "203.0.113.6",
};

const execFileAsync = promisify(execFile);

async function auditEntries() {
	const text = await readFile(auditLog, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function readStream(stream: ReadableStream<Uint8Array>) {
	return Buffer.from(await new Response(stream).arrayBuffer()).toString();
}

beforeEach(async () => {
	await rm(path.join(tmp, "data"), { recursive: true, force: true });
	for (const dir of Object.values(dirs)) {
		await rm(dir, { recursive: true, force: true });
	}
	await fs.initStorage();
	await writeFile(path.join(dirs.shared, "a.txt"), "hello world");
	await writeFile(path.join(dirs.shared, "pic.JPG"), "not really a jpg");
	await mkdir(path.join(dirs.shared, "docs", "deep"), { recursive: true });
	await writeFile(path.join(dirs.shared, "docs", "deep", "b.txt"), "b");
	await writeFile(path.join(dirs.archive, "old.txt"), "old");
	usageMap.clear();
	index.rows.clear();
});

afterAll(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe("initStorage", () => {
	it("creates folders and the audit log directory", async () => {
		await rm(dirs.alice, { recursive: true });
		await fs.initStorage();
		expect((await stat(dirs.alice)).isDirectory()).toBe(true);
		expect((await stat(path.dirname(auditLog))).isDirectory()).toBe(true);
	});
});

describe("list", () => {
	it("lists accessible folders at the root", async () => {
		const names = (await fs.list(alice, "/")).entries.map((e) => e.name).sort();
		expect(names).toEqual(["alice", "archive", "quota", "shared", "view"]);
		const guestNames = (await fs.list(guest, "/")).entries
			.map((e) => e.name)
			.sort();
		expect(guestNames).toEqual(["archive", "quota", "shared"]);
	});

	it("lists entries with type, size and thumbnail flag", async () => {
		const { entries, writable } = await fs.list(alice, "/shared");
		expect(writable).toBe(true);
		expect((await fs.list(guest, "/shared")).writable).toBe(false);
		expect((await fs.list(alice, "/archive")).writable).toBe(false);
		expect((await fs.list(alice, "/view")).writable).toBe(false);
		const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
		expect(byName["a.txt"]).toMatchObject({
			type: "file",
			size: 11,
			thumbnail: false,
		});
		expect(byName["pic.JPG"]).toMatchObject({ type: "file", thumbnail: true });
		expect(byName.docs).toMatchObject({
			type: "dir",
			size: 0,
			thumbnail: false,
		});
	});

	it("rejects files, missing paths and hidden folders", async () => {
		await expect(fs.list(alice, "/shared/a.txt")).rejects.toThrow(BadRequest);
		await expect(fs.list(alice, "/shared/missing")).rejects.toThrow(NotFound);
		await expect(fs.list(guest, "/alice")).rejects.toThrow(NotFound);
	});

	it("hides the upload staging directory at folder roots", async () => {
		await mkdir(path.join(dirs.shared, ".file-captain-uploads"));
		const names = (await fs.list(alice, "/shared")).entries.map((e) => e.name);
		expect(names).not.toContain(".file-captain-uploads");
	});

	it("is not audited", async () => {
		await fs.list(alice, "/shared");
		expect(await auditEntries()).toEqual([]);
	});
});

describe("openDownload", () => {
	it("streams the whole file", async () => {
		const file = await fs.openDownload(alice, "/shared/a.txt");
		expect(file).toMatchObject({ name: "a.txt", size: 11, range: null });
		expect(await readStream(file.stream)).toBe("hello world");
	});

	it("supports byte ranges", async () => {
		const file = await fs.openDownload(alice, "/shared/a.txt", "bytes=6-");
		expect(file.range).toEqual({ start: 6, end: 10 });
		expect(await readStream(file.stream)).toBe("world");
	});

	it("is allowed for read-only users", async () => {
		const file = await fs.openDownload(guest, "/archive/old.txt");
		expect(await readStream(file.stream)).toBe("old");
	});

	it("rejects folders and the root", async () => {
		await expect(fs.openDownload(alice, "/shared/docs")).rejects.toThrow(
			BadRequest,
		);
		await expect(fs.openDownload(alice, "/")).rejects.toThrow(BadRequest);
	});
});

describe("openZip", () => {
	/** Saves the zip and lists it with the system unzip: "name size" per entry. */
	async function unzipList(stream: ReadableStream<Uint8Array>) {
		const file = path.join(tmp, "out.zip");
		await writeFile(
			file,
			Buffer.from(await new Response(stream).arrayBuffer()),
		);
		const { stdout } = await execFileAsync("unzip", ["-Z", "-l", file]);
		const { stdout: content } = await execFileAsync("unzip", [
			"-p",
			file,
			"docs/deep/b.txt",
		]).catch(() => ({ stdout: "" }));
		await rm(file);
		const entries = stdout
			.split("\n")
			.filter((line) => /^[-d]/.test(line))
			.map((line) => {
				const cols = line.trim().split(/\s+/);
				return `${cols.at(-1)} ${cols[3]}`;
			})
			.sort();
		return { entries, content };
	}

	it("zips files and folders recursively, named after the folder", async () => {
		const zip = await fs.openZip(alice, "/shared", ["a.txt", "docs"]);
		expect(zip.name).toBe("shared.zip");
		const { entries, content } = await unzipList(zip.stream);
		expect(entries).toEqual([
			"a.txt 11",
			"docs/ 0",
			"docs/deep/ 0",
			"docs/deep/b.txt 1",
		]);
		expect(content).toBe("b");
	});

	it("skips symlinks below the selection", async () => {
		await symlink(
			path.join(dirs.alice),
			path.join(dirs.shared, "docs", "link"),
		);
		const { entries } = await unzipList(
			(await fs.openZip(alice, "/shared", ["docs"])).stream,
		);
		expect(entries).not.toContainEqual(expect.stringContaining("link"));
	});

	it("stops cleanly when the client cancels", async () => {
		await writeFile(
			path.join(dirs.shared, "big.bin"),
			Buffer.alloc(4 * 1024 ** 2),
		);
		const errors = vi.spyOn(console, "error");
		const reader = (
			await fs.openZip(alice, "/shared", ["big.bin", "docs"])
		).stream.getReader();
		await reader.read();
		await reader.cancel();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(errors).not.toHaveBeenCalled();
		errors.mockRestore();
	});

	it("is allowed for read-only users", async () => {
		const zip = await fs.openZip(guest, "/archive", ["old.txt"]);
		expect(zip.name).toBe("archive.zip");
		expect((await unzipList(zip.stream)).entries).toEqual(["old.txt 3"]);
	});

	it("rejects bad names, missing entries, the root and hidden folders", async () => {
		await expect(fs.openZip(alice, "/shared", ["../alice"])).rejects.toThrow(
			BadRequest,
		);
		await expect(fs.openZip(alice, "/shared", ["nope.txt"])).rejects.toThrow(
			NotFound,
		);
		await expect(fs.openZip(alice, "/", ["shared"])).rejects.toThrow(
			BadRequest,
		);
		await expect(fs.openZip(guest, "/alice", ["x"])).rejects.toThrow(NotFound);
	});
});

describe("parseRange", () => {
	it("handles the common forms", () => {
		expect(fs.parseRange("bytes=0-4", 10)).toEqual({ start: 0, end: 4 });
		expect(fs.parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
		expect(fs.parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
		expect(fs.parseRange("bytes=0-100", 10)).toEqual({ start: 0, end: 9 });
	});

	it("ignores unusable ranges", () => {
		for (const h of [
			null,
			"",
			"bytes=10-",
			"bytes=5-2",
			"bytes=0-1,3-4",
			"items=0-1",
			"bytes=-",
		]) {
			expect(fs.parseRange(h, 10), String(h)).toBeNull();
		}
		expect(fs.parseRange("bytes=0-0", 0)).toBeNull();
	});
});

describe("mkdir", () => {
	it("creates a folder and audits it", async () => {
		await fs.mkdir(alice, "/shared/new");
		expect((await stat(path.join(dirs.shared, "new"))).isDirectory()).toBe(
			true,
		);
		expect(await auditEntries()).toEqual([
			expect.objectContaining({
				user: "alice@example.com",
				action: "mkdir",
				src: "/shared/new",
				result: "ok",
				ip: "203.0.113.5",
			}),
		]);
	});

	it("conflicts on an existing name and audits the failure", async () => {
		await expect(fs.mkdir(alice, "/shared/docs")).rejects.toThrow(Conflict);
		expect(await auditEntries()).toEqual([
			expect.objectContaining({ action: "mkdir", result: "error" }),
		]);
	});

	it("does not create missing parents", async () => {
		await expect(fs.mkdir(alice, "/shared/x/y")).rejects.toThrow(NotFound);
	});

	it("conflicts on a name that differs only in case", async () => {
		await expect(fs.mkdir(alice, "/shared/DOCS")).rejects.toThrow(Conflict);
		await expect(fs.mkdir(alice, "/shared/A.TXT")).rejects.toThrow(Conflict);
	});

	it("refuses read-only users and read-only folders", async () => {
		await expect(fs.mkdir(guest, "/shared/new")).rejects.toThrow(Forbidden);
		await expect(fs.mkdir(alice, "/archive/new")).rejects.toThrow(Forbidden);
		await expect(fs.mkdir(alice, "/view/new")).rejects.toThrow(Forbidden);
	});

	it("refuses top-level folders and the root", async () => {
		await expect(fs.mkdir(alice, "/shared")).rejects.toThrow(Forbidden);
		await expect(fs.mkdir(alice, "/")).rejects.toThrow(BadRequest);
	});
});

describe("rename", () => {
	it("renames in place", async () => {
		await fs.rename(alice, "/shared/a.txt", "c.txt");
		expect(await readdir(dirs.shared)).toContain("c.txt");
		expect(await auditEntries()).toEqual([
			expect.objectContaining({
				action: "rename",
				src: "/shared/a.txt",
				dst: "/shared/c.txt",
			}),
		]);
	});

	it("never overwrites", async () => {
		await writeFile(path.join(dirs.shared, "c.txt"), "keep");
		await expect(fs.rename(alice, "/shared/a.txt", "c.txt")).rejects.toThrow(
			Conflict,
		);
		expect(await readFile(path.join(dirs.shared, "c.txt"), "utf8")).toBe(
			"keep",
		);
	});

	it("allows changing only the case of a name", async () => {
		await fs.rename(alice, "/shared/a.txt", "A.txt");
		const names = await readdir(dirs.shared);
		expect(names).toContain("A.txt");
		expect(names).not.toContain("a.txt");
	});

	it("rejects a name another entry has in a different case", async () => {
		await expect(fs.rename(alice, "/shared/a.txt", "PIC.jpg")).rejects.toThrow(
			Conflict,
		);
		await expect(fs.rename(alice, "/shared/a.txt", "Docs")).rejects.toThrow(
			Conflict,
		);
		expect(await readdir(dirs.shared)).toContain("a.txt");
	});

	it("rejects names with separators or dots", async () => {
		for (const name of ["../x", "a/b", "..", "."]) {
			await expect(
				fs.rename(alice, "/shared/a.txt", name),
				name,
			).rejects.toThrow(BadRequest);
		}
		expect(await readdir(dirs.shared)).toContain("a.txt");
	});

	it("refuses read-only users and read-only folders", async () => {
		await expect(fs.rename(guest, "/shared/a.txt", "b.txt")).rejects.toThrow(
			Forbidden,
		);
		await expect(
			fs.rename(alice, "/archive/old.txt", "new.txt"),
		).rejects.toThrow(Forbidden);
		expect(await readdir(dirs.archive)).toEqual(["old.txt"]);
	});

	it("refuses top-level folders", async () => {
		await expect(fs.rename(alice, "/shared", "x")).rejects.toThrow(Forbidden);
	});

	it("reports a missing source", async () => {
		await expect(fs.rename(alice, "/shared/missing", "x")).rejects.toThrow(
			NotFound,
		);
	});
});

describe("move", () => {
	it("moves between folders", async () => {
		await fs.move(alice, "/shared/docs", "/alice/docs");
		expect(
			await readFile(path.join(dirs.alice, "docs", "deep", "b.txt"), "utf8"),
		).toBe("b");
		await expect(stat(path.join(dirs.shared, "docs"))).rejects.toThrow();
	});

	it("never overwrites", async () => {
		await expect(
			fs.move(alice, "/shared/a.txt", "/shared/docs"),
		).rejects.toThrow(Conflict);
	});

	it("reports a conflict when moving onto itself", async () => {
		await expect(
			fs.move(alice, "/shared/a.txt", "/shared/a.txt"),
		).rejects.toThrow(Conflict);
	});

	it("refuses to move a folder into itself", async () => {
		await expect(
			fs.move(alice, "/shared/docs", "/shared/docs/deep/docs"),
		).rejects.toThrow(BadRequest);
	});

	it("refuses moving out of a read-only folder", async () => {
		await expect(
			fs.move(alice, "/archive/old.txt", "/shared/old.txt"),
		).rejects.toThrow(Forbidden);
	});

	it("refuses folders the user cannot see", async () => {
		await expect(
			fs.move(guest, "/shared/a.txt", "/alice/a.txt"),
		).rejects.toThrow(Forbidden);
		const bob = { ...alice, username: "bob@example.com" };
		await expect(fs.move(bob, "/shared/a.txt", "/alice/a.txt")).rejects.toThrow(
			NotFound,
		);
	});
});

describe("copy", () => {
	it("copies a tree recursively", async () => {
		await fs.copy(alice, "/shared/docs", "/alice/docs-copy");
		expect(
			await readFile(
				path.join(dirs.alice, "docs-copy", "deep", "b.txt"),
				"utf8",
			),
		).toBe("b");
		expect(
			await readFile(path.join(dirs.shared, "docs", "deep", "b.txt"), "utf8"),
		).toBe("b");
		expect(await auditEntries()).toEqual([
			expect.objectContaining({
				action: "copy",
				src: "/shared/docs",
				dst: "/alice/docs-copy",
			}),
		]);
	});

	it("refuses read-only users and copying into read-only folders", async () => {
		await expect(
			fs.copy(guest, "/shared/a.txt", "/shared/a2.txt"),
		).rejects.toThrow(Forbidden);
		await expect(
			fs.copy(alice, "/shared/a.txt", "/archive/a.txt"),
		).rejects.toThrow(Forbidden);
		expect(await readdir(dirs.archive)).toEqual(["old.txt"]);
	});

	it("can copy out of a read-only folder", async () => {
		await fs.copy(alice, "/archive/old.txt", "/shared/old.txt");
		expect(await readFile(path.join(dirs.shared, "old.txt"), "utf8")).toBe(
			"old",
		);
	});

	it("never overwrites", async () => {
		await expect(
			fs.copy(alice, "/shared/a.txt", "/shared/pic.JPG"),
		).rejects.toThrow(Conflict);
	});

	it("rejects a name that differs from an existing one only in case", async () => {
		await expect(
			fs.copy(alice, "/shared/a.txt", "/shared/PIC.jpg"),
		).rejects.toThrow(Conflict);
		await expect(
			fs.move(alice, "/shared/docs/deep/b.txt", "/shared/A.TXT"),
		).rejects.toThrow(Conflict);
	});

	it("reports a conflict, not a nesting error, when copying onto itself", async () => {
		await expect(
			fs.copy(alice, "/shared/a.txt", "/shared/a.txt"),
		).rejects.toThrow(Conflict);
		await expect(
			fs.copy(alice, "/shared/docs", "/shared/docs"),
		).rejects.toThrow(Conflict);
	});

	it("refuses to copy a folder into itself", async () => {
		await expect(
			fs.copy(alice, "/shared/docs", "/shared/docs/again"),
		).rejects.toThrow(BadRequest);
	});
});

describe("remove", () => {
	it("deletes files and folders recursively", async () => {
		await fs.remove(alice, "/shared/docs");
		await fs.remove(alice, "/shared/a.txt");
		expect((await readdir(dirs.shared)).sort()).toEqual(["pic.JPG"]);
		expect((await auditEntries()).map((e) => e.action)).toEqual([
			"delete",
			"delete",
		]);
	});

	it("refuses top-level folders, read-only users and folders", async () => {
		await expect(fs.remove(alice, "/shared")).rejects.toThrow(Forbidden);
		await expect(fs.remove(guest, "/shared/a.txt")).rejects.toThrow(Forbidden);
		await expect(fs.remove(alice, "/archive/old.txt")).rejects.toThrow(
			Forbidden,
		);
	});

	it("audits failures, including path attacks, without host paths", async () => {
		await expect(fs.remove(alice, "/shared/../../etc")).rejects.toThrow(
			BadRequest,
		);
		await expect(fs.remove(alice, "/shared/missing")).rejects.toThrow(NotFound);
		const entries = await auditEntries();
		expect(entries.map((e) => e.result)).toEqual(["error", "error"]);
		expect(JSON.stringify(entries)).not.toContain(tmp);
	});
});

describe("getThumbnail", () => {
	const thumbDir = () => path.join(tmp, "data", ".cache", "thumbnails");

	beforeEach(async () => {
		const png = await sharp({
			create: { width: 400, height: 200, channels: 3, background: "red" },
		})
			.png()
			.toBuffer();
		await writeFile(path.join(dirs.shared, "real.png"), png);
	});

	it("generates a 128px webp and caches it on disk", async () => {
		const thumb = await fs.getThumbnail(guest, "/shared/real.png");
		const meta = await sharp(thumb.data).metadata();
		expect(meta).toMatchObject({ format: "webp", width: 128, height: 64 });
		expect(await readdir(thumbDir())).toEqual([`${thumb.etag}.webp`]);

		const again = await fs.getThumbnail(guest, "/shared/real.png");
		expect(again.etag).toBe(thumb.etag);
	});

	it("changes the cache key when the file changes", async () => {
		const before = await fs.getThumbnail(alice, "/shared/real.png");
		await writeFile(
			path.join(dirs.shared, "real.png"),
			await sharp({
				create: { width: 10, height: 10, channels: 3, background: "blue" },
			})
				.png()
				.toBuffer(),
		);
		const after = await fs.getThumbnail(alice, "/shared/real.png");
		expect(after.etag).not.toBe(before.etag);
	});

	it("lists no thumbnails and serves none when thumbnailConcurrency is 0", async () => {
		const { getConfig } = await import("./config");
		const server = getConfig().server;
		const original = server.thumbnailConcurrency;
		server.thumbnailConcurrency = 0;
		try {
			const { entries } = await fs.list(alice, "/shared");
			expect(entries.find((e) => e.name === "real.png")?.thumbnail).toBe(false);
			await expect(fs.getThumbnail(alice, "/shared/real.png")).rejects.toThrow(
				NotFound,
			);
			expect(await readdir(thumbDir())).toEqual([]);
		} finally {
			server.thumbnailConcurrency = original;
		}
	});

	it("returns NotFound for non-images, broken images and folders", async () => {
		await expect(fs.getThumbnail(alice, "/shared/a.txt")).rejects.toThrow(
			NotFound,
		);
		await expect(fs.getThumbnail(alice, "/shared/pic.JPG")).rejects.toThrow(
			NotFound,
		);
		await expect(fs.getThumbnail(alice, "/shared/docs")).rejects.toThrow(
			NotFound,
		);
		await expect(fs.getThumbnail(guest, "/alice/x.png")).rejects.toThrow(
			NotFound,
		);
	});
});

describe("uploads", () => {
	const staged = () => path.join(tmp, "data", "staged.bin");

	beforeEach(async () => {
		await writeFile(staged(), "uploaded bytes");
	});

	it("checkUpload accepts a free name without auditing", async () => {
		await fs.checkUpload(alice, "/shared/docs/new.txt", 5);
		expect(await auditEntries()).toEqual([]);
	});

	it("checkUpload rejects conflicts, read-only targets and files in the way", async () => {
		await expect(fs.checkUpload(alice, "/shared/a.txt", 1)).rejects.toThrow(
			Conflict,
		);
		await expect(fs.checkUpload(guest, "/shared/x.txt", 1)).rejects.toThrow(
			Forbidden,
		);
		await expect(fs.checkUpload(alice, "/archive/x.txt", 1)).rejects.toThrow(
			Forbidden,
		);
		await expect(
			fs.checkUpload(alice, "/shared/a.txt/x.txt", 1),
		).rejects.toThrow(Conflict);
		await expect(fs.checkUpload(alice, "/shared/../x.txt", 1)).rejects.toThrow(
			BadRequest,
		);
		const entries = await auditEntries();
		expect(entries).toHaveLength(5);
		expect(
			entries.every((e) => e.action === "upload" && e.result === "error"),
		).toBe(true);
	});

	it("finalizeUpload moves the file into place and audits it", async () => {
		await fs.finalizeUpload(alice, staged(), "/shared/docs/new.txt");
		expect(
			await readFile(path.join(dirs.shared, "docs", "new.txt"), "utf8"),
		).toBe("uploaded bytes");
		await expect(stat(staged())).rejects.toThrow();
		const [entry] = await auditEntries();
		expect(entry).toMatchObject({
			user: "alice@example.com",
			action: "upload",
			src: "/shared/docs/new.txt",
			result: "ok",
		});
	});

	it("finalizeUpload never overwrites and cleans up the staged file", async () => {
		await expect(
			fs.finalizeUpload(alice, staged(), "/shared/a.txt"),
		).rejects.toThrow(Conflict);
		expect(await readFile(path.join(dirs.shared, "a.txt"), "utf8")).toBe(
			"hello world",
		);
		await expect(stat(staged())).rejects.toThrow();
		const [entry] = await auditEntries();
		expect(entry).toMatchObject({ action: "upload", result: "error" });
	});

	it("rejects uploads whose name differs from an existing one only in case", async () => {
		await expect(fs.checkUpload(alice, "/shared/A.TXT", 1)).rejects.toThrow(
			Conflict,
		);
		await expect(
			fs.finalizeUpload(alice, staged(), "/shared/Pic.jpg"),
		).rejects.toThrow(Conflict);
		expect(await readdir(dirs.shared)).not.toContain("Pic.jpg");
	});

	it("checkUpload accepts missing parents without creating them", async () => {
		await fs.checkUpload(alice, "/shared/new/sub/x.txt", 1);
		await expect(stat(path.join(dirs.shared, "new"))).rejects.toThrow();
		expect(await auditEntries()).toEqual([]);
	});

	it("finalizeUpload creates missing parents and audits each as mkdir", async () => {
		await fs.finalizeUpload(alice, staged(), "/shared/docs/new/sub/x.txt");
		expect(
			await readFile(
				path.join(dirs.shared, "docs", "new", "sub", "x.txt"),
				"utf8",
			),
		).toBe("uploaded bytes");
		const entries = await auditEntries();
		expect(entries.map((e) => [e.action, e.src, e.result])).toEqual([
			["mkdir", "/shared/docs/new", "ok"],
			["mkdir", "/shared/docs/new/sub", "ok"],
			["upload", "/shared/docs/new/sub/x.txt", "ok"],
		]);
		expect(index.rows.has("shared\0/docs/new/sub")).toBe(true);
	});

	it("finalizeUpload merges into existing folders", async () => {
		await fs.finalizeUpload(alice, staged(), "/shared/docs/deep/c.txt");
		expect(await readdir(path.join(dirs.shared, "docs", "deep"))).toEqual([
			"b.txt",
			"c.txt",
		]);
		const entries = await auditEntries();
		expect(entries.map((e) => e.action)).toEqual(["upload"]);
	});

	it("files of one new folder finishing together create it once", async () => {
		const second = path.join(tmp, "data", "staged2.bin");
		await writeFile(second, "more bytes");
		await Promise.all([
			fs.finalizeUpload(alice, staged(), "/shared/new/a.txt"),
			fs.finalizeUpload(alice, second, "/shared/new/b.txt"),
		]);
		expect((await readdir(path.join(dirs.shared, "new"))).sort()).toEqual([
			"a.txt",
			"b.txt",
		]);
		const entries = await auditEntries();
		expect(entries.filter((e) => e.action === "mkdir")).toHaveLength(1);
		expect(entries.every((e) => e.result === "ok")).toBe(true);
	});

	it("finalizeUpload never creates a second folder differing only in case", async () => {
		// Case-insensitive disks (macOS) merge into docs; others get a Conflict.
		await fs
			.finalizeUpload(alice, staged(), "/shared/DOCS/x.txt")
			.catch((err) => expect(err).toBeInstanceOf(Conflict));
		await writeFile(staged(), "uploaded bytes");
		await expect(
			fs.finalizeUpload(alice, staged(), "/shared/a.txt/x.txt"),
		).rejects.toThrow(Conflict);
		expect((await readdir(dirs.shared)).sort()).toEqual([
			"a.txt",
			"docs",
			"pic.JPG",
		]);
	});

	it("rejects folder uploads into the staging directory or read-only places", async () => {
		await expect(
			fs.checkUpload(alice, "/shared/.file-captain-uploads/x/y.txt", 1),
		).rejects.toThrow(NotFound);
		await expect(
			fs.checkUpload(alice, "/archive/new/y.txt", 1),
		).rejects.toThrow(Forbidden);
		await expect(
			fs.finalizeUpload(guest, staged(), "/shared/new/y.txt"),
		).rejects.toThrow(Forbidden);
		await expect(stat(path.join(dirs.shared, "new"))).rejects.toThrow();
	});

	it("finalizeUpload refuses read-only users", async () => {
		await expect(
			fs.finalizeUpload(guest, staged(), "/shared/new.txt"),
		).rejects.toThrow(Forbidden);
	});
});

describe("storage limits", () => {
	const KB = 1024;

	beforeEach(async () => {
		await writeFile(path.join(dirs.quota, "a.bin"), Buffer.alloc(40 * KB));
		await fs.indexFiles();
	});

	it("measures usage from the index after a sync, only for limited folders", () => {
		expect([...usageMap.keys()]).toEqual(["quota"]);
		expect(usageMap.get("quota")).toBe(40 * KB);
	});

	it("measures exact bytes, not disk blocks", async () => {
		await mkdir(path.join(dirs.quota, "sub"));
		await writeFile(path.join(dirs.quota, "sub", "tiny.txt"), "hello");
		await fs.indexFiles();
		expect(usageMap.get("quota")).toBe(40 * KB + 5);
	});

	it("reports usage and limit in the root listing", async () => {
		const { entries } = await fs.list(alice, "/");
		const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
		expect(byName.quota).toMatchObject({
			size: usageMap.get("quota"),
			limit: 256 * KB,
		});
		expect(byName.quota?.disk).toBeUndefined();
	});

	it("reports disk usage for folders without a limit", async () => {
		const { entries } = await fs.list(alice, "/");
		const shared = entries.find((e) => e.name === "shared");
		expect(shared?.disk).toBe(true);
		expect(shared?.limit).toBeGreaterThan(0);
		expect(shared?.size).toBeGreaterThan(0);
		expect(shared?.size).toBeLessThanOrEqual(shared?.limit ?? 0);
	});

	it("rejects uploads that would exceed the limit", async () => {
		await fs.checkUpload(alice, "/quota/small.bin", 10 * KB);
		await expect(
			fs.checkUpload(alice, "/quota/big.bin", 250 * KB),
		).rejects.toThrow(Forbidden);
	});

	it("counts finished uploads", async () => {
		const before = usageMap.get("quota") ?? 0;
		const staged = path.join(tmp, "data", "staged.bin");
		await writeFile(staged, Buffer.alloc(40 * KB));
		await fs.finalizeUpload(alice, staged, "/quota/b.bin");
		expect(usageMap.get("quota")).toBe(before + 40 * KB);
	});

	it("tracks copies, moves and deletes", async () => {
		const start = usageMap.get("quota") ?? 0;
		await writeFile(path.join(dirs.shared, "c.bin"), Buffer.alloc(40 * KB));

		await fs.copy(alice, "/shared/c.bin", "/quota/c.bin");
		const afterCopy = usageMap.get("quota") ?? 0;
		expect(afterCopy).toBe(start + 40 * KB);

		await fs.move(alice, "/quota/c.bin", "/shared/c2.bin");
		expect(usageMap.get("quota")).toBe(start);

		await fs.remove(alice, "/quota/a.bin");
		expect(usageMap.get("quota")).toBe(start - 40 * KB);
	});

	it("rejects copies and moves that would exceed the limit", async () => {
		await writeFile(path.join(dirs.shared, "huge.bin"), Buffer.alloc(300 * KB));
		await expect(
			fs.copy(alice, "/shared/huge.bin", "/quota/huge.bin"),
		).rejects.toThrow(Forbidden);
		await expect(
			fs.move(alice, "/shared/huge.bin", "/quota/huge.bin"),
		).rejects.toThrow(Forbidden);
		expect(await readdir(dirs.quota)).toEqual(["a.bin"]);
	});
});

describe("search index", () => {
	const paths = () =>
		[...index.rows.values()]
			.filter((r) => r.folder === "shared")
			.map((r) => r.path)
			.sort();

	beforeEach(async () => {
		await mkdir(path.join(dirs.shared, ".file-captain-uploads"));
		await fs.indexFiles();
	});

	it("indexes every folder at startup, skipping the upload staging dir", () => {
		expect(paths()).toEqual([
			"/",
			"/a.txt",
			"/docs",
			"/docs/deep",
			"/docs/deep/b.txt",
			"/pic.JPG",
		]);
		expect(index.rows.get("archive\0/old.txt")?.size).toBe(3);
	});

	it("re-reads only directories whose mtime changed", async () => {
		// Adding a file changes /docs's mtime; rewriting b.txt in place leaves
		// /docs/deep's alone, so its stale size shows the directory was skipped.
		await writeFile(path.join(dirs.shared, "docs", "new.txt"), "n");
		await writeFile(path.join(dirs.shared, "docs", "deep", "b.txt"), "longer");
		await fs.indexFiles();

		expect(paths()).toContain("/docs/new.txt");
		expect(index.rows.get("shared\0/docs/deep/b.txt")?.size).toBe(1);
	});

	it("writes only rows that changed", async () => {
		index.upserted = [];
		await fs.indexFiles();
		expect(index.upserted).toEqual([]);

		await writeFile(path.join(dirs.shared, "docs", "new.txt"), "n");
		await fs.indexFiles();
		// The new file, then /docs itself, marked synced.
		expect(index.upserted).toEqual(["shared/docs/new.txt", "shared/docs"]);
	});

	it("drops what was below a folder that became a file", async () => {
		await rm(path.join(dirs.shared, "docs"), { recursive: true });
		await writeFile(path.join(dirs.shared, "docs"), "now a file");
		await fs.indexFiles();
		expect(paths()).toEqual(["/", "/a.txt", "/docs", "/pic.JPG"]);
		expect(index.rows.get("shared\0/docs")).toMatchObject({
			isDir: false,
			size: 10,
		});
	});

	it("drops folders that are no longer configured", async () => {
		index.rows.set("gone\0/", {
			folder: "gone",
			path: "/",
			parent: "",
			name: "",
			isDir: true,
			size: 0,
			mtimeMs: 0,
		});
		await fs.indexFiles();
		expect(index.rows.has("gone\0/")).toBe(false);
	});

	it("removes entries deleted while the app was down", async () => {
		await rm(path.join(dirs.shared, "docs"), { recursive: true });
		await fs.indexFiles();
		expect(paths()).toEqual(["/", "/a.txt", "/pic.JPG"]);
	});

	it("follows mkdir, upload, copy, rename, move and delete", async () => {
		await fs.mkdir(alice, "/shared/new");
		const staged = path.join(tmp, "data", "staged.bin");
		await writeFile(staged, "up");
		await fs.finalizeUpload(alice, staged, "/shared/new/up.txt");
		await fs.copy(alice, "/shared/docs", "/shared/new/docs2");
		await fs.rename(alice, "/shared/a.txt", "renamed.txt");
		await fs.move(alice, "/shared/new", "/alice/moved");
		await fs.remove(alice, "/shared/docs");

		expect(paths()).toEqual(["/", "/pic.JPG", "/renamed.txt"]);
		const alicePaths = [...index.rows.values()]
			.filter((r) => r.folder === "alice")
			.map((r) => `${r.parent} ${r.path} ${r.name}`)
			.sort();
		expect(alicePaths).toEqual([
			" / ",
			"/ /moved moved",
			"/moved /moved/docs2 docs2",
			"/moved /moved/up.txt up.txt",
			"/moved/docs2 /moved/docs2/deep deep",
			"/moved/docs2/deep /moved/docs2/deep/b.txt b.txt",
		]);
	});

	it("reports the first sync, and joins a running one instead of starting another", async () => {
		const state = globalThis as { fileCaptainIndexed?: boolean };
		state.fileCaptainIndexed = undefined; // as if just started
		expect(fs.status(alice).indexing).toBe(false);
		const first = fs.indexFiles();
		expect(fs.indexFiles()).toBe(first);
		expect(fs.status(alice).indexing).toBe(true);
		await first;
		expect(fs.status(alice).indexing).toBe(false);

		// Later syncs catch up on outside changes; the index is complete already.
		const later = fs.indexFiles();
		expect(fs.status(alice).indexing).toBe(false);
		await later;
	});

	it("sums the files below each subdirectory", async () => {
		await mkdir(path.join(dirs.shared, "docs", "empty"));
		await writeFile(path.join(dirs.shared, "docs", "c.txt"), "cc");
		await mkdir(path.join(dirs.shared, "docs2"));
		await writeFile(path.join(dirs.shared, "docs2", "d.txt"), "ddd");
		await fs.indexFiles();

		// Files directly in the folder don't count; "docs2" isn't part of "docs".
		expect(await fs.dirSizes(alice, "/shared")).toEqual({ docs: 3, docs2: 3 });
		expect(await fs.dirSizes(alice, "/shared/docs")).toEqual({ deep: 1 });
		await expect(fs.dirSizes(guest, "/alice")).rejects.toThrow(NotFound);
		await expect(fs.dirSizes(alice, "/")).rejects.toThrow(BadRequest);
	});

	it("has no folder sizes until the first sync finishes", async () => {
		const state = globalThis as { fileCaptainIndexed?: boolean };
		state.fileCaptainIndexed = undefined;
		expect(await fs.dirSizes(alice, "/shared")).toBeNull();
		await fs.indexFiles();
		expect(await fs.dirSizes(alice, "/shared")).toEqual({ docs: 1 });
	});

	it("searches only the user's folders and returns virtual paths", async () => {
		await writeFile(path.join(dirs.alice, "b-private.txt"), "secret");
		await fs.indexFiles();

		const hits = async (user: typeof alice, q: string) =>
			(await fs.search(user, q)).map((r) => r.path).sort();
		expect(await hits(alice, "b")).toEqual([
			"/alice/b-private.txt",
			"/shared/docs/deep/b.txt",
		]);
		expect(await hits(guest, "b")).toEqual(["/shared/docs/deep/b.txt"]);
		expect(await hits(alice, "PIC jpg")).toEqual(["/shared/pic.JPG"]);
		const [pic] = await fs.search(alice, "pic");
		expect(pic).toMatchObject({
			name: "pic.JPG",
			type: "file",
			thumbnail: true,
		});
	});
});
