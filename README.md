# My MP3 Streamer

Railway-hosted Node.js + TypeScript + Fastify backend for a Subsonic/OpenSubsonic-compatible music server.

## Local setup

1. Copy `.env.example` to `.env`
2. Install dependencies
3. Run migrations
4. Seed the admin user
5. Start the dev server

## Scripts

- `npm run dev`
- `npm run build`
- `npm start`
- `npm run migrate`
- `npm run seed:admin`

## First test upload

Use one dedicated R2 bucket, for example `mymp3streamr-media`, with keys like:

- `audio/{trackId}/original.mp3`
- `art/{albumId}/cover.jpg`
- `imports/{importId}/source.json`

The quickest path is the helper script:

```bash
APP_BASE_URL="https://mymp3streamr-production.up.railway.app" \
ADMIN_API_KEY="your-admin-api-key" \
AUDIO_FILE="/path/to/test-track.mp3" \
COVER_FILE="/path/to/cover.jpg" \
ARTIST_NAME="Test Artist" \
ALBUM_TITLE="Test Album" \
TRACK_TITLE="Test Track" \
DURATION_SECONDS=180 \
scripts/upload-test-media.sh
```

`COVER_FILE` is optional. The server must have the Cloudflare R2 variables configured before this script can create signed upload URLs.

When the Railway server is running:

1. Create a bootstrap payload:

```bash
cat > bootstrap.json <<'JSON'
{
  "artistName": "Test Artist",
  "albumTitle": "Test Album",
  "trackTitle": "Test Track",
  "durationSeconds": 123,
  "bitrate": 320,
  "mimeType": "audio/mpeg",
  "fileSuffix": "mp3",
  "year": 2026,
  "genre": "Test",
  "sourceUrl": "https://example.com/source",
  "sourceTitle": "Test Source"
}
JSON
```

2. Bootstrap the import, which returns the generated IDs plus both upload URLs:

```bash
curl -X POST "$APP_BASE_URL/admin/bootstrap-import" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @bootstrap.json
```

3. Save the returned `importId`, `track.id`, `album.id`, `audioKey`, `coverKey`, `audioUploadUrl`, and `coverUploadUrl`.
4. Upload the MP3:

```bash
curl -X PUT "$AUDIO_UPLOAD_URL" \
  -H "Content-Type: audio/mpeg" \
  --data-binary @./test-track.mp3
```

5. Upload the cover image:

```bash
curl -X PUT "$COVER_UPLOAD_URL" \
  -H "Content-Type: image/jpeg" \
  --data-binary @./cover.jpg
```

6. Finalize the metadata with the real file size:

```bash
FILE_SIZE=$(stat -f%z ./test-track.mp3)

curl -X POST "$APP_BASE_URL/admin/import" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"importId\": \"$IMPORT_ID\",
    \"artistId\": \"$ARTIST_ID\",
    \"albumId\": \"$ALBUM_ID\",
    \"trackId\": \"$TRACK_ID\",
    \"artistName\": \"Test Artist\",
    \"albumTitle\": \"Test Album\",
    \"trackTitle\": \"Test Track\",
    \"audioKey\": \"$AUDIO_KEY\",
    \"thumbnailKey\": \"$COVER_KEY\",
    \"durationSeconds\": 123,
    \"bitrate\": 320,
    \"mimeType\": \"audio/mpeg\",
    \"fileSuffix\": \"mp3\",
    \"fileSize\": $FILE_SIZE,
    \"sourceUrl\": \"https://example.com/source\",
    \"sourceTitle\": \"Test Source\",
    \"year\": 2026,
    \"genre\": \"Test\"
  }"
```

7. Open the Android client and browse the library.

## App landing page

The Railway app root URL now shows a simple landing page with a link to `/admin-panel`.
That admin page is only a lightweight guide page; the actual ingestion actions still use the authenticated admin API endpoints.

## YouTube extension import

The repo includes a private Chrome extension in `extension/`.

Server endpoints:

- `POST /admin/youtube-import` starts a protected YouTube import job.
- `GET /admin/youtube-import/:importId` returns job status.

The server-side job uses `yt-dlp` and `ffmpeg` to extract an MP3, uploads the MP3 and thumbnail to R2, and saves catalog metadata to Postgres. The included `Dockerfile` installs those media tools for Railway.

Chrome setup:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select the `extension/` folder.
5. Open the extension options page.
6. Set the Railway server URL and Admin API Key.
7. Open a YouTube video and click the extension icon.

The extension is intended for private-use imports into your authenticated MyMP3Streamr server. It does not expose a public import API.
