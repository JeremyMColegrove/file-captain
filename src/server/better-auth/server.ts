import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { findUser } from "~/server/config";
import { Forbidden, Unauthorized } from "~/server/errors";
import type { AppUser } from "~/server/file-service";
import { getAuth } from ".";
import { clientIp } from "./config";

export const getSession = cache(async () =>
	getAuth().api.getSession({ headers: await headers() }),
);

/**
 * Returns the signed-in user as defined in config.yaml, or throws
 * Unauthorized. A session for a user removed from the config is rejected.
 * Requests a browser marks as coming from another site (including sibling
 * subdomains, which SameSite cookies don't block) are rejected too.
 */
export async function requireUser(): Promise<AppUser> {
	const fetchSite = (await headers()).get("sec-fetch-site");
	if (fetchSite === "cross-site" || fetchSite === "same-site") {
		throw new Forbidden("Cross-site request");
	}
	const user = await currentUser();
	if (!user) throw new Unauthorized();
	return user;
}

/**
 * For server-rendered pages: the signed-in user, or a redirect to /sign-in.
 * Pages only read, so unlike requireUser, links from other sites are fine.
 */
export async function requirePageUser(): Promise<AppUser> {
	const user = await currentUser();
	if (!user) redirect("/sign-in");
	return user;
}

async function currentUser(): Promise<AppUser | null> {
	const session = await getSession();
	const configUser = session?.user.username
		? findUser(session.user.username)
		: undefined;
	if (!configUser) return null;
	return {
		username: configUser.username,
		readOnly: configUser.readOnly,
		ip: clientIp(await headers()),
	};
}
