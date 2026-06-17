import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { createOrUpdateAlbum, createOrUpdateArtist, createOrUpdateTrack, listMediaItems } from '../db/repositories.js';
import { deleteR2Object, presignR2Get, presignR2Put } from '../storage/r2.js';
import { randomId } from '../utils/crypto.js';
import { createYoutubeImport, getYoutubeImport } from '../services/youtube-import.js';

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

  app.get('/admin/media', async (_request, reply) => {
    const media = await listMediaItems();
    const items = await Promise.all(media.map(async (item) => ({
      ...item,
      coverUrl: item.cover_key ? await presignR2Get(item.cover_key, 1800) : null
    })));
    return reply.send({ ok: true, media: items });
  });

  app.delete('/admin/media/:trackId', async (request, reply) => {
    const params = request.params as { trackId: string };
    const trackId = params.trackId?.trim();
    if (!trackId) {
      return reply.code(400).send({ ok: false, error: 'Missing trackId' });
    }

    const client = await pool.connect();
    const cleanupKeys = new Set<string>();
    const deletedImportIds: string[] = [];
    let albumDeleted = false;
    let artistDeleted = false;
    let mediaRow: {
      id: string;
      album_id: string;
      artist_id: string | null;
      audio_key: string;
      source_thumbnail_key: string | null;
    } | null = null;
    let albumRow: { id: string; artist_id: string; cover_art_key: string | null } | null = null;

    try {
      await client.query('begin');

      const trackResult = await client.query<{
        id: string;
        album_id: string;
        artist_id: string | null;
        audio_key: string;
        source_thumbnail_key: string | null;
      }>(
        `select id, album_id, artist_id, audio_key, source_thumbnail_key
         from tracks
         where id = $1::uuid
         limit 1
         for update`,
        [trackId]
      );
      mediaRow = trackResult.rows[0] ?? null;
      if (!mediaRow) {
        await client.query('rollback');
        return reply.code(404).send({ ok: false, error: 'Media not found' });
      }

      const albumResult = await client.query<{ id: string; artist_id: string; cover_art_key: string | null }>(
        `select id, artist_id, cover_art_key
         from albums
         where id = $1::uuid
         limit 1
         for update`,
        [mediaRow.album_id]
      );
      albumRow = albumResult.rows[0] ?? null;
      if (!albumRow) {
        throw new Error('Album not found for media item');
      }

      const importResult = await client.query<{ id: string }>(
        `delete from imports
         where track_id = $1::uuid
            or audio_key = $2
            or thumbnail_key = $3
         returning id`,
        [mediaRow.id, mediaRow.audio_key, mediaRow.source_thumbnail_key]
      );
      deletedImportIds.push(...importResult.rows.map((row) => row.id));

      await client.query('delete from tracks where id = $1::uuid', [mediaRow.id]);

      const remainingTracks = await client.query<{ count: string }>(
        'select count(*)::text as count from tracks where album_id = $1::uuid',
        [albumRow.id]
      );
      if (Number(remainingTracks.rows[0]?.count ?? '0') === 0) {
        await client.query('delete from albums where id = $1::uuid', [albumRow.id]);
        albumDeleted = true;

        const remainingAlbums = await client.query<{ count: string }>(
          'select count(*)::text as count from albums where artist_id = $1::uuid',
          [albumRow.artist_id]
        );
        if (Number(remainingAlbums.rows[0]?.count ?? '0') === 0) {
          await client.query('delete from artists where id = $1::uuid', [albumRow.artist_id]);
          artistDeleted = true;
        }
      }

      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    if (mediaRow) {
      cleanupKeys.add(mediaRow.audio_key);
      if (mediaRow.source_thumbnail_key && (!albumDeleted || mediaRow.source_thumbnail_key !== albumRow?.cover_art_key)) {
        cleanupKeys.add(mediaRow.source_thumbnail_key);
      }
    }
    if (albumDeleted && albumRow?.cover_art_key) {
      cleanupKeys.add(albumRow.cover_art_key);
    }
    for (const importId of deletedImportIds) {
      cleanupKeys.add(`imports/${importId}/source.json`);
    }

    const cleanupErrors: string[] = [];
    await Promise.all(Array.from(cleanupKeys).map(async (key) => {
      try {
        await deleteR2Object(key);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : `Failed to delete ${key}`);
      }
    }));

    return reply.send({
      ok: true,
      deleted: {
        trackId: mediaRow.id,
        albumDeleted,
        artistDeleted,
        importCount: deletedImportIds.length,
        r2KeysDeleted: Array.from(cleanupKeys)
      },
      ...(cleanupErrors.length > 0 ? { warnings: cleanupErrors } : {})
    });
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

  app.post('/admin/youtube-import', async (request, reply) => {
    const body = request.body as {
      sourceUrl: string;
      title?: string;
      artistName?: string;
      albumTitle?: string;
      thumbnailUrl?: string;
      year?: number;
      genre?: string;
    };

    if (!body?.sourceUrl) {
      return reply.code(400).send({ ok: false, error: 'Missing sourceUrl' });
    }

    try {
      const job = await createYoutubeImport({
        sourceUrl: body.sourceUrl,
        title: body.title,
        artistName: body.artistName,
        albumTitle: body.albumTitle,
        thumbnailUrl: body.thumbnailUrl,
        year: body.year,
        genre: body.genre
      });
      return reply.send({ ok: true, ...job });
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to start YouTube import'
      });
    }
  });

  app.get('/admin/youtube-import/:importId', async (request, reply) => {
    const params = request.params as { importId: string };
    const job = await getYoutubeImport(params.importId);
    if (!job) {
      return reply.code(404).send({ ok: false, error: 'Import not found' });
    }
    return reply.send({ ok: true, job });
  });

  app.get('/admin/reindex', async () => {
    return { ok: true };
  });
}
