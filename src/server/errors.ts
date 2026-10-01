import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

export class AppError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export class BadRequest extends AppError {
	constructor(message = "Bad request") {
		super(400, "BAD_REQUEST", message);
	}
}

export class Unauthorized extends AppError {
	constructor(message = "Not signed in") {
		super(401, "UNAUTHORIZED", message);
	}
}

export class Forbidden extends AppError {
	constructor(message = "Not allowed") {
		super(403, "FORBIDDEN", message);
	}
}

export class NotFound extends AppError {
	constructor(message = "Not found") {
		super(404, "NOT_FOUND", message);
	}
}

export class Conflict extends AppError {
	constructor(message = "Already exists") {
		super(409, "CONFLICT", message);
	}
}

/**
 * Maps any thrown value to a typed AppError. Filesystem errors carry host
 * paths in their message, so they are replaced with a generic one.
 */
export function toAppError(err: unknown): AppError {
	if (err instanceof AppError) return err;
	if (err instanceof SyntaxError) return new BadRequest("Invalid JSON body");
	if (err instanceof ZodError) {
		return new BadRequest(err.issues[0]?.message ?? "Invalid input");
	}
	switch ((err as NodeJS.ErrnoException)?.code) {
		case "ENOENT":
			return new NotFound();
		case "EEXIST":
		case "ENOTEMPTY":
			return new Conflict();
		case "EACCES":
		case "EPERM":
		case "EROFS":
			return new Forbidden("Permission denied on the server");
		case "ENOTDIR":
		case "EISDIR":
		case "ENAMETOOLONG":
		case "EINVAL":
			return new BadRequest();
	}
	return new AppError(500, "INTERNAL", "Internal server error");
}

export function errorResponse(err: unknown): Response {
	const appError = toAppError(err);
	if (appError.status >= 500) console.error(err);
	return Response.json(
		{ error: { code: appError.code, message: appError.message } },
		{ status: appError.status },
	);
}

/** Wraps a route handler so every thrown error becomes a JSON error response. */
export function withErrors<A extends unknown[]>(
	handler: (...args: A) => Promise<Response>,
) {
	return async (...args: A): Promise<Response> => {
		try {
			return await handler(...args);
		} catch (err) {
			// Next.js control flow (redirects, dynamic bailouts) must propagate.
			unstable_rethrow(err);
			return errorResponse(err);
		}
	};
}
