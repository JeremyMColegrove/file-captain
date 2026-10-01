import { searchQuery } from "~/lib/schemas";
import { requireUser } from "~/server/better-auth/server";
import { withErrors } from "~/server/errors";
import * as fileService from "~/server/file-service";

export const GET = withErrors(async (req: Request) => {
	const { q } = searchQuery.parse(
		Object.fromEntries(new URL(req.url).searchParams),
	);
	const user = await requireUser();
	return Response.json({ results: await fileService.search(user, q) });
});
