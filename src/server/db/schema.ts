import { relations } from "drizzle-orm";
import {
	bigint,
	boolean,
	doublePrecision,
	index,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

/**
 * Disk usage per configured folder, for storageLimit. Measured with `du` at
 * startup and adjusted by file-service after each change. A cache only: the
 * filesystem stays authoritative.
 */
export const folderUsage = pgTable("folder_usage", {
	folder: text("folder").primaryKey(),
	bytes: bigint("bytes", { mode: "number" }).notNull(),
	updatedAt: timestamp("updated_at").notNull(),
});

/**
 * Every file and directory in the configured folders, for search. `path` is
 * relative to the folder root (`/photos/a.jpg`; the root itself is `/`). A
 * cache only: file-service keeps it in step with its own changes, and at
 * startup re-reads each directory whose mtime differs from `mtimeMs`.
 */
export const fileIndex = pgTable(
	"file_index",
	{
		folder: text("folder").notNull(),
		path: text("path").notNull(),
		parent: text("parent").notNull(),
		name: text("name").notNull(),
		isDir: boolean("is_dir").notNull(),
		size: bigint("size", { mode: "number" }).notNull(),
		mtimeMs: doublePrecision("mtime_ms").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.folder, t.path] }),
		index("file_index_parent_idx").on(t.folder, t.parent),
	],
);

export const user = pgTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified")
		.$defaultFn(() => false)
		.notNull(),
	image: text("image"),
	username: text("username").unique(),
	displayUsername: text("display_username"),
	createdAt: timestamp("created_at")
		.$defaultFn(() => /* @__PURE__ */ new Date())
		.notNull(),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => /* @__PURE__ */ new Date())
		.notNull(),
});

export const session = pgTable("session", {
	id: text("id").primaryKey(),
	expiresAt: timestamp("expires_at").notNull(),
	token: text("token").notNull().unique(),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
	id: text("id").primaryKey(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at"),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
	scope: text("scope"),
	password: text("password"),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
	id: text("id").primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at").$defaultFn(
		() => /* @__PURE__ */ new Date(),
	),
	updatedAt: timestamp("updated_at").$defaultFn(
		() => /* @__PURE__ */ new Date(),
	),
});

export const userRelations = relations(user, ({ many }) => ({
	account: many(account),
	session: many(session),
}));

export const accountRelations = relations(account, ({ one }) => ({
	user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
	user: one(user, { fields: [session.userId], references: [user.id] }),
}));
