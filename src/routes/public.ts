import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateRequest, AuthError } from '../auth/index.js';
import { config } from '../config.js';
import { getAlbumById, getArtistById, getTrackById, listAlbums, listAlbumsByArtist, listArtists, listTracksByAlbum, searchCatalog } from '../db/repositories.js';
import { getR2Object } from '../storage/r2.js';
import { renderAlbumDirectory, renderAlbumList, renderMusicFolders, renderPing, renderSearchResults, renderSong } from '../catalog/format.js';
import { subsonicErrorXml, wrapSubsonicResponse, xmlElement } from '../utils/subsonic.js';

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
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
        background: #0f1115;
        color: #e5e7eb;
        display: grid;
        place-items: center;
      }
      .card {
        width: min(760px, calc(100vw - 32px));
        background: #171a21;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 20px;
        padding: 28px;
      }
      h1 { margin: 0 0 12px; }
      p { color: #9ca3af; line-height: 1.6; }
      code {
        background: #1f2430;
        padding: 2px 6px;
        border-radius: 6px;
        color: #7dd3fc;
      }
      ul { line-height: 1.9; }
      a { color: #7dd3fc; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Admin Panel</h1>
      <p>This is a lightweight admin landing page for test ingestion. Use the API endpoints below with your admin key.</p>
      <ul>
        <li><code>POST ${appBaseUrl}/admin/bootstrap-import</code></li>
        <li><code>POST ${appBaseUrl}/admin/import</code></li>
        <li><code>POST ${appBaseUrl}/admin/upload-url</code></li>
      </ul>
      <p>Auth: <code>Authorization: Bearer &lt;ADMIN_API_KEY&gt;</code> or <code>x-admin-key</code>.</p>
      <p><a href="/">Back to home</a></p>
    </main>
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
    if (!user) return sendSubsonicXml(reply, subsonicErrorXml(40, 'Authentication failed'));
    return sendSubsonicXml(reply, wrapSubsonicResponse(renderPing()));
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
