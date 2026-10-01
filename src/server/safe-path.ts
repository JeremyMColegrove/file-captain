import path from "node:path";

import type { FolderConfig } from "./config";
import { BadRequest, NotFound } from "./errors";

/**
 * SECURITY-CRITICAL. Every client-supplied path goes through here.
 *
 * Virtual paths look like `/<folder>/<rest>`. `/` itself is the virtual list
 * of folders the user can access. Changes must keep safe-path.test.ts passing
 * and add tests for new cases.
 */

/**
 * Hidden directory at each folder root where in-progress uploads are staged
 * (same disk as the target). Clients can never address it.
 */
export const UPLOAD_STAGING_DIR = ".file-captain-uploads";

export type ResolvedPath =
	| { kind: "root"; virtualPath: "/" }
	| {
			kind: "folder";
			folder: FolderConfig;
			/** Absolute host path. Never send to the client or the audit log. */
			absPath: string;
			/** Normalized virtual path, e.g. `/shared/photos`. */
			virtualPath: string;
			/** True when the path is the folder's own root (`/shared`). */
			isFolderRoot: boolean;
	  };

function isListed(list: FolderConfig["users"], username: string) {
	if (list === "all") return true;
	const key = username.toLowerCase();
	return list.some((u) => u.toLowerCase() === key);
}

export function canAccessFolder(folder: FolderConfig, username: string) {
	return (
		isListed(folder.users, username) || isListed(folder.readOnlyUsers, username)
	);
}

/**
 * Writes need write access everywhere: the user and folder aren't readOnly,
 * and the user is in `users` but not `readOnlyUsers` (most restrictive wins).
 */
export function canWriteFolder(
	folder: FolderConfig,
	user: { username: string; readOnly: boolean },
) {
	return (
		!user.readOnly &&
		!folder.readOnly &&
		isListed(folder.users, user.username) &&
		!isListed(folder.readOnlyUsers, user.username)
	);
}

export function accessibleFolders(folders: FolderConfig[], username: string) {
	return folders.filter((f) => canAccessFolder(f, username));
}

/** Splits a virtual path into segments, rejecting anything suspicious. */
export function splitVirtualPath(virtualPath: string): string[] {
	if (typeof virtualPath !== "string") throw new BadRequest("Invalid path");
	if (virtualPath.includes("\0")) throw new BadRequest("Invalid path");
	if (virtualPath.length > 4096) throw new BadRequest("Path too long");

	const segments = virtualPath.split("/").filter((s) => s !== "" && s !== ".");
	if (segments.some((s) => s === ".." || s.includes("\\"))) {
		throw new BadRequest("Invalid path");
	}
	return segments;
}

export function resolveVirtualPath(
	folders: FolderConfig[],
	username: string,
	virtualPath: string,
): ResolvedPath {
	const segments = splitVirtualPath(virtualPath);
	const [name, ...rest] = segments;
	if (name === undefined) return { kind: "root", virtualPath: "/" };

	// Unknown and inaccessible folders look the same to the client.
	const folder = accessibleFolders(folders, username).find(
		(f) => f.name === name,
	);
	if (!folder) throw new NotFound();
	// Case-insensitive because the host filesystem may be.
	if (rest[0]?.toLowerCase() === UPLOAD_STAGING_DIR) throw new NotFound();

	const root = path.resolve(folder.path);
	const relative = `/${rest.join("/")}`;
	const absPath = path.resolve(root, `.${relative}`);
	if (absPath !== root && !absPath.startsWith(root + path.sep)) {
		throw new BadRequest("Invalid path");
	}

	return {
		kind: "folder",
		folder,
		absPath,
		virtualPath: `/${segments.join("/")}`,
		isFolderRoot: absPath === root,
	};
}

/** Validates a single file or folder name (used for rename, mkdir targets). */
export function isValidName(name: string) {
	return (
		name.length > 0 &&
		name.length <= 255 &&
		name !== "." &&
		name !== ".." &&
		!/[/\\\0]/.test(name)
	);
}
