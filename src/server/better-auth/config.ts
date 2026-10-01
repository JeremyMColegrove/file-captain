import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
} from "better-auth/api";
import { username } from "better-auth/plugins";

import { env } from "~/env";
import { writeAudit } from "~/server/audit";
import { db } from "~/server/db";

/** Best-effort client IP for the audit log. */
export function clientIp(headers: Headers | undefined) {
	const forwarded = headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
	return forwarded || headers?.get("x-real-ip") || "unknown";
}

function createAuth() {
	return betterAuth({
		secret: env.BETTER_AUTH_SECRET,
		database: drizzleAdapter(db, {
			provider: "pg",
		}),
		// Users come from config.yaml (see sync-users.ts); nobody signs up.
		// Username login is built on email/password, so each user gets a
		// placeholder email that is never shown or used.
		emailAndPassword: {
			enabled: true,
			disableSignUp: true,
			minPasswordLength: 1,
		},
		plugins: [username()],
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path !== "/sign-out") return;
				const session = await getSessionFromCtx(ctx).catch(() => null);
				if (!session) return;
				await writeAudit({
					user: session.user.username ?? session.user.name,
					action: "logout",
					result: "ok",
					ip: clientIp(ctx.headers),
				});
			}),
			after: createAuthMiddleware(async (ctx) => {
				if (ctx.path !== "/sign-in/username") return;
				const failed = ctx.context.returned instanceof APIError;
				const body = ctx.body as { username?: unknown } | undefined;
				await writeAudit({
					user: typeof body?.username === "string" ? body.username : "",
					action: failed ? "login_failed" : "login",
					result: failed ? "error" : "ok",
					ip: clientIp(ctx.headers),
				});
			}),
		},
	});
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];

let auth: Auth | undefined;

/** Created lazily so `next build` doesn't need config.yaml. */
export function getAuth(): Auth {
	auth ??= createAuth();
	return auth;
}

// Only the endpoints this app uses are reachable. Everything else Better Auth
// ships (change password, update user, delete user, ...) is out of scope.
const ALLOWED_PATHS = new Set([
	"/api/auth/sign-in/username",
	"/api/auth/sign-out",
	"/api/auth/get-session",
]);

export function authHandler(request: Request) {
	if (!ALLOWED_PATHS.has(new URL(request.url).pathname)) {
		return Response.json(
			{ error: { code: "NOT_FOUND", message: "Not found" } },
			{ status: 404 },
		);
	}
	return getAuth().handler(request);
}
