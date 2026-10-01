import { mkdtempSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

// Search indexing is covered in file-service.test.ts.
vi.mock("./search-index", () => ({
	getEntry: async () => undefined,
	getChildren: async () => [],
	upsertEntries: async () => {},
	removeTree: async () => {},
	removeEntries: async () => {},
	moveTree: async () => {},
}));

const tmp = mkdtempSync(path.join(tmpdir(), "file-captain-uploads-"));
const shared = path.join(tmp, "shared");
const archive = path.join(tmp, "archive");
writeFileSync(
	path.join(tmp, "config.yaml"),
	`
server:
  cacheDir: ${path.join(tmp, "data", ".cache")}
  auditLog: ${path.join(tmp, "data", "audit.jsonl")}
  maxUploadSize: 1KB
users:
  - username: alice@example.com
    password: test-password
  - username: bob@example.com
    password: test-password
folders:
  - name: shared
    path: ${shared}
    users: all
  - name: archive
    path: ${archive}
    users: all
    readOnly: true
`,
);
process.env.CONFIG_PATH = path.join(tmp, "config.yaml");

const { handleUpload } = await import("./uploads");
const { initStorage } = await import("./file-service");
const { Forbidden, NotFound } = await import("./errors");

const alice = {
	username: "alice@example.com",
	readOnly: false,
	ip: "203.0.113.5",
};
const bob = { username: "bob@example.com", readOnly: false, ip: "203.0.113.6" };
const base = "http://localhost/api/upload";

const b64 = (s: string) => Buffer.from(s).toString("base64");

function create(
	user: typeof alice,
	folder: string,
	dir: string,
	name: string,
	size: number,
) {
	return handleUpload(
		user,
		new Request(`${base}/${folder}`, {
			method: "POST",
			headers: {
				"Tus-Resumable": "1.0.0",
				"Upload-Length": String(size),
				"Upload-Metadata": `dir ${b64(dir)},name ${b64(name)}`,
			},
		}),
	);
}

function patch(user: typeof alice, location: string, body: string) {
	return handleUpload(
		user,
		new Request(new URL(location, base), {
			method: "PATCH",
			headers: {
				"Tus-Resumable": "1.0.0",
				"Upload-Offset": "0",
				"Content-Type": "application/offset+octet-stream",
			},
			body,
			duplex: "half",
		} as RequestInit),
	);
}

beforeEach(async () => {
	await rm(`${tmp}/data`, { recursive: true, force: true });
	await rm(shared, { recursive: true, force: true });
	await initStorage();
	await writeFile(path.join(shared, "taken.txt"), "x");
});

describe("tus uploads", () => {
	it("stages in the target folder and finalizes into place", async () => {
		const res = await create(alice, "shared", "/shared", "hello.txt", 5);
		expect(res.status).toBe(201);
		const location = res.headers.get("location") ?? "";
		expect(location).toMatch(/^\/api\/upload\/shared\/[0-9a-f]+$/);
		expect(
			await readdir(path.join(shared, ".file-captain-uploads")),
		).not.toEqual([]);

		expect((await patch(alice, location, "hello")).status).toBe(204);
		expect(await readFile(path.join(shared, "hello.txt"), "utf8")).toBe(
			"hello",
		);
		expect(await readdir(path.join(shared, ".file-captain-uploads"))).toEqual(
			[],
		);
	});

	it("only lets the owner resume an upload", async () => {
		const res = await create(alice, "shared", "/shared", "mine.txt", 5);
		const location = res.headers.get("location") ?? "";
		expect((await patch(bob, location, "hello")).status).toBe(404);
	});

	it("rejects name conflicts and oversize files before any bytes arrive", async () => {
		expect(
			(await create(alice, "shared", "/shared", "taken.txt", 1)).status,
		).toBe(409);
		expect(
			(await create(alice, "shared", "/shared", "big.bin", 2048)).status,
		).toBe(413);
	});

	it("rejects targets outside the endpoint's folder", async () => {
		const res = await create(alice, "shared", "/archive", "x.txt", 1);
		expect(res.status).toBe(403);
	});

	it("refuses read-only and unknown folders without creating staging dirs", async () => {
		await expect(
			create(alice, "archive", "/archive", "x.txt", 1),
		).rejects.toThrow(Forbidden);
		await expect(create(alice, "nope", "/nope", "x.txt", 1)).rejects.toThrow(
			NotFound,
		);
		expect(await readdir(archive)).toEqual([]);
	});
});
