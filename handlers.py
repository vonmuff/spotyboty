import asyncio
import logging
import os
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
from aiogram.types import FSInputFile, WebAppInfo, InlineKeyboardMarkup, InlineKeyboardButton

from config import (
    ADMIN_ID,
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
        tracks.append({
            "id": track_id,
            "url": f"https://open.spotify.com/track/{track_id}",
            "title": title,
            "performer": artists or "Spotify",
            "duration": duration_str,
        })
    return tracks


def _inspect_spotify_metadata_sync(query: str) -> Optional[dict]:
    """
    Быстрая разведка метаданных трека/альбома/плейлиста в Spotify ДО запуска скачивания spotdl.
    Возвращает чистые поля performer, title, url и total_tracks для проверки блэклиста, лимита и кэша.
    """
    sp = get_spotify_client()
    try:
        parsed = parse_spotify_url(query)
        if parsed:
            kind, item_id = parsed
            if kind == "track":
                item = sp.track(item_id)
                artists = ", ".join(a.get("name", "") for a in item.get("artists", []) if a.get("name"))
                return {
                    "type": "track",
                    "title": item.get("name", "Без названия"),
                    "performer": artists or "Spotify",
                    "url": f"https://open.spotify.com/track/{item_id}",
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

    cookies_path = COOKIES_FILE if os.path.isfile(COOKIES_FILE) else os.path.join(BASE_DIR, "cookies.txt")
    if os.path.isfile(cookies_path):
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