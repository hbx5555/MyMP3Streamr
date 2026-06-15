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
