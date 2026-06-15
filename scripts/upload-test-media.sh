#!/usr/bin/env bash
set -euo pipefail

APP_BASE_URL="${APP_BASE_URL:-https://mymp3streamr-production.up.railway.app}"
AUDIO_CONTENT_TYPE="${AUDIO_CONTENT_TYPE:-audio/mpeg}"
COVER_CONTENT_TYPE="${COVER_CONTENT_TYPE:-image/jpeg}"
ARTIST_NAME="${ARTIST_NAME:-Test Artist}"
ALBUM_TITLE="${ALBUM_TITLE:-Test Album}"
TRACK_TITLE="${TRACK_TITLE:-Test Track}"
DURATION_SECONDS="${DURATION_SECONDS:-180}"
BITRATE="${BITRATE:-128}"
YEAR="${YEAR:-2026}"
GENRE="${GENRE:-Test}"
SOURCE_URL="${SOURCE_URL:-manual-test-upload}"
SOURCE_TITLE="${SOURCE_TITLE:-Manual test upload}"

export APP_BASE_URL AUDIO_CONTENT_TYPE COVER_CONTENT_TYPE ARTIST_NAME ALBUM_TITLE TRACK_TITLE DURATION_SECONDS BITRATE YEAR GENRE SOURCE_URL SOURCE_TITLE

if [[ -z "${ADMIN_API_KEY:-}" ]]; then
  echo "ADMIN_API_KEY is required." >&2
  exit 1
fi

if [[ -z "${AUDIO_FILE:-}" || ! -f "$AUDIO_FILE" ]]; then
  echo "AUDIO_FILE must point to a local MP3 file." >&2
  exit 1
fi

if [[ -n "${COVER_FILE:-}" && ! -f "$COVER_FILE" ]]; then
  echo "COVER_FILE was set but does not point to a file." >&2
  exit 1
fi

json_get() {
  node -e "const fs = require('node:fs'); const path = process.argv[1]; const key = process.argv[2]; const data = JSON.parse(fs.readFileSync(path, 'utf8')); const value = key.split('.').reduce((acc, part) => acc && acc[part], data); if (value == null) process.exit(1); process.stdout.write(String(value));" "$1" "$2"
}

file_size() {
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1"
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

bootstrap_body="$tmp_dir/bootstrap-request.json"
bootstrap_response="$tmp_dir/bootstrap-response.json"
import_body="$tmp_dir/import-request.json"
import_response="$tmp_dir/import-response.json"

node -e "
const fs = require('node:fs');
const env = process.env;
fs.writeFileSync(process.argv[1], JSON.stringify({
  artistName: env.ARTIST_NAME,
  albumTitle: env.ALBUM_TITLE,
  trackTitle: env.TRACK_TITLE,
  durationSeconds: Number(env.DURATION_SECONDS),
  bitrate: Number(env.BITRATE),
  mimeType: env.AUDIO_CONTENT_TYPE,
  fileSuffix: 'mp3',
  year: Number(env.YEAR),
  genre: env.GENRE,
  sourceUrl: env.SOURCE_URL,
  sourceTitle: env.SOURCE_TITLE,
  audioContentType: env.AUDIO_CONTENT_TYPE,
  coverContentType: env.COVER_CONTENT_TYPE
}));
" "$bootstrap_body"

echo "Creating import and signed upload URLs..."
curl -fsS -X POST "$APP_BASE_URL/admin/bootstrap-import" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary "@$bootstrap_body" \
  -o "$bootstrap_response"

audio_upload_url="$(json_get "$bootstrap_response" audioUploadUrl)"
audio_key="$(json_get "$bootstrap_response" audioKey)"
cover_upload_url="$(json_get "$bootstrap_response" coverUploadUrl)"
cover_key="$(json_get "$bootstrap_response" coverKey)"
import_id="$(json_get "$bootstrap_response" importId)"
artist_id="$(json_get "$bootstrap_response" artist.id)"
album_id="$(json_get "$bootstrap_response" album.id)"
track_id="$(json_get "$bootstrap_response" track.id)"

echo "Uploading audio to R2..."
curl -fsS -X PUT "$audio_upload_url" \
  -H "Content-Type: $AUDIO_CONTENT_TYPE" \
  --data-binary "@$AUDIO_FILE" \
  -o /dev/null

if [[ -n "${COVER_FILE:-}" ]]; then
  echo "Uploading cover art to R2..."
  curl -fsS -X PUT "$cover_upload_url" \
    -H "Content-Type: $COVER_CONTENT_TYPE" \
    --data-binary "@$COVER_FILE" \
    -o /dev/null
else
  cover_key=""
fi

audio_size="$(file_size "$AUDIO_FILE")"

TRACK_ID="$track_id" ARTIST_ID="$artist_id" ALBUM_ID="$album_id" IMPORT_ID="$import_id" AUDIO_KEY="$audio_key" COVER_KEY="$cover_key" AUDIO_SIZE="$audio_size" node -e "
const fs = require('node:fs');
const env = process.env;
const payload = {
  artistId: env.ARTIST_ID,
  albumId: env.ALBUM_ID,
  trackId: env.TRACK_ID,
  importId: env.IMPORT_ID,
  artistName: env.ARTIST_NAME,
  albumTitle: env.ALBUM_TITLE,
  trackTitle: env.TRACK_TITLE,
  audioKey: env.AUDIO_KEY,
  durationSeconds: Number(env.DURATION_SECONDS),
  bitrate: Number(env.BITRATE),
  mimeType: env.AUDIO_CONTENT_TYPE,
  fileSuffix: 'mp3',
  fileSize: Number(env.AUDIO_SIZE),
  sourceUrl: env.SOURCE_URL,
  sourceTitle: env.SOURCE_TITLE,
  year: Number(env.YEAR),
  genre: env.GENRE
};
if (env.COVER_KEY) payload.thumbnailKey = env.COVER_KEY;
fs.writeFileSync(process.argv[1], JSON.stringify(payload));
" "$import_body"

echo "Finalizing catalog import..."
curl -fsS -X POST "$APP_BASE_URL/admin/import" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary "@$import_body" \
  -o "$import_response"

echo "Upload complete:"
node -e "const fs = require('node:fs'); const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(JSON.stringify({ ok: data.ok, artist: data.artist?.name, album: data.album?.title, track: data.track?.title, trackId: data.track?.id }, null, 2));" "$import_response"
