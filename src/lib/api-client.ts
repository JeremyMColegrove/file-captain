/** Mirrors the /api/files response. */
export type Entry = {
	name: string;
	type: "file" | "dir";
	size: number;
	mtime: string;
	thumbnail: boolean;
	/** Top-level folders with a storageLimit only; `size` is then the usage. */
	limit?: number;
};
export type Listing = { entries: Entry[]; writable: boolean };
/** Mirrors the /api/files/search response. */
export type SearchResult = Entry & { path: string };

/** GETs `url`, or POSTs `body` as JSON. Throws the server's error message. */
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
		throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
	}
	return data as T;
}

export const join = (dir: string, name: string) =>
	dir === "/" ? `/${name}` : `${dir}/${name}`;

export const q = (path: string) => `?path=${encodeURIComponent(path)}`;
