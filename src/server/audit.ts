import { appendFile } from "node:fs/promises";

import { getConfig } from "./config";

export type AuditAction =
	| "login"
	| "login_failed"
	| "logout"
	| "upload"
	| "mkdir"
	| "rename"
	| "move"
	| "copy"
	| "delete";

export type AuditEntry = {
	user: string;
	action: AuditAction;
	/** Virtual paths only, never host paths. */
	src?: string;
	dst?: string;
	result: "ok" | "error";
	ip: string;
};

/** Appends one JSONL line to the audit log. Never throws. */
export async function writeAudit(entry: AuditEntry) {
	const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
	try {
		await appendFile(getConfig().server.auditLog, `${line}\n`, "utf8");
	} catch (err) {
		console.error("Failed to write audit log entry", line, err);
	}
}
