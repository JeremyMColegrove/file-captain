#!/bin/sh

set -eu

# Started as root: take ownership of the app's own writable paths, then drop
# to PUID:PGID so files written to mounted volumes match the host user.
# Media folders are left alone; PUID:PGID must already be able to write them.
if [ "$(id -u)" = "0" ]; then
	PUID="${PUID:-1000}"
	PGID="${PGID:-1000}"
	chown -R "$PUID:$PGID" /app/.next/cache
	# /data holds the thumbnail cache and audit log. Only re-owned when it
	# changed, since the cache can hold many files.
	mkdir -p /data
	if [ "$(stat -c '%u:%g' /data)" != "$PUID:$PGID" ]; then
		echo "Setting owner of /data to $PUID:$PGID..."
		chown -R "$PUID:$PGID" /data
	fi
	echo "Running as $PUID:$PGID"
	exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$0" "$@"
fi

echo "Running database migrations..."
node ./scripts/run-migrations.mjs

echo "Starting server..."
exec node server.js
