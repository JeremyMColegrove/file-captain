import { zipForm } from "~/lib/schemas";
import { requireUser } from "~/server/better-auth/server";
import { BadRequest, withErrors } from "~/server/errors";
import * as fileService from "~/server/file-service";

// A form POST rather than a GET: the browser then handles the response as a
// normal (streamed) download, and long selections don't hit URL length limits.
export const POST = withErrors(async (req: Request) => {
	const form = await req.formData().catch(() => {
		throw new BadRequest("Expected form data");
	});
	const { dir, names } = zipForm.parse({
		dir: form.get("dir"),
		names: form.getAll("name"),
	});
	const user = await requireUser();
	const zip = await fileService.openZip(user, dir, names);
	return new Response(zip.stream, {
		headers: {
			"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(zip.name)}`,
			"Content-Type": "application/zip",
		},
	});
});
