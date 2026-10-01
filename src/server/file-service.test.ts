import { mkdtempSync, writeFileSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
}));
vi.mock("./search-index", () => {
	const key = (folder: string, p: string) => `${folder}\0${p}`;
	const inTree = (row: IndexRow, folder: string, p: string) =>
		row.folder === folder && (row.path === p || row.path.startsWith(`${p}/`));
	return {
		getEntry: async (folder: string, p: string) =>
			index.rows.get(key(folder, p)),
		getChildren: async (folder: string, parent: string) =>
			[...index.rows.values()].filter(
				(r) => r.folder === folder && r.parent === parent,
			),
		upsertEntries: async (rows: IndexRow[]) => {
			for (const r of rows) index.rows.set(key(r.folder, r.path), r);
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
  - username: alice
    password: pw
  - username: guest
    password: pw
    readOnly: true
folders:
  - name: shared
    path: ${dirs.shared}
    users: all
  - name: alice
    path: ${dirs.alice}
    users: [alice]
  - name: archive
    path: ${dirs.archive}
    users: all
    readOnly: true
  - name: quota
    path: ${dirs.quota}
    users: all
    storageLimit: 256KB
`,
);
process.env.CONFIG_PATH = path.join(tmp, "config.yaml");

const fs = await import("./file-service");
const { BadRequest, Conflict, Forbidden, NotFound } = await import("./errors");

const alice = { username: "alice", readOnly: false, ip: "203.0.113.5" };
const guest = { username: "guest", readOnly: true, ip: "203.0.113.6" };

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
		expect(names).toEqual(["alice", "archive", "quota", "shared"]);
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
				user: "alice",
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

	it("refuses read-only users and read-only folders", async () => {
		await expect(fs.mkdir(guest, "/shared/new")).rejects.toThrow(Forbidden);
		await expect(fs.mkdir(alice, "/archive/new")).rejects.toThrow(Forbidden);
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
		const bob = { ...alice, username: "bob" };
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

	it("checkUpload rejects conflicts, read-only targets and missing folders", async () => {
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
			fs.checkUpload(alice, "/shared/nope/x.txt", 1),
		).rejects.toThrow(NotFound);
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
			user: "alice",
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
		await fs.measureUsage();
	});

	it("measures only folders with a limit", () => {
		expect([...usageMap.keys()]).toEqual(["quota"]);
		expect(usageMap.get("quota")).toBeGreaterThanOrEqual(40 * KB);
	});

	it("reports usage and limit in the root listing", async () => {
		const { entries } = await fs.list(alice, "/");
		const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
		expect(byName.quota).toMatchObject({
			size: usageMap.get("quota"),
			limit: 256 * KB,
		});
		expect(byName.shared?.limit).toBeUndefined();
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
		expect(usageMap.get("quota")).toBeGreaterThanOrEqual(before + 40 * KB);
	});

	it("tracks copies, moves and deletes", async () => {
		const start = usageMap.get("quota") ?? 0;
		await writeFile(path.join(dirs.shared, "c.bin"), Buffer.alloc(40 * KB));

		await fs.copy(alice, "/shared/c.bin", "/quota/c.bin");
		const afterCopy = usageMap.get("quota") ?? 0;
		expect(afterCopy).toBeGreaterThanOrEqual(start + 40 * KB);

		await fs.move(alice, "/quota/c.bin", "/shared/c2.bin");
		expect(usageMap.get("quota")).toBe(start);

		await fs.remove(alice, "/quota/a.bin");
		expect(usageMap.get("quota")).toBeLessThan(start);
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
