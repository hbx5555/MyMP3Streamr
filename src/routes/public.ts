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

export async function registerPublicRoutes(app: FastifyInstance) {
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
