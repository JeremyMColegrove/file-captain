import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	constants,
	createReadStream,
	type ReadStream,
	type Stats,
} from "node:fs";
import {
	copyFile,
	mkdir as fsMkdir,
	rename as fsRename,
	link,
	lstat,
	opendir,
	readFile,
	readlink,
	rm,
	stat,
	statfs,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ZipArchive } from "archiver";
import sharp from "sharp";

import { type AuditAction, writeAudit } from "./audit";
import { type FolderConfig, getConfig } from "./config";
import {
	BadRequest,
	Conflict,
	Forbidden,
	NotFound,
	toAppError,
} from "./errors";
import {
	accessibleFolders,
	canWriteFolder,
	isValidName,
	type ResolvedPath,
	resolveVirtualPath,
	UPLOAD_STAGING_DIR,
} from "./safe-path";
import * as searchIndex from "./search-index";
import * as usage from "./usage";

/**
 * The only module that reads or writes user files. Every method takes the
 * authenticated user first, resolves paths through safe-path, and writes an
 * audit entry for mutations (success and failure).
 */

export type AppUser = { username: string; readOnly: boolean; ip: string };

export type Entry = {
	name: string;
	type: "file" | "dir";
	size: number;
	mtime: string;
	thumbnail: boolean;
	/**
	 * Top-level folders only: `size` is then the used bytes out of `limit`.
	 * That is the cached usage against storageLimit, or, for folders without
	 * one (`disk: true`), the whole disk's usage.
	 */
	limit?: number;
	disk?: boolean;
};

const THUMBNAIL_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".webp",
	".gif",
	".avif",
]);

/** Runs at most `max()` jobs at once; the rest wait in line. */
function limiter(max: () => number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async <T>(job: () => Promise<T>): Promise<T> => {
		if (active < max()) active++;
		else await new Promise<void>((resolve) => waiting.push(resolve));
		try {
			return await job();
		} finally {
			// Hand the slot straight to the next job, or give it back.
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
}

const thumbnailConcurrency = () => getConfig().server.thumbnailConcurrency;
const limitSharp = limiter(thumbnailConcurrency);
// One thread per job, so limitSharp caps thumbnails at thumbnailConcurrency
// cores (libvips otherwise uses every core per job). Each image is decoded once, so
// libvips' operation cache would only hold memory.
sharp.concurrency(1);
sharp.cache(false);
const thumbnailDir = () => path.join(getConfig().server.cacheDir, "thumbnails");

/** Whether a file named `name` gets a thumbnail (never when they're off). */
const hasThumbnail = (name: string) =>
	thumbnailConcurrency() > 0 &&
	THUMBNAIL_EXTENSIONS.has(path.extname(name).toLowerCase());

type FolderPath = Extract<ResolvedPath, { kind: "folder" }>;

function resolve(user: AppUser, virtualPath: string) {
	return resolveVirtualPath(getConfig().folders, user.username, virtualPath);
}

/** Resolves a path that must be inside a folder (not the virtual root). */
function resolveInFolder(user: AppUser, virtualPath: string): FolderPath {
	const resolved = resolve(user, virtualPath);
	if (resolved.kind === "root") throw new BadRequest("Pick a folder first");
	return resolved;
}

/** Resolves a path the user is about to create, change, or remove. */
function resolveWritable(user: AppUser, virtualPath: string): FolderPath {
	const resolved = resolveInFolder(user, virtualPath);
	if (!canWriteFolder(resolved.folder, user)) {
		throw new Forbidden("This folder is read-only");
	}
	if (resolved.isFolderRoot) {
		throw new Forbidden("Top-level folders are managed in config.yaml");
	}
	return resolved;
}

async function audited<T>(
	user: AppUser,
	action: AuditAction,
	src: string,
	dst: string | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		const value = await fn();
		await writeAudit({
			user: user.username,
			action,
			src,
			dst,
			result: "ok",
			ip: user.ip,
		});
		return value;
	} catch (err) {
		await writeAudit({
			user: user.username,
			action,
			src,
			dst,
			result: "error",
			ip: user.ip,
		});
		throw toAppError(err);
	}
}

/** Throws Conflict if `dst` exists, unless it is the same file as `src` (case-only rename). */
async function assertFree(dst: string, src?: string) {
	const existing = await lstat(dst).catch(() => null);
	if (!existing) return;
	if (src && (await lstat(src)).ino === existing.ino) return;
	throw new Conflict("An item with that name already exists");
}

/**
 * The exact size in bytes of a file, or of all files in a tree. Unlike
 * `du`, which counts whole disk blocks, a 10-byte file counts as 10 bytes.
 * Walks one directory at a time and doesn't follow links. Unreadable
 * entries count as 0.
 */
async function treeSize(absPath: string): Promise<number> {
	const info = await lstat(absPath).catch(() => null);
	if (!info?.isDirectory()) return info?.isFile() ? info.size : 0;
	const dir = await opendir(absPath).catch(() => null);
	if (!dir) return 0;
	let total = 0;
	for await (const dirent of dir) {
		total += await treeSize(path.join(absPath, dirent.name));
	}
	return total;
}

const hasLimit = (folder: FolderConfig) => folder.storageLimit !== undefined;

/** Throws if adding `bytes` would push the folder past its storageLimit. */
async function assertSpace(folder: FolderConfig, bytes: number) {
	if (folder.storageLimit === undefined) return;
	if ((await usage.getUsage(folder.name)) + bytes > folder.storageLimit) {
		throw new Forbidden("Not enough space left in this folder");
	}
}

/** Adjusts the cached usage after a change. The change already happened, so never throws. */
async function trackUsage(folder: FolderConfig, delta: number) {
	if (!hasLimit(folder)) return;
	await usage.addUsage(folder.name, delta).catch((err) => {
		console.error(`Failed to update usage for ${folder.name}`, err);
	});
}

/**
 * Caches the usage of every folder with a storageLimit, summed from the search
 * index so the disks aren't walked a second time. Runs after each full sync.
 */
async function measureUsage() {
	for (const folder of getConfig().folders.filter(hasLimit)) {
		await usage.setUsage(
			folder.name,
			await searchIndex.folderSize(folder.name),
		);
	}
}

/** The path of a resolved entry relative to its folder root, e.g. `/a/b.txt`. */
function relPath(resolved: FolderPath) {
	return resolved.virtualPath.slice(resolved.folder.name.length + 1) || "/";
}

const parentOf = (rel: string) => rel.slice(0, rel.lastIndexOf("/")) || "/";

function indexRow(
	folder: FolderConfig,
	rel: string,
	info: { isDirectory(): boolean; size: number; mtimeMs: number },
): searchIndex.IndexRow {
	const isDir = info.isDirectory();
	return {
		folder: folder.name,
		path: rel,
		parent: rel === "/" ? "" : parentOf(rel),
		name: rel.slice(rel.lastIndexOf("/") + 1),
		isDir,
		size: isDir ? 0 : info.size,
		mtimeMs: info.mtimeMs,
	};
}

/**
 * Brings the index for directory `rel` and everything below it in line with
 * the disk. `storedMtime` is the mtime in its row (undefined if it has none).
 * A directory whose mtime matches is not re-read (its entries can't have
 * changed), only descended into. Walks one directory at a time, never holding
 * the whole tree, and writes only rows that changed.
 */
async function syncIndexDir(
	folder: FolderConfig,
	rel: string,
	storedMtime: number | undefined,
): Promise<void> {
	const abs = path.join(folder.path, `.${rel}`);
	// The folder root may itself be a symlink; links below it are not followed.
	const info = await (rel === "/" ? stat : lstat)(abs).catch(() => null);
	if (info?.isSymbolicLink()) return;
	if (!info?.isDirectory()) {
		if (rel !== "/") await searchIndex.removeTree(folder.name, rel);
		return;
	}

	if (storedMtime === info.mtimeMs) {
		for (const child of await searchIndex.getChildren(folder.name, rel, true)) {
			await syncIndexDir(folder, child.path, child.mtimeMs);
		}
		return;
	}

	const known = new Map(
		(await searchIndex.getChildren(folder.name, rel)).map((c) => [c.path, c]),
	);
	const changed: searchIndex.IndexRow[] = [];
	const subdirs: { path: string; storedMtime: number | undefined }[] = [];
	const present = new Set<string>();
	for await (const dirent of await opendir(abs)) {
		if (rel === "/" && dirent.name.toLowerCase() === UPLOAD_STAGING_DIR) {
			continue;
		}
		const childRel = rel === "/" ? `/${dirent.name}` : `${rel}/${dirent.name}`;
		// stat, like list(), so a link to a folder shows as a folder.
		const childInfo = await stat(path.join(abs, dirent.name)).catch(() => null);
		if (!childInfo) continue;
		present.add(childRel);
		const row = indexRow(folder, childRel, childInfo);
		const old = known.get(childRel);
		// A folder replaced by a file: drop what was indexed below it.
		if (old?.isDir && !row.isDir) {
			await searchIndex.removeTree(folder.name, childRel);
		}
		if (dirent.isDirectory()) {
			// A directory's mtime marks it as synced, so it's only written by
			// its own sync below. Until then keep the old value (-1 if new).
			const storedMtime = old?.isDir ? old.mtimeMs : undefined;
			row.mtimeMs = storedMtime ?? -1;
			subdirs.push({ path: childRel, storedMtime });
		}
		if (
			!old ||
			old.isDir !== row.isDir ||
			old.size !== row.size ||
			old.mtimeMs !== row.mtimeMs
		) {
			changed.push(row);
		}
	}
	const goneFiles: string[] = [];
	for (const child of known.values()) {
		if (present.has(child.path)) continue;
		if (child.isDir) await searchIndex.removeTree(folder.name, child.path);
		else goneFiles.push(child.path);
	}
	await searchIndex.removeEntries(folder.name, goneFiles);
	await searchIndex.upsertEntries(changed);
	for (const subdir of subdirs) {
		await syncIndexDir(folder, subdir.path, subdir.storedMtime);
	}
	// Written last, so an interrupted sync re-reads this directory next time.
	await searchIndex.upsertEntries([indexRow(folder, rel, info)]);
}

// On globalThis because instrumentation (which starts syncs) and route
// handlers (which report them) may each get their own copy of this module.
const indexing = globalThis as {
	fileCaptainIndexing?: Promise<void>;
	/** Set once a sync has finished, i.e. the index is complete. */
	fileCaptainIndexed?: boolean;
};

/**
 * Syncs the search index with every configured folder, then re-measures
 * storage usage from it. Runs at startup and every `indexIntervalMinutes`.
 * A call while a sync is running joins it.
 */
export function indexFiles(): Promise<void> {
	indexing.fileCaptainIndexing ??= (async () => {
		const { folders } = getConfig();
		await searchIndex.keepFolders(folders.map((f) => f.name));
		for (const folder of folders) {
			const root = await searchIndex.getEntry(folder.name, "/");
			await syncIndexDir(folder, "/", root?.mtimeMs);
		}
		indexing.fileCaptainIndexed = true;
		await measureUsage();
	})().finally(() => {
		indexing.fileCaptainIndexing = undefined;
	});
	return indexing.fileCaptainIndexing;
}

export type Status = {
	/**
	 * True while the first sync since startup runs; search may be incomplete.
	 * Later periodic syncs only catch up on outside changes, so they don't count.
	 */
	indexing: boolean;
};

export function status(_user: AppUser): Status {
	return {
		indexing:
			indexing.fileCaptainIndexing !== undefined &&
			!indexing.fileCaptainIndexed,
	};
}

/**
 * Index updates after a change. The change already happened, so these never
 * throw. The parent's row keeps its old mtime, so the next startup re-reads
 * that one directory and confirms it.
 */
async function updateIndex(what: string, job: () => Promise<void>) {
	await job().catch((err) => {
		console.error(`Failed to update the search index (${what})`, err);
	});
}

/** Indexes a new file, or a new directory and everything in it. */
function indexAdded(target: FolderPath) {
	return updateIndex("add", async () => {
		const rel = relPath(target);
		const info = await stat(target.absPath);
		if (info.isDirectory()) {
			// Drop any stale row first so the walk doesn't skip the directory.
			await searchIndex.removeTree(target.folder.name, rel);
			await syncIndexDir(target.folder, rel, undefined);
		} else {
			await searchIndex.upsertEntries([indexRow(target.folder, rel, info)]);
		}
	});
}

/** True if `child` is strictly below `parent` (the same path is a name conflict instead). */
function isInside(child: string, parent: string) {
	return child.startsWith(parent + path.sep);
}

/** Recursively copies, walking one directory handle at a time. */
async function copyTree(src: string, dst: string): Promise<void> {
	const info = await lstat(src);
	if (info.isSymbolicLink()) {
		await symlink(await readlink(src), dst);
	} else if (info.isDirectory()) {
		await fsMkdir(dst);
		for await (const dirent of await opendir(src)) {
			await copyTree(path.join(src, dirent.name), path.join(dst, dirent.name));
		}
	} else if (info.isFile()) {
		await copyFile(src, dst, constants.COPYFILE_EXCL);
	}
	// Sockets, FIFOs and devices are skipped.
}

/** Creates every configured folder and server directory that is missing. */
export async function initStorage() {
	const { server, folders } = getConfig();
	for (const folder of folders) {
		await fsMkdir(folder.path, { recursive: true });
	}
	await fsMkdir(thumbnailDir(), { recursive: true });
	await fsMkdir(path.dirname(server.auditLog), { recursive: true });
}

export type Listing = {
	entries: Entry[];
	/** Whether the user may create, change or delete items here (UI hint only). */
	writable: boolean;
};

export async function list(
	user: AppUser,
	virtualPath: string,
): Promise<Listing> {
	const resolved = resolve(user, virtualPath);

	if (resolved.kind === "root") {
		const folders = accessibleFolders(getConfig().folders, user.username);
		const entries = await Promise.all(
			folders.map(async (folder) => {
				const info = await stat(folder.path).catch(() => null);
				const entry = {
					name: folder.name,
					type: "dir" as const,
					size: 0,
					mtime: (info?.mtime ?? new Date(0)).toISOString(),
					thumbnail: false,
				};
				if (hasLimit(folder)) {
					return {
						...entry,
						size: await usage.getUsage(folder.name),
						limit: folder.storageLimit,
					};
				}
				const disk = await statfs(folder.path).catch(() => null);
				if (!disk) return entry;
				return {
					...entry,
					size: (disk.blocks - disk.bfree) * disk.bsize,
					limit: disk.blocks * disk.bsize,
					disk: true,
				};
			}),
		);
		return { entries, writable: false };
	}

	const dir = await stat(resolved.absPath).catch((err) => {
		throw toAppError(err);
	});
	if (!dir.isDirectory()) throw new BadRequest("Not a folder");

	const names: string[] = [];
	for await (const dirent of await opendir(resolved.absPath)) {
		if (
			resolved.isFolderRoot &&
			dirent.name.toLowerCase() === UPLOAD_STAGING_DIR
		) {
			continue;
		}
		names.push(dirent.name);
	}

	const entries = await Promise.all(
		names.map(async (name): Promise<Entry | null> => {
			const info = await stat(path.join(resolved.absPath, name)).catch(
				() => null,
			);
			if (!info) return null; // broken symlink or removed meanwhile
			const isDir = info.isDirectory();
			return {
				name,
				type: isDir ? "dir" : "file",
				size: isDir ? 0 : info.size,
				mtime: info.mtime.toISOString(),
				thumbnail: !isDir && hasThumbnail(name),
			};
		}),
	);
	return {
		entries: entries.filter((e): e is Entry => e !== null),
		writable: canWriteFolder(resolved.folder, user),
	};
}

export type SearchResult = Entry & {
	/** Virtual path of the match, e.g. `/shared/photos/a.jpg`. */
	path: string;
};

const SEARCH_LIMIT = 50;

/** Finds entries whose name contains every word of `query`, in the user's folders. */
export async function search(
	user: AppUser,
	query: string,
): Promise<SearchResult[]> {
	const folders = accessibleFolders(getConfig().folders, user.username);
	const rows = await searchIndex.search(
		folders.map((f) => f.name),
		query,
		SEARCH_LIMIT,
	);
	return rows.map((row) => ({
		path: `/${row.folder}${row.path}`,
		name: row.name,
		type: row.isDir ? "dir" : "file",
		size: row.size,
		mtime: new Date(row.mtimeMs).toISOString(),
		thumbnail: !row.isDir && hasThumbnail(row.name),
	}));
}

/** Parses a single `bytes=` range. Returns null (send the whole file) if absent or unusable. */
export function parseRange(header: string | null | undefined, size: number) {
	const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
	if (!match || size === 0) return null;
	const [, from = "", to = ""] = match;
	let start: number;
	let end: number;
	if (from === "") {
		if (to === "") return null;
		start = Math.max(0, size - Number(to));
		end = size - 1;
	} else {
		start = Number(from);
		end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
	}
	if (start > end || start >= size) return null;
	return { start, end };
}

export type Download = {
	name: string;
	size: number;
	mtime: Date;
	/** Set when the response is a 206 partial response. */
	range: { start: number; end: number } | null;
	stream: ReadableStream<Uint8Array>;
};

export async function openDownload(
	user: AppUser,
	virtualPath: string,
	rangeHeader?: string | null,
): Promise<Download> {
	const resolved = resolveInFolder(user, virtualPath);
	const info = await stat(resolved.absPath).catch((err) => {
		throw toAppError(err);
	});
	if (!info.isFile()) throw new BadRequest("Not a file");

	const range = parseRange(rangeHeader, info.size);
	const nodeStream = createReadStream(resolved.absPath, range ?? undefined);
	return {
		name: path.basename(resolved.absPath),
		size: info.size,
		mtime: info.mtime,
		range,
		stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
	};
}

export type ZipDownload = { name: string; stream: ReadableStream<Uint8Array> };

/**
 * Streams entries of folder `dir` as a zip, folders recursively. Adds one
 * file at a time and walks one directory at a time, so neither the files nor
 * the tree are held in memory. Like list(), the selected entries themselves
 * may be symlinks; links further down are skipped.
 */
export async function openZip(
	user: AppUser,
	dir: string,
	names: string[],
): Promise<ZipDownload> {
	const parent = resolveInFolder(user, dir);
	// Checked up front so a bad request gets an error, not a broken zip.
	const items: { name: string; absPath: string; info: Stats }[] = [];
	for (const name of new Set(names)) {
		if (!isValidName(name)) throw new BadRequest("Invalid name");
		const { absPath } = resolveInFolder(user, `${parent.virtualPath}/${name}`);
		const info = await stat(absPath).catch((err) => {
			throw toAppError(err);
		});
		items.push({ name, absPath, info });
	}

	// Stored, not compressed: photos and videos are compressed already, and
	// deflating gigabytes would cost a lot of CPU for little gain.
	const archive = new ZipArchive({ store: true });
	// The client went away: stop walking and release the open file.
	const closed = new AbortController();
	let reading: ReadStream | undefined;
	archive.on("close", () => {
		closed.abort();
		reading?.destroy();
	});
	// Waits until the archive has taken in the last entry (and the client
	// has read enough of it).
	const appended = () => once(archive, "entry", { signal: closed.signal });

	async function add(absPath: string, name: string, info: Stats) {
		if (info.isDirectory()) {
			archive.append(Buffer.alloc(0), {
				name,
				type: "directory",
				date: info.mtime,
			});
			await appended();
			for await (const dirent of await opendir(absPath)) {
				const child = path.join(absPath, dirent.name);
				const childInfo = await lstat(child).catch(() => null);
				if (!childInfo || childInfo.isSymbolicLink()) continue;
				await add(child, `${name}/${dirent.name}`, childInfo);
			}
		} else if (info.isFile()) {
			reading = createReadStream(absPath);
			archive.append(reading, { name, date: info.mtime });
			await appended();
		}
		// Sockets, FIFOs and devices are skipped.
	}

	(async () => {
		for (const item of items) await add(item.absPath, item.name, item.info);
		await archive.finalize();
	})().catch((err) => {
		if (!closed.signal.aborted) console.error("Zip download failed", err);
		archive.destroy(err);
	});

	const folderName = path.posix.basename(parent.virtualPath);
	return {
		name: `${folderName}.zip`,
		stream: Readable.toWeb(archive) as ReadableStream<Uint8Array>,
	};
}

export function mkdir(user: AppUser, virtualPath: string) {
	return audited(user, "mkdir", virtualPath, undefined, async () => {
		const target = resolveWritable(user, virtualPath);
		if (!isValidName(path.basename(target.absPath)))
			throw new BadRequest("Invalid name");
		await fsMkdir(target.absPath);
		await indexAdded(target);
	});
}

export function rename(user: AppUser, virtualPath: string, newName: string) {
	const dstVirtual = path.posix.join(path.posix.dirname(virtualPath), newName);
	return audited(user, "rename", virtualPath, dstVirtual, async () => {
		if (!isValidName(newName)) throw new BadRequest("Invalid name");
		const src = resolveWritable(user, virtualPath);
		const dst = resolveWritable(user, dstVirtual);
		await lstat(src.absPath);
		await assertFree(dst.absPath, src.absPath);
		await fsRename(src.absPath, dst.absPath);
		await updateIndex("rename", () =>
			searchIndex.moveTree(
				src.folder.name,
				relPath(src),
				dst.folder.name,
				relPath(dst),
			),
		);
	});
}

export function move(user: AppUser, srcPath: string, dstPath: string) {
	return audited(user, "move", srcPath, dstPath, async () => {
		const src = resolveWritable(user, srcPath);
		const dst = resolveWritable(user, dstPath);
		if (isInside(dst.absPath, src.absPath)) {
			throw new BadRequest("Cannot move a folder into itself");
		}
		await lstat(src.absPath);
		await assertFree(dst.absPath);
		const crossFolder = src.folder.name !== dst.folder.name;
		const bytes =
			crossFolder && (hasLimit(src.folder) || hasLimit(dst.folder))
				? await treeSize(src.absPath)
				: 0;
		await assertSpace(dst.folder, bytes);
		try {
			await fsRename(src.absPath, dst.absPath);
		} catch (err) {
			// Folders can live on different disks; fall back to copy + delete.
			if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
			await copyTree(src.absPath, dst.absPath);
			await rm(src.absPath, { recursive: true });
		}
		if (crossFolder) {
			await trackUsage(src.folder, -bytes);
			await trackUsage(dst.folder, bytes);
		}
		await updateIndex("move", () =>
			searchIndex.moveTree(
				src.folder.name,
				relPath(src),
				dst.folder.name,
				relPath(dst),
			),
		);
	});
}

export function copy(user: AppUser, srcPath: string, dstPath: string) {
	return audited(user, "copy", srcPath, dstPath, async () => {
		const src = resolveInFolder(user, srcPath);
		const dst = resolveWritable(user, dstPath);
		if (isInside(dst.absPath, src.absPath)) {
			throw new BadRequest("Cannot copy a folder into itself");
		}
		await lstat(src.absPath);
		await assertFree(dst.absPath);
		const bytes = hasLimit(dst.folder) ? await treeSize(src.absPath) : 0;
		await assertSpace(dst.folder, bytes);
		await copyTree(src.absPath, dst.absPath);
		await trackUsage(dst.folder, bytes);
		await indexAdded(dst);
	});
}

export function remove(user: AppUser, virtualPath: string) {
	return audited(user, "delete", virtualPath, undefined, async () => {
		const target = resolveWritable(user, virtualPath);
		await lstat(target.absPath);
		const bytes = hasLimit(target.folder) ? await treeSize(target.absPath) : 0;
		await rm(target.absPath, { recursive: true });
		await trackUsage(target.folder, -bytes);
		await updateIndex("delete", () =>
			searchIndex.removeTree(target.folder.name, relPath(target)),
		);
	});
}

export type Thumbnail = { data: Buffer; etag: string };

/** Returns a cached 128px webp thumbnail, generating it on first request. */
export async function getThumbnail(
	user: AppUser,
	virtualPath: string,
): Promise<Thumbnail> {
	const resolved = resolveInFolder(user, virtualPath);
	if (!hasThumbnail(resolved.absPath)) {
		throw new NotFound();
	}
	const info = await stat(resolved.absPath).catch(() => null);
	if (!info?.isFile()) throw new NotFound();

	const etag = createHash("sha256")
		.update(
			[
				resolved.folder.name,
				resolved.virtualPath,
				info.mtimeMs,
				info.size,
			].join("\0"),
		)
		.digest("hex");
	const cached = path.join(thumbnailDir(), `${etag}.webp`);

	const existing = await readFile(cached).catch(() => null);
	if (existing) return { data: existing, etag };

	try {
		const data = await limitSharp(() =>
			sharp(resolved.absPath)
				.rotate()
				.resize(128, 128, { fit: "inside", withoutEnlargement: true })
				.webp()
				.toBuffer(),
		);
		// Write then rename so a concurrent reader never sees a partial file.
		const tmp = `${cached}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmp, data);
		await fsRename(tmp, cached);
		return { data, etag };
	} catch {
		throw new NotFound();
	}
}

/** Checks an upload target before any bytes arrive. Audits only rejections. */
export async function checkUpload(
	user: AppUser,
	targetPath: string,
	size: number,
) {
	try {
		const target = resolveWritable(user, targetPath);
		if (!isValidName(path.basename(target.absPath)))
			throw new BadRequest("Invalid name");
		const parent = await stat(path.dirname(target.absPath)).catch(() => null);
		if (!parent?.isDirectory()) throw new NotFound("Folder not found");
		await assertFree(target.absPath);
		await assertSpace(target.folder, size);
	} catch (err) {
		await writeAudit({
			user: user.username,
			action: "upload",
			src: targetPath,
			result: "error",
			ip: user.ip,
		});
		throw toAppError(err);
	}
}

/**
 * Moves a finished upload from the staging dir into place. Never overwrites:
 * a name taken while the upload was running is a Conflict.
 */
export function finalizeUpload(
	user: AppUser,
	stagedPath: string,
	targetPath: string,
) {
	return audited(user, "upload", targetPath, undefined, async () => {
		try {
			const target = resolveWritable(user, targetPath);
			if (!isValidName(path.basename(target.absPath)))
				throw new BadRequest("Invalid name");
			// Re-checked: other uploads may have finished meanwhile.
			const bytes = hasLimit(target.folder) ? await treeSize(stagedPath) : 0;
			await assertSpace(target.folder, bytes);
			try {
				// link() fails with EEXIST instead of replacing, unlike rename().
				await link(stagedPath, target.absPath);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP") {
					throw err;
				}
				// Target is a separate mount inside the folder, or no hard links.
				await copyFile(stagedPath, target.absPath, constants.COPYFILE_EXCL);
			}
			await trackUsage(target.folder, bytes);
			await indexAdded(target);
		} finally {
			// On failure the client re-uploads under a new name.
			await rm(stagedPath, { force: true });
		}
	});
}
