import { pathQuery } from "~/lib/schemas";
import { requireUser } from "~/server/better-auth/server";
import { withErrors } from "~/server/errors";
import * as fileService from "~/server/file-service";

export const GET = withErrors(async (req: Request) => {
	const { path } = pathQuery.parse(
		Object.fromEntries(new URL(req.url).searchParams),
	);
	const user = await requireUser();
	return Response.json({ sizes: await fileService.dirSizes(user, path) });
});
