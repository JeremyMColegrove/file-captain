@AGENTS.md

# File Captain

Next.js 16 (App Router, Cache Components) + TypeScript + Tailwind + shadcn/ui,
tRPC, Drizzle ORM on PostgreSQL, Better Auth (username + password only), Biome,
Docker. Package manager: npm.

## How to work with this user

- **Database changes go through the user.** When you change the schema
  (`src/server/db/schema.ts`), tell the user what changed and let *them* run
  `npm run db:generate` then `npm run db:migrate`. Don't generate or run
  migrations yourself.
- **The user does the testing.** Make the change, then ask the user to try it
  and report back. Don't start the app or poke at the database to check your
  own work.
- **No shortcuts around type errors.** If fixing a TypeScript error would need
  a workaround that just forces one type into another, stop and ask the user.
- **No automated test suite.** Verify with `npm run typecheck` and
  `npm run check` (Biome), plus the user's manual testing.
- **Keep everything on one branch** (`main`) unless the user asks for a PR
  workflow. If tooling creates a separate branch, merge it back.
- **Optimistic updates.** React Query mutations update the cache
  optimistically, roll back on error, and show the error message
  (see `src/app/_components/post.tsx`).
- **Keep the code simple** and maintainable.

## Project notes

- Auth: Better Auth requires an email per account, so sign-up uses a
  placeholder from `usernameToEmail` in `src/server/better-auth/client.ts`.
  Users only ever see username + password.
- With `cacheComponents`, anything reading request data (session, headers,
  cookies) must be inside a `<Suspense>` boundary (see `src/app/page.tsx`).
- Client components must use `import type` for server types (e.g. `AppRouter`);
  an inline `import { type X }` keeps the module import and pulls server code
  into the browser bundle.
