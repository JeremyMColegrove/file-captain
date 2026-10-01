import {
	and,
	asc,
	desc,
	eq,
	ilike,
	inArray,
	like,
	ne,
	notInArray,
	or,
	sql,
} from "drizzle-orm";

import { db } from "./db";
import { fileIndex } from "./db/schema";

/**
 * The search index in Postgres. See fileIndex in the schema. Only file-service
 * calls this; paths are relative to a folder root (`/a/b.txt`, root is `/`).
 */

export type IndexRow = typeof fileIndex.$inferSelect;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/** Rows at `p` and everything below it. */
function inTree(folder: string, p: string) {
	return and(
		eq(fileIndex.folder, folder),
		// A LIKE prefix, so file_index_path_prefix_idx can serve it.
		or(eq(fileIndex.path, p), like(fileIndex.path, `${escapeLike(p)}/%`)),
	);
}

export async function getEntry(folder: string, p: string) {
	const [row] = await db
		.select()
		.from(fileIndex)
		.where(and(eq(fileIndex.folder, folder), eq(fileIndex.path, p)));
	return row;
}

export type ChildRow = Pick<IndexRow, "path" | "isDir" | "size" | "mtimeMs">;

/** The direct children of `parent`, or only its subdirectories if `dirsOnly`. */
export function getChildren(
	folder: string,
	parent: string,
	dirsOnly = false,
): Promise<ChildRow[]> {
	return db
		.select({
			path: fileIndex.path,
			isDir: fileIndex.isDir,
			size: fileIndex.size,
			mtimeMs: fileIndex.mtimeMs,
		})
		.from(fileIndex)
		.where(
			and(
				eq(fileIndex.folder, folder),
				eq(fileIndex.parent, parent),
				dirsOnly ? eq(fileIndex.isDir, true) : undefined,
			),
		);
}

export async function upsertEntries(rows: IndexRow[]) {
	// Batched to stay well under Postgres' bind parameter limit.
	for (let i = 0; i < rows.length; i += 1000) {
		await db
			.insert(fileIndex)
			.values(rows.slice(i, i + 1000))
			.onConflictDoUpdate({
				target: [fileIndex.folder, fileIndex.path],
				set: {
					parent: sql`excluded.parent`,
					name: sql`excluded.name`,
					isDir: sql`excluded.is_dir`,
					size: sql`excluded.size`,
					mtimeMs: sql`excluded.mtime_ms`,
				},
			});
	}
}

export async function removeTree(folder: string, p: string) {
	await db.delete(fileIndex).where(inTree(folder, p));
}

/** Removes the rows at exactly `paths` (files; use removeTree for folders). */
export async function removeEntries(folder: string, paths: string[]) {
	for (let i = 0; i < paths.length; i += 1000) {
		await db
			.delete(fileIndex)
			.where(
				and(
					eq(fileIndex.folder, folder),
					inArray(fileIndex.path, paths.slice(i, i + 1000)),
				),
			);
	}
}

/** Re-keys `src` and everything below it to `dst`, without touching the disk. */
export async function moveTree(
	srcFolder: string,
	src: string,
	dstFolder: string,
	dst: string,
) {
	const dstParent = dst.slice(0, dst.lastIndexOf("/")) || "/";
	const dstName = dst.slice(dst.lastIndexOf("/") + 1);
	const rest = (column: typeof fileIndex.path | typeof fileIndex.parent) =>
		sql`substr(${column}, ${src.length + 1})`;
	await db.transaction(async (tx) => {
		await tx.delete(fileIndex).where(inTree(dstFolder, dst));
		await tx
			.update(fileIndex)
			.set({
				folder: dstFolder,
				path: sql`${dst} || ${rest(fileIndex.path)}`,
				parent: sql`case when ${fileIndex.path} = ${src} then ${dstParent} else ${dst} || ${rest(fileIndex.parent)} end`,
				name: sql`case when ${fileIndex.path} = ${src} then ${dstName} else ${fileIndex.name} end`,
			})
			.where(inTree(srcFolder, src));
	});
}

/** Total bytes of the files indexed in `folder`. */
export async function folderSize(folder: string): Promise<number> {
	const [row] = await db
		.select({ bytes: sql<string>`coalesce(sum(${fileIndex.size}), 0)` })
		.from(fileIndex)
		.where(and(eq(fileIndex.folder, folder), eq(fileIndex.isDir, false)));
	// Postgres returns sum(bigint) as numeric, which arrives as a string.
	return Number(row?.bytes ?? 0);
}

/** Drops rows of folders that are no longer in config.yaml. */
export async function keepFolders(folders: string[]) {
	await db
		.delete(fileIndex)
		.where(folders.length ? notInArray(fileIndex.folder, folders) : undefined);
}

/** Entries in `folders` whose name contains every word of `query`. */
export function search(folders: string[], query: string, limit: number) {
	const words = query.split(/\s+/).filter(Boolean);
	if (folders.length === 0 || words.length === 0) return Promise.resolve([]);
	return db
		.select()
		.from(fileIndex)
		.where(
			and(
				inArray(fileIndex.folder, folders),
				ne(fileIndex.path, "/"),
				...words.map((w) => ilike(fileIndex.name, `%${escapeLike(w)}%`)),
			),
		)
		.orderBy(desc(fileIndex.isDir), asc(fileIndex.name))
		.limit(limit);
}
