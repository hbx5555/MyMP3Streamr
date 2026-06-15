export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  role: string;
};

export type ArtistRow = {
  id: string;
  name: string;
  sort_name: string | null;
};

export type AlbumRow = {
  id: string;
  artist_id: string;
  title: string;
  sort_title: string | null;
  year: number | null;
  genre: string | null;
  cover_art_key: string | null;
  track_count: number;
  duration_seconds: number;
};

export type TrackRow = {
  id: string;
  album_id: string;
  artist_id: string | null;
  title: string;
  sort_title: string | null;
  track_number: number | null;
  disc_number: number | null;
  duration_seconds: number;
  bitrate: number | null;
  mime_type: string;
  file_suffix: string;
  audio_key: string;
  file_size: number;
  checksum: string | null;
  source_url: string | null;
  source_title: string | null;
  source_thumbnail_key: string | null;
};
