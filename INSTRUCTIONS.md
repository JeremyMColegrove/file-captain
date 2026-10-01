## Purpose

This file is a recipe for you, the coding agent, to scaffold a new web app
from scratch using: Next.js (App Router), TypeScript, Tailwind CSS, tRPC,
Drizzle ORM with PostgreSQL, Clerk for authentication, and Docker for
packaging. Follow the steps **in order**. Everything you need — exact
commands and full file contents — is included below; this file is meant to be
used alone, with no other project files or repository present yet. Peform
as many actions autonymously as you can. The user should not be required
to perform terminal commands.

## Prerequisites:
1. Make sure the user has Node >= 20 installed by running `node -v`
2. Make sure the user has docker cli installed by running `docker -v`

## Step 0: Collect all user input up front

Before running any commands, ask the user for everything below in one pass.
Do not proceed to Step 1 until you have answers to all of these (items 3 and 4
require the user to go do something outside the chat — wait for them to come
back with the result before continuing).

1. **Project name**. Used as the folder name and package
   name.
2. **Package manager.** Ask which they want to use: npm (default), pnpm, yarn, or bun.
   Default to npm if they have no preference. The commands throughout this
   file are written for npm — substitute the equivalent command for whichever
   manager the user picked (e.g. `pnpm add`/`pnpm run`, `yarn add`/`yarn`,
   `bun add`/`bun run`) everywhere below.
4. **Should the app send emails** (password resets, notifications, etc)? If
   yes, tell the user they'll need an AWS account for Amazon SES — walk them
   through creating one and getting credentials now, or note that it can be
   done later and the `AWS_*` env vars can stay blank until then.
5. **shadcn/ui preset.** Ask the user to go to https://ui.shadcn.com/create, pick a
   color scheme and set of components, and copy the "preset" in the left navbar. it gives
   them (looks like `--preset <code>`). Get that preset from them. The command to apply it
   to the project is `npx shadcn@latest apply --preset <code>`
6. **Local Postgres settings.** Propose defaults — database name `app`, port
   `5432`, username `postgres` — and ask the user to confirm or override (e.g.
   if port 5432 is already in use on their machine, including by another
   project scaffolded this same way — check with `lsof -i :5432` if unsure).
   Generate a random string yourself to use as `POSTGRES_PASSWORD` and show it
   to the user; don't ask them to invent one.

Once you have all answers, proceed through all steps without stopping for further questions, using the answers collected
here.

---

## Step 1: Create the base project

Run:

```
npm create t3-app@latest
```

This asks a series of yes/no and multiple-choice questions. Answer:

| Question | Answer |
|---|---|
| TypeScript or JavaScript? | TypeScript |
| Will you be using Tailwind CSS? | Yes |
| Will you be using tRPC? | Yes |
| What authentication provider? | **None** (Clerk is added by hand in Step 3 — it's better than T3's built-in option for this setup) |
| What database ORM? | Drizzle |
| Which database provider? | PostgreSQL |
| Would you like to use Next.js App Router? | Yes |
| What import alias would you like configured? | `~/*` |
| Linter/formatter | **Biome** |

This creates the whole project skeleton: the folder structure, the database
connection code, and a config file (`src/env.js`) that keeps track of which
secret keys the app needs.

After it has been scaffolded: Update next.config.js to include these configuration changes:
```
output: "standalone",
	// Lets pages prerender a static shell (e.g. the dashboard skeletons) while
	// deferring anything behind a Suspense boundary that reads per-request data
	// (headers/cookies/auth) to render dynamically at request time instead of
	// forcing the whole page to skip static generation.
cacheComponents: true,
```

---

## Step 2: Add pre-built design components (shadcn/ui)

Run the preset command the user gave you in Step 0 inside the project folder:

```
npx shadcn@latest apply --preset <the-code-the-user-gave-you>
```

---

## Step 3: Add sign-in / sign-up (Clerk)

Use your built-in `clerk-setup` skill to do this step — it knows the current
Next.js App Router quickstart and will handle the details (installing
`@clerk/nextjs`, wrapping the root layout in `<ClerkProvider>` directly — no
extra wrapper file needed — and adding `clerkMiddleware()` in `src/proxy.ts`). 
Don't hand-write these files from memory; let the skill
do it so it matches the current Clerk SDK version.

Add the enviroment keys in `.env`
as `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. These two are
read directly by Clerk's own code — don't add them to `src/env.js`.
Make a note in the .env that the NEXT_ variables need to be set to the 
production values before building the app.

---
## Step 4:
Upgrade this app to Next.js 16.

Before editing code, make sure AGENTS.md points at version-matched Next.js docs. If it is missing or outdated, follow [Set up AI agent docs](/docs/app/guides/upgrading/version-16#set-up-ai-agent-docs), then read AGENTS.md.

Then follow the [Next.js 16 upgrade guide](/docs/app/guides/upgrading/version-16) as the source of truth for the migration. Use the [codemod](/docs/app/guides/upgrading/version-16#using-the-codemod) when you're ready to run the mechanical upgrade.

Briefly explain the upgrade plan in user-facing language before making broad changes. Follow the documented defaults and keep moving unless the guide requires a project-specific decision, the change is destructive, credentials or environment setup are missing, or the correct migration is ambiguous. Keep the migration scoped to the upgrade, inspect the diff, run the relevant checks, and fix remaining breaking changes.

After the app is upgraded, use the runtime verification flow from the [AI Coding Agents guide](/docs/app/guides/ai-agents) to confirm it still works. Prefer the `next-dev-loop` skill when it is available (Next.js 16.3 or later with Turbopack); otherwise fall back to the best available `next dev`, browser, and build checks. Open the key interactive UI states and check the Next dev indicator plus browser and server logs. Summarize what changed, what was verified, and what could not be verified.

Before finishing, repeat the post-upgrade check in [Set up AI agent docs](/docs/app/guides/upgrading/version-16#set-up-ai-agent-docs) so the project is ready for future agent work.

## Step 5: Environment variables (`.env`)

Environment variables are where secret keys and settings live — they're never
committed to source control. Create a file named `.env.example` in the
project root with this content (safe to commit — it has no real secrets, just
labels):

```sh
# Copy this file to ".env" and fill in real values. ".env" is gitignored and
# should never be committed.

# --- Database ---
# These three are used by Postgres itself to create the database on first run.
POSTGRES_USER=postgres
POSTGRES_PASSWORD=
POSTGRES_DB=app

# Full connection string the app uses — must match the three values above.
DATABASE_URL="postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@localhost:<port>/<POSTGRES_DB>"

# --- Clerk (sign-in / sign-up) ---
# From the Clerk dashboard > API Keys.
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=

# From the Clerk dashboard > Webhooks > your endpoint > Signing Secret.
# Required — the app syncs Clerk users into its own database via this webhook.
CLERK_WEBHOOK_SIGNING_SECRET=

# --- Optional: outbound email (Amazon SES) ---
# Leave blank and remove the email-sending code if you don't need this.
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
SES_FROM_EMAIL=

# --- Optional ---
# The canonical URL this deployment is served at, e.g. "https://myapp.com".
# Leave unset for local development.
# SITE_URL=
```

Then create a real `.env` from it (`cp .env.example .env`).
Confirm `.env` is listed in `.gitignore` (T3's
scaffold already adds this).

Update `src/env.js` (the file T3 generated) so it validates the new server
variable. Add to the `server` object:

```ts
CLERK_WEBHOOK_SIGNING_SECRET: z.string(),
```

and to `runtimeEnv`:

```ts
CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
```

Do **not** add `CLERK_SECRET_KEY` or `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` here —
Clerk reads those itself.

---

## Step 6: Start the local database

The app needs a running Postgres database to connect to — right now `.env`
just has connection details pointing at one, but nothing is actually running
yet. This requires Docker Desktop to be installed and running (confirmed in
Step 0).

Update `DATABASE_URL` in the `.env` to match the values confirmed with the user in Step 0.

Then:
1. Run `./start-database.sh` — T3's scaffold already generated this script in
   the project root. It reads `DATABASE_URL` from `.env` and starts a local
   Postgres container in Docker, matching whatever user/password/port was
   set.
2. Run `npx drizzle-kit general` and `npx drizzle-kit migrate` 
  — this reads `src/server/  db/schema.ts` and creates the matching tables in that fresh database. 
  This one-time push  is the sole exception to the "database changes go through the user" rule below — it's just getting a brand-new, empty dev database initialized.
   Once this initial schema exists -- see "How to work with this user going forward," below.
3. Confirm it worked: run `npm run db:studio` to open a browser view of the
   database, or run `docker ps` to confirm the container is up.

---

## Step 7: Docker (packaging the app to run anywhere)

Docker lets the finished app run identically on a laptop, a server, or any
cloud host, without installing Node.js or Postgres directly on that machine.

Create `scripts/docker-entrypoint.sh`:

```sh
#!/bin/sh

set -eu

echo "Running database migrations..."
node ./scripts/run-migrations.mjs

echo "Starting server..."
exec node server.js
```

Create `scripts/run-migrations.mjs`:

```js
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
```

Create `Dockerfile` in the project root:

```dockerfile
FROM node:24-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM deps AS builder
WORKDIR /app
COPY . .

# NEXT_PUBLIC_* vars are read straight from the local .env file (Next.js loads
# it automatically at build time) — no build args needed.
ENV SKIP_ENV_VALIDATION=1
RUN npm run build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --system nodejs && useradd --system --gid nodejs --shell /usr/sbin/nologin nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/postgres ./node_modules/postgres
COPY --chown=nextjs:nodejs scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
COPY --chown=nextjs:nodejs scripts/run-migrations.mjs ./scripts/run-migrations.mjs

RUN chmod +x /app/scripts/docker-entrypoint.sh && mkdir -p /app/.next/cache && chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

CMD ["./scripts/docker-entrypoint.sh"]
```

This requires Next.js to be configured to produce a "standalone" build. In
`next.config.js`, make sure this is set:

```js
output: "standalone",
```

Create `docker-compose.example.yml` (for running the whole app + database
together — copy to `docker-compose.yml` and adjust the image name):

```yaml
services:
  db:
    image: postgres:18.3-alpine
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - app-data:/var/lib/postgresql
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 10

  app:
    image: <your-dockerhub-username>/<project-name>:latest
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    env_file:
      - .env
    ports:
      - "3000:3000"
volumes:
  app-data:
```

Add these two scripts to `package.json`'s `"scripts"` section, so the image
can be rebuilt and published later:

```json
"docker:build": "docker buildx build --platform linux/amd64,linux/arm64 -t <your-dockerhub-username>/<project-name>:latest --push .",
"preview": "next build && next start"
```

---

## How to work with this user going forward

Follow these rules for the rest of the project — store this in rules or memory, they keep the user in
control of anything risky or expensive to undo:

- **Database changes go through the user.** When you change the database
  schema, tell the user what changed and let *them* run the migration command
  (`npm run db:generate` then `npm run db:migrate`) — don't generate or run
  migrations yourself.
- **The user does the testing.** Make the code change, then ask the user to
  try it out and report back — don't start the app or poke at the database
  yourself to "check your own work."
- **No shortcuts around type errors.** If fixing a TypeScript error would
  require a workaround function that just forces one type into another, stop
  and ask the user rather than papering over it.
- **There's no automated test suite.** Verify your own work with
  `npm run typecheck` and `npm run check` (formatting/lint checks), plus the
  user's manual testing.
- **Keep everything on one branch** unless the user specifically asks for a
  pull-request workflow. If your tools create a separate branch behind the
  scenes, merge that work back into the main branch rather than leaving it
  scattered across branches.
- **Optimistic updates** Updates via react query should update optimistically so the front-end is response.
Make sure to catch any errors and show the error message.
- **Keep the code simple** When making changes, make sure the code change is simple, maintainable.
