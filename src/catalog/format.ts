import type { AlbumRow, ArtistRow, TrackRow } from '../types.js';
import { xmlElement, xmlTextElement } from '../utils/subsonic.js';

export function renderArtists(artists: ArtistRow[]): string {
  return artists.map((artist) => xmlElement('artist', {
    id: `artist:${artist.id}`,
    name: artist.name,
    albumCount: 0
  })).join('');
}

export function renderAlbums(albums: AlbumRow[]): string {
  return albums.map((album) => xmlElement('album', {
    id: `album:${album.id}`,
    name: album.title,
    title: album.title,
    artist: '',
    coverArt: album.cover_art_key ?? '',
    songCount: album.track_count,
    duration: album.duration_seconds,
    year: album.year ?? ''
  })).join('');
}

export function renderTracks(tracks: TrackRow[]): string {
  return tracks.map((track) => xmlElement('song', {
    id: `track:${track.id}`,
    parent: `album:${track.album_id}`,
    title: track.title,
    album: '',
    artist: '',
    track: track.track_number ?? '',
    discNumber: track.disc_number ?? '',
    duration: track.duration_seconds,
    bitRate: track.bitrate ?? '',
    contentType: track.mime_type,
    suffix: track.file_suffix,
    isDir: false,
    coverArt: track.source_thumbnail_key ?? ''
  })).join('');
}

export function renderArtistSection(name: string, artists: ArtistRow[]): string {
  return xmlElement('index', { name }, renderArtists(artists));
}

export function renderTrackDirectory(track: TrackRow): string {
  return xmlElement('directory', {
    id: `track:${track.id}`,
    parent: `album:${track.album_id}`,
    title: track.title,
    album: '',
    artist: '',
    track: track.track_number ?? '',
    discNumber: track.disc_number ?? '',
    duration: track.duration_seconds,
    bitRate: track.bitrate ?? '',
    contentType: track.mime_type,
    suffix: track.file_suffix,
    isDir: false,
    coverArt: track.source_thumbnail_key ?? ''
  });
}

export function renderAlbumDirectory(album: AlbumRow, tracks: TrackRow[], artistName = ''): string {
  return xmlElement('directory', {
    id: `album:${album.id}`,
    parent: `artist:${album.artist_id}`,
    name: album.title,
    title: album.title,
    artist: artistName,
    year: album.year ?? '',
    songCount: album.track_count,
    duration: album.duration_seconds,
    coverArt: album.cover_art_key ?? '',
    isDir: true
  }, tracks.map(renderTrackDirectory).join(''));
}

export function renderMusicFolders(): string {
  return xmlElement('musicFolders', {}, xmlElement('musicFolder', { id: 'root', name: 'Library' }));
}

export function renderSearchResults(payload: {
  artists: ArtistRow[];
  albums: AlbumRow[];
  tracks: TrackRow[];
}): string {
  return xmlElement('searchResult3', {},
    xmlElement('artists', {}, payload.artists.map((artist) => xmlElement('artist', {
      id: `artist:${artist.id}`,
      name: artist.name,
      albumCount: 0
    })).join('')) +
    xmlElement('albums', {}, payload.albums.map((album) => xmlElement('album', {
      id: `album:${album.id}`,
      name: album.title,
      artist: '',
      title: album.title,
      songCount: album.track_count,
      duration: album.duration_seconds,
      year: album.year ?? '',
      coverArt: album.cover_art_key ?? ''
    })).join('')) +
    xmlElement('songs', {}, payload.tracks.map((track) => xmlElement('song', {
      id: `track:${track.id}`,
      parent: `album:${track.album_id}`,
      title: track.title,
      album: '',
      artist: '',
      track: track.track_number ?? '',
      discNumber: track.disc_number ?? '',
      duration: track.duration_seconds,
      bitRate: track.bitrate ?? '',
      contentType: track.mime_type,
      suffix: track.file_suffix,
      isDir: false,
      coverArt: track.source_thumbnail_key ?? ''
    })).join(''))
  );
}

export function renderSong(track: TrackRow): string {
  return xmlElement('song', {
    id: `track:${track.id}`,
    parent: `album:${track.album_id}`,
    title: track.title,
    album: '',
    artist: '',
    track: track.track_number ?? '',
    discNumber: track.disc_number ?? '',
    duration: track.duration_seconds,
    bitRate: track.bitrate ?? '',
    contentType: track.mime_type,
    suffix: track.file_suffix,
    isDir: false,
    coverArt: track.source_thumbnail_key ?? ''
  });
}

export function renderAlbumList(albums: AlbumRow[]): string {
  return xmlElement('albumList2', {}, albums.map((album) => xmlElement('album', {
    id: `album:${album.id}`,
    name: album.title,
    artist: '',
    songCount: album.track_count,
    duration: album.duration_seconds,
    year: album.year ?? '',
    coverArt: album.cover_art_key ?? ''
  })).join(''));
}

export function renderPing(message = 'ok'): string {
  return xmlElement('ping', {}, xmlTextElement('message', message));
}
