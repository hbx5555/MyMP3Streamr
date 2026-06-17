import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateRequest, AuthError } from '../auth/index.js';
import { config } from '../config.js';
import { getAlbumById, getArtistById, getTrackById, listAlbums, listAlbumsByArtist, listArtists, listTracks, listTracksByAlbum, searchCatalog } from '../db/repositories.js';
import { getR2Object } from '../storage/r2.js';
import { renderAlbumDirectory, renderAlbumList, renderMusicFolders, renderPing, renderSearchResults, renderSong } from '../catalog/format.js';
import { SUBSONIC_VERSION, subsonicErrorXml, wrapSubsonicResponse, xmlElement } from '../utils/subsonic.js';
import type { AlbumRow, ArtistRow, TrackRow } from '../types.js';

function getCleanId(raw: string | undefined, prefix: string): string | null {
  if (!raw) return null;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function getPrefixedId(raw: string | undefined, prefix: string): string | null {
  if (!raw?.startsWith(prefix)) return null;
  return raw.slice(prefix.length);
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

function subsonicResponseBase(status: 'ok' | 'failed') {
  return {
    status,
    version: SUBSONIC_VERSION,
    type: 'MyMP3Streamr',
    serverVersion: '0.1.0',
    openSubsonic: true
  };
}

async function sendSubsonicOk(request: FastifyRequest, reply: FastifyReply, xml: string, payload: Record<string, unknown> = {}) {
  if (wantsSubsonicJson(request)) {
    return reply.send({
      'subsonic-response': {
        ...subsonicResponseBase('ok'),
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
        ...subsonicResponseBase('failed'),
        error: { code, message }
      }
    });
  }

  return sendSubsonicXml(reply, subsonicErrorXml(code, message));
}

function normalizeSubsonicSearchQuery(query: string | undefined): string {
  const trimmed = (query ?? '').trim();
  return trimmed === '""' ? '' : trimmed.replace(/^"(.*)"$/, '$1');
}

function getNumberQuery(request: FastifyRequest, key: string, fallback: number): number {
  const query = request.query as Record<string, string | undefined>;
  const parsed = Number.parseInt(query[key] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sliceForSubsonic<T>(items: T[], offset: number, count: number): T[] {
  if (count === 0) return [];
  return items.slice(offset, offset + count);
}

function mapById<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function jsonArtist(artist: ArtistRow, albumCount = 0) {
  return {
    id: `artist:${artist.id}`,
    name: artist.name,
    albumCount
  };
}

function jsonAlbum(album: AlbumRow, artist: ArtistRow | undefined) {
  return {
    id: `album:${album.id}`,
    parent: `artist:${album.artist_id}`,
    name: album.title,
    title: album.title,
    artist: artist?.name ?? '',
    artistId: `artist:${album.artist_id}`,
    year: album.year ?? undefined,
    genre: album.genre ?? undefined,
    coverArt: album.cover_art_key ? `album:${album.id}` : undefined,
    songCount: album.track_count,
    duration: album.duration_seconds,
    isDir: true
  };
}

function jsonTrack(track: TrackRow, album: AlbumRow | undefined, artist: ArtistRow | undefined) {
  return {
    id: `track:${track.id}`,
    parent: `album:${track.album_id}`,
    albumId: `album:${track.album_id}`,
    artistId: track.artist_id ? `artist:${track.artist_id}` : undefined,
    isDir: false,
    title: track.title,
    album: album?.title ?? '',
    artist: artist?.name ?? '',
    track: track.track_number ?? undefined,
    discNumber: track.disc_number ?? undefined,
    year: album?.year ?? undefined,
    genre: album?.genre ?? undefined,
    coverArt: track.source_thumbnail_key ? `track:${track.id}` : album?.cover_art_key ? `album:${album.id}` : undefined,
    size: track.file_size,
    contentType: track.mime_type,
    suffix: track.file_suffix,
    duration: track.duration_seconds,
    bitRate: track.bitrate ?? undefined,
    path: `${artist?.name ?? 'Unknown Artist'}/${album?.title ?? 'Unknown Album'}/${track.title}.${track.file_suffix}`
  };
}

async function loadCatalogMaps() {
  const [artists, albums] = await Promise.all([listArtists(), listAlbums()]);
  return {
    artists,
    albums,
    artistById: mapById(artists),
    albumById: mapById(albums)
  };
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
        <a class="button primary" href="/admin-panel">Add media</a>
        <a class="button" href="/media-manager">Media Manager</a>
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
      .key-tools {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .key-tools button {
        min-height: 40px;
        padding: 10px 14px;
        border-radius: 999px;
        background: var(--accent-strong);
      }
      .key-status {
        font-size: 0.84rem;
        line-height: 1.4;
        color: var(--muted);
      }
      .key-status.ok { color: var(--ok); }
      .key-status.error { color: var(--danger); }
      .field-note {
        color: var(--muted);
        font-size: 0.84rem;
        line-height: 1.4;
      }
      .field-note.ready {
        color: var(--ok);
      }
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
          <h1>Add media</h1>
          <p class="subtle">Upload audio, optional cover art, and catalog metadata into R2 and Postgres.</p>
        </div>
        <div class="actions" style="margin-top: 0">
          <a href="/media-manager">Media Manager</a>
          <a href="/">Back to home</a>
        </div>
      </header>

      <form id="uploadForm">
        <section>
          <h2>Track Upload</h2>
          <div class="grid">
            <label class="full">
              Upload key
              <input id="adminKey" name="adminKey" type="password" autocomplete="off" required />
              <span id="adminKeyNote" class="field-note">Enter once per page session. It is not saved after refresh.</span>
              <div class="key-tools">
                <button id="checkKeyButton" type="button">Check key</button>
                <span id="keyStatus" class="key-status">Not checked yet</span>
              </div>
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
            <button id="submitButton" type="submit">Add media</button>
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
      const adminKeyNote = document.getElementById('adminKeyNote');
      const checkKeyButton = document.getElementById('checkKeyButton');
      const keyStatus = document.getElementById('keyStatus');
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
        submitButton.textContent = isBusy ? 'Uploading...' : 'Add media';
      }

      function updateAdminKeyNote() {
        if (adminKey.value.trim()) {
          adminKeyNote.textContent = 'Key entered for this page session. It will stay until refresh or close.';
          adminKeyNote.className = 'field-note ready';
          window.localStorage.setItem('adminKey', adminKey.value.trim());
          keyStatus.textContent = 'Key entered, not yet checked.';
          keyStatus.className = 'key-status';
        } else {
          adminKeyNote.textContent = 'Enter once per page session. It is not saved after refresh.';
          adminKeyNote.className = 'field-note';
          window.localStorage.removeItem('adminKey');
          keyStatus.textContent = 'Not checked yet';
          keyStatus.className = 'key-status';
        }
      }

      function resetUploadFields() {
        const currentAdminKey = adminKey.value;
        form.reset();
        adminKey.value = currentAdminKey;
        bitrate.value = '128';
        updateAdminKeyNote();
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

      async function checkAdminKey() {
        const key = adminKey.value.trim();
        if (!key) {
          keyStatus.textContent = 'Enter an upload key first.';
          keyStatus.className = 'key-status error';
          return;
        }

        keyStatus.textContent = 'Checking key...';
        keyStatus.className = 'key-status';
        try {
          const response = await fetch(appBaseUrl + '/admin/auth-check', {
            headers: {
              Authorization: 'Bearer ' + key
            }
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.ok === false) {
            throw new Error(data.error || 'Unauthorized');
          }
          keyStatus.textContent = 'Key accepted.';
          keyStatus.className = 'key-status ok';
        } catch (error) {
          keyStatus.textContent = error instanceof Error ? error.message : 'Unauthorized';
          keyStatus.className = 'key-status error';
        }
      }

      adminKey.value = window.localStorage.getItem('adminKey') || '';
      adminKey.addEventListener('input', updateAdminKeyNote);
      updateAdminKeyNote();
      checkKeyButton.addEventListener('click', () => {
        checkAdminKey().catch(() => {});
      });

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
          resetUploadFields();
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

function renderMediaManagerPage(appBaseUrl: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My MP3 Streamer Media Manager</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0e1116;
        --panel: #171b23;
        --panel-soft: #202634;
        --line: rgba(255,255,255,0.1);
        --text: #f5f7fb;
        --muted: #a8b0bc;
        --accent: #7dd3fc;
        --accent-strong: #2563eb;
        --danger: #f87171;
        --ok: #86efac;
      }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Avenir Next, ui-sans-serif, system-ui, sans-serif;
        background:
          radial-gradient(circle at top left, rgba(37,99,235,0.18), transparent 30%),
          radial-gradient(circle at top right, rgba(125,211,252,0.12), transparent 28%),
          repeating-linear-gradient(135deg, rgba(255,255,255,0.02) 0 1px, transparent 1px 84px),
          var(--bg);
        color: var(--text);
      }
      main {
        width: min(1240px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0 44px;
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
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      .toolbar a,
      .toolbar button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--text);
        text-decoration: none;
        padding: 0 16px;
        font: inherit;
      }
      .toolbar .primary {
        background: linear-gradient(135deg, var(--accent-strong), #0ea5e9);
        border-color: transparent;
      }
      .panel {
        margin-top: 24px;
        background: color-mix(in srgb, var(--panel) 92%, transparent);
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 20px;
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }
      .key-row {
        display: grid;
        gap: 8px;
        max-width: 420px;
        margin-bottom: 16px;
        color: var(--muted);
        font-size: 0.92rem;
      }
      .key-row input {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--panel-soft);
        color: var(--text);
        font: inherit;
        padding: 11px 14px;
        min-height: 44px;
      }
      .key-row .key-tools {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .key-row .key-tools button {
        min-height: 40px;
        padding: 10px 14px;
        border-radius: 999px;
        background: var(--accent-strong);
        border: 0;
        color: white;
      }
      .key-row .key-status {
        font-size: 0.84rem;
        line-height: 1.4;
        color: var(--muted);
      }
      .key-row .key-status.ok { color: var(--ok); }
      .key-row .key-status.error { color: var(--danger); }
      .panel-head h2 {
        margin: 0;
        font-size: 0.9rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--accent);
      }
      .panel-head p {
        margin: 6px 0 0;
        color: var(--muted);
      }
      .status {
        color: var(--muted);
        min-height: 24px;
      }
      .status.ok { color: var(--ok); }
      .status.error { color: var(--danger); }
      .media-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 16px;
      }
      .card {
        overflow: hidden;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
        box-shadow: 0 18px 40px rgba(0,0,0,0.22);
      }
      .cover {
        aspect-ratio: 1 / 1;
        background: var(--panel-soft);
        border-bottom: 1px solid var(--line);
        display: grid;
        place-items: center;
        overflow: hidden;
      }
      .cover img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .cover .fallback {
        color: var(--muted);
        text-align: center;
        padding: 20px;
        line-height: 1.4;
      }
      .content {
        padding: 16px;
        display: grid;
        gap: 10px;
      }
      .title {
        margin: 0;
        font-size: 1.05rem;
        line-height: 1.3;
      }
      .desc {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
        font-size: 0.95rem;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .card-actions {
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: flex-end;
        margin-top: 6px;
      }
      .card-actions button.delete {
        border: 0;
        border-radius: 999px;
        background: linear-gradient(135deg, #ef4444, #dc2626);
        color: white;
        font: inherit;
        font-weight: 700;
        padding: 10px 14px;
        min-height: 40px;
        cursor: pointer;
      }
      .card-actions button.delete:disabled {
        opacity: 0.72;
        cursor: wait;
      }
      .card-status {
        margin-right: auto;
        font-size: 0.84rem;
        line-height: 1.4;
        color: var(--muted);
      }
      .card-status.error { color: var(--danger); }
      .card-status.ok { color: var(--ok); }
      .pill {
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 4px 10px;
        color: var(--muted);
        font-size: 0.82rem;
        background: rgba(255,255,255,0.03);
      }
      .empty {
        color: var(--muted);
        border: 1px dashed var(--line);
        border-radius: 18px;
        padding: 28px;
      }
      @media (max-width: 980px) {
        .media-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 720px) {
        main { padding: 20px 0 32px; }
        header { align-items: start; flex-direction: column; }
        .media-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Media Manager</h1>
          <p class="subtle">Review uploaded media cards and remove the matching R2 objects and SQL records in one step.</p>
        </div>
        <div class="toolbar">
          <a class="primary" href="/admin-panel">Add media</a>
          <a href="/">Back to home</a>
        </div>
      </header>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Uploaded media</h2>
            <p id="summary">Loading media...</p>
          </div>
          <div id="status" class="status" role="status" aria-live="polite"></div>
        </div>
        <label class="key-row">
          Upload key
          <input id="adminKey" type="password" autocomplete="off" placeholder="Enter admin key to load and delete media" />
          <div class="key-tools">
            <button id="checkKeyButton" type="button">Check key</button>
            <span id="keyStatus" class="key-status">Not checked yet</span>
          </div>
        </label>
        <div id="mediaGrid" class="media-grid"></div>
      </section>
    </main>
    <script>
      const appBaseUrl = ${JSON.stringify(appBaseUrl)};
      const mediaGrid = document.getElementById('mediaGrid');
      const summary = document.getElementById('summary');
      const statusEl = document.getElementById('status');
      const adminKey = document.getElementById('adminKey');
      const checkKeyButton = document.getElementById('checkKeyButton');
      const keyStatus = document.getElementById('keyStatus');

      function authHeaders() {
        const key = adminKey.value.trim() || window.localStorage.getItem('adminKey') || '';
        if (adminKey.value.trim()) {
          window.localStorage.setItem('adminKey', adminKey.value.trim());
        }
        return {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json'
        };
      }

      async function checkAdminKey() {
        const key = adminKey.value.trim();
        if (!key) {
          keyStatus.textContent = 'Enter an upload key first.';
          keyStatus.className = 'key-status error';
          return;
        }

        keyStatus.textContent = 'Checking key...';
        keyStatus.className = 'key-status';
        try {
          const response = await fetch(appBaseUrl + '/admin/auth-check', {
            headers: {
              Authorization: 'Bearer ' + key
            }
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.ok === false) {
            throw new Error(data.error || 'Unauthorized');
          }
          keyStatus.textContent = 'Key accepted.';
          keyStatus.className = 'key-status ok';
        } catch (error) {
          keyStatus.textContent = error instanceof Error ? error.message : 'Unauthorized';
          keyStatus.className = 'key-status error';
        }
      }

      function setStatus(message, type) {
        statusEl.textContent = message;
        statusEl.className = 'status' + (type ? ' ' + type : '');
      }

      function formatDuration(seconds) {
        const total = Number(seconds) || 0;
        const mins = Math.floor(total / 60);
        const secs = total % 60;
        return mins + ':' + String(secs).padStart(2, '0');
      }

      function renderCard(item) {
        const card = document.createElement('article');
        card.className = 'card';
        card.dataset.trackId = item.id;

        const cover = document.createElement('div');
        cover.className = 'cover';
        if (item.coverUrl) {
          const img = document.createElement('img');
          img.src = item.coverUrl;
          img.alt = item.title + ' cover';
          cover.appendChild(img);
        } else {
          const fallback = document.createElement('div');
          fallback.className = 'fallback';
          fallback.textContent = 'No cover art available';
          cover.appendChild(fallback);
        }

        const content = document.createElement('div');
        content.className = 'content';
        content.innerHTML = \`
          <h3 class="title"></h3>
          <p class="desc"></p>
          <div class="meta"></div>
        \`;
        content.querySelector('.title').textContent = item.title;
        content.querySelector('.desc').textContent = item.artist_name + ' • ' + item.album_title + (item.source_title && item.source_title !== item.title ? ' • ' + item.source_title : '');

        const meta = content.querySelector('.meta');
        const pills = [
          item.album_year ? String(item.album_year) : null,
          item.album_genre || null,
          formatDuration(item.duration_seconds),
          item.bitrate ? item.bitrate + ' kbps' : null
        ].filter(Boolean);
        for (const pillText of pills) {
          const pill = document.createElement('span');
          pill.className = 'pill';
          pill.textContent = pillText;
          meta.appendChild(pill);
        }

        const cardStatus = document.createElement('span');
        cardStatus.className = 'card-status';
        cardStatus.textContent = 'Ready to delete';

        const deleteButton = document.createElement('button');
        deleteButton.className = 'delete';
        deleteButton.type = 'button';
        deleteButton.textContent = 'Delete media';
        deleteButton.setAttribute('aria-label', 'Delete ' + item.title);
        deleteButton.addEventListener('click', async () => {
          if (!window.confirm('Delete "' + item.title + '" and its uploaded files?')) {
            return;
          }

          deleteButton.disabled = true;
          cardStatus.textContent = 'Deleting...';
          cardStatus.className = 'card-status';
          card.style.opacity = '0.7';
          setStatus('Deleting ' + item.title + '...');
          try {
            const response = await fetch(appBaseUrl + '/admin/media/' + encodeURIComponent(item.id) + '/delete', {
              method: 'POST',
              headers: authHeaders()
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.ok === false) {
              throw new Error(data.error || 'Delete failed with status ' + response.status);
            }
            if (Array.isArray(data.warnings) && data.warnings.length > 0) {
              setStatus('Deleted ' + item.title + ' with cleanup warnings.', 'error');
              cardStatus.textContent = data.warnings[0];
              cardStatus.className = 'card-status error';
            } else {
              setStatus('Deleted ' + item.title + '.', 'ok');
              cardStatus.textContent = 'Deleted';
              cardStatus.className = 'card-status ok';
            }
            await loadMedia();
          } catch (error) {
            card.style.opacity = '1';
            setStatus(error instanceof Error ? error.message : 'Delete failed', 'error');
            cardStatus.textContent = error instanceof Error ? error.message : 'Delete failed';
            cardStatus.className = 'card-status error';
            deleteButton.disabled = false;
          }
        });

        card.appendChild(cover);
        card.appendChild(content);
        const actions = document.createElement('div');
        actions.className = 'card-actions';
        actions.appendChild(cardStatus);
        actions.appendChild(deleteButton);
        content.appendChild(actions);
        return card;
      }

      async function loadMedia() {
        mediaGrid.innerHTML = '';
        summary.textContent = 'Loading media...';
        try {
          const response = await fetch(appBaseUrl + '/admin/media', {
            headers: authHeaders()
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.ok === false) {
            throw new Error(data.error || 'Failed to load media');
          }

          const items = data.media || [];
          summary.textContent = items.length + ' media item' + (items.length === 1 ? '' : 's') + ' found';
          if (!items.length) {
            mediaGrid.innerHTML = '<div class="empty">No uploaded media found.</div>';
            return;
          }

          for (const item of items) {
            mediaGrid.appendChild(renderCard(item));
          }
        } catch (error) {
          summary.textContent = 'Unable to load media';
          mediaGrid.innerHTML = '<div class="empty">Media list could not be loaded.</div>';
          setStatus(error instanceof Error ? error.message : 'Failed to load media', 'error');
        }
      }

      adminKey.value = window.localStorage.getItem('adminKey') || '';
      adminKey.addEventListener('input', () => {
        if (adminKey.value.trim()) {
          window.localStorage.setItem('adminKey', adminKey.value.trim());
          keyStatus.textContent = 'Key entered, not yet checked.';
          keyStatus.className = 'key-status';
        } else {
          window.localStorage.removeItem('adminKey');
          keyStatus.textContent = 'Not checked yet';
          keyStatus.className = 'key-status';
        }
      });
      checkKeyButton.addEventListener('click', () => {
        checkAdminKey().catch(() => {});
      });
      loadMedia();
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

  app.get('/media-manager', async (_request, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(renderMediaManagerPage(config.APP_BASE_URL));
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

  async function getOpenSubsonicExtensions(request: FastifyRequest, reply: FastifyReply) {
    return sendSubsonicOk(
      request,
      reply,
      wrapSubsonicResponse(xmlElement('openSubsonicExtensions')),
      { openSubsonicExtensions: [] }
    );
  }

  app.get('/rest/getOpenSubsonicExtensions.view', getOpenSubsonicExtensions);
  app.get('/rest/getOpenSubsonicExtensions', getOpenSubsonicExtensions);

  app.get('/rest/getMusicFolders.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
    return sendSubsonicOk(
      request,
      reply,
      wrapSubsonicResponse(renderMusicFolders()),
      { musicFolders: { musicFolder: [{ id: 'root', name: 'Library' }] } }
    );
  });

  app.get('/rest/getIndexes.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
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
    const [tracks, catalog] = await Promise.all([listTracks(), loadCatalogMaps()]);
    const index = Object.keys(sections).sort().map((section) => ({
      name: section,
      artist: sections[section].map((artist) => jsonArtist(artist, catalog.albums.filter((album) => album.artist_id === artist.id).length))
    }));
    const child = tracks.map((track) => {
      const album = catalog.albumById.get(track.album_id);
      const artist = track.artist_id ? catalog.artistById.get(track.artist_id) : undefined;
      return jsonTrack(track, album, artist);
    });
    return sendSubsonicOk(
      request,
      reply,
      wrapSubsonicResponse(body),
      { indexes: { index, child, lastModified: Date.now(), ignoredArticles: 'The El La Los Las Le Les' } }
    );
  });

  app.get('/rest/getArtists.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
    const artists = await listArtists();
    const body = xmlElement('artists', {}, artists.map((artist) => xmlElement('artist', {
      id: `artist:${artist.id}`,
      name: artist.name,
      albumCount: 0
    })).join(''));
    const albums = await listAlbums();
    return sendSubsonicOk(
      request,
      reply,
      wrapSubsonicResponse(body),
      { artists: { index: [{ name: 'A-Z', artist: artists.map((artist) => jsonArtist(artist, albums.filter((album) => album.artist_id === artist.id).length)) }] } }
    );
  });

  app.get('/rest/getMusicDirectory.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
    const query = request.query as Record<string, string | undefined>;
    const id = query.id;
    if (!id) return sendSubsonicError(request, reply, 10, 'Missing id');

    if (id === 'root') {
      const artists = await listArtists();
      const body = xmlElement('directory', { id: 'root', name: 'Library', isDir: true }, artists.map((artist) => xmlElement('artist', {
        id: `artist:${artist.id}`,
        name: artist.name,
        albumCount: 0
      })).join(''));
      return sendSubsonicOk(
        request,
        reply,
        wrapSubsonicResponse(body),
        { directory: { id: 'root', name: 'Library', child: artists.map((artist) => ({ ...jsonArtist(artist), isDir: true })) } }
      );
    }

    const artistId = getCleanId(id, 'artist:');
    if (artistId) {
      const artist = await getArtistById(artistId);
      if (!artist) return sendSubsonicError(request, reply, 70, 'Artist not found');
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
      return sendSubsonicOk(
        request,
        reply,
        wrapSubsonicResponse(body),
        { directory: { id: `artist:${artist.id}`, name: artist.name, child: albums.map((album) => jsonAlbum(album, artist)) } }
      );
    }

    const albumId = getCleanId(id, 'album:');
    if (albumId) {
      const album = await getAlbumById(albumId);
      if (!album) return sendSubsonicError(request, reply, 70, 'Album not found');
      const tracks = await listTracksByAlbum(albumId);
      const artist = await getArtistById(album.artist_id);
      return sendSubsonicOk(
        request,
        reply,
        wrapSubsonicResponse(renderAlbumDirectory(album, tracks, artist?.name ?? '')),
        { directory: { id: `album:${album.id}`, name: album.title, child: tracks.map((track) => jsonTrack(track, album, artist ?? undefined)) } }
      );
    }

    const trackId = getCleanId(id, 'track:');
    if (trackId) {
      const track = await getTrackById(trackId);
      if (!track) return sendSubsonicError(request, reply, 70, 'Track not found');
      const catalog = await loadCatalogMaps();
      const album = catalog.albumById.get(track.album_id);
      const artist = track.artist_id ? catalog.artistById.get(track.artist_id) : undefined;
      return sendSubsonicOk(
        request,
        reply,
        wrapSubsonicResponse(renderSong(track)),
        { directory: { id: `track:${track.id}`, name: track.title, child: [jsonTrack(track, album, artist)] } }
      );
    }

    return sendSubsonicError(request, reply, 10, 'Unsupported id type');
  });

  app.get('/rest/getCoverArt.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicXml(reply, subsonicErrorXml(40, 'Authentication failed'));
    const query = request.query as Record<string, string | undefined>;
    const id = query.id;
    if (!id) return sendSubsonicXml(reply, subsonicErrorXml(10, 'Missing id'));

    const trackId = getPrefixedId(id, 'track:');
    const albumId = getPrefixedId(id, 'album:');
    const track = trackId ? await getTrackById(trackId) : null;
    const album = albumId ? await getAlbumById(albumId) : null;
    const objectKey = track?.source_thumbnail_key ?? album?.cover_art_key ?? (id.startsWith('art/') ? id : null);
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
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
    const rawQuery = (request.query as Record<string, string | undefined>).query;
    if (rawQuery === undefined) return sendSubsonicError(request, reply, 10, 'Missing query');
    const q = normalizeSubsonicSearchQuery(rawQuery);
    const payload = q
      ? await searchCatalog(q)
      : {
          artists: await listArtists(),
          albums: await listAlbums(),
          tracks: await listTracks()
        };
    const catalog = await loadCatalogMaps();
    const artistOffset = getNumberQuery(request, 'artistOffset', 0);
    const artistCount = getNumberQuery(request, 'artistCount', 20);
    const albumOffset = getNumberQuery(request, 'albumOffset', 0);
    const albumCount = getNumberQuery(request, 'albumCount', 20);
    const songOffset = getNumberQuery(request, 'songOffset', 0);
    const songCount = getNumberQuery(request, 'songCount', 20);
    const artists = sliceForSubsonic(payload.artists, artistOffset, artistCount);
    const albums = sliceForSubsonic(payload.albums, albumOffset, albumCount);
    const tracks = sliceForSubsonic(payload.tracks, songOffset, songCount);
    return sendSubsonicOk(
      request,
      reply,
      wrapSubsonicResponse(renderSearchResults(payload)),
      {
        searchResult3: {
          artist: artists.map((artist) => jsonArtist(artist, catalog.albums.filter((album) => album.artist_id === artist.id).length)),
          album: albums.map((album) => jsonAlbum(album, catalog.artistById.get(album.artist_id))),
          song: tracks.map((track) => {
            const album = catalog.albumById.get(track.album_id);
            const artist = track.artist_id ? catalog.artistById.get(track.artist_id) : undefined;
            return jsonTrack(track, album, artist);
          })
        }
      }
    );
  });

  app.get('/rest/getGenres.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
    const albums = await listAlbums();
    const genreCounts = albums.reduce<Record<string, { albumCount: number; songCount: number }>>((acc, album) => {
      if (!album.genre) return acc;
      acc[album.genre] ??= { albumCount: 0, songCount: 0 };
      acc[album.genre].albumCount += 1;
      acc[album.genre].songCount += album.track_count;
      return acc;
    }, {});
    const genre = Object.entries(genreCounts).map(([value, counts]) => ({
      value,
      albumCount: counts.albumCount,
      songCount: counts.songCount
    }));
    return sendSubsonicOk(
      request,
      reply,
      wrapSubsonicResponse(xmlElement('genres')),
      { genres: { genre } }
    );
  });

  app.get('/rest/getStarred2.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
    return sendSubsonicOk(
      request,
      reply,
      wrapSubsonicResponse(xmlElement('starred2')),
      { starred2: { artist: [], album: [], song: [] } }
    );
  });

  app.get('/rest/getBookmarks.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
    return sendSubsonicOk(
      request,
      reply,
      wrapSubsonicResponse(xmlElement('bookmarks')),
      { bookmarks: { bookmark: [] } }
    );
  });

  app.get('/rest/getAlbumList2.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
    const rows = await listAlbums();
    const catalog = await loadCatalogMaps();
    return sendSubsonicOk(
      request,
      reply,
      wrapSubsonicResponse(renderAlbumList(rows.slice(0, 100))),
      { albumList2: { album: rows.slice(0, 100).map((album) => jsonAlbum(album, catalog.artistById.get(album.artist_id))) } }
    );
  });

  app.get('/rest/getSong.view', async (request, reply) => {
    const user = await ensureAuth(request);
    if (!user) return sendSubsonicError(request, reply, 40, 'Authentication failed');
    const id = (request.query as Record<string, string | undefined>).id;
    if (!id) return sendSubsonicError(request, reply, 10, 'Missing id');
    const trackId = getCleanId(id, 'track:') ?? id;
    const track = await getTrackById(trackId);
    if (!track) return sendSubsonicError(request, reply, 70, 'Track not found');
    const catalog = await loadCatalogMaps();
    const album = catalog.albumById.get(track.album_id);
    const artist = track.artist_id ? catalog.artistById.get(track.artist_id) : undefined;
    return sendSubsonicOk(
      request,
      reply,
      wrapSubsonicResponse(renderSong(track)),
      { song: jsonTrack(track, album, artist) }
    );
  });
}
