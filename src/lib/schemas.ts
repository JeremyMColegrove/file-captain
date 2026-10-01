import { z } from "zod";

/** A virtual path like `/shared/photos`. safe-path does the real checking. */
const virtualPath = z.string().min(1).max(4096);

export const pathQuery = z.object({ path: virtualPath.default("/") });

export const searchQuery = z.object({ q: z.string().trim().min(1).max(255) });

export const pathBody = z.object({ path: virtualPath });

export const renameBody = z.object({
	path: virtualPath,
	newName: z.string().min(1).max(255),
});

export const srcDstBody = z.object({ src: virtualPath, dst: virtualPath });

/** tus Upload-Metadata sent by Uppy: the target folder and file name. */
export const uploadMeta = z.object({
	dir: virtualPath,
	name: z.string().min(1).max(255),
});
