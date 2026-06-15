create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  role text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz null
);

create table if not exists artists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_name text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists albums (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists(id) on delete cascade,
  title text not null,
  sort_title text null,
  year integer null,
  genre text null,
  cover_art_key text null,
  track_count integer not null default 0,
  duration_seconds integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tracks (
  id uuid primary key default gen_random_uuid(),
  album_id uuid not null references albums(id) on delete cascade,
  artist_id uuid null references artists(id) on delete set null,
  title text not null,
  sort_title text null,
  track_number integer null,
  disc_number integer null,
  duration_seconds integer not null,
  bitrate integer null,
  mime_type text not null,
  file_suffix text not null default 'mp3',
  audio_key text not null,
  file_size bigint not null,
  checksum text null,
  source_url text null,
  source_title text null,
  source_thumbnail_key text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists imports (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending',
  source_url text null,
  source_title text null,
  source_thumbnail_url text null,
  thumbnail_key text null,
  audio_key text null,
  track_id uuid null references tracks(id) on delete set null,
  error_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists playlist_tracks (
  playlist_id uuid not null references playlists(id) on delete cascade,
  track_id uuid not null references tracks(id) on delete cascade,
  position integer not null,
  added_at timestamptz not null default now(),
  primary key (playlist_id, track_id)
);

create table if not exists scrobbles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  track_id uuid not null references tracks(id) on delete cascade,
  played_at timestamptz not null default now(),
  seconds_played integer not null default 0,
  completed boolean not null default false
);

create index if not exists idx_artists_name on artists (name);
create index if not exists idx_artists_sort_name on artists (sort_name);
create index if not exists idx_albums_artist_id on albums (artist_id);
create index if not exists idx_albums_title on albums (title);
create index if not exists idx_tracks_album_id on tracks (album_id);
create index if not exists idx_tracks_artist_id on tracks (artist_id);
create index if not exists idx_tracks_title on tracks (title);
create index if not exists idx_imports_status on imports (status);
create index if not exists idx_playlist_tracks_playlist_id_position on playlist_tracks (playlist_id, position);
create index if not exists idx_auth_tokens_token_hash on auth_tokens (token_hash);
create index if not exists idx_scrobbles_user_id_played_at on scrobbles (user_id, played_at);
