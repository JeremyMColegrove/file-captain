import { describe, expect, it } from "vitest";

import { parseConfig, parseSize } from "./config";

const valid = `
server:
  cacheDir: /data/.cache
  auditLog: /data/audit.jsonl
  maxUploadSize: 10GB
users:
  - username: jeremy
    password: "pw"
  - username: guest
    password: "pw2"
    readOnly: true
folders:
  - name: shared
    path: /mnt/shared
    users: all
    storageLimit: 1000gb
  - name: jeremy
    path: /mnt/jeremy
    users: [jeremy]
`;

describe("parseSize", () => {
	it("parses units case-insensitively", () => {
		expect(parseSize("10GB")).toBe(10 * 1024 ** 3);
		expect(parseSize("200gb")).toBe(200 * 1024 ** 3);
		expect(parseSize("512 MB")).toBe(512 * 1024 ** 2);
		expect(parseSize("1.5KB")).toBe(1536);
		expect(parseSize("42")).toBe(42);
		expect(parseSize(42)).toBe(42);
	});

	it("rejects garbage", () => {
		expect(parseSize("ten gigs")).toBeNull();
		expect(parseSize("10PB")).toBeNull();
		expect(parseSize("-5GB")).toBeNull();
		expect(parseSize(-1)).toBeNull();
	});
});

describe("parseConfig", () => {
	it("accepts a valid config and applies defaults", () => {
		const config = parseConfig(valid);
		expect(config.server.maxUploadSize).toBe(10 * 1024 ** 3);
		expect(config.users[0]?.readOnly).toBe(false);
		expect(config.users[1]?.readOnly).toBe(true);
		expect(config.folders[0]?.users).toBe("all");
		expect(config.folders[0]?.storageLimit).toBe(1000 * 1024 ** 3);
		expect(config.folders[1]?.storageLimit).toBeUndefined();
		expect(config.folders[1]?.readOnly).toBe(false);
	});

	it("rejects invalid YAML", () => {
		expect(() => parseConfig("server: [")).toThrow(/not valid YAML/);
	});

	it("rejects relative folder paths", () => {
		expect(() =>
			parseConfig(valid.replace("/mnt/jeremy", "mnt/jeremy")),
		).toThrow(/folders.1.path/);
	});

	it("rejects folders that reference unknown users", () => {
		expect(() =>
			parseConfig(valid.replace("[jeremy]", "[jeremy, bob]")),
		).toThrow(/Unknown user "bob"/);
	});

	it("rejects duplicate usernames and folder names", () => {
		expect(() =>
			parseConfig(valid.replace("username: guest", "username: Jeremy")),
		).toThrow(/Duplicate username/);
		expect(() =>
			parseConfig(valid.replace("- name: jeremy", "- name: shared")),
		).toThrow(/Duplicate folder name/);
	});

	it("rejects usernames Better Auth cannot sign in with", () => {
		expect(() =>
			parseConfig(valid.replace("username: guest", "username: a-b")),
		).toThrow(/users.1.username/);
	});

	it("rejects folder names with slashes or leading dots", () => {
		expect(() =>
			parseConfig(valid.replace("name: shared", "name: a/b")),
		).toThrow(/folders.0.name/);
		expect(() =>
			parseConfig(valid.replace("name: shared", "name: ..")),
		).toThrow(/folders.0.name/);
	});

	it("requires at least one user and folder", () => {
		expect(() =>
			parseConfig(
				"server:\n  cacheDir: /c\n  auditLog: /a\n  maxUploadSize: 1GB\nusers: []\nfolders: []",
			),
		).toThrow(/users.*\n.*folders/);
	});
});
