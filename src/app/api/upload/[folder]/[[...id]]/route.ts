import { requireUser } from "~/server/better-auth/server";
import { withErrors } from "~/server/errors";
import { handleUpload } from "~/server/uploads";

// tus validates its own headers and Upload-Metadata (see uploads.ts). GET is
// deliberately not exported: tus would serve staged uploads by id.
const handler = withErrors(async (req: Request) => {
	const user = await requireUser();
	return handleUpload(user, req);
});

export {
	handler as DELETE,
	handler as HEAD,
	handler as OPTIONS,
	handler as PATCH,
	handler as POST,
};
