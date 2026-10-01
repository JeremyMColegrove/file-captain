import { pathBody } from "~/lib/schemas";
import { requireUser } from "~/server/better-auth/server";
import { withErrors } from "~/server/errors";
import * as fileService from "~/server/file-service";

export const POST = withErrors(async (req: Request) => {
	const { path } = pathBody.parse(await req.json());
	const user = await requireUser();
	await fileService.remove(user, path);
	return Response.json({ ok: true });
});
