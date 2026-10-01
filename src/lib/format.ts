export function formatSize(bytes: number) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** e.g. "Aug 5, 2026". */
export const formatShortDate = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
