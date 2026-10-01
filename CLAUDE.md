# Project: Simple Multi-User File Manager

You are working on an existing, deliberately simple browser-based file manager, similar in spirit to FileBrowser. The architecture is already built and settled. Your job is to implement features, fix bugs, and refactor *within* this architecture. Do not redesign it, introduce new layers, or add dependencies without asking first.

## Guiding principle: simplicity is the feature

This project is intentionally small. Before adding anything, ask whether it is required by the scope below. If a change adds complexity without serving an in-scope feature, don't make it. Prefer boring, readable code over clever abstractions. The target is a codebase one person can fully understand, comfortably under ~5k lines.

## Scope

In scope:
- Multiple users, each confined to the folders configured for them (shared or per-user)
- Browse (list), download, upload, mkdir, rename, move, copy, delete
- Image thumbnails
- Chunked, resumable uploads
- An append-only audit log of every mutating action
- All configuration from config.yaml

Explicitly out of scope (do not implement, scaffold, or "prepare for"):
- Share links, public access, or guest users
- Video thumbnails or media transcoding
- User self-registration, password changes in the UI, or an admin panel
- OAuth/OIDC/LDAP
- A public or versioned API for third-party clients

## Stack

- zod for all validation (config, request bodies, query params)
- Database: PostgreSQL via Drizzle ORM. Used by Better Auth for users and sessions; may later be used for performance caching when explicitly requested. Schema changes go through the user (they run `npm run db:generate` / `db:migrate`).
- Auth: Better Auth (username + password, `username` plugin). Users are defined only in config.yaml and synced into the DB at startup (created, password updated, removed users deleted). Sign-up is disabled; no user creation via UI is possible.
- Uploads: tus protocol, with `@tus/server` on the backend and Uppy on the frontend
- Thumbnails: sharp, generated on demand and cached on disk
- Styling: Tailwind CSS
- Tests: Vitest
- Deployment: a single Docker image (multi-stage build) with PUID/PGID support

## Layering rules (strict)

1. **Route handlers are thin.** Each one does exactly this:
   - Parse and validate input with a schema from `lib/schemas.ts`
   - Call `requireUser()`
   - Call one `file-service` method
   - Return JSON or a stream
   No filesystem calls and no business logic belong in routes.
2. **`file-service.ts` is the only code that reads or writes user files.** Every method:
   - Takes the authenticated user as its first argument
   - Resolves all paths through `safe-path.ts`
   - Performs the operation
   - Writes an audit entry
3. **`safe-path.ts` is security-critical.**
   - All client-supplied paths are *virtual* paths whose first segment is a folder name from config (e.g. `/shared/photos/2024`). `/` is a virtual listing of the folders the user can access.
   - Look up the folder by name, reject it if the user has no access, then resolve the rest with `path.resolve(folderRoot, "." + rest)` and reject anything that is not equal to or inside `folderRoot`.
   - Reject null bytes. Never trust a path the client sends, even though users have no shell access, because requests can be crafted by hand.
   - Every change to this file must keep its tests passing and add tests for new cases.
4. **Audit logging happens in the service layer, never in routes.** This means no operation can skip it.
5. **Client components never import from `src/server/`.**

## Config (config.yaml)

The config is loaded once at startup, validated with zod, and the process fails fast with a clear error if it is invalid. Its location comes from the `CONFIG_PATH` env var (default `/config/config.yaml`). Secrets stay in the environment, not config.yaml: `BETTER_AUTH_SECRET` (32+ chars, signs sessions) and `DATABASE_URL` (shared with the Postgres container). The shape is:

```yaml
server:
  cacheDir: /data/.cache               # thumbnails
  auditLog: /data/audit.jsonl
  maxUploadSize: 10GB

users:
  - username: jeremy
    password: "plaintext"              # plaintext is intentional: config readers already have file access
    readOnly: false                    # optional, default false
  - username: guest
    password: "..."
    readOnly: true

folders:
  - name: shared                       # shown as /shared
    path: /mnt/media/shared/global
    users: all                         # every user
    storageLimit: 1000GB               # optional
  - name: jeremy
    path: /mnt/media/shared/jeremy
    users: [jeremy]                    # one or more usernames
    storageLimit: 200GB
    readOnly: false                    # optional, per-folder
```

Additional rules:
- Usernames and folder names are unique. Every username listed under a folder must exist in `users`.
- If a folder's directory does not exist, create it at startup.
- `storageLimit`: each limited folder's usage is measured with `du -sk` at startup (in the background) and cached in the `folder_usage` table. file-service adjusts it after upload, copy, move and delete, and rejects writes that would exceed the limit. Only per-folder totals are stored.
- A write is allowed only if neither the user nor the folder is `readOnly`. Read-only users/folders allow list, download, and thumbnails only. Enforce this in `file-service`, not in the UI alone.

## Uploads

- Uploads are staged in a hidden `.file-captain-uploads` directory at the target folder's root (same disk as the destination; the cache disk may be too small). safe-path rejects that name and listings hide it. Each folder has its own tus endpoint at `/api/upload/<folder>`.
- When an upload finishes, the completion handler calls `fileService.finalizeUpload(user, stagedPath, targetVirtualPath)`. That method validates the target, and writes an audit entry.
- On a name conflict, reject the upload. Never silently overwrite. The client may retry with a new name.
- Stale incomplete uploads older than 24h are cleaned up on startup and on an hourly interval.

## Thumbnails

- Thumbnails are images only: jpg, png, webp, gif, avif.
- The cache key is a hash of folder name + virtual path + mtime + size. Store thumbnails in `cacheDir/thumbnails`.
- Generate on first request with sharp: 128 max dimension, webp output.
- Limit concurrent sharp jobs (e.g. p-limit at 2–4) so large folders can't spike the CPU.
- Serve with long-lived cache headers. The key changes whenever the file changes.
- If generation fails, return 404 and let the UI show a generic file icon.

## Streaming and performance

- Downloads must stream (`fs.createReadStream` to a web `ReadableStream`). Never buffer whole files in memory.
- Support HTTP Range requests on download.
- Directory listing returns name, type, size, mtime, and a flag indicating whether a thumbnail is available. No recursive operations except copy and delete.
- Recursive copy and delete must stream through the tree. Never load a full tree into memory.

## Audit log

The log is append-only JSONL with one entry per mutating action, including failures. Each entry has this shape:

{"ts":"2026-10-01T12:00:00.000Z","user":"alice","action":"move","src":"/a.txt","dst":"/docs/a.txt","result":"ok","ip":"203.0.113.5"}

Rules:
- Valid actions are: login, login_failed, logout, upload, mkdir, rename, move, copy, delete.
- Reads (list, download, thumbnail) are not audited.
- Log virtual paths only, never absolute host paths.

## Errors

- Throw typed errors from `server/errors.ts`: NotFound, Forbidden, Conflict, BadRequest, Unauthorized.
- One shared helper maps them to HTTP responses of the form `{ error: { code, message } }`.
- Never leak host paths or stack traces to the client.

## Docker

- Use a multi-stage build that copies the Next.js standalone output. The final image runs as a non-root user.
- An entrypoint handles PUID/PGID so files written to mounted volumes match host ownership.
- `/config/config.yaml` and `/data` are volumes.
- Include a `/api/health` endpoint for container health checks.

## How to work

- Keep diffs small and focused on the task at hand.
- Match existing patterns before inventing new ones.
- Ask before adding any new dependency.
- Write or update Vitest tests for anything touching `safe-path.ts`, `file-service.ts`, or config validation.
- If a request seems to push the project out of scope, say so and suggest the simplest in-scope alternative rather than building it.