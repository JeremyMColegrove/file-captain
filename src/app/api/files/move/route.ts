import { srcDstBody } from "~/lib/schemas";
import { requireUser } from "~/server/better-auth/server";
import { withErrors } from "~/server/errors";
import * as fileService from "~/server/file-service";

export const POST = withErrors(async (req: Request) => {
	const { src, dst } = srcDstBody.parse(await req.json());
	const user = await requireUser();
	await fileService.move(user, src, dst);
	return Response.json({ ok: true });
});
