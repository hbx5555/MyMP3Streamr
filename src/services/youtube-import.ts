import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { createOrUpdateAlbum, createOrUpdateArtist, createOrUpdateTrack } from '../db/repositories.js';
import { putR2Object } from '../storage/r2.js';
import { randomId } from '../utils/crypto.js';

const execFileAsync = promisify(execFile);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be']);

type YoutubeImportInput = {
  sourceUrl: string;
  title?: string;
  artistName?: string;
  albumTitle?: string;
  thumbnailUrl?: string;
  year?: number;
  genre?: string;
};

type YoutubeMetadata = {
  title?: string;
  uploader?: string;
  channel?: string;
  thumbnail?: string;
  duration?: number;
  webpage_url?: string;
};

type ImportStatusRow = {
  id: string;
  status: string;
  source_url: string | null;
  source_title: string | null;
  source_thumbnail_url: string | null;
  thumbnail_key: string | null;
  audio_key: string | null;
  track_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type YoutubeImportJob = {
  importId: string;
  status: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceThumbnailUrl: string | null;
  thumbnailKey: string | null;
  audioKey: string | null;
  trackId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

function getCanonicalYoutubeUrl(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid YouTube URL');
  }

  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    throw new Error('Only YouTube URLs are supported');
  }

  if (host === 'youtu.be') {
    const videoId = parsed.pathname.split('/').filter(Boolean)[0];
    if (!videoId) throw new Error('Missing YouTube video id');
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  const videoId = parsed.searchParams.get('v');
  if (!videoId) {
    throw new Error('Missing YouTube video id');
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function writeCookiesFile(tmpDir: string) {
  if (!config.YTDLP_COOKIES_BASE64) return null;
  const cookiesPath = path.join(tmpDir, 'youtube-cookies.txt');
  await fs.writeFile(cookiesPath, Buffer.from(config.YTDLP_COOKIES_BASE64, 'base64'));
  return cookiesPath;
}

function getYtDlpBaseArgs(cookiesPath: string | null) {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--force-ipv4',
    '--extractor-args',
    'youtube:player_client=default,ios'
  ];

  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  }

  return args;
}

async function setImportStatus(importId: string, status: string, errorMessage?: string) {
  await pool.query(
    `update imports
     set status = $2,
         error_message = $3,
         updated_at = now()
     where id = $1::uuid`,
    [importId, status, errorMessage ?? null]
  );
}

async function updateImportOutput(input: {
  importId: string;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourceThumbnailUrl?: string | null;
  thumbnailKey?: string | null;
  audioKey?: string | null;
  trackId?: string | null;
}) {
  await pool.query(
    `update imports
     set source_url = coalesce($2, source_url),
         source_title = coalesce($3, source_title),
         source_thumbnail_url = coalesce($4, source_thumbnail_url),
         thumbnail_key = coalesce($5, thumbnail_key),
         audio_key = coalesce($6, audio_key),
         track_id = coalesce($7::uuid, track_id),
         updated_at = now()
     where id = $1::uuid`,
    [
      input.importId,
      input.sourceUrl ?? null,
      input.sourceTitle ?? null,
      input.sourceThumbnailUrl ?? null,
      input.thumbnailKey ?? null,
      input.audioKey ?? null,
      input.trackId ?? null
    ]
  );
}

async function getYoutubeMetadata(sourceUrl: string, cookiesPath: string | null): Promise<YoutubeMetadata> {
  const { stdout } = await execFileAsync('yt-dlp', [
    ...getYtDlpBaseArgs(cookiesPath),
    '--dump-json',
    sourceUrl
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000
  });
  return JSON.parse(stdout) as YoutubeMetadata;
}

async function extractMp3(sourceUrl: string, tmpDir: string, cookiesPath: string | null) {
  const outputTemplate = path.join(tmpDir, 'source.%(ext)s');
  await execFileAsync('yt-dlp', [
    ...getYtDlpBaseArgs(cookiesPath),
    '--extract-audio',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '0',
    '--output',
    outputTemplate,
    sourceUrl
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 15 * 60_000
  });

  const files = await fs.readdir(tmpDir);
  const mp3 = files.find((file) => file.endsWith('.mp3'));
  if (!mp3) {
    throw new Error('yt-dlp did not produce an MP3 file');
  }
  return path.join(tmpDir, mp3);
}

async function downloadThumbnail(thumbnailUrl: string) {
  const response = await fetch(thumbnailUrl);
  if (!response.ok) {
    throw new Error(`Thumbnail download failed with status ${response.status}`);
  }
  const contentType = response.headers.get('content-type') ?? 'image/jpeg';
  const body = Buffer.from(await response.arrayBuffer());
  return { body, contentType };
}

async function runYoutubeImport(importId: string, input: YoutubeImportInput) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `mymp3streamr-${importId}-`));
  try {
    const canonicalSourceUrl = getCanonicalYoutubeUrl(input.sourceUrl);
    const cookiesPath = await writeCookiesFile(tmpDir);
    await setImportStatus(importId, 'metadata');
    const metadata = await getYoutubeMetadata(canonicalSourceUrl, cookiesPath);
    const sourceTitle = input.title?.trim() || metadata.title || 'YouTube Track';
    const artistName = input.artistName?.trim() || metadata.uploader || metadata.channel || 'YouTube';
    const albumTitle = input.albumTitle?.trim() || sourceTitle;
    const thumbnailUrl = input.thumbnailUrl?.trim() || metadata.thumbnail || null;
    const sourceUrl = metadata.webpage_url || canonicalSourceUrl;

    await updateImportOutput({
      importId,
      sourceUrl,
      sourceTitle,
      sourceThumbnailUrl: thumbnailUrl
    });

    await setImportStatus(importId, 'extracting');
    const mp3Path = await extractMp3(canonicalSourceUrl, tmpDir, cookiesPath);
    const mp3 = await fs.readFile(mp3Path);
    const stat = await fs.stat(mp3Path);

    await setImportStatus(importId, 'uploading');
    const artistId = randomId();
    const albumId = randomId();
    const trackId = randomId();
    const audioKey = `audio/${trackId}/original.mp3`;
    const coverKey = thumbnailUrl ? `art/${albumId}/cover.jpg` : null;

    await putR2Object(audioKey, mp3, 'audio/mpeg');

    if (thumbnailUrl && coverKey) {
      const cover = await downloadThumbnail(thumbnailUrl);
      await putR2Object(coverKey, cover.body, cover.contentType);
    }

    await setImportStatus(importId, 'saving');
    const artist = await createOrUpdateArtist({ id: artistId, name: artistName });
    const album = await createOrUpdateAlbum({
      id: albumId,
      artistId: artist.id,
      title: albumTitle,
      year: input.year ?? null,
      genre: input.genre ?? null,
      coverArtKey: coverKey
    });
    const track = await createOrUpdateTrack({
      id: trackId,
      albumId: album.id,
      artistId: artist.id,
      title: sourceTitle,
      durationSeconds: Math.max(1, Math.round(metadata.duration ?? 1)),
      bitrate: 320,
      mimeType: 'audio/mpeg',
      fileSuffix: 'mp3',
      audioKey,
      fileSize: stat.size,
      sourceUrl,
      sourceTitle,
      sourceThumbnailKey: coverKey
    });

    await putR2Object(`imports/${importId}/source.json`, JSON.stringify({
      input,
      metadata,
      artist,
      album,
      track,
      audioKey,
      coverKey
    }, null, 2), 'application/json');

    await updateImportOutput({
      importId,
      sourceUrl,
      sourceTitle,
      sourceThumbnailUrl: thumbnailUrl,
      thumbnailKey: coverKey,
      audioKey,
      trackId: track.id
    });
    await setImportStatus(importId, 'complete');
  } catch (error) {
    await setImportStatus(importId, 'failed', error instanceof Error ? error.message : 'YouTube import failed');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function createYoutubeImport(input: YoutubeImportInput) {
  const canonicalSourceUrl = getCanonicalYoutubeUrl(input.sourceUrl);

  const importId = randomId();
  await pool.query(
    `insert into imports (id, status, source_url, source_title, source_thumbnail_url, created_at, updated_at)
     values ($1::uuid, $2, $3, $4, $5, now(), now())`,
    [importId, 'queued', canonicalSourceUrl, input.title ?? null, input.thumbnailUrl ?? null]
  );

  void runYoutubeImport(importId, { ...input, sourceUrl: canonicalSourceUrl });

  return {
    importId,
    status: 'queued'
  };
}

export async function getYoutubeImport(importId: string): Promise<YoutubeImportJob | null> {
  const result = await pool.query<ImportStatusRow>(
    `select id, status, source_url, source_title, source_thumbnail_url, thumbnail_key, audio_key, track_id, error_message, created_at, updated_at
     from imports
     where id = $1::uuid
     limit 1`,
    [importId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    importId: row.id,
    status: row.status,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    sourceThumbnailUrl: row.source_thumbnail_url,
    thumbnailKey: row.thumbnail_key,
    audioKey: row.audio_key,
    trackId: row.track_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
