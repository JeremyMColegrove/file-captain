import { describe, expect, it } from "vitest";

import { parseConfig, parseSize } from "./config";

const valid = `
server:
  cacheDir: /data/.cache
  auditLog: /data/audit.jsonl
  maxUploadSize: 10GB
users:
  - username: jeremy@example.com
    password: "jeremy-password"
  - username: guest@example.com
    password: "guest-password"
    readOnly: true
folders:
  - name: shared
    path: /mnt/shared
    users: all
    storageLimit: 1000gb
  - name: jeremy
    path: /mnt/jeremy
    users: [jeremy@example.com]
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
		expect(config.server.indexIntervalMinutes).toBe(15);
		expect(config.server.thumbnailConcurrency).toBe(3);
		expect(config.users[0]?.readOnly).toBe(false);
		expect(config.users[1]?.readOnly).toBe(true);
		expect(config.folders[0]?.users).toBe("all");
		expect(config.folders[0]?.storageLimit).toBe(1000 * 1024 ** 3);
		expect(config.folders[1]?.storageLimit).toBeUndefined();
		expect(config.folders[1]?.readOnly).toBe(false);
		expect(config.folders[1]?.readOnlyUsers).toEqual([]);
	});

	it("accepts readOnlyUsers alone and validates its usernames", () => {
		const viewOnly = valid.replace(
			"users: [jeremy@example.com]",
			"readOnlyUsers: [guest@example.com]",
		);
		expect(parseConfig(viewOnly).folders[1]).toMatchObject({
			users: [],
			readOnlyUsers: ["guest@example.com"],
		});
		expect(() =>
			parseConfig(
				valid.replace(
					"users: [jeremy@example.com]",
					"readOnlyUsers: [bob@example.com]",
				),
			),
		).toThrow(/folders.1.readOnlyUsers: Unknown user "bob@example.com"/);
	});

	it("rejects folders without any users", () => {
		expect(() =>
			parseConfig(valid.replace("    users: [jeremy@example.com]\n", "")),
		).toThrow(/folders.1.users: Set users and\/or readOnlyUsers/);
	});

	it("rejects invalid YAML", () => {
		expect(() => parseConfig("server: [")).toThrow(/not valid YAML/);
	});

	it("validates indexIntervalMinutes", () => {
		const withInterval = (value: string) =>
			valid.replace(
				"maxUploadSize: 10GB",
				`maxUploadSize: 10GB\n  indexIntervalMinutes: ${value}`,
			);
		expect(parseConfig(withInterval("0")).server.indexIntervalMinutes).toBe(0);
		expect(parseConfig(withInterval("60")).server.indexIntervalMinutes).toBe(
			60,
		);
		expect(() => parseConfig(withInterval("-1"))).toThrow(
			/server.indexIntervalMinutes/,
		);
		expect(() => parseConfig(withInterval("1.5"))).toThrow(
			/server.indexIntervalMinutes/,
		);
	});

	it("validates thumbnailConcurrency", () => {
		const withConcurrency = (value: string) =>
			valid.replace(
				"maxUploadSize: 10GB",
				`maxUploadSize: 10GB\n  thumbnailConcurrency: ${value}`,
			);
		expect(parseConfig(withConcurrency("0")).server.thumbnailConcurrency).toBe(
			0,
		);
		expect(parseConfig(withConcurrency("1")).server.thumbnailConcurrency).toBe(
			1,
		);
		expect(() => parseConfig(withConcurrency("-1"))).toThrow(
			/server.thumbnailConcurrency/,
		);
		expect(() => parseConfig(withConcurrency("1.5"))).toThrow(
			/server.thumbnailConcurrency/,
		);
	});

	it("rejects relative folder paths", () => {
		expect(() =>
			parseConfig(valid.replace("/mnt/jeremy", "mnt/jeremy")),
		).toThrow(/folders.1.path/);
	});

	it("rejects folders that reference unknown users", () => {
		expect(() =>
			parseConfig(
				valid.replace(
					"[jeremy@example.com]",
					"[jeremy@example.com, bob@example.com]",
				),
			),
		).toThrow(/Unknown user "bob@example.com"/);
	});

	it("rejects duplicate usernames and folder names", () => {
		expect(() =>
			parseConfig(
				valid.replace(
					"username: guest@example.com",
					"username: Jeremy@example.com",
				),
			),
		).toThrow(/Duplicate username/);
		expect(() =>
			parseConfig(valid.replace("- name: jeremy", "- name: shared")),
		).toThrow(/Duplicate folder name/);
	});

	it("requires usernames to be email addresses", () => {
		expect(() =>
			parseConfig(
				valid.replace("username: guest@example.com", "username: guest"),
			),
		).toThrow(/users.1.username: Must be an email address/);
	});

	it("accepts long passwords with any symbols", () => {
		const password = "a=[[b]]{c}#d!@$%^&*()'\\ long passphrase, 40+ chars";
		const config = parseConfig(
			valid.replace('"guest-password"', JSON.stringify(password)),
		);
		expect(config.users[1]?.password).toBe(password);
	});

	it("rejects passwords longer than Better Auth accepts", () => {
		expect(() =>
			parseConfig(valid.replace('"guest-password"', `"${"x".repeat(129)}"`)),
		).toThrow(/users.1.password: Use at most 128 characters/);
	});

	it("rejects passwords shorter than 12 characters", () => {
		expect(() =>
			parseConfig(valid.replace('"guest-password"', '"short"')),
		).toThrow(/users.1.password: Use at least 12 characters/);
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
