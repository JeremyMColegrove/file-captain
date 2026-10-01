import { eq, sql } from "drizzle-orm";

import { db } from "./db";
import { folderUsage } from "./db/schema";

/** Cached disk usage per folder (bytes). See folderUsage in the schema. */

export async function getUsage(folder: string): Promise<number> {
	const [row] = await db
		.select({ bytes: folderUsage.bytes })
		.from(folderUsage)
		.where(eq(folderUsage.folder, folder));
	return row?.bytes ?? 0;
}

export async function setUsage(folder: string, bytes: number) {
	await db
		.insert(folderUsage)
		.values({ folder, bytes, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: folderUsage.folder,
			set: { bytes, updatedAt: new Date() },
		});
}

export async function addUsage(folder: string, delta: number) {
	if (delta === 0) return;
	await db
		.insert(folderUsage)
		.values({ folder, bytes: Math.max(0, delta), updatedAt: new Date() })
		.onConflictDoUpdate({
			target: folderUsage.folder,
			set: {
				bytes: sql`greatest(0, ${folderUsage.bytes} + ${delta})`,
				updatedAt: new Date(),
			},
		});
}
