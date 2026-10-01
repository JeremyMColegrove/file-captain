import { pathQuery } from "~/lib/schemas";
import { requireUser } from "~/server/better-auth/server";
import { withErrors } from "~/server/errors";
import * as fileService from "~/server/file-service";

// The client adds `&v=<mtime>` so the URL changes whenever the file does,
// which makes the long cache lifetime safe.
export const GET = withErrors(async (req: Request) => {
	const { path } = pathQuery.parse(
		Object.fromEntries(new URL(req.url).searchParams),
	);
	const user = await requireUser();
	const thumb = await fileService.getThumbnail(user, path);
	return new Response(new Uint8Array(thumb.data), {
		headers: {
			"Content-Type": "image/webp",
			"Cache-Control": "private, max-age=31536000, immutable",
			ETag: `"${thumb.etag}"`,
		},
	});
});
