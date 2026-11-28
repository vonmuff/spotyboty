import asyncio
from datetime import datetime, timedelta
import hashlib
import hmac
import logging
import os
import tempfile
import time
from typing import Optional
from urllib.parse import urlencode

import aiosqlite
from aiohttp import web, ClientSession, TCPConnector, WSMsgType
from aiogram import Bot
from aiogram.utils.web_app import safe_parse_webapp_init_data
from mutagen.mp3 import MP3
from mutagen.id3 import ID3, APIC
from bot.config import DB_PATH, WEB_STATIC_DIR, COVERS_DIR, MEDIA_SIGN_KEY
from services.cache import write_optimized_cover, optimize_existing_cover_file

logger = logging.getLogger(__name__)

routes = web.RouteTableDef()
bot_instance: Bot = None
http_session: ClientSession = None

os.makedirs(COVERS_DIR, exist_ok=True)

METADATA_SEMAPHORE = asyncio.Semaphore(2)
_resolving_tasks: set[str] = set()
MEDIA_TOKEN_BUCKET = 6 * 3600  # Квантование exp по 6-часовым окнам для попадания в кэш браузера

FILE_PATH_CACHE_TTL = 1800  # 30 минут
FILE_PATH_CACHE_MAX_SIZE = 1000
_file_path_cache: dict[str, tuple[str, float]] = {}

ROWID_CACHE_MAX_SIZE = 2000
_rowid_to_file_id_cache: dict[int, str] = {}
_checked_covers: set[str] = set()
_bot_username_cache: Optional[str] = None
ROOMS_WS_UPSTREAM = os.getenv("ROOMS_WS_UPSTREAM", "http://127.0.0.1:4000/ws/rooms/websocket")


def _get_http_session() -> ClientSession:
    global http_session
    if http_session is None or http_session.closed:
        connector = TCPConnector(limit=32, keepalive_timeout=60, ttl_dns_cache=300)
        http_session = ClientSession(connector=connector)
    return http_session


def _cache_rowid_file_id(rowid: int, file_id: str) -> None:
    if len(_rowid_to_file_id_cache) >= ROWID_CACHE_MAX_SIZE and rowid not in _rowid_to_file_id_cache:
        _rowid_to_file_id_cache.pop(next(iter(_rowid_to_file_id_cache)))
    _rowid_to_file_id_cache[rowid] = file_id

MAX_USER_PLAYLISTS = 15
MAX_PLAYLIST_NAME_LEN = 32


async def get_cached_file_path(file_id: str, force_refresh: bool = False) -> str:
    """Кэширует Telegram file_path в памяти на 30 минут, снижая нагрузку на Bot API при Range-запросах."""
    now = time.monotonic()
    if not force_refresh:
        cached = _file_path_cache.get(file_id)
        if cached and cached[1] > now:
            return cached[0]

    file_info = await bot_instance.get_file(file_id)
    if len(_file_path_cache) >= FILE_PATH_CACHE_MAX_SIZE:
        expired = [k for k, (_, exp) in _file_path_cache.items() if exp <= now]
        for k in expired:
            _file_path_cache.pop(k, None)
        if len(_file_path_cache) >= FILE_PATH_CACHE_MAX_SIZE:
            _file_path_cache.pop(next(iter(_file_path_cache)))

    _file_path_cache[file_id] = (file_info.file_path, now + FILE_PATH_CACHE_TTL)
    return file_info.file_path


def _get_authenticated_user_id(request: web.Request) -> Optional[int]:
    """Проверяет криптографическую подпись Telegram WebApp initData и возвращает user_id."""
    init_data = request.headers.get("X-Telegram-Init-Data", "").strip()
    if not init_data or not bot_instance:
        return None
    try:
        parsed = safe_parse_webapp_init_data(token=bot_instance.token, init_data=init_data)
        return parsed.user.id if parsed.user else None
    except ValueError:
        return None


def sign_media_token(item_id: str, exp: Optional[int] = None) -> tuple[int, str]:
    """Генерирует временную HMAC-подпись для /api/stream и /api/cover (exp квантуется по 6ч окнам для кэша браузера)."""
    if exp is None:
        exp = ((int(time.time()) // MEDIA_TOKEN_BUCKET) + 2) * MEDIA_TOKEN_BUCKET
    payload = f"{item_id}:{exp}".encode("utf-8")
    sig = hmac.new(MEDIA_SIGN_KEY.encode("utf-8"), payload, hashlib.sha256).hexdigest()[:32]
    return exp, sig


def verify_media_token(item_id: Optional[str], exp_str: Optional[str], sig: Optional[str]) -> bool:
    if not item_id or not exp_str or not sig:
        return False
    try:
        exp = int(exp_str)
    except ValueError:
        return False
    if exp < int(time.time()):
        return False
    _, expected_sig = sign_media_token(item_id, exp)
    return hmac.compare_digest(sig, expected_sig)


async def _resolve_file_id_from_request(request: web.Request) -> Optional[str]:
    """Проверяет подписанный непрозрачный id и возвращает file_id (с in-memory кэшем)."""
    item_id = request.query.get("id")
    if not verify_media_token(item_id, request.query.get("exp"), request.query.get("sig")):
        return None
    try:
        rowid = int(item_id)
    except ValueError:
        return None
    cached_fid = _rowid_to_file_id_cache.get(rowid)
    if cached_fid is not None:
        return cached_fid
    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute("SELECT file_id FROM playlist WHERE rowid = ?", (rowid,)) as cur:
            row = await cur.fetchone()
            if row:
                _cache_rowid_file_id(rowid, row[0])
                return row[0]
            return None


def get_cover_cache_path(file_id: str) -> str:
    safe_hash = hashlib.md5(file_id.encode("utf-8")).hexdigest()
    return os.path.join(COVERS_DIR, f"{safe_hash}.jpg")


def _extract_id3_sync(temp_name: str, cover_path: str):
    """Синхронное извлечение ID3-тегов (выполняется в отдельном потоке, не блокируя Event Loop)"""
    title, performer = None, None
    audio = MP3(temp_name, ID3=ID3)
    if audio.tags:
        if 'TIT2' in audio.tags and audio.tags['TIT2'].text:
            title = str(audio.tags['TIT2'].text[0]).strip()
        if 'TPE1' in audio.tags and audio.tags['TPE1'].text:
            performer = str(audio.tags['TPE1'].text[0]).strip()

        for tag in audio.tags.values():
            if isinstance(tag, APIC):
                write_optimized_cover(cover_path, tag.data)
                break
    return title, performer


async def resolve_track_metadata(file_id: str):
    """
    Скачивает MP3 один раз, если у трека нет обложки в кэше или названия в БД.
    Извлекает ID3-теги (название, автора и картинку APIC) и сохраняет их.
    """
    cover_path = get_cover_cache_path(file_id)
    title, performer = None, None

    async with METADATA_SEMAPHORE:
        try:
            file_path = await get_cached_file_path(file_id)
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as temp_mp3:
                temp_name = temp_mp3.name

            await bot_instance.download_file(file_path, temp_name)

            try:
                title, performer = await asyncio.to_thread(_extract_id3_sync, temp_name, cover_path)
            except Exception as e:
                logger.warning("Ошибка чтения ID3 для %s: %s", file_id, e)
            finally:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)

            if title or performer:
                async with aiosqlite.connect(DB_PATH) as conn:
                    await conn.execute(
                        "UPDATE tracks SET title = COALESCE(title, ?), performer = COALESCE(performer, ?) WHERE file_id = ?",
                        (title, performer, file_id)
                    )
                    await conn.execute(
                        "UPDATE playlist SET title = COALESCE(title, ?), performer = COALESCE(performer, ?) WHERE file_id = ?",
                        (title, performer, file_id)
                    )
                    await conn.commit()
        except Exception as e:
            logger.warning("Ошибка загрузки файла для метаданных %s: %s", file_id, e)
        finally:
            _resolving_tasks.discard(file_id)

    return title, performer


def schedule_metadata_resolution(file_id: str):
    """Запускает фоновое извлечение ID3-тегов без задержки открытия плейлиста"""
    if file_id not in _resolving_tasks:
        _resolving_tasks.add(file_id)
        asyncio.create_task(resolve_track_metadata(file_id))


@routes.get('/health')
async def healthcheck(request):
    try:
        async with aiosqlite.connect(DB_PATH) as conn:
            async with conn.execute("SELECT 1") as cur:
                await cur.fetchone()
        return web.json_response({'status': 'ok'})
    except Exception as e:
        logger.error("Healthcheck failed: %s", e)
        return web.json_response({'status': 'error'}, status=503)


def _get_asset_version() -> str:
    mtimes = []
    for fname in ("playlist.html", "style.css", "app.js"):
        fpath = os.path.join(WEB_STATIC_DIR, fname)
        if os.path.isfile(fpath):
            mtimes.append(str(int(os.path.getmtime(fpath))))
    return "-".join(mtimes) or "1"


@routes.get('/')
async def index(request):
    html_path = os.path.join(WEB_STATIC_DIR, 'playlist.html')
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read().replace("__ASSET_V__", _get_asset_version())
    return web.Response(
        text=html,
        content_type="text/html",
        charset="utf-8",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@routes.get('/api/playlist')
async def get_playlist(request):
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)
        
    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute("""
            SELECT p.rowid,
                   p.file_id,
                   COALESCE(p.title, t.title),
                   COALESCE(p.performer, t.performer),
                   t.url
            FROM playlist p
            LEFT JOIN tracks t ON p.file_id = t.file_id
            WHERE p.user_id = ?
            ORDER BY p.rowid DESC
        """, (user_id,)) as cursor:
            rows = await cursor.fetchall()

    tracks = []
    for row_id, file_id, title, performer, raw_url in rows:
        # Если у трека еще нет нормального названия, запускаем фоновую задачу, не задерживая ответ
        if not title or "spotify.com" in title.lower() or title == "Трек из Spotify":
            schedule_metadata_resolution(file_id)
            if title and ("spotify.com" in title.lower() or title == "Трек из Spotify"):
                title = None

        if not title:
            if raw_url and "spotify.com" not in raw_url.lower():
                if " - " in raw_url:
                    perf_part, title_part = raw_url.split(" - ", 1)
                    performer = performer or perf_part.strip().title()
                    title = title_part.strip().title()
                else:
                    title = raw_url.strip().title()
            else:
                title = "Загрузка названия..."

        if not performer:
            performer = "Spotify"

        _cache_rowid_file_id(row_id, file_id)
        item_id = str(row_id)
        exp, sig = sign_media_token(item_id)
        signed_query = urlencode({"id": item_id, "exp": exp, "sig": sig})

        tracks.append({
            "file_id": file_id,
            "title": title,
            "performer": performer,
            "name": f"{performer} — {title}",
            "stream_url": f"/api/stream?{signed_query}",
            "cover_url": f"/api/cover?{signed_query}",
        })
        
    return web.json_response({'tracks': tracks})


@routes.delete('/api/playlist')
async def delete_track(request):
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)

    file_id = request.query.get('file_id')
    if not file_id:
        return web.json_response({'error': 'No file_id'}, status=400)

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute(
            "SELECT rowid FROM playlist WHERE user_id = ? AND file_id = ?",
            (user_id, file_id),
        ) as cur:
            row = await cur.fetchone()
            if row:
                _rowid_to_file_id_cache.pop(row[0], None)
        await conn.execute("DELETE FROM playlist WHERE user_id = ? AND file_id = ?", (user_id, file_id))
        await conn.execute(
            """
            DELETE FROM playlist_items
            WHERE file_id = ?
              AND playlist_id IN (SELECT id FROM user_playlists WHERE user_id = ?)
            """,
            (file_id, user_id),
        )
        await conn.commit()
    return web.json_response({'status': 'deleted'})


def _parse_playlist_id(request: web.Request) -> Optional[int]:
    raw = request.match_info.get('id', '')
    if not raw.isdigit():
        return None
    return int(raw)


@routes.get('/api/playlists')
async def list_user_playlists(request):
    """Возвращает пользовательские плейлисты (папки) вместе со списками track_ids."""
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute(
            "SELECT id, name, emoji FROM user_playlists WHERE user_id = ? ORDER BY position ASC, id ASC",
            (user_id,),
        ) as cur:
            pl_rows = await cur.fetchall()

        async with conn.execute(
            """
            SELECT pi.playlist_id, pi.file_id
            FROM playlist_items pi
            INNER JOIN user_playlists up ON up.id = pi.playlist_id
            INNER JOIN playlist p ON p.user_id = up.user_id AND p.file_id = pi.file_id
            WHERE up.user_id = ?
            ORDER BY pi.position ASC, pi.rowid DESC
            """,
            (user_id,),
        ) as cur:
            item_rows = await cur.fetchall()

    items_by_pl: dict[int, list[str]] = {}
    for pl_id, fid in item_rows:
        items_by_pl.setdefault(pl_id, []).append(fid)

    playlists = [
        {
            "id": pl_id,
            "name": name,
            "emoji": emoji or "🎧",
            "track_ids": items_by_pl.get(pl_id, []),
        }
        for pl_id, name, emoji in pl_rows
    ]
    return web.json_response({"playlists": playlists})


@routes.post('/api/playlists')
async def create_user_playlist(request):
    """Создаёт новый пользовательский плейлист (до MAX_USER_PLAYLISTS штук на пользователя)."""
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({'error': 'Invalid JSON'}, status=400)

    name = str(body.get('name', '')).strip()[:MAX_PLAYLIST_NAME_LEN]
    emoji = str(body.get('emoji', '🎧')).strip()[:8] or '🎧'
    if not name:
        return web.json_response({'error': 'Name is required'}, status=400)

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute(
            "SELECT COUNT(*) FROM user_playlists WHERE user_id = ?",
            (user_id,),
        ) as cur:
            count = (await cur.fetchone())[0]
        if count >= MAX_USER_PLAYLISTS:
            return web.json_response(
                {'error': f'Максимум {MAX_USER_PLAYLISTS} плейлистов'},
                status=400,
            )

        async with conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM user_playlists WHERE user_id = ?",
            (user_id,),
        ) as cur:
            next_pos = (await cur.fetchone())[0]

        now_iso = datetime.now().isoformat()
        cur = await conn.execute(
            "INSERT INTO user_playlists (user_id, name, emoji, position, created_at) VALUES (?, ?, ?, ?, ?)",
            (user_id, name, emoji, next_pos, now_iso),
        )
        pl_id = cur.lastrowid
        await conn.commit()

    return web.json_response(
        {"playlist": {"id": pl_id, "name": name, "emoji": emoji, "track_ids": []}},
        status=201,
    )


@routes.put('/api/playlists/reorder')
async def reorder_user_playlists(request):
    """Сохраняет новый порядок вкладок пользовательских плейлистов."""
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({'error': 'Invalid JSON'}, status=400)

    raw_ids = body.get('playlist_ids')
    if not isinstance(raw_ids, list):
        return web.json_response({'error': 'playlist_ids list required'}, status=400)

    clean_ids = []
    seen = set()
    for item in raw_ids:
        try:
            pid = int(item)
        except (TypeError, ValueError):
            continue
        if pid not in seen:
            seen.add(pid)
            clean_ids.append(pid)

    async with aiosqlite.connect(DB_PATH) as conn:
        for pos, pid in enumerate(clean_ids):
            await conn.execute(
                "UPDATE user_playlists SET position = ? WHERE id = ? AND user_id = ?",
                (pos, pid, user_id),
            )
        await conn.commit()

    return web.json_response({'status': 'ok'})


@routes.patch('/api/playlists/{id}')
async def update_user_playlist(request):
    """Переименовывает или меняет эмодзи пользовательского плейлиста."""
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)

    pl_id = _parse_playlist_id(request)
    if pl_id is None:
        return web.json_response({'error': 'Invalid playlist id'}, status=400)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({'error': 'Invalid JSON'}, status=400)

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute(
            "SELECT name, emoji FROM user_playlists WHERE id = ? AND user_id = ?",
            (pl_id, user_id),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return web.json_response({'error': 'Not found'}, status=404)

        new_name = str(body.get('name', row[0])).strip()[:MAX_PLAYLIST_NAME_LEN] or row[0]
        new_emoji = str(body.get('emoji', row[1])).strip()[:8] or row[1]

        await conn.execute(
            "UPDATE user_playlists SET name = ?, emoji = ? WHERE id = ? AND user_id = ?",
            (new_name, new_emoji, pl_id, user_id),
        )
        await conn.commit()

    return web.json_response({"playlist": {"id": pl_id, "name": new_name, "emoji": new_emoji}})


@routes.delete('/api/playlists/{id}')
async def delete_user_playlist(request):
    """Удаляет пользовательский плейлист (сами треки в 'Все треки' сохраняются)."""
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)

    pl_id = _parse_playlist_id(request)
    if pl_id is None:
        return web.json_response({'error': 'Invalid playlist id'}, status=400)

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute(
            "SELECT 1 FROM user_playlists WHERE id = ? AND user_id = ?",
            (pl_id, user_id),
        ) as cur:
            if not await cur.fetchone():
                return web.json_response({'error': 'Not found'}, status=404)

        await conn.execute("DELETE FROM playlist_items WHERE playlist_id = ?", (pl_id,))
        await conn.execute("DELETE FROM user_playlists WHERE id = ? AND user_id = ?", (pl_id, user_id))
        await conn.commit()

    return web.json_response({'status': 'deleted'})


@routes.post('/api/playlists/{id}/tracks')
async def add_tracks_to_user_playlist(request):
    """Добавляет один или несколько треков (file_ids) в пользовательский плейлист."""
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)

    pl_id = _parse_playlist_id(request)
    if pl_id is None:
        return web.json_response({'error': 'Invalid playlist id'}, status=400)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({'error': 'Invalid JSON'}, status=400)

    raw_ids = body.get('file_ids')
    if not isinstance(raw_ids, list) or not raw_ids:
        return web.json_response({'error': 'file_ids list required'}, status=400)

    clean_ids = [str(fid).strip() for fid in raw_ids if str(fid).strip()][:500]
    if not clean_ids:
        return web.json_response({'error': 'No valid file_ids'}, status=400)

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute(
            "SELECT 1 FROM user_playlists WHERE id = ? AND user_id = ?",
            (pl_id, user_id),
        ) as cur:
            if not await cur.fetchone():
                return web.json_response({'error': 'Not found'}, status=404)

        # Разрешаем добавлять только треки, которые есть в библиотеке этого пользователя
        placeholders = ",".join("?" for _ in clean_ids)
        async with conn.execute(
            f"SELECT file_id FROM playlist WHERE user_id = ? AND file_id IN ({placeholders})",
            [user_id, *clean_ids],
        ) as cur:
            allowed_ids = {r[0] for r in await cur.fetchall()}

        async with conn.execute(
            "SELECT COALESCE(MIN(position), 0) FROM playlist_items WHERE playlist_id = ?",
            (pl_id,),
        ) as cur:
            min_pos = (await cur.fetchone())[0]

        now_iso = datetime.now().isoformat()
        valid_ids = [fid for fid in clean_ids if fid in allowed_ids]
        to_insert = [
            (pl_id, fid, min_pos - 1 - idx, now_iso)
            for idx, fid in enumerate(valid_ids)
        ]
        if to_insert:
            await conn.executemany(
                "INSERT OR IGNORE INTO playlist_items (playlist_id, file_id, position, added_at) VALUES (?, ?, ?, ?)",
                to_insert,
            )
            await conn.commit()

    return web.json_response({'status': 'ok', 'added': len(to_insert)})


@routes.put('/api/playlists/{id}/reorder')
async def reorder_playlist_tracks(request):
    """Сохраняет ручной порядок треков внутри пользовательского плейлиста."""
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)

    pl_id = _parse_playlist_id(request)
    if pl_id is None:
        return web.json_response({'error': 'Invalid playlist id'}, status=400)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({'error': 'Invalid JSON'}, status=400)

    raw_ids = body.get('file_ids')
    if not isinstance(raw_ids, list):
        return web.json_response({'error': 'file_ids list required'}, status=400)

    clean_ids = []
    seen = set()
    for item in raw_ids[:1000]:
        fid = str(item).strip()
        if fid and fid not in seen:
            seen.add(fid)
            clean_ids.append(fid)

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute(
            "SELECT 1 FROM user_playlists WHERE id = ? AND user_id = ?",
            (pl_id, user_id),
        ) as cur:
            if not await cur.fetchone():
                return web.json_response({'error': 'Not found'}, status=404)

        await conn.executemany(
            "UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND file_id = ?",
            [(pos, pl_id, fid) for pos, fid in enumerate(clean_ids)],
        )
        await conn.commit()

    return web.json_response({'status': 'ok'})


@routes.delete('/api/playlists/{id}/tracks')
async def remove_track_from_user_playlist(request):
    """Убирает трек только из конкретного пользовательского плейлиста."""
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)

    pl_id = _parse_playlist_id(request)
    if pl_id is None:
        return web.json_response({'error': 'Invalid playlist id'}, status=400)

    file_id = request.query.get('file_id')
    if not file_id:
        return web.json_response({'error': 'No file_id'}, status=400)

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute(
            "SELECT 1 FROM user_playlists WHERE id = ? AND user_id = ?",
            (pl_id, user_id),
        ) as cur:
            if not await cur.fetchone():
                return web.json_response({'error': 'Not found'}, status=404)

        await conn.execute(
            "DELETE FROM playlist_items WHERE playlist_id = ? AND file_id = ?",
            (pl_id, file_id),
        )
        await conn.commit()

    return web.json_response({'status': 'deleted'})


@routes.get('/api/stream')
async def stream_audio(request):
    """Проксирует аудиопоток с поддержкой Range-запросов и кэшированием Telegram file_path"""
    file_id = await _resolve_file_id_from_request(request)
    if not file_id:
        return web.Response(status=403, text="Forbidden")
    try:
        headers = {}
        if 'Range' in request.headers:
            headers['Range'] = request.headers['Range']

        session = _get_http_session()

        for attempt in range(2):
            file_path = await get_cached_file_path(file_id, force_refresh=(attempt > 0))
            direct_url = f"https://api.telegram.org/file/bot{bot_instance.token}/{file_path}"

            async with session.get(direct_url, headers=headers) as resp:
                if resp.status == 404 and attempt == 0:
                    _file_path_cache.pop(file_id, None)
                    continue

                raw_ct = resp.headers.get('Content-Type', '')
                if not raw_ct or raw_ct == 'application/octet-stream':
                    ext = os.path.splitext(file_path)[1].lower()
                    content_type = {
                        '.m4a': 'audio/mp4',
                        '.mp4': 'audio/mp4',
                        '.ogg': 'audio/ogg',
                        '.opus': 'audio/ogg',
                        '.mp3': 'audio/mpeg',
                    }.get(ext, 'audio/mpeg')
                else:
                    content_type = raw_ct

                response = web.StreamResponse(
                    status=resp.status,
                    headers={
                        'Content-Type': content_type,
                        'Accept-Ranges': 'bytes',
                        'Cache-Control': 'private, max-age=1800',
                    }
                )
                if 'Content-Range' in resp.headers:
                    response.headers['Content-Range'] = resp.headers['Content-Range']
                if 'Content-Length' in resp.headers:
                    response.headers['Content-Length'] = resp.headers['Content-Length']

                await response.prepare(request)
                async for chunk in resp.content.iter_chunked(16384):
                    await response.write(chunk)
                await response.write_eof()
                return response

        return web.Response(status=404, text="File not found")
    except Exception as e:
        logger.warning("Ошибка стриминга %s: %s", file_id, e)
        return web.Response(status=500, text=str(e))


@routes.post('/api/send_track')
async def send_track(request):
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)

    file_id = request.query.get('file_id')
    if not file_id:
        return web.json_response({'error': 'No file_id'}, status=400)

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute(
            "SELECT 1 FROM playlist WHERE user_id = ? AND file_id = ?",
            (user_id, file_id)
        ) as cur:
            if not await cur.fetchone():
                return web.json_response({'error': 'Track not found in playlist'}, status=404)

    try:
        await bot_instance.send_audio(chat_id=user_id, audio=file_id)
        return web.json_response({'status': 'sent'})
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)


@routes.post('/api/stats/play')
async def record_track_play(request):
    """Записывает прослушивание трека в play_history для персональной статистики."""
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({'error': 'Invalid JSON'}, status=400)

    file_id = str(body.get('file_id', '')).strip()
    if not file_id:
        return web.json_response({'error': 'file_id required'}, status=400)

    try:
        listened_sec = int(float(body.get('listened_sec', 0)))
    except (TypeError, ValueError):
        listened_sec = 0
    listened_sec = max(1, min(7200, listened_sec))

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute(
            """
            SELECT COALESCE(p.title, t.title), COALESCE(p.performer, t.performer)
            FROM playlist p
            LEFT JOIN tracks t ON p.file_id = t.file_id
            WHERE p.user_id = ? AND p.file_id = ?
            LIMIT 1
            """,
            (user_id, file_id),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return web.json_response({'error': 'Not found'}, status=404)

        title = row[0] or str(body.get('title', '')).strip()[:160] or 'Без названия'
        performer = row[1] or str(body.get('performer', '')).strip()[:120] or 'Spotify'

        await conn.execute(
            """
            INSERT INTO play_history (user_id, file_id, title, performer, listened_sec, played_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (user_id, file_id, title, performer, listened_sec, datetime.now().isoformat()),
        )
        await conn.commit()

    return web.json_response({'status': 'ok'})


@routes.get('/api/stats')
async def get_user_stats(request):
    """Возвращает персональную статистику прослушиваний (Spotify Wrapped-карточка)."""
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)

    period = request.query.get('period', 'all')
    since_iso = None
    if period == '7d':
        since_iso = (datetime.now() - timedelta(days=7)).isoformat()
    elif period == '30d':
        since_iso = (datetime.now() - timedelta(days=30)).isoformat()

    where_sql = "WHERE user_id = ?"
    params: list = [user_id]
    if since_iso:
        where_sql += " AND played_at >= ?"
        params.append(since_iso)

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute(
            f"""
            SELECT COUNT(*), COALESCE(SUM(listened_sec), 0), COUNT(DISTINCT file_id)
            FROM play_history
            {where_sql}
            """,
            params,
        ) as cur:
            summary_row = await cur.fetchone()

        total_plays = int(summary_row[0] or 0)
        total_seconds = int(summary_row[1] or 0)
        unique_tracks = int(summary_row[2] or 0)

        async with conn.execute(
            f"""
            SELECT performer, COUNT(*) AS plays, COALESCE(SUM(listened_sec), 0) AS secs
            FROM play_history
            {where_sql} AND performer IS NOT NULL AND TRIM(performer) != ''
            GROUP BY LOWER(TRIM(performer))
            ORDER BY plays DESC, secs DESC
            LIMIT 3
            """,
            params,
        ) as cur:
            artist_rows = await cur.fetchall()

        async with conn.execute(
            f"""
            SELECT h.file_id,
                   MAX(h.title) AS title,
                   MAX(h.performer) AS performer,
                   COUNT(*) AS plays,
                   COALESCE(SUM(h.listened_sec), 0) AS secs,
                   MAX(p.rowid) AS row_id
            FROM play_history h
            LEFT JOIN playlist p ON p.user_id = h.user_id AND p.file_id = h.file_id
            WHERE h.user_id = ? {"AND h.played_at >= ?" if since_iso else ""}
            GROUP BY h.file_id
            ORDER BY plays DESC, secs DESC
            LIMIT 5
            """,
            params,
        ) as cur:
            track_rows = await cur.fetchall()

    top_artists = [
        {"performer": r[0], "plays": int(r[1]), "seconds": int(r[2])}
        for r in artist_rows
    ]

    top_tracks = []
    for fid, title, performer, plays, secs, row_id in track_rows:
        cover_url = None
        if row_id is not None:
            _cache_rowid_file_id(row_id, fid)
            item_id = str(row_id)
            exp, sig = sign_media_token(item_id)
            cover_url = f"/api/cover?{urlencode({'id': item_id, 'exp': exp, 'sig': sig})}"
        top_tracks.append({
            "file_id": fid,
            "title": title or "Без названия",
            "performer": performer or "Spotify",
            "plays": int(plays),
            "seconds": int(secs),
            "cover_url": cover_url,
            "in_library": row_id is not None,
        })

    return web.json_response({
        "period": period,
        "total_plays": total_plays,
        "total_seconds": total_seconds,
        "unique_tracks": unique_tracks,
        "top_artists": top_artists,
        "top_tracks": top_tracks,
    })


@routes.get('/api/cover')
async def get_cover(request):
    file_id = await _resolve_file_id_from_request(request)
    if not file_id:
        return web.Response(status=403, text="Forbidden")
        
    cover_path = get_cover_cache_path(file_id)
    
    if os.path.exists(cover_path):
        if cover_path not in _checked_covers:
            _checked_covers.add(cover_path)
            if len(_checked_covers) > 2000:
                _checked_covers.clear()
            await asyncio.to_thread(optimize_existing_cover_file, cover_path)
        return web.FileResponse(cover_path, headers={"Cache-Control": "public, max-age=21600, immutable"})
        
    await resolve_track_metadata(file_id)
    
    if os.path.exists(cover_path):
        _checked_covers.add(cover_path)
        return web.FileResponse(cover_path, headers={"Cache-Control": "public, max-age=21600, immutable"})
         
    return web.Response(status=404)


@routes.get('/api/room_config')
async def get_room_config(request):
    global _bot_username_cache
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)
    if _bot_username_cache is None and bot_instance:
        try:
            me = await bot_instance.get_me()
            _bot_username_cache = me.username or ""
        except Exception as e:
            logger.warning("Не удалось получить username бота: %s", e)
            _bot_username_cache = ""
    return web.json_response({
        "bot_username": _bot_username_cache or "",
        "ws_path": "/ws/rooms/websocket",
    })


@routes.get('/ws/rooms/websocket')
async def proxy_rooms_websocket(request):
    """Проксирует WebSocket-соединения комнат на Elixir-сервис (Phoenix Channels)."""
    upstream_url = ROOMS_WS_UPSTREAM
    if request.query_string:
        upstream_url = f"{upstream_url}?{request.query_string}"

    session = _get_http_session()
    try:
        upstream_ws = await session.ws_connect(upstream_url, heartbeat=25)
    except Exception as e:
        logger.warning("Elixir rooms upstream unavailable (%s): %s", ROOMS_WS_UPSTREAM, e)
        return web.Response(status=503, text="Rooms service unavailable")

    client_ws = web.WebSocketResponse(heartbeat=25)
    await client_ws.prepare(request)

    async def forward_client_to_upstream():
        async for msg in client_ws:
            if msg.type == WSMsgType.TEXT:
                await upstream_ws.send_str(msg.data)
            elif msg.type == WSMsgType.BINARY:
                await upstream_ws.send_bytes(msg.data)
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break

    async def forward_upstream_to_client():
        async for msg in upstream_ws:
            if msg.type == WSMsgType.TEXT:
                await client_ws.send_str(msg.data)
            elif msg.type == WSMsgType.BINARY:
                await client_ws.send_bytes(msg.data)
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break

    tasks = [
        asyncio.create_task(forward_client_to_upstream()),
        asyncio.create_task(forward_upstream_to_client()),
    ]
    try:
        _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    finally:
        if not upstream_ws.closed:
            await upstream_ws.close()
        if not client_ws.closed:
            await client_ws.close()

    return client_ws


async def _on_startup(app: web.Application):
    _get_http_session()


async def _on_cleanup(app: web.Application):
    global http_session
    if http_session and not http_session.closed:
        await http_session.close()


def create_web_app(bot: Bot) -> web.Application:
    """Создает единое aiohttp-приложение для WebApp-виджета и Telegram Webhook"""
    global bot_instance
    bot_instance = bot
    app = web.Application()
    app.add_routes(routes)
    app.router.add_static('/static', WEB_STATIC_DIR)
    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)
    return app