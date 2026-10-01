import { headers } from "next/headers";
import { cache } from "react";

import { findUser } from "~/server/config";
import { Unauthorized } from "~/server/errors";
import type { AppUser } from "~/server/file-service";
import { getAuth } from ".";
import { clientIp } from "./config";

export const getSession = cache(async () =>
	getAuth().api.getSession({ headers: await headers() }),
);

/**
 * Returns the signed-in user as defined in config.yaml, or throws
 * Unauthorized. A session for a user removed from the config is rejected.
 */
export async function requireUser(): Promise<AppUser> {
	const session = await getSession();
	const configUser = session?.user.username
		? findUser(session.user.username)
		: undefined;
	if (!configUser) throw new Unauthorized();
	return {
		username: configUser.username,
		readOnly: configUser.readOnly,
		ip: clientIp(await headers()),
	};
}
