import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins";

import { db } from "~/server/db";

export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
	}),
	// Username login is built on top of email/password. Users never see an
	// email — the sign-up form fills in a placeholder (see `usernameToEmail`).
	emailAndPassword: {
		enabled: true,
	},
	plugins: [username()],
});

export type Session = typeof auth.$Infer.Session;
