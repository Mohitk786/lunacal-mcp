#!/usr/bin/env bash
# Dump the MCP Postgres database from inside the compose network.
# The database has no published port, so this uses `docker compose exec`.
#
# Usage:
#   ./scripts/backup.sh [output-directory]
#
# Cron (daily at 03:15 UTC), from the repo directory:
#   15 3 * * * cd /opt/lunacal-mcp && ./scripts/backup.sh /var/backups/lunacal-mcp >> /var/log/lunacal-mcp-backup.log 2>&1
#
# Copy the dumps off the server. A backup that only lives on the same disk
# does not survive that disk. Example with rclone, after the cron line:
#   30 3 * * * rclone copy /var/backups/lunacal-mcp remote:lunacal-mcp-backups --immutable
#
# Restore (stops writes only if you choose to; this is a plain SQL dump):
#   gunzip -c backups/lunacal-mcp-YYYYmmddTHHMMSSZ.sql.gz | docker compose exec -T postgres psql -U mcp -d lunacal_mcp

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/lunacal-mcp-$STAMP.sql.gz"

docker compose -f "$ROOT/docker-compose.yml" exec -T postgres \
  pg_dump --no-owner --no-acl -U mcp -d lunacal_mcp | gzip > "$FILE"

echo "Wrote $FILE"
