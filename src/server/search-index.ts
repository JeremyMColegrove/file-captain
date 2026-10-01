import {
	and,
	asc,
	desc,
	eq,
	ilike,
	inArray,
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

/** Rows at `p` and everything below it. */
function inTree(folder: string, p: string) {
	return and(
		eq(fileIndex.folder, folder),
		or(
			eq(fileIndex.path, p),
			// left() instead of LIKE, so names containing % or _ need no escaping.
			eq(sql`left(${fileIndex.path}, ${p.length + 1})`, `${p}/`),
		),
	);
}

export async function getEntry(folder: string, p: string) {
	const [row] = await db
		.select()
		.from(fileIndex)
		.where(and(eq(fileIndex.folder, folder), eq(fileIndex.path, p)));
	return row;
}

export function getChildren(folder: string, parent: string) {
	return db
		.select()
		.from(fileIndex)
		.where(and(eq(fileIndex.folder, folder), eq(fileIndex.parent, parent)));
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
				...words.map((w) =>
					ilike(fileIndex.name, `%${w.replace(/[\\%_]/g, "\\$&")}%`),
				),
			),
		)
		.orderBy(desc(fileIndex.isDir), asc(fileIndex.name))
		.limit(limit);
}
