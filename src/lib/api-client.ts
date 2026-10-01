/** Mirrors the /api/files response. */
export type Entry = {
	name: string;
	type: "file" | "dir";
	size: number;
	mtime: string;
	thumbnail: boolean;
	/** Top-level folders only: `size` used out of `limit` (the disk's size if `disk`). */
	limit?: number;
	disk?: boolean;
};
export type Listing = { entries: Entry[]; writable: boolean };
/** Mirrors the /api/files/search response. */
export type SearchResult = Entry & { path: string };

/** Mirrors the /api/files/status response. */
export type Status = { indexing: boolean };

/** A failed request, carrying the server's error code (e.g. "CONFLICT"). */
export class ApiError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
	}
}

/** GETs `url`, or POSTs `body` as JSON. Throws an ApiError with the server's message. */
export async function api<T>(url: string, body?: unknown): Promise<T> {
	const res = await fetch(
		url,
		body === undefined
			? undefined
			: {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
	);
	const data = await res.json().catch(() => null);
	if (!res.ok) {
		throw new ApiError(
			data?.error?.message ?? `Request failed (${res.status})`,
			data?.error?.code ?? "UNKNOWN",
		);
	}
	return data as T;
}

export const join = (dir: string, name: string) =>
	dir === "/" ? `/${name}` : `${dir}/${name}`;

export const q = (path: string) => `?path=${encodeURIComponent(path)}`;

/** `v` changes with the file, so the long-lived browser cache stays correct. */
const version = (entry: Entry) =>
	`&v=${encodeURIComponent(`${entry.mtime}-${entry.size}`)}`;

export const thumbnailUrl = (path: string, entry: Entry) =>
	`/api/files/thumbnail${q(path)}${version(entry)}`;

/** The file itself, served for display in the page (previewable types only). */
export const previewUrl = (path: string, entry: Entry) =>
	`/api/files/download${q(path)}&inline=1${version(entry)}`;
