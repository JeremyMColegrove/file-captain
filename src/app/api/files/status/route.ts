import { requireUser } from "~/server/better-auth/server";
import { withErrors } from "~/server/errors";
import * as fileService from "~/server/file-service";

export const GET = withErrors(async () => {
	const user = await requireUser();
	return Response.json(fileService.status(user));
});
