import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { createOrUpdateAlbum, createOrUpdateArtist, createOrUpdateTrack } from '../db/repositories.js';
import { presignR2Put } from '../storage/r2.js';
import { randomId } from '../utils/crypto.js';

function requireAdminKey(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  const key = bearer ?? (request.headers['x-admin-key'] as string | undefined);
  if (key !== config.ADMIN_API_KEY) {
    reply.code(401).send({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/admin/')) {
      const allowed = requireAdminKey(request, reply);
      if (!allowed) {
        return;
      }
    }
  });

  app.post('/admin/import', async (request, reply) => {
    const body = request.body as {
      artistId?: string;
      albumId?: string;
      trackId?: string;
      importId?: string;
      artistName: string;
      albumTitle: string;
      trackTitle: string;
      audioKey: string;
      thumbnailKey?: string;
      durationSeconds: number;
      bitrate?: number;
      mimeType?: string;
      fileSuffix?: string;
      fileSize: number;
      sourceUrl?: string;
      sourceTitle?: string;
      year?: number;
      genre?: string;
    };

    if (!body?.artistName || !body.albumTitle || !body.trackTitle || !body.audioKey || !body.durationSeconds || !body.fileSize) {
      return reply.code(400).send({ ok: false, error: 'Missing required fields' });
    }

    const artist = await createOrUpdateArtist({ id: body.artistId, name: body.artistName });
    const album = await createOrUpdateAlbum({
      id: body.albumId,
      artistId: artist.id,
      title: body.albumTitle,
      year: body.year ?? null,
      genre: body.genre ?? null,
      coverArtKey: body.thumbnailKey ?? null
    });

    const track = await createOrUpdateTrack({
      id: body.trackId,
      albumId: album.id,
      artistId: artist.id,
      title: body.trackTitle,
      durationSeconds: body.durationSeconds,
      bitrate: body.bitrate ?? null,
      mimeType: body.mimeType ?? 'audio/mpeg',
      fileSuffix: body.fileSuffix ?? 'mp3',
      audioKey: body.audioKey,
      fileSize: body.fileSize,
      sourceUrl: body.sourceUrl ?? null,
      sourceTitle: body.sourceTitle ?? null,
      sourceThumbnailKey: body.thumbnailKey ?? null
    });

    if (body.importId) {
      await pool.query(
        `update imports
         set status = $2,
             source_url = coalesce($3, source_url),
             source_title = coalesce($4, source_title),
             thumbnail_key = coalesce($5, thumbnail_key),
             audio_key = coalesce($6, audio_key),
             track_id = $7::uuid,
             updated_at = now()
         where id = $1::uuid`,
        [
          body.importId,
          'complete',
          body.sourceUrl ?? null,
          body.sourceTitle ?? null,
          body.thumbnailKey ?? null,
          body.audioKey,
          track.id
        ]
      );
    }

    return reply.send({ ok: true, artist, album, track });
  });

  app.post('/admin/upload-url', async (request, reply) => {
    const body = request.body as { key: string; contentType?: string };
    if (!body?.key || !body.contentType) {
      return reply.code(400).send({ ok: false, error: 'Missing key' });
    }
    const uploadId = randomId('upload_');
    const url = await presignR2Put(body.key, body.contentType, 900);
    return reply.send({
      ok: true,
      uploadId,
      key: body.key,
      contentType: body.contentType,
      method: 'PUT',
      url
    });
  });

  app.post('/admin/bootstrap-import', async (request, reply) => {
    const body = request.body as {
      artistName: string;
      albumTitle: string;
      trackTitle: string;
      durationSeconds: number;
      bitrate?: number;
      mimeType?: string;
      fileSuffix?: string;
      year?: number;
      genre?: string;
      sourceUrl?: string;
      sourceTitle?: string;
      audioContentType?: string;
      coverContentType?: string;
    };

    if (!body?.artistName || !body.albumTitle || !body.trackTitle || !body.durationSeconds) {
      return reply.code(400).send({ ok: false, error: 'Missing required fields' });
    }

    const artistId = randomId();
    const albumId = randomId();
    const trackId = randomId();
    const importId = randomId();
    const audioKey = `audio/${trackId}/original.${body.fileSuffix ?? 'mp3'}`;
    const coverKey = `art/${albumId}/cover.jpg`;
    const audioUploadUrl = await presignR2Put(audioKey, body.audioContentType ?? 'audio/mpeg', 900);
    const coverUploadUrl = await presignR2Put(coverKey, body.coverContentType ?? 'image/jpeg', 900);

    await pool.query(
      `insert into imports (id, status, source_url, source_title, thumbnail_key, audio_key, created_at, updated_at)
       values ($1::uuid, $2, $3, $4, $5, $6, now(), now())`,
      [importId, 'pending', body.sourceUrl ?? null, body.sourceTitle ?? null, coverKey, audioKey]
    );

    const artist = await createOrUpdateArtist({ id: artistId, name: body.artistName });
    const album = await createOrUpdateAlbum({
      id: albumId,
      artistId: artist.id,
      title: body.albumTitle,
      year: body.year ?? null,
      genre: body.genre ?? null,
      coverArtKey: coverKey
    });
    const track = await createOrUpdateTrack({
      id: trackId,
      albumId: album.id,
      artistId: artist.id,
      title: body.trackTitle,
      durationSeconds: body.durationSeconds,
      bitrate: body.bitrate ?? null,
      mimeType: body.mimeType ?? 'audio/mpeg',
      fileSuffix: body.fileSuffix ?? 'mp3',
      audioKey,
      fileSize: 0,
      sourceUrl: body.sourceUrl ?? null,
      sourceTitle: body.sourceTitle ?? null,
      sourceThumbnailKey: coverKey
    });

    return reply.send({
      ok: true,
      importId,
      artist,
      album,
      track,
      audioKey,
      coverKey,
      audioUploadUrl,
      coverUploadUrl
    });
  });

  app.get('/admin/reindex', async () => {
    return { ok: true };
  });
}
