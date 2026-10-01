import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	plugins: [usernameClient()],
});

export type Session = typeof authClient.$Infer.Session;

/**
 * Better Auth requires an email on every account. This app only supports
 * username + password, so each account gets a unique placeholder address
 * that is never shown to the user or used to send mail.
 */
export const usernameToEmail = (username: string) =>
	`${username.toLowerCase()}@users.file-captain.invalid`;
