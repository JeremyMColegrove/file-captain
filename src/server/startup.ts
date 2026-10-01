import { syncUsers } from "./better-auth/sync-users";
import { configPath, getConfig } from "./config";
import { indexFiles, initStorage, measureUsage } from "./file-service";
import { cleanStaleUploads } from "./uploads";

/** Runs once when the server starts. Exits the process if anything is wrong. */
export async function startup() {
	try {
		const config = getConfig();
		await initStorage();
		await syncUsers();
		await cleanStaleUploads();
		// In the background: big folders take a while, and the last measured
		// value in the database is used until this finishes.
		measureUsage().catch((err) => console.error("Measuring usage failed", err));
		// Also in the background; search covers what's indexed so far.
		indexFiles().catch((err) => console.error("Indexing files failed", err));
		setInterval(
			() => {
				cleanStaleUploads().catch((err) => console.error(err));
			},
			60 * 60 * 1000,
		).unref();
		console.log(
			`Loaded ${configPath()}: ${config.users.length} user(s), ${config.folders.length} folder(s)`,
		);
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	}
}
