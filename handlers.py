import asyncio
import logging
import os
import random
import re
import shutil
import sys
import tempfile
import glob
import time
import zipfile
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable, Dict, Optional

import aiohttp
import aiosqlite
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
from aiogram import Router, BaseMiddleware, types, F
from aiogram.filters import Command
from aiogram.types import (
    BufferedInputFile,
    FSInputFile,
    WebAppInfo,
    InlineKeyboardMarkup,
    InlineKeyboardButton,
)

from config import (
    ADMIN_ID,
    STORAGE_CHAT_ID,
    COOLDOWN_SECONDS,
    WEBAPP_URL,
    DB_PATH,
    BASE_DIR,
    COOKIES_FILE,
    DOWNLOAD_TIMEOUT,
    COLLECTION_DOWNLOAD_TIMEOUT,
    MAX_COLLECTION_TRACKS,
    SPOTIPY_CLIENT_ID,
    SPOTIPY_CLIENT_SECRET,
)
from database import log_request
from downloader import download_track_fast_sync, download_cover_bytes, save_cover_to_cache
from keyboards import main_keyboard, get_playlist_keyboard

logger = logging.getLogger(__name__)

router = Router()

MENU_BUTTONS = {"🆘 Как пользоваться", "ℹ️ О боте", "🎵 Мой плейлист"}

BLACKLIST_FILE = os.path.join(BASE_DIR, "blacklist.txt")
TOP_SONGS_FILE = os.path.join(BASE_DIR, "top_songs.txt")

SPOTIFY_URL_RE = re.compile(
    r"https?://open\.spotify\.com/(?:intl-[a-zA-Z0-9-]+/)?(track|album|playlist)/([A-Za-z0-9]+)"
)
SHORT_SPOTIFY_URL_RE = re.compile(r"https?://(?:spotify\.link|spoti\.fi)/\S+")

DOWNLOAD_SEMAPHORE = asyncio.Semaphore(2)

_spotify_client: Optional[spotipy.Spotify] = None
_blacklist_cache: tuple[Optional[float], Optional[re.Pattern]] = (None, None)

_seed_task: Optional[asyncio.Task] = None
_seed_stop_event: Optional[asyncio.Event] = None
_seed_state: dict[str, Any] = {}

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


def parse_spotify_url(text: str) -> Optional[tuple[str, str]]:
    """Извлекает (type, id) из любой ссылки open.spotify.com (включая /intl-xx/)."""
    match = SPOTIFY_URL_RE.search(text)
    if match:
        return match.group(1), match.group(2)
    return None


async def resolve_spotify_short_url(url: str) -> str:
    """Разворачивает короткие ссылки spotify.link / spoti.fi до канонического open.spotify.com URL."""
    try:
        timeout = aiohttp.ClientTimeout(total=8)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, allow_redirects=True) as resp:
                return str(resp.url)
    except Exception as e:
        logger.warning("Short link resolve error: %s", e)
        return url


async def normalize_query(raw_query: str) -> str:
    """Нормализует Spotify-ссылки (короткие и локализованные /intl-xx/) в канонический вид."""
    query = raw_query.strip()
    short_match = SHORT_SPOTIFY_URL_RE.search(query)
    if short_match:
        resolved = await resolve_spotify_short_url(short_match.group(0))
        parsed = parse_spotify_url(resolved)
        if parsed:
            return f"https://open.spotify.com/{parsed[0]}/{parsed[1]}"
        return resolved.split("?")[0].strip()

    parsed = parse_spotify_url(query)
    if parsed:
        return f"https://open.spotify.com/{parsed[0]}/{parsed[1]}"

    if "open.spotify.com/" in query:
        return query.split("?")[0].strip()

    return query


def get_spotify_client() -> spotipy.Spotify:
    """Инициализирует официальный клиент Spotipy для мгновенного получения метаданных и поиска"""
    global _spotify_client
    if _spotify_client is None:
        client_id = SPOTIPY_CLIENT_ID.strip() if SPOTIPY_CLIENT_ID else ""
        client_secret = SPOTIPY_CLIENT_SECRET.strip() if SPOTIPY_CLIENT_SECRET else ""
        auth_manager = SpotifyClientCredentials(
            client_id=client_id,
            client_secret=client_secret
        )
        _spotify_client = spotipy.Spotify(auth_manager=auth_manager, requests_timeout=10)
    return _spotify_client


def _extract_spotify_covers(item: dict) -> tuple[Optional[str], Optional[str]]:
    """Возвращает (cover_url для WebApp 640px, thumb_url для Telegram ~300px)."""
    images = (item.get("album") or {}).get("images") or []
    if not images:
        return None, None
    cover_url = images[0].get("url")
    # Telegram thumbnail лучше всего принимает ~300x300 (обычно images[1])
    thumb_url = images[1].get("url") if len(images) > 1 else cover_url
    return cover_url, thumb_url


def _search_spotify_sync(query: str, limit: int = 5) -> list[dict]:
    """Синхронный поиск топ-5 треков в Spotify API (вызывается через asyncio.to_thread)"""
    sp = get_spotify_client()
    results = sp.search(q=query, limit=limit, type="track")
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
        cover_url, thumb_url = _extract_spotify_covers(item)
        tracks.append({
            "id": track_id,
            "url": f"https://open.spotify.com/track/{track_id}",
            "title": title,
            "performer": artists or "Spotify",
            "duration": duration_str,
            "duration_sec": total_sec,
            "cover_url": cover_url,
            "thumb_url": thumb_url,
        })
    return tracks


def _inspect_spotify_metadata_sync(query: str) -> Optional[dict]:
    """
    Быстрая разведка метаданных трека/альбома/плейлиста в Spotify ДО запуска скачивания.
    Возвращает чистые поля performer, title, url, duration_sec, cover_url и total_tracks.
    """
    sp = get_spotify_client()
    try:
        parsed = parse_spotify_url(query)
        if parsed:
            kind, item_id = parsed
            if kind == "track":
                item = sp.track(item_id)
                artists = ", ".join(a.get("name", "") for a in item.get("artists", []) if a.get("name"))
                cover_url, thumb_url = _extract_spotify_covers(item)
                return {
                    "type": "track",
                    "title": item.get("name", "Без названия"),
                    "performer": artists or "Spotify",
                    "url": f"https://open.spotify.com/track/{item_id}",
                    "duration_sec": int(item.get("duration_ms", 0) // 1000),
                    "cover_url": cover_url,
                    "thumb_url": thumb_url,
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
                    fields="name,tracks(total,items(track(artists(name))))"
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
            res = _search_spotify_sync(query, limit=1)
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
                    "total_tracks": 1,
                }
    except Exception as e:
        logger.warning("Metadata inspect error: %s", e)
    return None


class ThrottlingMiddleware(BaseMiddleware):
    """Анти-спам Middleware с автоматической очисткой памяти от старых записей"""
    def __init__(self, cooldown: float, max_cache_size: int = 2000):
        self.cooldown = cooldown
        self.max_cache_size = max_cache_size
        self.users: Dict[int, float] = {}

    async def __call__(
        self,
        handler: Callable[[types.Message, Dict[str, Any]], Awaitable[Any]],
        event: types.Message,
        data: Dict[str, Any]
    ) -> Any:
        if not event.text or event.text.startswith("/") or event.text in MENU_BUTTONS:
            return await handler(event, data)

        user_id = event.from_user.id
        now = time.monotonic()

        if len(self.users) > self.max_cache_size:
            cutoff = now - self.cooldown
            self.users = {uid: ts for uid, ts in self.users.items() if ts > cutoff}

        last_time = self.users.get(user_id)
        if last_time is not None and (now - last_time) < self.cooldown:
            remaining = round(self.cooldown - (now - last_time), 1)
            await event.answer(f"⏳ Не так быстро! Подожди еще {remaining} сек.")
            return

        self.users[user_id] = now
        return await handler(event, data)


router.message.middleware(ThrottlingMiddleware(COOLDOWN_SECONDS))


def _get_blacklist_pattern() -> Optional[re.Pattern]:
    """Кэширует скомпилированный regex блэклиста в памяти и обновляет только при изменении mtime файла."""
    global _blacklist_cache
    if not os.path.isfile(BLACKLIST_FILE):
        _blacklist_cache = (None, None)
        return None

    mtime = os.path.getmtime(BLACKLIST_FILE)
    cached_mtime, cached_pattern = _blacklist_cache
    if cached_mtime == mtime:
        return cached_pattern

    with open(BLACKLIST_FILE, "r", encoding="utf-8") as f:
        entries = sorted(
            {line.strip().lower() for line in f if len(line.strip()) >= 2},
            key=len,
            reverse=True,
        )

    if not entries:
        _blacklist_cache = (mtime, None)
        return None

    joined = "|".join(re.escape(e) for e in entries)
    pattern = re.compile(
        rf"(?<![a-zа-яёіїєґ0-9])(?:{joined})(?![a-zа-яёіїєґ0-9])",
        re.IGNORECASE,
    )
    _blacklist_cache = (mtime, pattern)
    return pattern


def find_blacklisted_artist(artist_text: str) -> Optional[str]:
    """
    Проверяет строку ИСПОЛНИТЕЛЯ на наличие запрещенных артистов из blacklist.txt.
    Ищет только полные совпадения слов/имён по границам слов.
    """
    if not artist_text:
        return None

    pattern = _get_blacklist_pattern()
    if pattern is None:
        return None

    match = pattern.search(artist_text.lower())
    return match.group(0) if match else None


async def find_cached_track(conn: aiosqlite.Connection, cache_key: str, raw_query: str) -> Optional[str]:
    """
    Ищет трек в локальной базе:
    1) Сначала по точному совпадению ключа (ссылка или текст запроса).
    2) Если не найдено и запрос текстовый (минимум 2 слова) — разбивает запрос на слова
       и ищет трек, где каждое слово присутствует в названии (title) или авторе (performer) в любом порядке.
    """
    async with conn.execute("SELECT file_id FROM tracks WHERE url = ?", (cache_key,)) as cur:
        row = await cur.fetchone()
        if row:
            return row[0]

    if "spotify.com" in raw_query.lower():
        return None

    words = [w for w in re.findall(r"[a-zа-яёіїєґ0-9]+", raw_query.lower()) if len(w) >= 2]
    if len(words) < 2:
        return None

    async with conn.execute(
        "SELECT file_id, title, performer, url FROM tracks WHERE title IS NOT NULL OR performer IS NOT NULL"
    ) as cur:
        rows = await cur.fetchall()

    best_file_id = None
    best_score = None

    for file_id, title, performer, url in rows:
        t_low = (title or "").lower()
        p_low = (performer or "").lower()
        u_low = (url or "").lower()
        combined = f"{p_low} {t_low}"
        full_haystack = f"{combined} {u_low}"

        if all(w in full_haystack for w in words):
            in_meta = all(w in combined for w in words)
            score = (0 if in_meta else 1, len(combined))
            if best_score is None or score < best_score:
                best_score = score
                best_file_id = file_id

    return best_file_id


def get_subprocess_env() -> dict:
    """Формирует окружение с правильным PATH без хардкода домашних путей."""
    env = os.environ.copy()
    candidates = [
        os.path.dirname(sys.executable),
        os.path.expanduser("~/.deno/bin"),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ]
    current_parts = [p for p in env.get("PATH", "").split(":") if p]
    extra_paths = [p for p in candidates if os.path.isdir(p) and p not in current_parts]
    if extra_paths:
        env["PATH"] = ":".join(extra_paths + current_parts)
    return env


def _get_cookies_path() -> Optional[str]:
    if os.path.isfile(COOKIES_FILE):
        return COOKIES_FILE
    fallback = os.path.join(BASE_DIR, "cookies.txt")
    return fallback if os.path.isfile(fallback) else None


def build_spotdl_cmd(query: str, temp_dir: str) -> list[str]:
    """Формирует консольную команду spotdl с автопоиском бинарника."""
    venv_spotdl = os.path.join(os.path.dirname(sys.executable), "spotdl")
    spotdl_bin = venv_spotdl if os.path.isfile(venv_spotdl) else (shutil.which("spotdl") or "spotdl")

    client_id = SPOTIPY_CLIENT_ID.strip() if SPOTIPY_CLIENT_ID else ""
    client_secret = SPOTIPY_CLIENT_SECRET.strip() if SPOTIPY_CLIENT_SECRET else ""

    cmd = [
        spotdl_bin,
        query,
        '--output', temp_dir,
        '--client-id', client_id,
        '--client-secret', client_secret,
    ]

    cookies_path = _get_cookies_path()
    if cookies_path:
        cmd.extend(['--cookie-file', cookies_path])

    return cmd


def parse_filename_meta(file_path: str):
    """Извлекает исполнителя и название из имени файла spotdl (Artist - Title.mp3)"""
    base = os.path.splitext(os.path.basename(file_path))[0]
    if " - " in base:
        performer, title = base.split(" - ", 1)
        return title.strip(), performer.strip()
    return base.strip(), "Spotify"


async def process_and_send_download(
    target_message: types.Message,
    user_id: int,
    clean_query: str,
    cache_key: str,
    status_text: str,
    existing_status_msg: Optional[types.Message] = None,
    extra_lookup_text: Optional[str] = None,
):
    """
    1) Сначала мгновенно получает метаданные из Spotify API и проверяет автора по блэклисту ДО запуска spotdl.
    2) Если автор разрешен — проверяет локальный кэш.
    3) Если в кэше нет — ставит скачивание в очередь семафора, отправляет трек и сохраняет в БД.
    """
    meta = await asyncio.to_thread(_inspect_spotify_metadata_sync, clean_query)
    if meta:
        bad_artist = find_blacklisted_artist(meta["performer"])
        if bad_artist:
            await log_request(
                user_id=user_id,
                request=clean_query,
                cache_key=cache_key,
                action="blocked_by_metadata_precheck",
                details={
                    "blocked_artist": bad_artist,
                    "performer": meta["performer"],
                    "title": meta["title"],
                },
            )

            block_text = f"🚫 Скачивание запрещено: исполнитель «{meta['performer']}» находится в черном списке."
            if existing_status_msg:
                await existing_status_msg.edit_text(block_text)
            else:
                await target_message.answer(block_text)
            return

        if meta.get("type") in ("album", "playlist") and meta.get("total_tracks", 0) > MAX_COLLECTION_TRACKS:
            limit_text = (
                f"🚫 Слишком большой {('альбом' if meta['type'] == 'album' else 'плейлист')} "
                f"({meta['total_tracks']} треков). Максимальный лимит: {MAX_COLLECTION_TRACKS} треков."
            )
            if existing_status_msg:
                await existing_status_msg.edit_text(limit_text)
            else:
                await target_message.answer(limit_text)
            return

        if not extra_lookup_text and meta.get("type") == "track":
            extra_lookup_text = f"{meta['performer']} - {meta['title']}"

    lookup_text = extra_lookup_text or clean_query

    async with aiosqlite.connect(DB_PATH) as conn:
        cached_file_id = await find_cached_track(conn, cache_key, lookup_text)

    if cached_file_id:
        markup = await get_playlist_keyboard(user_id, cached_file_id)
        await target_message.answer_audio(
            audio=cached_file_id,
            caption="⚡️ Моментально из кэша",
            reply_markup=markup
        )
        if existing_status_msg:
            try:
                await existing_status_msg.delete()
            except Exception:
                pass
        return

    if existing_status_msg:
        status_msg = existing_status_msg
        if DOWNLOAD_SEMAPHORE.locked():
            try:
                await status_msg.edit_text("⏳ Сервер занят другими загрузками, ваш запрос в очереди...")
            except Exception:
                pass
        else:
            try:
                await status_msg.edit_text(status_text)
            except Exception:
                pass
    else:
        if DOWNLOAD_SEMAPHORE.locked():
            status_msg = await target_message.answer("⏳ Сервер занят другими загрузками, ваш запрос в очереди...")
        else:
            status_msg = await target_message.answer(status_text)

    async with DOWNLOAD_SEMAPHORE:
        # Повторная проверка кэша после выхода из очереди
        async with aiosqlite.connect(DB_PATH) as conn:
            cached_file_id = await find_cached_track(conn, cache_key, lookup_text)

        if cached_file_id:
            markup = await get_playlist_keyboard(user_id, cached_file_id)
            await target_message.answer_audio(
                audio=cached_file_id,
                caption="⚡️ Моментально из кэша",
                reply_markup=markup
            )
            try:
                await status_msg.delete()
            except Exception:
                pass
            return

        try:
            await status_msg.edit_text(status_text)
        except Exception:
            pass

        with tempfile.TemporaryDirectory() as temp_dir:
            try:
                start_time = time.time()

                # Быстрый путь в памяти (ytmusicapi + yt-dlp в m4a без перекодировки ffmpeg) для одиночного трека
                if meta and meta.get("type") == "track":
                    try:
                        fast_file, cover_bytes, thumb_bytes = await asyncio.wait_for(
                            asyncio.gather(
                                asyncio.to_thread(
                                    download_track_fast_sync,
                                    meta["title"],
                                    meta["performer"],
                                    temp_dir,
                                    meta.get("duration_sec") or None,
                                    _get_cookies_path(),
                                ),
                                download_cover_bytes(meta.get("cover_url")),
                                download_cover_bytes(meta.get("thumb_url")),
                            ),
                            timeout=DOWNLOAD_TIMEOUT,
                        )
                    except asyncio.TimeoutError:
                        fast_file, cover_bytes, thumb_bytes = None, None, None
                        logger.warning("Fast download timed out for %r, falling back to spotdl", clean_query)
                    except Exception as e:
                        fast_file, cover_bytes, thumb_bytes = None, None, None
                        logger.warning("Fast download error for %r: %s", clean_query, e)

                    if fast_file and os.path.isfile(fast_file):
                        download_time = round(time.time() - start_time, 2)
                        thumb_data = thumb_bytes or cover_bytes
                        thumbnail = (
                            BufferedInputFile(thumb_data, filename="cover.jpg")
                            if thumb_data else None
                        )
                        sent_msg = await target_message.answer_audio(
                            audio=FSInputFile(fast_file),
                            title=meta["title"],
                            performer=meta["performer"],
                            duration=meta.get("duration_sec") or None,
                            thumbnail=thumbnail,
                            caption=f"⏱ Загружено за {download_time} сек.",
                        )
                        file_id = sent_msg.audio.file_id
                        title = sent_msg.audio.title or meta["title"]
                        performer = sent_msg.audio.performer or meta["performer"]

                        if cover_bytes or thumb_bytes:
                            save_cover_to_cache(file_id, cover_bytes or thumb_bytes)

                        async with aiosqlite.connect(DB_PATH) as conn:
                            await conn.execute(
                                "INSERT OR REPLACE INTO tracks (url, file_id, title, performer) VALUES (?, ?, ?, ?)",
                                (cache_key, file_id, title, performer)
                            )
                            await conn.commit()

                        markup = await get_playlist_keyboard(user_id, file_id)
                        await target_message.bot.edit_message_reply_markup(
                            chat_id=target_message.chat.id,
                            message_id=sent_msg.message_id,
                            reply_markup=markup
                        )
                        await status_msg.delete()
                        return

                cmd = build_spotdl_cmd(clean_query, temp_dir)
                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=get_subprocess_env()
                )

                async def progress_updater():
                    last_count = -1
                    while process.returncode is None:
                        await asyncio.sleep(4)
                        current_files = len([
                            f for f in glob.glob(os.path.join(temp_dir, '*.*'))
                            if not f.endswith('.part') and not f.endswith('.ytdl')
                        ])
                        if current_files != last_count and current_files > 0:
                            try:
                                await status_msg.edit_text(f"{status_text}\n📥 Уже скачано файлов: {current_files} ...")
                                last_count = current_files
                            except Exception:
                                pass

                updater_task = asyncio.create_task(progress_updater())
                is_collection = (meta and meta.get("type") in ("album", "playlist")) or (
                    parse_spotify_url(clean_query) is not None and parse_spotify_url(clean_query)[0] in ("album", "playlist")
                )
                timeout_sec = COLLECTION_DOWNLOAD_TIMEOUT if is_collection else DOWNLOAD_TIMEOUT

                try:
                    stdout_bytes, stderr_bytes = await asyncio.wait_for(
                        process.communicate(),
                        timeout=timeout_sec
                    )
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
                    await status_msg.edit_text(
                        "⏱ Превышено время ожидания скачивания. Попробуй еще раз позже или выбери отдельный трек."
                    )
                    return
                finally:
                    updater_task.cancel()

                download_time = round(time.time() - start_time, 2)
                downloaded_files = [
                    f for f in glob.glob(os.path.join(temp_dir, '*.*'))
                    if not f.endswith('.part') and not f.endswith('.ytdl')
                ]

                if downloaded_files:
                    safe_files = []

                    for file_path in downloaded_files:
                        f_title, f_perf = parse_filename_meta(file_path)
                        bad_artist = find_blacklisted_artist(f_perf)
                        if bad_artist:
                            await log_request(
                                user_id=user_id,
                                request=clean_query,
                                cache_key=cache_key,
                                action="blocked_by_file",
                                details={
                                    "blocked_artist": bad_artist,
                                    "filename": os.path.basename(file_path),
                                },
                            )
                        else:
                            safe_files.append(file_path)

                    if not safe_files:
                        await status_msg.edit_text("🚫 Исполнитель этого трека находится в черном списке.")
                        return

                    if len(safe_files) == 1:
                        file_path = safe_files[0]
                        f_title, f_perf = parse_filename_meta(file_path)

                        sent_msg = await target_message.answer_audio(
                            audio=FSInputFile(file_path),
                            caption=f"⏱ Загружено с нуля за {download_time} сек."
                        )
                        file_id = sent_msg.audio.file_id
                        title = sent_msg.audio.title or (meta["title"] if meta else None) or f_title
                        performer = sent_msg.audio.performer or (meta["performer"] if meta else None) or f_perf

                        async with aiosqlite.connect(DB_PATH) as conn:
                            await conn.execute(
                                "INSERT OR REPLACE INTO tracks (url, file_id, title, performer) VALUES (?, ?, ?, ?)",
                                (cache_key, file_id, title, performer)
                            )
                            await conn.commit()

                        markup = await get_playlist_keyboard(user_id, file_id)
                        await target_message.bot.edit_message_reply_markup(
                            chat_id=target_message.chat.id,
                            message_id=sent_msg.message_id,
                            reply_markup=markup
                        )
                    else:
                        await status_msg.edit_text(f"🚀 Упаковываем плейлист ({len(safe_files)} треков) в ZIP-архивы...")

                        MAX_ZIP_SIZE = 45 * 1024 * 1024
                        zip_index = 1
                        current_zip_size = 0
                        zip_parts = []

                        current_zip_name = os.path.join(temp_dir, f"Playlist_part{zip_index}.zip")
                        zipf = zipfile.ZipFile(current_zip_name, 'w', zipfile.ZIP_DEFLATED)

                        for f_path in safe_files:
                            file_size = os.path.getsize(f_path)

                            if current_zip_size + file_size > MAX_ZIP_SIZE and current_zip_size > 0:
                                zipf.close()
                                zip_parts.append(current_zip_name)

                                zip_index += 1
                                current_zip_name = os.path.join(temp_dir, f"Playlist_part{zip_index}.zip")
                                zipf = zipfile.ZipFile(current_zip_name, 'w', zipfile.ZIP_DEFLATED)
                                current_zip_size = 0

                            zipf.write(f_path, os.path.basename(f_path))
                            current_zip_size += file_size

                        zipf.close()
                        if current_zip_size > 0:
                            zip_parts.append(current_zip_name)

                        for idx, part_name in enumerate(zip_parts, 1):
                            await target_message.answer_document(
                                document=FSInputFile(part_name),
                                caption=f"📦 Плейлист (Часть {idx} из {len(zip_parts)})"
                            )
                            await asyncio.sleep(1)

                    await status_msg.delete()
                else:
                    out_str = (stdout_bytes.decode("utf-8", errors="ignore") + "\n" + stderr_bytes.decode("utf-8", errors="ignore")).strip()
                    logger.warning("spotdl returned no files for query=%r:\n%s", clean_query, out_str)
                    if user_id == ADMIN_ID and out_str:
                        short_err = out_str[-600:]
                        await status_msg.edit_text(f"❌ Ничего не найдено.\n\n🛠 Лог для админа:\n{short_err}")
                    else:
                        await status_msg.edit_text("❌ Ничего не найдено.")
            except Exception as e:
                logger.exception("Download processing error for query=%r", clean_query)
                await status_msg.edit_text(f"❌ Ошибка: {e}")


@router.message(Command("start"))
async def cmd_start(message: types.Message):
    await message.answer(
        "Привет! Я музыкальный бот 🎧\n\n"
        "Отправь мне ссылку на Spotify или напиши название песни.\n"
        "⚠️ <b>Важно:</b> чтобы я нашел правильный трек, всегда пиши ИМЯ АВТОРА и название (например, <code>Queen - Bohemian Rhapsody</code>).",
        reply_markup=main_keyboard,
        parse_mode="HTML"
    )


@router.message(F.text == "🆘 Как пользоваться")
async def btn_help(message: types.Message):
    await message.answer("Просто скинь мне название трека или ссылку на Spotify. При поиске по тексту я предложу 5 вариантов на выбор (треки с пометкой ⚡️ загружаются мгновенно из кэша).")


@router.message(F.text == "ℹ️ О боте")
async def btn_info(message: types.Message):
    await message.answer("Музыкальный Бот\n\nИщет треки по названию и ссылке Spotify, позволяет собирать свой плейлист прямо в Telegram. Блокирует поиск и скачивание треков авторов из россии.")


@router.message(Command("stats"))
async def cmd_stats(message: types.Message):
    if message.from_user.id != ADMIN_ID:
        return

    cutoff_iso = (datetime.now() - timedelta(days=30)).isoformat()

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute("SELECT COUNT(*) FROM tracks") as cur:
            tracks_count = (await cur.fetchone())[0]
        async with conn.execute("SELECT COUNT(DISTINCT user_id) FROM playlist") as cur:
            playlists_count = (await cur.fetchone())[0]
        async with conn.execute("SELECT COUNT(*) FROM request_logs") as cur:
            total_requests = (await cur.fetchone())[0]
        async with conn.execute("SELECT COUNT(*) FROM request_logs WHERE action LIKE 'blocked%'") as cur:
            blocks = (await cur.fetchone())[0]
        async with conn.execute(
            "SELECT COUNT(DISTINCT user_id) FROM request_logs WHERE created_at >= ?",
            (cutoff_iso,),
        ) as cur:
            monthly_users = (await cur.fetchone())[0]

    await message.answer(
        f"📊 <b>Статистика бота:</b>\n\n"
        f"🎵 Треков в кэше: <code>{tracks_count}</code>\n"
        f"👥 Пользователей с плейлистами: <code>{playlists_count}</code>\n"
        f"📅 Активных юзеров (30 дней): <code>{monthly_users}</code>\n"
        f"📈 Всего запросов: <code>{total_requests}</code>\n"
        f"🚫 Блокировок (блэклист): <code>{blocks}</code>",
        parse_mode="HTML"
    )


@router.callback_query(F.data == "add_to_pl")
async def cq_add_to_pl(callback: types.CallbackQuery):
    audio = callback.message.audio
    file_id = audio.file_id
    user_id = callback.from_user.id
    
    title = audio.title or (audio.file_name.rsplit('.', 1)[0] if audio.file_name else None)
    performer = audio.performer or "Неизвестный исполнитель"

    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute(
            "INSERT OR REPLACE INTO playlist (user_id, file_id, title, performer) VALUES (?, ?, ?, ?)",
            (user_id, file_id, title, performer)
        )
        if title:
            await conn.execute(
                "UPDATE tracks SET title = COALESCE(title, ?), performer = COALESCE(performer, ?) WHERE file_id = ?",
                (title, performer, file_id)
            )
        await conn.commit()

    await callback.answer("✅ Добавлено в плейлист!")
    markup = await get_playlist_keyboard(user_id, file_id)
    await callback.message.edit_reply_markup(reply_markup=markup)


@router.callback_query(F.data == "remove_from_pl")
async def cq_remove_from_pl(callback: types.CallbackQuery):
    file_id = callback.message.audio.file_id
    user_id = callback.from_user.id
    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute("DELETE FROM playlist WHERE user_id = ? AND file_id = ?", (user_id, file_id))
        await conn.commit()

    await callback.answer("❌ Удалено из плейлиста!")
    markup = await get_playlist_keyboard(user_id, file_id)
    await callback.message.edit_reply_markup(reply_markup=markup)


@router.callback_query(F.data == "cancel_search")
async def cq_cancel_search(callback: types.CallbackQuery):
    await callback.answer("Поиск отменен")
    try:
        await callback.message.delete()
    except Exception:
        pass


@router.callback_query(F.data.startswith("dl_sp:"))
async def cq_download_selected_spotify(callback: types.CallbackQuery):
    """Обработчик выбора одного из 5 предложенных вариантов трека"""
    track_id = callback.data.split(":", 1)[1]
    spotify_url = f"https://open.spotify.com/track/{track_id}"
    await callback.answer("🎧 Проверяю трек...")

    await process_and_send_download(
        target_message=callback.message,
        user_id=callback.from_user.id,
        clean_query=spotify_url,
        cache_key=spotify_url,
        status_text="⏳ Скачиваю выбранный трек...",
        existing_status_msg=callback.message,
    )


@router.message(F.text == "🎵 Мой плейлист")
async def btn_playlist(message: types.Message):
    markup = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(
            text="📱 Открыть плейлист", 
            web_app=WebAppInfo(url=WEBAPP_URL)
        )]
    ])
    await message.answer("🎧 Управляй своими сохраненными треками в удобном меню:", reply_markup=markup)


def _discover_spotify_tracks_sync(
    target_count: int,
    source: Optional[str],
    existing_urls: set[str],
) -> list[dict]:
    """
    Собирает до target_count новых треков из Spotify API (которых ещё нет в БД и нет в блэклисте).
    Поддерживает:
      - ссылку на Spotify playlist/album,
      - произвольный поисковый запрос/жанр,
      - автоматический подбор популярных треков (если source не указан).
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
        cover_url, thumb_url = _extract_spotify_covers(item)
        candidates.append({
            "id": track_id,
            "url": url,
            "title": item.get("name", "Без названия"),
            "performer": artists or "Spotify",
            "duration_sec": int(item.get("duration_ms", 0) // 1000),
            "cover_url": cover_url,
            "thumb_url": thumb_url,
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
                fields="items(track(id,name,artists(name))),next",
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

    # Автоматический режим: Spotify Dev Mode ограничивает /v1/search до limit=10
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


async def _run_seed_job(
    bot,
    admin_chat_id: int,
    status_msg: types.Message,
    tracks: list[dict],
    stop_event: asyncio.Event,
):
    global _seed_task, _seed_state
    total = len(tracks)
    saved = 0
    skipped = 0
    failed = 0
    upload_chat_id = STORAGE_CHAT_ID or admin_chat_id
    should_delete_msg = STORAGE_CHAT_ID is None

    _seed_state = {
        "total": total,
        "processed": 0,
        "saved": 0,
        "skipped": 0,
        "failed": 0,
        "started_at": time.monotonic(),
    }

    async def _update_status(force: bool = False):
        processed = _seed_state["processed"]
        if not force and processed % 5 != 0 and processed != total:
            return
        elapsed = int(time.monotonic() - _seed_state["started_at"])
        mins, secs = divmod(elapsed, 60)
        try:
            await status_msg.edit_text(
                f"🌱 <b>Пополнение базы данных</b>\n\n"
                f"Прогресс: <code>{processed}/{total}</code>\n"
                f"✅ Сохранено: <code>{saved}</code>\n"
                f"⏭ Пропущено (кэш/блэклист): <code>{skipped}</code>\n"
                f"❌ Ошибок: <code>{failed}</code>\n"
                f"⏱ Прошло: <code>{mins}м {secs}с</code>\n\n"
                f"Остановить: /seed_stop",
                parse_mode="HTML",
            )
        except Exception:
            pass

    try:
        for idx, track in enumerate(tracks, 1):
            if stop_event.is_set():
                break

            url = track["url"]
            full_label = f"{track['performer']} - {track['title']}"

            async with aiosqlite.connect(DB_PATH) as conn:
                if await find_cached_track(conn, url, full_label):
                    skipped += 1
                    _seed_state.update(processed=idx, skipped=skipped)
                    await _update_status()
                    continue

            if find_blacklisted_artist(track["performer"]):
                skipped += 1
                _seed_state.update(processed=idx, skipped=skipped)
                await _update_status()
                continue

            async with DOWNLOAD_SEMAPHORE:
                if stop_event.is_set():
                    break
                with tempfile.TemporaryDirectory() as temp_dir:
                    try:
                        # Сначала пробуем быстрый in-memory загрузчик (ytmusicapi + yt-dlp m4a)
                        file_path, cover_bytes, thumb_bytes = await asyncio.wait_for(
                            asyncio.gather(
                                asyncio.to_thread(
                                    download_track_fast_sync,
                                    track["title"],
                                    track["performer"],
                                    temp_dir,
                                    track.get("duration_sec") or None,
                                    _get_cookies_path(),
                                ),
                                download_cover_bytes(track.get("cover_url")),
                                download_cover_bytes(track.get("thumb_url")),
                            ),
                            timeout=DOWNLOAD_TIMEOUT,
                        )

                        # Fallback на spotdl, если быстрый способ не нашёл трек
                        if not file_path or not os.path.isfile(file_path):
                            cmd = build_spotdl_cmd(url, temp_dir)
                            proc = await asyncio.create_subprocess_exec(
                                *cmd,
                                stdout=asyncio.subprocess.PIPE,
                                stderr=asyncio.subprocess.PIPE,
                                env=get_subprocess_env(),
                            )
                            try:
                                await asyncio.wait_for(proc.communicate(), timeout=DOWNLOAD_TIMEOUT)
                            except asyncio.TimeoutError:
                                proc.kill()
                                await proc.wait()
                                failed += 1
                                _seed_state.update(processed=idx, failed=failed)
                                await _update_status()
                                continue

                            files = [
                                f for f in glob.glob(os.path.join(temp_dir, "*.*"))
                                if not f.endswith(".part") and not f.endswith(".ytdl")
                            ]
                            if not files:
                                failed += 1
                                _seed_state.update(processed=idx, failed=failed)
                                await _update_status()
                                continue
                            file_path = files[0]

                        f_title, f_perf = parse_filename_meta(file_path)
                        if find_blacklisted_artist(f_perf):
                            skipped += 1
                            _seed_state.update(processed=idx, skipped=skipped)
                            await _update_status()
                            continue

                        thumb_data = thumb_bytes or cover_bytes
                        thumbnail = (
                            BufferedInputFile(thumb_data, filename="cover.jpg")
                            if thumb_data else None
                        )
                        sent_msg = await bot.send_audio(
                            chat_id=upload_chat_id,
                            audio=FSInputFile(file_path),
                            title=track["title"] or f_title,
                            performer=track["performer"] or f_perf,
                            duration=track.get("duration_sec") or None,
                            thumbnail=thumbnail,
                            disable_notification=True,
                        )
                        file_id = sent_msg.audio.file_id
                        title = sent_msg.audio.title or track["title"] or f_title
                        performer = sent_msg.audio.performer or track["performer"] or f_perf

                        if cover_bytes or thumb_bytes:
                            save_cover_to_cache(file_id, cover_bytes or thumb_bytes)

                        async with aiosqlite.connect(DB_PATH) as conn:
                            await conn.execute(
                                "INSERT OR REPLACE INTO tracks (url, file_id, title, performer) VALUES (?, ?, ?, ?)",
                                (url, file_id, title, performer),
                            )
                            await conn.commit()

                        if should_delete_msg:
                            try:
                                await bot.delete_message(chat_id=upload_chat_id, message_id=sent_msg.message_id)
                            except Exception:
                                pass

                        saved += 1
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        logger.warning("Seed track error (%s): %s", url, e)
                        failed += 1

            _seed_state.update(processed=idx, saved=saved, skipped=skipped, failed=failed)
            await _update_status()
            await asyncio.sleep(2)

        elapsed = int(time.monotonic() - _seed_state["started_at"])
        mins, secs = divmod(elapsed, 60)
        header = "🛑 <b>Пополнение базы остановлено</b>" if stop_event.is_set() else "✅ <b>Пополнение базы завершено!</b>"
        await status_msg.edit_text(
            f"{header}\n\n"
            f"Обработано: <code>{_seed_state['processed']}/{total}</code>\n"
            f"✅ Сохранено в БД: <code>{saved}</code>\n"
            f"⏭ Пропущено: <code>{skipped}</code>\n"
            f"❌ Ошибок: <code>{failed}</code>\n"
            f"⏱ Затрачено: <code>{mins}м {secs}с</code>",
            parse_mode="HTML",
        )
    except asyncio.CancelledError:
        logger.info("Seed job cancelled")
    except Exception as e:
        logger.exception("Seed job failed unexpectedly: %s", e)
        try:
            await status_msg.edit_text(f"❌ Критическая ошибка пополнения: {e}")
        except Exception:
            pass
    finally:
        _seed_task = None
        _seed_state = {}


@router.message(Command("seed"))
async def cmd_seed(message: types.Message):
    """
    Админ-команда для массового пополнения БД треками:
      /seed — скачать 100 новых популярных треков
      /seed 50 — скачать 50 новых популярных треков
      /seed 100 https://open.spotify.com/playlist/... — до 100 треков из плейлиста/альбома
      /seed 50 rock — до 50 треков по жанру/запросу
    """
    global _seed_task, _seed_stop_event
    if message.from_user.id != ADMIN_ID:
        return

    if _seed_task is not None and not _seed_task.done():
        await message.answer(
            "⏳ Пополнение базы уже запущено!\n"
            "Проверить прогресс: /seed_status\n"
            "Остановить: /seed_stop"
        )
        return

    parts = (message.text or "").split(maxsplit=2)
    target_count = 100
    source: Optional[str] = None

    if len(parts) >= 2:
        if parts[1].isdigit():
            target_count = max(1, min(int(parts[1]), 500))
            if len(parts) == 3:
                source = await normalize_query(parts[2])
        else:
            raw_source = (message.text or "").split(maxsplit=1)[1]
            source = await normalize_query(raw_source)

    status_msg = await message.answer(
        f"🔎 Подбираю до <code>{target_count}</code> новых треков из Spotify...",
        parse_mode="HTML",
    )

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute("SELECT url FROM tracks") as cur:
            existing_urls = {row[0] for row in await cur.fetchall() if row[0]}

    try:
        tracks = await asyncio.to_thread(
            _discover_spotify_tracks_sync,
            target_count,
            source,
            existing_urls,
        )
    except Exception as e:
        logger.warning("Seed discovery failed: %s", e)
        await status_msg.edit_text(f"❌ Не удалось получить треки из Spotify API: {e}")
        return

    if not tracks:
        await status_msg.edit_text("ℹ️ Новых треков для скачивания не найдено (все уже есть в базе или в блэклисте).")
        return

    _seed_stop_event = asyncio.Event()
    _seed_task = asyncio.create_task(
        _run_seed_job(
            bot=message.bot,
            admin_chat_id=message.chat.id,
            status_msg=status_msg,
            tracks=tracks,
            stop_event=_seed_stop_event,
        )
    )


@router.message(Command("seed_stop"))
async def cmd_seed_stop(message: types.Message):
    if message.from_user.id != ADMIN_ID:
        return
    if _seed_task is None or _seed_task.done():
        await message.answer("ℹ️ Сейчас пополнение базы не запущено.")
        return
    if _seed_stop_event:
        _seed_stop_event.set()
    await message.answer("🛑 Останавливаю пополнение после завершения текущего трека...")


@router.message(Command("seed_status"))
async def cmd_seed_status(message: types.Message):
    if message.from_user.id != ADMIN_ID:
        return
    if _seed_task is None or _seed_task.done() or not _seed_state:
        await message.answer("ℹ️ Сейчас пополнение базы не запущено.")
        return
    elapsed = int(time.monotonic() - _seed_state["started_at"])
    mins, secs = divmod(elapsed, 60)
    await message.answer(
        f"🌱 <b>Статус пополнения:</b>\n\n"
        f"Обработано: <code>{_seed_state['processed']}/{_seed_state['total']}</code>\n"
        f"✅ Сохранено: <code>{_seed_state['saved']}</code>\n"
        f"⏭ Пропущено: <code>{_seed_state['skipped']}</code>\n"
        f"❌ Ошибок: <code>{_seed_state['failed']}</code>\n"
        f"⏱ Прошло: <code>{mins}м {secs}с</code>",
        parse_mode="HTML",
    )


@router.message(Command("preload"))
async def cmd_preload(message: types.Message):
    if message.from_user.id != ADMIN_ID:
        return
    if not os.path.exists(TOP_SONGS_FILE):
        return
    with open(TOP_SONGS_FILE, "r", encoding="utf-8") as f:
        tracks = [line.strip() for line in f if line.strip()]
    await message.answer(f"🚀 Начинаю прогрев. Треков: {len(tracks)}")
    
    for query in tracks:
        cache_key = query.lower()
        async with aiosqlite.connect(DB_PATH) as conn:
            if await find_cached_track(conn, cache_key, query):
                continue

        meta = await asyncio.to_thread(_inspect_spotify_metadata_sync, query)
        if meta and find_blacklisted_artist(meta["performer"]):
            continue

        async with DOWNLOAD_SEMAPHORE:
            with tempfile.TemporaryDirectory() as temp_dir:
                try:
                    cmd = build_spotdl_cmd(query, temp_dir)
                    proc = await asyncio.create_subprocess_exec(
                        *cmd,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        env=get_subprocess_env()
                    )
                    try:
                        await asyncio.wait_for(proc.communicate(), timeout=DOWNLOAD_TIMEOUT)
                    except asyncio.TimeoutError:
                        proc.kill()
                        await proc.wait()
                        continue
                    files = [
                        f for f in glob.glob(os.path.join(temp_dir, '*.*'))
                        if not f.endswith('.part') and not f.endswith('.ytdl')
                    ]
                    if files:
                        f_title, f_perf = parse_filename_meta(files[0])
                        sent_msg = await message.answer_audio(audio=FSInputFile(files[0]), disable_notification=True)
                        title = sent_msg.audio.title or f_title
                        performer = sent_msg.audio.performer or f_perf
                        async with aiosqlite.connect(DB_PATH) as conn:
                            await conn.execute(
                                "INSERT OR IGNORE INTO tracks (url, file_id, title, performer) VALUES (?, ?, ?, ?)",
                                (cache_key, sent_msg.audio.file_id, title, performer)
                            )
                            await conn.commit()
                        await asyncio.sleep(3)
                except Exception:
                    pass
    await message.answer("✅ Прогрев завершен!")


@router.message(F.text)
async def handle_music_request(message: types.Message):
    query = message.text.strip()
    clean_query = await normalize_query(query)
    cache_key = clean_query if "spotify.com" in clean_query else clean_query.lower()

    await log_request(
        user_id=message.from_user.id,
        full_name=message.from_user.full_name,
        username=message.from_user.username,
        request=query,
        cache_key=cache_key,
        action="allowed",
    )

    if "spotify.com" not in clean_query:
        try:
            results = await asyncio.to_thread(_search_spotify_sync, clean_query, 5)
        except Exception as e:
            logger.warning("Spotipy search error: %s", e)
            results = []

        if results:
            buttons = []
            async with aiosqlite.connect(DB_PATH) as conn:
                for item in results:
                    full_title = f"{item['performer']} - {item['title']}"
                    is_cached = await find_cached_track(conn, item["url"], full_title)
                    prefix = "⚡️ " if is_cached else "🎵 "
                    btn_label = f"{prefix}{item['performer']} — {item['title']} ({item['duration']})"
                    if len(btn_label) > 60:
                        btn_label = btn_label[:57] + "..."

                    buttons.append([
                        InlineKeyboardButton(
                            text=btn_label,
                            callback_data=f"dl_sp:{item['id']}"
                        )
                    ])

            buttons.append([InlineKeyboardButton(text="✖️ Отмена", callback_data="cancel_search")])
            await message.answer(
                f"🔎 Результаты по запросу «{query}»\n"
                f"Выбери нужный вариант (⚡️ — мгновенно из кэша):",
                reply_markup=InlineKeyboardMarkup(inline_keyboard=buttons)
            )
            return

    status_text = "⏳ Качаю по ссылке..." if "spotify.com" in clean_query else f"🔍 Ищу и скачиваю: «{query}»..."
    await process_and_send_download(
        target_message=message,
        user_id=message.from_user.id,
        clean_query=clean_query,
        cache_key=cache_key,
        status_text=status_text,
    )