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

1. Create a track ID, album ID, and artist name in your notes.
2. Request a signed upload URL for the MP3:

```bash
curl -X POST "$APP_BASE_URL/admin/upload-url" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "audio/<trackId>/original.mp3",
    "contentType": "audio/mpeg"
  }'
```

3. Upload the MP3 with the returned `url` using `PUT` and the same `Content-Type`:

```bash
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: audio/mpeg" \
  --data-binary @./test-track.mp3
```
4. Request a signed upload URL for the cover art:

```bash
curl -X POST "$APP_BASE_URL/admin/upload-url" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "art/<albumId>/cover.jpg",
    "contentType": "image/jpeg"
  }'
```

5. Upload the cover image with `PUT`:

```bash
curl -X PUT "$COVER_URL" \
  -H "Content-Type: image/jpeg" \
  --data-binary @./cover.jpg
```
6. Create or update the catalog metadata:

```bash
curl -X POST "$APP_BASE_URL/admin/import" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "artistName": "Test Artist",
    "albumTitle": "Test Album",
    "trackTitle": "Test Track",
    "audioKey": "audio/<trackId>/original.mp3",
    "thumbnailKey": "art/<albumId>/cover.jpg",
    "durationSeconds": 123,
    "bitrate": 320,
    "mimeType": "audio/mpeg",
    "fileSuffix": "mp3",
    "fileSize": 1234567,
    "sourceUrl": "https://example.com/source",
    "sourceTitle": "Test Source",
    "year": 2026,
    "genre": "Test"
  }'
```

7. Open the Android client and browse the library.
