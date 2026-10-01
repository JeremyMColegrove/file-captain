import { syncUsers } from "./better-auth/sync-users";
import { configPath, getConfig } from "./config";
import { indexFiles, initStorage } from "./file-service";
import { cleanStaleUploads } from "./uploads";

/** Runs once when the server starts. Exits the process if anything is wrong. */
export async function startup() {
	try {
		const config = getConfig();
		await initStorage();
		await syncUsers();
		await cleanStaleUploads();
		// In the background: big folders take a while. Search covers what's
		// indexed so far, and storage limits use the last measured usage until
		// the sync finishes and re-measures it.
		indexFiles().catch((err) => console.error("Indexing files failed", err));
		setInterval(
			() => {
				cleanStaleUploads().catch((err) => console.error(err));
			},
			60 * 60 * 1000,
		).unref();
		const { indexIntervalMinutes } = config.server;
		if (indexIntervalMinutes > 0) {
			setInterval(
				() => {
					indexFiles().catch((err) =>
						console.error("Indexing files failed", err),
					);
				},
				indexIntervalMinutes * 60 * 1000,
			).unref();
		}
		console.log(
			`Loaded ${configPath()}: ${config.users.length} user(s), ${config.folders.length} folder(s)`,
		);
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	}
}
