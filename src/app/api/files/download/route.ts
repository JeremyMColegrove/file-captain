import { previewOf } from "~/lib/file-types";
import { downloadQuery } from "~/lib/schemas";
import { requireUser } from "~/server/better-auth/server";
import { withErrors } from "~/server/errors";
import * as fileService from "~/server/file-service";

export const GET = withErrors(async (req: Request) => {
	const { path, inline } = downloadQuery.parse(
		Object.fromEntries(new URL(req.url).searchParams),
	);
	const user = await requireUser();
	const file = await fileService.openDownload(
		user,
		path,
		req.headers.get("range"),
	);

	// Only allowlisted types are shown inline; everything else downloads.
	const preview = inline ? previewOf(file.name) : null;
	const filename = `filename*=UTF-8''${encodeURIComponent(file.name)}`;
	const headers = new Headers({
		"Accept-Ranges": "bytes",
		"Content-Disposition": `${preview ? "inline" : "attachment"}; ${filename}`,
		"Content-Type": preview?.mime ?? "application/octet-stream",
		"Last-Modified": file.mtime.toUTCString(),
		"X-Content-Type-Options": "nosniff",
	});
	if (preview) {
		// Opened directly in a tab, the file still can't run script.
		headers.set("Content-Security-Policy", "sandbox");
		// The client adds `&v=<mtime>-<size>` (as for thumbnails), so reopening
		// a file is a browser cache hit instead of another disk read.
		headers.set("Cache-Control", "private, max-age=31536000, immutable");
	}
	if (!file.range) {
		headers.set("Content-Length", String(file.size));
		return new Response(file.stream, { headers });
	}
	const { start, end } = file.range;
	headers.set("Content-Length", String(end - start + 1));
	headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
	return new Response(file.stream, { status: 206, headers });
});
