import { pathQuery } from "~/lib/schemas";
import { requireUser } from "~/server/better-auth/server";
import { withErrors } from "~/server/errors";
import * as fileService from "~/server/file-service";

export const GET = withErrors(async (req: Request) => {
	const { path } = pathQuery.parse(
		Object.fromEntries(new URL(req.url).searchParams),
	);
	const user = await requireUser();
	const file = await fileService.openDownload(
		user,
		path,
		req.headers.get("range"),
	);

	const headers = new Headers({
		"Accept-Ranges": "bytes",
		"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
		"Content-Type": "application/octet-stream",
		"Last-Modified": file.mtime.toUTCString(),
	});
	if (!file.range) {
		headers.set("Content-Length", String(file.size));
		return new Response(file.stream, { headers });
	}
	const { start, end } = file.range;
	headers.set("Content-Length", String(end - start + 1));
	headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
	return new Response(file.stream, { status: 206, headers });
});
