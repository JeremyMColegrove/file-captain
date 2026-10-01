import { z } from "zod";

/** A virtual path like `/shared/photos`. safe-path does the real checking. */
const virtualPath = z.string().min(1).max(4096);

export const pathQuery = z.object({ path: virtualPath.default("/") });

/** `inline=1` serves a previewable file for display instead of as an attachment. */
export const downloadQuery = z.object({
	path: virtualPath,
	inline: z.literal("1").optional(),
});

export const searchQuery = z.object({ q: z.string().trim().min(1).max(255) });

export const pathBody = z.object({ path: virtualPath });

export const renameBody = z.object({
	path: virtualPath,
	newName: z.string().min(1).max(255),
});

/** Form fields for a zip download: a folder and the names of entries in it. */
export const zipForm = z.object({
	dir: virtualPath,
	names: z.array(z.string().min(1).max(255)).min(1).max(10000),
});

export const srcDstBody = z.object({ src: virtualPath, dst: virtualPath });

/** tus Upload-Metadata sent by Uppy: the target folder and file name. */
export const uploadMeta = z.object({
	dir: virtualPath,
	name: z.string().min(1).max(255),
});
