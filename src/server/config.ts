import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const UNITS: Record<string, number> = {
	B: 1,
	KB: 1024,
	MB: 1024 ** 2,
	GB: 1024 ** 3,
	TB: 1024 ** 4,
};

/** Parses sizes like `10GB`, `200gb`, `512 MB` or a plain byte count. */
export function parseSize(value: string | number): number | null {
	if (typeof value === "number") {
		return Number.isFinite(value) && value >= 0 ? value : null;
	}
	const match = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?B)?\s*$/i.exec(value);
	if (!match?.[1]) return null;
	const unit = UNITS[(match[2] ?? "B").toUpperCase()];
	return unit ? Math.floor(Number(match[1]) * unit) : null;
}

const size = z.union([z.string(), z.number()]).transform((value, ctx) => {
	const bytes = parseSize(value);
	if (bytes === null) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `Invalid size "${value}" (use e.g. 500MB, 10GB, 1TB)`,
		});
		return z.NEVER;
	}
	return bytes;
});

const absolutePath = z
	.string()
	.min(1)
	.refine((p) => path.isAbsolute(p), "Must be an absolute path");

// Users sign in with their email address. Better Auth is configured to accept
// the same (see better-auth/config.ts).
export const username = z
	.string()
	.email("Must be an email address")
	.max(254, "Must be an email address");
// Folder names appear in URLs, so keep them plain too.
const folderName = z
	.string()
	.regex(
		/^[a-z0-9_-][a-z0-9 _.-]{0,63}$/i,
		"Use letters, digits, spaces, _ . - (max 64 chars, no leading dot)",
	);

// Optional so a folder can have only readOnlyUsers (validated below).
const folderUsers = z.union([z.literal("all"), z.array(username)]).default([]);

export const configSchema = z
	.object({
		server: z.object({
			cacheDir: absolutePath,
			auditLog: absolutePath,
			maxUploadSize: size,
			// How often to rescan folders for changes made outside the app
			// (e.g. over SMB). Unchanged directories are skipped. 0 turns it off.
			indexIntervalMinutes: z.number().int().min(0).default(15),
			// How many thumbnails to generate at once. Each reads the whole
			// image, so lower is gentler on spinning disks. 0 turns them off.
			thumbnailConcurrency: z.number().int().min(0).default(3),
		}),
		users: z
			.array(
				z.object({
					username,
					// The login page may be public; rate limiting is only per IP.
					// Any characters; the max is Better Auth's maxPasswordLength.
					password: z
						.string()
						.min(12, "Use at least 12 characters")
						.max(128, "Use at most 128 characters"),
					readOnly: z.boolean().default(false),
				}),
			)
			.min(1, "At least one user is required"),
		folders: z
			.array(
				z.object({
					name: folderName,
					path: absolutePath,
					// Read-write users; readOnlyUsers can list, download and preview.
					users: folderUsers,
					readOnlyUsers: folderUsers,
					storageLimit: size.optional(),
					readOnly: z.boolean().default(false),
				}),
			)
			.min(1, "At least one folder is required"),
	})
	.superRefine((config, ctx) => {
		const usernames = new Set<string>();
		config.users.forEach((user, i) => {
			const key = user.username.toLowerCase();
			if (usernames.has(key)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["users", i, "username"],
					message: `Duplicate username "${user.username}"`,
				});
			}
			usernames.add(key);
		});

		const names = new Set<string>();
		config.folders.forEach((folder, i) => {
			const key = folder.name.toLowerCase();
			if (names.has(key)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["folders", i, "name"],
					message: `Duplicate folder name "${folder.name}"`,
				});
			}
			names.add(key);

			if (folder.users.length === 0 && folder.readOnlyUsers.length === 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["folders", i, "users"],
					message: "Set users and/or readOnlyUsers",
				});
			}
			for (const key of ["users", "readOnlyUsers"] as const) {
				const list = folder[key];
				if (list === "all") continue;
				for (const name of list) {
					if (!usernames.has(name.toLowerCase())) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: ["folders", i, key],
							message: `Unknown user "${name}"`,
						});
					}
				}
			}
		});
	});

export type Config = z.infer<typeof configSchema>;
export type UserConfig = Config["users"][number];
export type FolderConfig = Config["folders"][number];

/** Parses and validates YAML text. Throws an Error listing every problem. */
export function parseConfig(yamlText: string): Config {
	let raw: unknown;
	try {
		raw = parseYaml(yamlText);
	} catch (err) {
		throw new Error(`config.yaml is not valid YAML: ${(err as Error).message}`);
	}
	const result = configSchema.safeParse(raw);
	if (!result.success) {
		const problems = result.error.issues
			.map(
				(issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
			)
			.join("\n");
		throw new Error(`config.yaml is invalid:\n${problems}`);
	}
	return result.data;
}

export const configPath = () =>
	process.env.CONFIG_PATH ?? "/config/config.yaml";

let cached: Config | undefined;

/** Loads config.yaml once (from CONFIG_PATH) and returns the cached result. */
export function getConfig(): Config {
	if (!cached) {
		const file = configPath();
		let text: string;
		try {
			// Runtime path from CONFIG_PATH; keeps Next from tracing the whole project.
			text = readFileSync(/* turbopackIgnore: true */ file, "utf8");
		} catch {
			throw new Error(
				`Could not read config file at ${file} (set CONFIG_PATH)`,
			);
		}
		cached = parseConfig(text);
	}
	return cached;
}

export function findUser(name: string): UserConfig | undefined {
	const key = name.toLowerCase();
	return getConfig().users.find((u) => u.username.toLowerCase() === key);
}
