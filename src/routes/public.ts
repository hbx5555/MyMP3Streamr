import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateRequest, AuthError } from '../auth/index.js';
import { config } from '../config.js';
import { getAlbumById, getArtistById, getTrackById, listAlbums, listAlbumsByArtist, listArtists, listTracksByAlbum, searchCatalog } from '../db/repositories.js';
import { getR2Object } from '../storage/r2.js';
import { renderAlbumDirectory, renderAlbumList, renderMusicFolders, renderPing, renderSearchResults, renderSong } from '../catalog/format.js';
import { SUBSONIC_VERSION, subsonicErrorXml, wrapSubsonicResponse, xmlElement } from '../utils/subsonic.js';

function getCleanId(raw: string | undefined, prefix: string): string | null {
  if (!raw) return null;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

async function ensureAuth(request: FastifyRequest) {
  try {
    return await authenticateRequest(request, config.ADMIN_PASSWORD);
  } catch (error) {
    if (error instanceof AuthError) {
      return null;
    }
    throw error;
  }
}

function parseRange(rangeHeader: string | undefined): string | undefined {
  return rangeHeader?.startsWith('bytes=') ? rangeHeader : undefined;
}

async function sendSubsonicXml(reply: FastifyReply, xml: string) {
  reply.header('Content-Type', 'application/xml; charset=utf-8');
  return reply.send(xml);
}

function wantsSubsonicJson(request: FastifyRequest): boolean {
  const query = request.query as Record<string, string | undefined>;
  return query.f?.toLowerCase() === 'json';
}

async function sendSubsonicOk(request: FastifyRequest, reply: FastifyReply, xml: string, payload: Record<string, unknown> = {}) {
  if (wantsSubsonicJson(request)) {
    return reply.send({
      'subsonic-response': {
        status: 'ok',
        version: SUBSONIC_VERSION,
        ...payload
      }
    });
  }

  return sendSubsonicXml(reply, xml);
}

async function sendSubsonicError(request: FastifyRequest, reply: FastifyReply, code: number, message: string) {
  if (wantsSubsonicJson(request)) {
    return reply.send({
      'subsonic-response': {
        status: 'failed',
        version: SUBSONIC_VERSION,
        error: { code, message }
      }
    });
  }

  return sendSubsonicXml(reply, subsonicErrorXml(code, message));
}

function renderLandingPage(appBaseUrl: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My MP3 Streamer</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0f1115;
        --panel: #171a21;
        --panel-2: #1f2430;
        --text: #f4f7fb;
        --muted: #9ca3af;
        --accent: #7dd3fc;
        --border: rgba(255,255,255,0.08);
      }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
        background: radial-gradient(circle at top, #182031 0%, var(--bg) 42%);
        color: var(--text);
        display: grid;
        place-items: center;
      }
      .card {
        width: min(760px, calc(100vw - 32px));
        background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.03));
        border: 1px solid var(--border);
        border-radius: 24px;
        box-shadow: 0 24px 80px rgba(0,0,0,0.35);
        padding: 32px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: clamp(2rem, 4vw, 3.25rem);
      }
      p {
        margin: 0 0 16px;
        color: var(--muted);
        line-height: 1.6;
      }
      .actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 24px;
      }
      a {
        color: var(--text);
        text-decoration: none;
      }
      .button {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--panel);
      }
      .button.primary {
        background: linear-gradient(135deg, #2563eb, #06b6d4);
        color: white;
        border-color: transparent;
      }
      code {
        background: var(--panel-2);
        padding: 2px 6px;
        border-radius: 6px;
        color: var(--accent);
      }
      .meta {
        margin-top: 24px;
        padding-top: 16px;
        border-top: 1px solid var(--border);
        font-size: 0.95rem;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>My MP3 Streamer</h1>
      <p>A self-hosted music server for streaming MP3s from Cloudflare R2 through Railway.</p>
      <div class="actions">
        <a class="button primary" href="/admin-panel">Open admin panel</a>
        <a class="button" href="/health">Health check</a>
      </div>
      <div class="meta">
        <p>API base: <code>${appBaseUrl}</code></p>
        <p>Admin endpoints expect <code>Authorization: Bearer &lt;ADMIN_API_KEY&gt;</code> or <code>x-admin-key</code>.</p>
      </div>
    </main>
  </body>
</html>`;
}

function renderAdminPanelPage(appBaseUrl: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My MP3 Streamer Admin</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #101114;
        --panel: #181b20;
        --panel-soft: #20242b;
        --line: rgba(255,255,255,0.11);
        --text: #f5f7fa;
        --muted: #a9b0ba;
        --accent: #5eead4;
        --accent-strong: #14b8a6;
        --danger: #f87171;
        --ok: #86efac;
      }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Avenir Next, ui-sans-serif, system-ui, sans-serif;
        background:
          linear-gradient(180deg, rgba(94,234,212,0.08), transparent 280px),
          repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 72px),
          var(--bg);
        color: var(--text);
      }
      main {
        width: min(1100px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0;
      }
      header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 20px;
        padding-bottom: 22px;
        border-bottom: 1px solid var(--line);
      }
      h1 {
        margin: 0;
        font-size: 2rem;
        font-weight: 760;
      }
      .subtle {
        color: var(--muted);
        margin: 8px 0 0;
        line-height: 1.5;
      }
      a { color: var(--accent); }
      form {
        display: grid;
        grid-template-columns: 1.15fr 0.85fr;
        gap: 24px;
        margin-top: 24px;
      }
      section {
        background: color-mix(in srgb, var(--panel) 92%, transparent);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 20px;
      }
      h2 {
        font-size: 0.9rem;
        letter-spacing: 0;
        text-transform: uppercase;
        color: var(--accent);
        margin: 0 0 16px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      label {
        display: grid;
        gap: 7px;
        color: var(--muted);
        font-size: 0.92rem;
      }
      label.full { grid-column: 1 / -1; }
      input {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-soft);
        color: var(--text);
        font: inherit;
        padding: 11px 12px;
        min-height: 44px;
      }
      input[type="file"] {
        padding: 9px;
      }
      input:focus {
        outline: 2px solid rgba(94,234,212,0.35);
        outline-offset: 1px;
      }
      button {
        border: 0;
        border-radius: 6px;
        background: var(--accent-strong);
        color: #04110f;
        font: inherit;
        font-weight: 760;
        padding: 13px 16px;
        min-height: 46px;
        cursor: pointer;
      }
      button:disabled {
        cursor: wait;
        opacity: 0.68;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-top: 18px;
      }
      .status {
        min-height: 24px;
        color: var(--muted);
        line-height: 1.45;
      }
      .status.ok { color: var(--ok); }
      .status.error { color: var(--danger); }
      .preview {
        display: grid;
        gap: 16px;
      }
      .cover-preview {
        width: 100%;
        aspect-ratio: 1 / 1;
        display: grid;
        place-items: center;
        border: 1px dashed var(--line);
        border-radius: 8px;
        background: var(--panel-soft);
        color: var(--muted);
        overflow: hidden;
      }
      .cover-preview img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .progress-wrap {
        display: grid;
        gap: 8px;
      }
      progress {
        width: 100%;
        height: 12px;
        accent-color: var(--accent-strong);
      }
      .endpoint {
        margin-top: 18px;
        color: var(--muted);
        font-size: 0.88rem;
      }
      code {
        background: var(--panel-soft);
        color: var(--accent);
        border-radius: 4px;
        padding: 2px 5px;
      }
      @media (max-width: 820px) {
        main { padding: 20px 0; }
        header { align-items: start; flex-direction: column; }
        form { grid-template-columns: 1fr; }
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>My MP3 Streamer Admin</h1>
          <p class="subtle">Upload audio, optional cover art, and catalog metadata into R2 and Postgres.</p>
        </div>
        <a href="/">Back to home</a>
      </header>

      <form id="uploadForm">
        <section>
          <h2>Track Upload</h2>
          <div class="grid">
            <label class="full">
              Admin API key
              <input id="adminKey" name="adminKey" type="password" autocomplete="off" required />
            </label>
            <label class="full">
              MP3 file
              <input id="audioFile" name="audioFile" type="file" accept="audio/mpeg,.mp3" required />
            </label>
            <label class="full">
              Cover image
              <input id="coverFile" name="coverFile" type="file" accept="image/jpeg,image/png,image/webp" />
            </label>
            <label>
              Artist
              <input id="artistName" name="artistName" type="text" required />
            </label>
            <label>
              Album
              <input id="albumTitle" name="albumTitle" type="text" required />
            </label>
            <label class="full">
              Track title
              <input id="trackTitle" name="trackTitle" type="text" required />
            </label>
            <label>
              Duration seconds
              <input id="durationSeconds" name="durationSeconds" type="number" min="1" step="1" required />
            </label>
            <label>
              Bitrate kbps
              <input id="bitrate" name="bitrate" type="number" min="1" step="1" value="128" />
            </label>
            <label>
              Year
              <input id="year" name="year" type="number" min="1900" max="2100" step="1" />
            </label>
            <label>
              Genre
              <input id="genre" name="genre" type="text" />
            </label>
            <label class="full">
              Source URL
              <input id="sourceUrl" name="sourceUrl" type="url" />
            </label>
          </div>
          <div class="actions">
            <button id="submitButton" type="submit">Upload track</button>
            <div id="status" class="status" role="status" aria-live="polite"></div>
          </div>
        </section>

        <section class="preview">
          <h2>Upload State</h2>
          <div id="coverPreview" class="cover-preview">No cover selected</div>
          <div class="progress-wrap">
            <label for="audioProgress">Audio upload</label>
            <progress id="audioProgress" value="0" max="100"></progress>
          </div>
          <div class="progress-wrap">
            <label for="coverProgress">Cover upload</label>
            <progress id="coverProgress" value="0" max="100"></progress>
          </div>
          <p class="endpoint">API base: <code>${appBaseUrl}</code></p>
        </section>
      </form>
    </main>
    <script>
      const appBaseUrl = ${JSON.stringify(appBaseUrl)};
      const form = document.getElementById('uploadForm');
      const adminKey = document.getElementById('adminKey');
      const audioFile = document.getElementById('audioFile');
      const coverFile = document.getElementById('coverFile');
      const trackTitle = document.getElementById('trackTitle');
      const durationSeconds = document.getElementById('durationSeconds');
      const bitrate = document.getElementById('bitrate');
      const statusEl = document.getElementById('status');
      const submitButton = document.getElementById('submitButton');
      const audioProgress = document.getElementById('audioProgress');
      const coverProgress = document.getElementById('coverProgress');
      const coverPreview = document.getElementById('coverPreview');

      function setStatus(message, type) {
        statusEl.textContent = message;
        statusEl.className = 'status' + (type ? ' ' + type : '');
      }

      function setBusy(isBusy) {
        submitButton.disabled = isBusy;
        submitButton.textContent = isBusy ? 'Uploading...' : 'Upload track';
      }

      function authHeaders() {
        return {
          Authorization: 'Bearer ' + adminKey.value.trim(),
          'Content-Type': 'application/json'
        };
      }

      function uploadToSignedUrl(url, file, contentType, progressEl) {
        return new Promise((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.open('PUT', url);
          request.setRequestHeader('Content-Type', contentType);
          request.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              progressEl.value = Math.round((event.loaded / event.total) * 100);
            }
          };
          request.onload = () => {
            if (request.status >= 200 && request.status < 300) {
              progressEl.value = 100;
              resolve();
            } else {
              reject(new Error('R2 upload failed with status ' + request.status));
            }
          };
          request.onerror = () => reject(new Error('Network error while uploading to R2'));
          request.send(file);
        });
      }

      async function postJson(path, payload) {
        const response = await fetch(appBaseUrl + path, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
          throw new Error(data.error || 'Request failed with status ' + response.status);
        }
        return data;
      }

      audioFile.addEventListener('change', () => {
        const file = audioFile.files && audioFile.files[0];
        if (!file) return;
        audioProgress.value = 0;
        if (!trackTitle.value) {
          trackTitle.value = file.name.replace(/\\.mp3$/i, '');
        }
        const audio = document.createElement('audio');
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => {
          if (Number.isFinite(audio.duration) && !durationSeconds.value) {
            durationSeconds.value = String(Math.max(1, Math.round(audio.duration)));
          }
          URL.revokeObjectURL(audio.src);
        };
        audio.src = URL.createObjectURL(file);
      });

      coverFile.addEventListener('change', () => {
        const file = coverFile.files && coverFile.files[0];
        coverProgress.value = 0;
        if (!file) {
          coverPreview.textContent = 'No cover selected';
          return;
        }
        const image = document.createElement('img');
        image.alt = 'Selected cover preview';
        image.src = URL.createObjectURL(file);
        image.onload = () => URL.revokeObjectURL(image.src);
        coverPreview.replaceChildren(image);
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const audio = audioFile.files && audioFile.files[0];
        const cover = coverFile.files && coverFile.files[0];
        if (!audio) {
          setStatus('Choose an MP3 file first.', 'error');
          return;
        }

        setBusy(true);
        audioProgress.value = 0;
        coverProgress.value = 0;

        try {
          setStatus('Creating signed upload URLs...');
          const bootstrap = await postJson('/admin/bootstrap-import', {
            artistName: document.getElementById('artistName').value.trim(),
            albumTitle: document.getElementById('albumTitle').value.trim(),
            trackTitle: trackTitle.value.trim(),
            durationSeconds: Number(durationSeconds.value),
            bitrate: bitrate.value ? Number(bitrate.value) : undefined,
            mimeType: audio.type || 'audio/mpeg',
            fileSuffix: 'mp3',
            year: document.getElementById('year').value ? Number(document.getElementById('year').value) : undefined,
            genre: document.getElementById('genre').value.trim() || undefined,
            sourceUrl: document.getElementById('sourceUrl').value.trim() || undefined,
            sourceTitle: trackTitle.value.trim(),
            audioContentType: audio.type || 'audio/mpeg',
            coverContentType: cover ? (cover.type || 'image/jpeg') : 'image/jpeg'
          });

          setStatus('Uploading MP3 to R2...');
          await uploadToSignedUrl(bootstrap.audioUploadUrl, audio, audio.type || 'audio/mpeg', audioProgress);

          let thumbnailKey;
          if (cover) {
            setStatus('Uploading cover art to R2...');
            await uploadToSignedUrl(bootstrap.coverUploadUrl, cover, cover.type || 'image/jpeg', coverProgress);
            thumbnailKey = bootstrap.coverKey;
          }

          setStatus('Saving catalog metadata...');
          const imported = await postJson('/admin/import', {
            importId: bootstrap.importId,
            artistId: bootstrap.artist.id,
            albumId: bootstrap.album.id,
            trackId: bootstrap.track.id,
            artistName: document.getElementById('artistName').value.trim(),
            albumTitle: document.getElementById('albumTitle').value.trim(),
            trackTitle: trackTitle.value.trim(),
            audioKey: bootstrap.audioKey,
            thumbnailKey,
            durationSeconds: Number(durationSeconds.value),
            bitrate: bitrate.value ? Number(bitrate.value) : undefined,
            mimeType: audio.type || 'audio/mpeg',
            fileSuffix: 'mp3',
            fileSize: audio.size,
            sourceUrl: document.getElementById('sourceUrl').value.trim() || undefined,
            sourceTitle: trackTitle.value.trim(),
            year: document.getElementById('year').value ? Number(document.getElementById('year').value) : undefined,
            genre: document.getElementById('genre').value.trim() || undefined
          });

          setStatus('Uploaded: ' + imported.track.title + ' by ' + imported.artist.name, 'ok');
          form.reset();
          coverPreview.textContent = 'No cover selected';
        } catch (error) {
          setStatus(error instanceof Error ? error.message : 'Upload failed', 'error');
        } finally {
          setBusy(false);
        }
      });
    </script>
  </body>
</html>`;
}

export async function registerPublicRoutes(app: FastifyInstance) {
  app.get('/', async (_request, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(renderLandingPage(config.APP_BASE_URL));
  });

  app.get('/admin-panel', async (_request, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(renderAdminPanelPage(config.APP_BASE_URL));
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'my-mp3-streamer'
  }));

  app.get('/rest/ping.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
    return sendSubsonicOk(request, reply, wrapSubsonicResponse(renderPing()));
  });

  app.get('/rest/getLicense.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
    return sendSubsonicOk(
      request,
      reply,
      wrapSubsonicResponse(xmlElement('license', { valid: true })),
      { license: { valid: true } }
    );
  });

  app.get('/rest/getOpenSubsonicExtensions.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
    return sendSubsonicOk(
      request,
      reply,
      wrapSubsonicResponse(xmlElement('openSubsonicExtensions')),
      { openSubsonicExtensions: { openSubsonicExtension: [] } }
    );
  });

  app.get('/rest/getMusicFolders.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicXml(reply, subsonicErrorXml(40, 'Authentication failed'));
    return sendSubsonicXml(reply, wrapSubsonicResponse(renderMusicFolders()));
  });

  app.get('/rest/getIndexes.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicXml(reply, subsonicErrorXml(40, 'Authentication failed'));
    const artists = await listArtists();
    const sections = artists.reduce<Record<string, typeof artists>>((acc, artist) => {
      const section = (artist.sort_name ?? artist.name).slice(0, 1).toUpperCase();
      acc[section] ??= [];
      acc[section].push(artist);
      return acc;
    }, {});
    const body = xmlElement('indexes', {}, Object.keys(sections).sort().map((section) => xmlElement('index', { name: section }, sections[section].map((artist) => xmlElement('artist', {
      id: `artist:${artist.id}`,
      name: artist.name,
      albumCount: 0
    })).join(''))).join(''));
    return sendSubsonicXml(reply, wrapSubsonicResponse(body));
  });

  app.get('/rest/getArtists.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicXml(reply, subsonicErrorXml(40, 'Authentication failed'));
    const artists = await listArtists();
    const body = xmlElement('artists', {}, artists.map((artist) => xmlElement('artist', {
      id: `artist:${artist.id}`,
      name: artist.name,
      albumCount: 0
    })).join(''));
    return sendSubsonicXml(reply, wrapSubsonicResponse(body));
  });

  app.get('/rest/getMusicDirectory.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicXml(reply, subsonicErrorXml(40, 'Authentication failed'));
    const query = request.query as Record<string, string | undefined>;
    const id = query.id;
    if (!id) return sendSubsonicXml(reply, subsonicErrorXml(10, 'Missing id'));

    if (id === 'root') {
      const artists = await listArtists();
      const body = xmlElement('directory', { id: 'root', name: 'Library', isDir: true }, artists.map((artist) => xmlElement('artist', {
        id: `artist:${artist.id}`,
        name: artist.name,
        albumCount: 0
      })).join(''));
      return sendSubsonicXml(reply, wrapSubsonicResponse(body));
    }

    const artistId = getCleanId(id, 'artist:');
    if (artistId) {
      const artist = await getArtistById(artistId);
      if (!artist) return sendSubsonicXml(reply, subsonicErrorXml(70, 'Artist not found'));
      const albums = await listAlbumsByArtist(artistId);
      const body = xmlElement('directory', { id: `artist:${artist.id}`, name: artist.name, isDir: true }, albums.map((album) => xmlElement('album', {
        id: `album:${album.id}`,
        name: album.title,
        title: album.title,
        artist: artist.name,
        year: album.year ?? '',
        songCount: album.track_count,
        duration: album.duration_seconds,
        coverArt: album.cover_art_key ?? '',
        isDir: true
      })).join(''));
      return sendSubsonicXml(reply, wrapSubsonicResponse(body));
    }

    const albumId = getCleanId(id, 'album:');
    if (albumId) {
      const album = await getAlbumById(albumId);
      if (!album) return sendSubsonicXml(reply, subsonicErrorXml(70, 'Album not found'));
      const tracks = await listTracksByAlbum(albumId);
      const artist = await getArtistById(album.artist_id);
      return sendSubsonicXml(reply, wrapSubsonicResponse(renderAlbumDirectory(album, tracks, artist?.name ?? '')));
    }

    const trackId = getCleanId(id, 'track:');
    if (trackId) {
      const track = await getTrackById(trackId);
      if (!track) return sendSubsonicXml(reply, subsonicErrorXml(70, 'Track not found'));
      return sendSubsonicXml(reply, wrapSubsonicResponse(renderSong(track)));
    }

    return sendSubsonicXml(reply, subsonicErrorXml(10, 'Unsupported id type'));
  });

  app.get('/rest/getCoverArt.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicXml(reply, subsonicErrorXml(40, 'Authentication failed'));
    const query = request.query as Record<string, string | undefined>;
    const id = query.id;
    if (!id) return sendSubsonicXml(reply, subsonicErrorXml(10, 'Missing id'));

    const trackId = getCleanId(id, 'track:');
    const albumId = getCleanId(id, 'album:');
    const resolvedId = trackId ?? albumId;
    if (!resolvedId) return sendSubsonicXml(reply, subsonicErrorXml(10, 'Unsupported cover art id'));

    const track = trackId ? await getTrackById(trackId) : null;
    const album = albumId ? await getAlbumById(albumId) : null;
    const objectKey = track?.source_thumbnail_key ?? album?.cover_art_key ?? null;
    if (!objectKey) return sendSubsonicXml(reply, subsonicErrorXml(70, 'Cover art not found'));

    const object = await getR2Object(objectKey);
    reply.header('Content-Type', object.ContentType ?? 'image/jpeg');
    if (object.ContentLength) reply.header('Content-Length', String(object.ContentLength));
    return reply.send(object.Body);
  });

  app.get('/rest/stream.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicXml(reply, subsonicErrorXml(40, 'Authentication failed'));
    const query = request.query as Record<string, string | undefined>;
    const id = query.id;
    if (!id) return sendSubsonicXml(reply, subsonicErrorXml(10, 'Missing id'));
    const trackId = getCleanId(id, 'track:') ?? id;
    const track = await getTrackById(trackId);
    if (!track) return sendSubsonicXml(reply, subsonicErrorXml(70, 'Track not found'));

    const range = parseRange(request.headers.range);
    const object = await getR2Object(track.audio_key, range);

    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', object.ContentType ?? track.mime_type);
    if (object.ContentLength) reply.header('Content-Length', String(object.ContentLength));
    if (object.ContentRange) reply.header('Content-Range', object.ContentRange);
    reply.status(object.ContentRange ? 206 : 200);
    return reply.send(object.Body);
  });

  app.get('/rest/search3.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicXml(reply, subsonicErrorXml(40, 'Authentication failed'));
    const q = (request.query as Record<string, string | undefined>).query;
    if (!q) return sendSubsonicXml(reply, subsonicErrorXml(10, 'Missing query'));
    const payload = await searchCatalog(q);
    return sendSubsonicXml(reply, wrapSubsonicResponse(renderSearchResults(payload)));
  });

  app.get('/rest/getAlbumList2.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicXml(reply, subsonicErrorXml(40, 'Authentication failed'));
    const rows = await listAlbums();
    return sendSubsonicXml(reply, wrapSubsonicResponse(renderAlbumList(rows.slice(0, 100))));
  });

  app.get('/rest/getSong.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicXml(reply, subsonicErrorXml(40, 'Authentication failed'));
    const id = (request.query as Record<string, string | undefined>).id;
    if (!id) return sendSubsonicXml(reply, subsonicErrorXml(10, 'Missing id'));
    const trackId = getCleanId(id, 'track:') ?? id;
    const track = await getTrackById(trackId);
    if (!track) return sendSubsonicXml(reply, subsonicErrorXml(70, 'Track not found'));
    return sendSubsonicXml(reply, wrapSubsonicResponse(renderSong(track)));
  });
}
