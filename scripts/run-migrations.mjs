import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
	const connectionString = process.env.DATABASE_URL;

	if (!connectionString) {
		throw new Error("DATABASE_URL is required to run database migrations.");
	}

	const conn = postgres(connectionString, { max: 1 });
	const db = drizzle(conn);

	try {
		const migrationsFolder = resolve(process.cwd(), "drizzle");
		await migrate(db, { migrationsFolder });
		console.log(`Applied migrations from ${migrationsFolder}.`);
	} finally {
		await conn.end();
	}
}

main().catch((error) => {
	console.error("Failed to run database migrations.");
	console.error(error);
	process.exit(1);
});
