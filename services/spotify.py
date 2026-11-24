import logging
import random
import re
from typing import Optional

import aiohttp
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials

from bot.config import SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET
from services.cache import find_blacklisted_artist

logger = logging.getLogger(__name__)

SPOTIFY_URL_RE = re.compile(
    r"https?://open\.spotify\.com/(?:intl-[a-zA-Z0-9-]+/)?(track|album|playlist)/([A-Za-z0-9]+)"
)
SHORT_SPOTIFY_URL_RE = re.compile(r"https?://(?:spotify\.link|spoti\.fi)/\S+")
YOUTUBE_URL_RE = re.compile(
    r"https?://(?:(?:www|m|music)\.)?(?:youtube\.com/(?:watch\?[^\s]*v=|shorts/)|youtu\.be/)([A-Za-z0-9_-]{11})"
)
SOUNDCLOUD_URL_RE = re.compile(r"https?://(?:(?:www|m)\.)?soundcloud\.com/([^\s?#/]+/[^\s?#/]+)")
SHORT_SOUNDCLOUD_URL_RE = re.compile(r"https?://on\.soundcloud\.com/\S+")

SEED_DISCOVERY_QUERIES = [
    "year:2026",
    "year:2025",
    "year:2024",
    "year:2023",
    "genre:pop",
    "genre:hip-hop",
    "genre:rock",
    "genre:electronic",
    "genre:dance",
    "genre:indie",
    "genre:r-n-b",
    "genre:latin",
    "genre:alt-rock",
    "genre:house",
    "genre:metal",
    "genre:jazz",
    "genre:soul",
    "genre:punk",
    "ukrainian hits",
    "top hits",
    "viral hits",
    "club hits",
    "workout hits",
    "chill hits",
]

_spotify_client: Optional[spotipy.Spotify] = None


def parse_spotify_url(text: str) -> Optional[tuple[str, str]]:
    """Извлекает (type, id) из любой ссылки open.spotify.com (включая /intl-xx/)."""
    match = SPOTIFY_URL_RE.search(text)
    if match:
        return match.group(1), match.group(2)
    return None


def parse_external_media_url(text: str) -> Optional[tuple[str, str]]:
    """Распознаёт и нормализует ссылки YouTube / YouTube Music / SoundCloud."""
    yt_match = YOUTUBE_URL_RE.search(text)
    if yt_match:
        video_id = yt_match.group(1)
        return "youtube", f"https://www.youtube.com/watch?v={video_id}"

    sc_match = SOUNDCLOUD_URL_RE.search(text)
    if sc_match:
        path = sc_match.group(1).rstrip("/")
        return "soundcloud", f"https://soundcloud.com/{path}"

    return None


async def resolve_short_url(url: str) -> str:
    """Разворачивает короткие ссылки (spotify.link / spoti.fi / on.soundcloud.com) по редиректу."""
    try:
        timeout = aiohttp.ClientTimeout(total=8)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, allow_redirects=True) as resp:
                return str(resp.url)
    except Exception as e:
        logger.warning("Short link resolve error: %s", e)
        return url


async def normalize_query(raw_query: str) -> str:
    """Нормализует ссылки Spotify, YouTube / YT Music и SoundCloud в канонический вид."""
    query = raw_query.strip()

    short_sp = SHORT_SPOTIFY_URL_RE.search(query)
    if short_sp:
        resolved = await resolve_short_url(short_sp.group(0))
        parsed = parse_spotify_url(resolved)
        if parsed:
            return f"https://open.spotify.com/{parsed[0]}/{parsed[1]}"
        return resolved.split("?")[0].strip()

    short_sc = SHORT_SOUNDCLOUD_URL_RE.search(query)
    if short_sc:
        resolved = await resolve_short_url(short_sc.group(0))
        ext_media = parse_external_media_url(resolved)
        if ext_media:
            return ext_media[1]
        return resolved.split("?")[0].strip()

    parsed = parse_spotify_url(query)
    if parsed:
        return f"https://open.spotify.com/{parsed[0]}/{parsed[1]}"

    ext_media = parse_external_media_url(query)
    if ext_media:
        return ext_media[1]

    if "open.spotify.com/" in query:
        return query.split("?")[0].strip()

    return query


def get_spotify_client() -> spotipy.Spotify:
    """Инициализирует официальный клиент Spotipy для мгновенного получения метаданных и поиска."""
    global _spotify_client
    if _spotify_client is None:
        client_id = SPOTIPY_CLIENT_ID.strip() if SPOTIPY_CLIENT_ID else ""
        client_secret = SPOTIPY_CLIENT_SECRET.strip() if SPOTIPY_CLIENT_SECRET else ""
        auth_manager = SpotifyClientCredentials(
            client_id=client_id,
            client_secret=client_secret,
        )
        _spotify_client = spotipy.Spotify(auth_manager=auth_manager, requests_timeout=10)
    return _spotify_client


def extract_spotify_covers(item: dict) -> tuple[Optional[str], Optional[str]]:
    """Возвращает (cover_url для WebApp 640px, thumb_url для Telegram ~300px)."""
    images = (item.get("album") or {}).get("images") or []
    if not images:
        return None, None
    cover_url = images[0].get("url")
    thumb_url = images[1].get("url") if len(images) > 1 else cover_url
    return cover_url, thumb_url


def search_spotify_sync(query: str, limit: int = 5, offset: int = 0) -> list[dict]:
    """Синхронный поиск треков в Spotify API с поддержкой пагинации (вызывается через asyncio.to_thread)."""
    sp = get_spotify_client()
    results = sp.search(q=query, limit=limit, offset=offset, type="track")
    items = results.get("tracks", {}).get("items", [])
    tracks = []
    for item in items:
        track_id = item.get("id")
        if not track_id:
            continue
        title = item.get("name", "Без названия")
        artists = ", ".join(a.get("name", "") for a in item.get("artists", []) if a.get("name"))
        duration_ms = item.get("duration_ms", 0)
        total_sec = duration_ms // 1000
        duration_str = f"{total_sec // 60}:{total_sec % 60:02d}"
        cover_url, thumb_url = extract_spotify_covers(item)
        tracks.append({
            "id": track_id,
            "url": f"https://open.spotify.com/track/{track_id}",
            "title": title,
            "performer": artists or "Spotify",
            "duration": duration_str,
            "duration_sec": total_sec,
            "cover_url": cover_url,
            "thumb_url": thumb_url,
            "isrc": (item.get("external_ids") or {}).get("isrc"),
            "album": (item.get("album") or {}).get("name"),
        })
    return tracks


def inspect_spotify_metadata_sync(query: str) -> Optional[dict]:
    """
    Быстрая разведка метаданных трека/альбома/плейлиста в Spotify ДО запуска скачивания.
    Возвращает чистые поля performer, title, url, duration_sec, cover_url, isrc, album и total_tracks.
    """
    sp = get_spotify_client()
    try:
        parsed = parse_spotify_url(query)
        if parsed:
            kind, item_id = parsed
            if kind == "track":
                item = sp.track(item_id)
                artists = ", ".join(a.get("name", "") for a in item.get("artists", []) if a.get("name"))
                cover_url, thumb_url = extract_spotify_covers(item)
                return {
                    "type": "track",
                    "title": item.get("name", "Без названия"),
                    "performer": artists or "Spotify",
                    "url": f"https://open.spotify.com/track/{item_id}",
                    "duration_sec": int(item.get("duration_ms", 0) // 1000),
                    "cover_url": cover_url,
                    "thumb_url": thumb_url,
                    "isrc": (item.get("external_ids") or {}).get("isrc"),
                    "album": (item.get("album") or {}).get("name"),
                    "total_tracks": 1,
                }
            elif kind == "album":
                album = sp.album(item_id)
                artists_set = set()
                for a in album.get("artists", []):
                    if a.get("name"):
                        artists_set.add(a["name"])
                for t in album.get("tracks", {}).get("items", []):
                    for a in t.get("artists", []):
                        if a.get("name"):
                            artists_set.add(a["name"])
                total_tracks = album.get("total_tracks") or len(album.get("tracks", {}).get("items", []))
                return {
                    "type": "album",
                    "title": album.get("name", "Альбом"),
                    "performer": ", ".join(artists_set),
                    "url": f"https://open.spotify.com/album/{item_id}",
                    "total_tracks": total_tracks,
                }
            elif kind == "playlist":
                playlist = sp.playlist(
                    item_id,
                    fields="name,tracks(total,items(track(artists(name))))",
                )
                tracks_data = playlist.get("tracks") or {}
                artists_set = set()
                for entry in tracks_data.get("items", []):
                    track_obj = (entry or {}).get("track") or {}
                    for a in track_obj.get("artists", []):
                        if a.get("name"):
                            artists_set.add(a["name"])
                return {
                    "type": "playlist",
                    "title": playlist.get("name", "Плейлист"),
                    "performer": ", ".join(artists_set),
                    "url": f"https://open.spotify.com/playlist/{item_id}",
                    "total_tracks": tracks_data.get("total", 0),
                }
        elif "spotify.com" not in query.lower():
            res = search_spotify_sync(query, limit=1)
            if res:
                first = res[0]
                return {
                    "type": "track",
                    "title": first["title"],
                    "performer": first["performer"],
                    "url": first["url"],
                    "duration_sec": first.get("duration_sec", 0),
                    "cover_url": first.get("cover_url"),
                    "thumb_url": first.get("thumb_url"),
                    "isrc": first.get("isrc"),
                    "album": first.get("album"),
                    "total_tracks": 1,
                }
    except Exception as e:
        logger.warning("Metadata inspect error: %s", e)
    return None


def discover_spotify_tracks_sync(
    target_count: int,
    source: Optional[str],
    existing_urls: set[str],
) -> list[dict]:
    """
    Собирает до target_count новых треков из Spotify API (которых ещё нет в БД и нет в блэклисте).
    Поддерживает ссылку на playlist/album, произвольный запрос/жанр или автоматический подбор.
    """
    sp = get_spotify_client()
    candidates: list[dict] = []
    seen_urls: set[str] = set(existing_urls)

    def _try_add_track(item: Optional[dict]) -> bool:
        if not item:
            return False
        track_id = item.get("id")
        if not track_id:
            return False
        url = f"https://open.spotify.com/track/{track_id}"
        if url in seen_urls:
            return False
        artists = ", ".join(a.get("name", "") for a in item.get("artists", []) if a.get("name"))
        if artists and find_blacklisted_artist(artists):
            return False
        seen_urls.add(url)
        cover_url, thumb_url = extract_spotify_covers(item)
        candidates.append({
            "id": track_id,
            "url": url,
            "title": item.get("name", "Без названия"),
            "performer": artists or "Spotify",
            "duration_sec": int(item.get("duration_ms", 0) // 1000),
            "cover_url": cover_url,
            "thumb_url": thumb_url,
            "isrc": (item.get("external_ids") or {}).get("isrc"),
            "album": (item.get("album") or {}).get("name"),
        })
        return True

    parsed = parse_spotify_url(source) if source else None

    if parsed and parsed[0] == "playlist":
        offset = 0
        while len(candidates) < target_count:
            page = sp.playlist_items(
                parsed[1],
                limit=100,
                offset=offset,
                fields="items(track(id,name,duration_ms,external_ids,album(name,images),artists(name))),next",
            )
            items = page.get("items", [])
            if not items:
                break
            for entry in items:
                _try_add_track((entry or {}).get("track"))
                if len(candidates) >= target_count:
                    break
            if not page.get("next"):
                break
            offset += len(items)
        return candidates

    if parsed and parsed[0] == "album":
        offset = 0
        while len(candidates) < target_count:
            page = sp.album_tracks(parsed[1], limit=50, offset=offset)
            items = page.get("items", [])
            if not items:
                break
            for item in items:
                _try_add_track(item)
                if len(candidates) >= target_count:
                    break
            if not page.get("next"):
                break
            offset += len(items)
        return candidates

    if source:
        offset = 0
        while len(candidates) < target_count and offset < 500:
            res = sp.search(q=source, type="track", limit=10, offset=offset)
            items = res.get("tracks", {}).get("items", [])
            if not items:
                break
            for item in items:
                _try_add_track(item)
                if len(candidates) >= target_count:
                    break
            offset += len(items)
        return candidates

    queries = SEED_DISCOVERY_QUERIES.copy()
    random.shuffle(queries)
    offsets = [0, 10, 20, 30, 40, 50, 70, 100]
    last_error: Optional[Exception] = None

    for q in queries:
        if len(candidates) >= target_count:
            break
        q_offsets = offsets.copy()
        random.shuffle(q_offsets)
        for off in q_offsets[:3]:
            if len(candidates) >= target_count:
                break
            try:
                res = sp.search(q=q, type="track", limit=10, offset=off)
                items = res.get("tracks", {}).get("items", [])
                random.shuffle(items)
                for item in items:
                    _try_add_track(item)
                    if len(candidates) >= target_count:
                        break
            except Exception as e:
                last_error = e
                logger.warning("Seed discovery search error for %r: %s", q, e)
                break

    if not candidates and last_error is not None:
        raise last_error

    return candidates
