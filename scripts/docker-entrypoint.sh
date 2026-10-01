#!/bin/sh

set -eu

echo "Running database migrations..."
node ./scripts/run-migrations.mjs

echo "Starting server..."
exec node server.js
