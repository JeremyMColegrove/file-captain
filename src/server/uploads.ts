import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { FileStore } from "@tus/file-store";
import { Server } from "@tus/server";

import { uploadMeta } from "~/lib/schemas";
import { type FolderConfig, getConfig } from "./config";
import { AppError, Forbidden, NotFound, toAppError } from "./errors";
import type { AppUser } from "./file-service";
import * as fileService from "./file-service";
import { canAccessFolder, UPLOAD_STAGING_DIR } from "./safe-path";

/**
 * tus (resumable upload) servers, one per folder. Chunks are staged in a
 * hidden directory at the folder's root so they land on the same disk as the
 * target (the cache disk may be too small). On completion
 * fileService.finalizeUpload links the file into place.
 *
 * Upload URLs look like /api/upload/<folder>/<id>.
 */

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** The signed-in user for each request, set by handleUpload. */
const users = new WeakMap<Request, AppUser>();

function userFor(req: Request): AppUser {
	const user = users.get(req);
	if (!user) throw new Error("handleUpload was bypassed");
	return user;
}

/** tus hooks reject by throwing `{ status_code, body }`. */
function tusError(err: unknown) {
	const appError = toAppError(err);
	if (appError.status >= 500) console.error(err);
	return {
		status_code: appError.status,
		body: JSON.stringify({
			error: { code: appError.code, message: appError.message },
		}),
	};
}

const stagingDir = (folder: FolderConfig) =>
	path.join(folder.path, UPLOAD_STAGING_DIR);

type Entry = { server: Server; store: FileStore };
const servers = new Map<string, Promise<Entry>>();

async function createServer(folder: FolderConfig): Promise<Entry> {
	// FileStore creates its directory in a callback that throws uncaught on
	// failure, so make sure it exists first.
	await mkdir(stagingDir(folder), { recursive: true });
	const store = new FileStore({
		directory: stagingDir(folder),
		expirationPeriodInMilliseconds: STALE_AFTER_MS,
	});

	/** Uploads may only target this server's folder. */
	function targetPath(metadata: Record<string, string | null> | undefined) {
		const { dir, name } = uploadMeta.parse(metadata ?? {});
		const target = path.posix.join("/", dir, name);
		if (target.split("/")[1] !== folder.name) {
			throw new Forbidden("Upload is for a different folder");
		}
		return target;
	}

	const server = new Server({
		path: `/api/upload/${encodeURIComponent(folder.name)}`,
		datastore: store,
		maxSize: getConfig().server.maxUploadSize,
		relativeLocation: true,
		async onIncomingRequest(req, id) {
			// Only the user who started an upload may resume or cancel it.
			if (req.method === "POST" || req.method === "OPTIONS") return;
			const upload = await store.getUpload(id).catch(() => null);
			if (upload && upload.metadata?.owner !== userFor(req).username) {
				throw { status_code: 404, body: "Not found" };
			}
		},
		async onUploadCreate(req, upload) {
			const user = userFor(req);
			try {
				await fileService.checkUpload(
					user,
					targetPath(upload.metadata),
					upload.size ?? 0,
				);
			} catch (err) {
				throw tusError(err);
			}
			return { metadata: { ...upload.metadata, owner: user.username } };
		},
		async onUploadFinish(req, upload) {
			const user = userFor(req);
			const stagedPath = upload.storage?.path;
			try {
				if (!stagedPath) throw new AppError(500, "INTERNAL", "Upload lost");
				await fileService.finalizeUpload(
					user,
					stagedPath,
					targetPath(upload.metadata),
				);
			} catch (err) {
				throw tusError(err);
			} finally {
				await store.configstore.delete(upload.id).catch(() => {});
			}
			return {};
		},
	});
	return { server, store };
}

function getServer(folder: FolderConfig): Promise<Entry> {
	let entry = servers.get(folder.name);
	if (!entry) {
		entry = createServer(folder);
		entry.catch(() => servers.delete(folder.name));
		servers.set(folder.name, entry);
	}
	return entry;
}

export async function handleUpload(
	user: AppUser,
	req: Request,
): Promise<Response> {
	const [, , , encoded = ""] = new URL(req.url).pathname.split("/");
	const name = decodeURIComponent(encoded);
	const folder = getConfig().folders.find(
		(f) => f.name === name && canAccessFolder(f, user.username),
	);
	if (!folder) throw new NotFound();
	// Checked here too so read-only folders never get a staging directory.
	if (user.readOnly || folder.readOnly) {
		throw new Forbidden("This folder is read-only");
	}
	users.set(req, user);
	const { server } = await getServer(folder);
	return server.handleWeb(req);
}

/** Deletes incomplete uploads older than 24h in every folder that has any. */
export async function cleanStaleUploads() {
	for (const folder of getConfig().folders) {
		if (folder.readOnly) continue;
		const exists = await stat(stagingDir(folder)).catch(() => null);
		if (!exists) continue;
		try {
			const { store } = await getServer(folder);
			const removed = await store.deleteExpired();
			if (removed) {
				console.log(`Removed ${removed} stale upload(s) in ${folder.name}`);
			}
		} catch (err) {
			console.error(`Stale upload cleanup failed for ${folder.name}`, err);
		}
	}
}
