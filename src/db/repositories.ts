import { query } from './pool.js';
import type { AlbumRow, ArtistRow, TrackRow, UserRow } from '../types.js';

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const result = await query<UserRow>('select id, email, password_hash, role from users where email = $1 limit 1', [email]);
  return result.rows[0] ?? null;
}

export async function ensureAdminUser(email: string, passwordHash: string): Promise<void> {
  const existing = await getUserByEmail(email);
  if (existing) return;
  await query(
    'insert into users (email, password_hash, role) values ($1, $2, $3)',
    [email, passwordHash, 'admin']
  );
}

export async function listArtists(): Promise<ArtistRow[]> {
  const result = await query<ArtistRow>('select id, name, sort_name from artists order by coalesce(sort_name, name) asc');
  return result.rows;
}

export async function listAlbums(): Promise<AlbumRow[]> {
  const result = await query<AlbumRow>(
    'select id, artist_id, title, sort_title, year, genre, cover_art_key, track_count, duration_seconds from albums order by coalesce(year, 0) desc, coalesce(sort_title, title) asc'
  );
  return result.rows;
}

export async function getArtistById(id: string): Promise<ArtistRow | null> {
  const result = await query<ArtistRow>('select id, name, sort_name from artists where id = $1 limit 1', [id]);
  return result.rows[0] ?? null;
}

export async function listAlbumsByArtist(artistId: string): Promise<AlbumRow[]> {
  const result = await query<AlbumRow>(
    'select id, artist_id, title, sort_title, year, genre, cover_art_key, track_count, duration_seconds from albums where artist_id = $1 order by coalesce(year, 0) desc, coalesce(sort_title, title) asc',
    [artistId]
  );
  return result.rows;
}

export async function getAlbumById(id: string): Promise<AlbumRow | null> {
  const result = await query<AlbumRow>(
    'select id, artist_id, title, sort_title, year, genre, cover_art_key, track_count, duration_seconds from albums where id = $1 limit 1',
    [id]
  );
  return result.rows[0] ?? null;
}

export async function listTracksByAlbum(albumId: string): Promise<TrackRow[]> {
  const result = await query<TrackRow>(
    'select id, album_id, artist_id, title, sort_title, track_number, disc_number, duration_seconds, bitrate, mime_type, file_suffix, audio_key, file_size, checksum, source_url, source_title, source_thumbnail_key from tracks where album_id = $1 order by coalesce(disc_number, 1), coalesce(track_number, 0), coalesce(sort_title, title)',
    [albumId]
  );
  return result.rows;
}

export async function getTrackById(id: string): Promise<TrackRow | null> {
  const result = await query<TrackRow>(
    'select id, album_id, artist_id, title, sort_title, track_number, disc_number, duration_seconds, bitrate, mime_type, file_suffix, audio_key, file_size, checksum, source_url, source_title, source_thumbnail_key from tracks where id = $1 limit 1',
    [id]
  );
  return result.rows[0] ?? null;
}

export async function searchCatalog(search: string) {
  const q = `%${search}%`;
  const [artists, albums, tracks] = await Promise.all([
    query<ArtistRow>('select id, name, sort_name from artists where name ilike $1 order by coalesce(sort_name, name)', [q]),
    query<AlbumRow>('select id, artist_id, title, sort_title, year, genre, cover_art_key, track_count, duration_seconds from albums where title ilike $1 order by coalesce(sort_title, title)', [q]),
    query<TrackRow>('select id, album_id, artist_id, title, sort_title, track_number, disc_number, duration_seconds, bitrate, mime_type, file_suffix, audio_key, file_size, checksum, source_url, source_title, source_thumbnail_key from tracks where title ilike $1 order by coalesce(sort_title, title)', [q])
  ]);

  return {
    artists: artists.rows,
    albums: albums.rows,
    tracks: tracks.rows
  };
}

export async function createOrUpdateArtist(input: { id?: string; name: string; sortName?: string | null }) {
  const result = await query<ArtistRow>(
    `insert into artists (id, name, sort_name)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3)
     on conflict (id) do update set name = excluded.name, sort_name = excluded.sort_name
     returning id, name, sort_name`,
    [input.id ?? null, input.name, input.sortName ?? null]
  );
  return result.rows[0];
}

export async function createOrUpdateAlbum(input: {
  id?: string;
  artistId: string;
  title: string;
  sortTitle?: string | null;
  year?: number | null;
  genre?: string | null;
  coverArtKey?: string | null;
}) {
  const result = await query<AlbumRow>(
    `insert into albums (id, artist_id, title, sort_title, year, genre, cover_art_key)
     values (coalesce($1::uuid, gen_random_uuid()), $2::uuid, $3, $4, $5, $6, $7)
     on conflict (id) do update set artist_id = excluded.artist_id, title = excluded.title, sort_title = excluded.sort_title, year = excluded.year, genre = excluded.genre, cover_art_key = excluded.cover_art_key
     returning id, artist_id, title, sort_title, year, genre, cover_art_key, track_count, duration_seconds`,
    [input.id ?? null, input.artistId, input.title, input.sortTitle ?? null, input.year ?? null, input.genre ?? null, input.coverArtKey ?? null]
  );
  return result.rows[0];
}

export async function createOrUpdateTrack(input: {
  id?: string;
  albumId: string;
  artistId?: string | null;
  title: string;
  sortTitle?: string | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  durationSeconds: number;
  bitrate?: number | null;
  mimeType: string;
  fileSuffix: string;
  audioKey: string;
  fileSize: number;
  checksum?: string | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourceThumbnailKey?: string | null;
}) {
  const result = await query<TrackRow>(
    `insert into tracks (
      id, album_id, artist_id, title, sort_title, track_number, disc_number, duration_seconds, bitrate, mime_type, file_suffix, audio_key, file_size, checksum, source_url, source_title, source_thumbnail_key
    ) values (
      coalesce($1::uuid, gen_random_uuid()), $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
    )
    on conflict (id) do update set
      album_id = excluded.album_id,
      artist_id = excluded.artist_id,
      title = excluded.title,
      sort_title = excluded.sort_title,
      track_number = excluded.track_number,
      disc_number = excluded.disc_number,
      duration_seconds = excluded.duration_seconds,
      bitrate = excluded.bitrate,
      mime_type = excluded.mime_type,
      file_suffix = excluded.file_suffix,
      audio_key = excluded.audio_key,
      file_size = excluded.file_size,
      checksum = excluded.checksum,
      source_url = excluded.source_url,
      source_title = excluded.source_title,
      source_thumbnail_key = excluded.source_thumbnail_key
    returning id, album_id, artist_id, title, sort_title, track_number, disc_number, duration_seconds, bitrate, mime_type, file_suffix, audio_key, file_size, checksum, source_url, source_title, source_thumbnail_key`,
    [
      input.id ?? null,
      input.albumId,
      input.artistId ?? null,
      input.title,
      input.sortTitle ?? null,
      input.trackNumber ?? null,
      input.discNumber ?? null,
      input.durationSeconds,
      input.bitrate ?? null,
      input.mimeType,
      input.fileSuffix,
      input.audioKey,
      input.fileSize,
      input.checksum ?? null,
      input.sourceUrl ?? null,
      input.sourceTitle ?? null,
      input.sourceThumbnailKey ?? null
    ]
  );

  await query(
    `update albums
     set track_count = (
       select count(*) from tracks where album_id = $1
     ),
     duration_seconds = coalesce((
       select sum(duration_seconds)::int from tracks where album_id = $1
     ), 0),
     updated_at = now()
     where id = $1`,
    [input.albumId]
  );

  return result.rows[0];
}
