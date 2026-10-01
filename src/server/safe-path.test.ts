import path from "node:path";
import { describe, expect, it } from "vitest";

import type { FolderConfig } from "./config";
import { BadRequest, NotFound } from "./errors";
import { isValidName, resolveVirtualPath } from "./safe-path";

const folders: FolderConfig[] = [
	{ name: "shared", path: "/srv/shared", users: "all", readOnly: false },
	{ name: "alice", path: "/srv/alice", users: ["alice"], readOnly: false },
	// A sibling whose path shares a prefix with /srv/alice.
	{ name: "alice2", path: "/srv/alice2", users: ["bob"], readOnly: false },
];

const resolve = (p: string, user = "alice") =>
	resolveVirtualPath(folders, user, p);

const absOf = (p: string, user?: string) => {
	const r = resolve(p, user);
	if (r.kind !== "folder") throw new Error("expected folder");
	return r.absPath;
};

describe("resolveVirtualPath", () => {
	it("treats empty and / as the virtual root", () => {
		expect(resolve("/")).toEqual({ kind: "root", virtualPath: "/" });
		expect(resolve("")).toEqual({ kind: "root", virtualPath: "/" });
		expect(resolve("//./")).toEqual({ kind: "root", virtualPath: "/" });
	});

	it("resolves paths inside a folder", () => {
		expect(absOf("/shared/photos/2024")).toBe(
			path.resolve("/srv/shared/photos/2024"),
		);
		expect(absOf("alice/a.txt")).toBe(path.resolve("/srv/alice/a.txt"));
	});

	it("normalizes duplicate slashes and dot segments", () => {
		const r = resolve("//shared/./photos//x/");
		expect(r.kind === "folder" && r.virtualPath).toBe("/shared/photos/x");
	});

	it("flags the folder root", () => {
		const r = resolve("/shared/");
		expect(r.kind === "folder" && r.isFolderRoot).toBe(true);
		const inner = resolve("/shared/x");
		expect(inner.kind === "folder" && inner.isFolderRoot).toBe(false);
	});

	it("rejects .. segments anywhere", () => {
		for (const p of [
			"/shared/..",
			"/shared/../alice",
			"/shared/a/../../alice2",
			"/../etc/passwd",
			"..",
			"/shared/a/..",
		]) {
			expect(() => resolve(p), p).toThrow(BadRequest);
		}
	});

	it("allows names that merely contain dots", () => {
		expect(absOf("/shared/..hidden")).toBe(
			path.resolve("/srv/shared/..hidden"),
		);
		expect(absOf("/shared/a..b")).toBe(path.resolve("/srv/shared/a..b"));
		expect(absOf("/shared/...")).toBe(path.resolve("/srv/shared/..."));
	});

	it("rejects null bytes", () => {
		expect(() => resolve("/shared/a\0.txt")).toThrow(BadRequest);
		expect(() => resolve("\0")).toThrow(BadRequest);
	});

	it("hides the upload staging directory", () => {
		for (const p of [
			"/shared/.file-captain-uploads",
			"/shared/.file-captain-uploads/abc123",
			"/shared/./.file-captain-uploads/",
			"/shared/.FILE-Captain-Uploads/abc",
		]) {
			expect(() => resolve(p), p).toThrow(NotFound);
		}
		// Only reserved at the folder root.
		expect(absOf("/shared/sub/.file-captain-uploads")).toBe(
			path.resolve("/srv/shared/sub/.file-captain-uploads"),
		);
	});

	it("rejects backslashes", () => {
		expect(() => resolve("/shared/..\\..\\etc")).toThrow(BadRequest);
	});

	it("rejects overly long paths", () => {
		expect(() => resolve(`/shared/${"a".repeat(5000)}`)).toThrow(BadRequest);
	});

	it("rejects non-string input", () => {
		expect(() => resolve(undefined as unknown as string)).toThrow(BadRequest);
	});

	it("hides folders the user cannot access", () => {
		expect(() => resolve("/alice2/x", "alice")).toThrow(NotFound);
		expect(() => resolve("/alice/x", "bob")).toThrow(NotFound);
		expect(absOf("/alice2/x", "bob")).toBe(path.resolve("/srv/alice2/x"));
	});

	it("matches usernames case-insensitively but folder names exactly", () => {
		expect(absOf("/alice/x", "ALICE")).toBe(path.resolve("/srv/alice/x"));
		expect(() => resolve("/Shared/x")).toThrow(NotFound);
	});

	it("rejects unknown folders", () => {
		expect(() => resolve("/nope")).toThrow(NotFound);
		expect(() => resolve("/etc/passwd")).toThrow(NotFound);
	});

	it("does not treat an absolute host path as a host path", () => {
		expect(absOf("/shared//srv/alice/secret")).toBe(
			path.resolve("/srv/shared/srv/alice/secret"),
		);
	});
});

describe("isValidName", () => {
	it("accepts normal names", () => {
		for (const n of ["a.txt", "..hidden", "with space", "ünïcode"]) {
			expect(isValidName(n), n).toBe(true);
		}
	});

	it("rejects separators, dots, null bytes and empty", () => {
		for (const n of ["", ".", "..", "a/b", "a\\b", "a\0b", "x".repeat(256)]) {
			expect(isValidName(n), JSON.stringify(n)).toBe(false);
		}
	});
});
