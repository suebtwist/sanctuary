#!/usr/bin/env bash
#
# Download a backup of the Sanctuary database from the VPS.
# Usage: ./backup.sh
#
# Set BACKUP_SECRET in your environment or a .env file alongside this script.
# Saves timestamped .db files to ./backups/ and prunes files older than 30 days.

set -euo pipefail

API="${SANCTUARY_API:-https://api.sanctuary-ops.xyz}"
SECRET="${BACKUP_SECRET:?Set BACKUP_SECRET environment variable}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date -u +"%Y-%m-%d-%H%M")
FILENAME="sanctuary-${TIMESTAMP}.db"
DEST="${BACKUP_DIR}/${FILENAME}"

echo "Downloading backup to ${DEST}..."
HTTP_CODE=$(curl -s -o "$DEST" -w "%{http_code}" "${API}/admin/backup?secret=${SECRET}")

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: Server returned HTTP ${HTTP_CODE}"
  cat "$DEST"  # show error body
  rm -f "$DEST"
  exit 1
fi

SIZE=$(stat -f%z "$DEST" 2>/dev/null || stat --printf="%s" "$DEST" 2>/dev/null)
echo "OK — ${FILENAME} (${SIZE} bytes)"

# Prune backups older than 30 days
PRUNED=$(find "$BACKUP_DIR" -name "sanctuary-*.db" -mtime +30 -print -delete | wc -l)
if [ "$PRUNED" -gt 0 ]; then
  echo "Pruned ${PRUNED} backup(s) older than 30 days"
fi
