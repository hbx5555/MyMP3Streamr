import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
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

    const artist = await createOrUpdateArtist({ name: body.artistName });
    const album = await createOrUpdateAlbum({
      artistId: artist.id,
      title: body.albumTitle,
      year: body.year ?? null,
      genre: body.genre ?? null,
      coverArtKey: body.thumbnailKey ?? null
    });

    const track = await createOrUpdateTrack({
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

  app.get('/admin/reindex', async () => {
    return { ok: true };
  });
}
