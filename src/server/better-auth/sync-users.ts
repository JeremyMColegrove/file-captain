import { eq } from "drizzle-orm";

import { getConfig } from "~/server/config";
import { db } from "~/server/db";
import { session, user } from "~/server/db/schema";
import { getAuth } from ".";

const placeholderEmail = (username: string) =>
	`${username}@users.file-captain.invalid`;

/**
 * Makes the Better Auth user table match config.yaml: creates missing users,
 * updates changed passwords (signing that user out everywhere), and deletes
 * users that are no longer configured.
 */
export async function syncUsers() {
	const ctx = await getAuth().$context;
	const configured = new Map(
		getConfig().users.map((u) => [u.username.toLowerCase(), u]),
	);
	const existing = await db
		.select({ id: user.id, username: user.username })
		.from(user);

	for (const row of existing) {
		if (!row.username || !configured.has(row.username)) {
			await ctx.internalAdapter.deleteUser(row.id);
			console.log(`Removed user "${row.username ?? row.id}" (not in config)`);
		}
	}

	for (const [name, configUser] of configured) {
		const row = existing.find((r) => r.username === name);
		if (!row) {
			const created = await ctx.internalAdapter.createUser(
				{
					name: configUser.username,
					email: placeholderEmail(name),
					emailVerified: true,
					username: name,
					displayUsername: configUser.username,
				},
				{ method: "config" },
			);
			await ctx.internalAdapter.linkAccount({
				userId: created.id,
				providerId: "credential",
				accountId: created.id,
				password: await ctx.password.hash(configUser.password),
			});
			console.log(`Created user "${configUser.username}"`);
			continue;
		}

		const account = await ctx.internalAdapter.findCredentialAccount(row.id);
		const unchanged =
			account?.password &&
			(await ctx.password.verify({
				hash: account.password,
				password: configUser.password,
			}));
		if (unchanged) continue;

		const hash = await ctx.password.hash(configUser.password);
		if (account) {
			await ctx.internalAdapter.updatePassword(row.id, hash);
		} else {
			await ctx.internalAdapter.linkAccount({
				userId: row.id,
				providerId: "credential",
				accountId: row.id,
				password: hash,
			});
		}
		await db.delete(session).where(eq(session.userId, row.id));
		console.log(`Updated password for "${configUser.username}"`);
	}
}
