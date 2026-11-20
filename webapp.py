import asyncio
import hashlib
import hmac
import os
import tempfile
import time
from typing import Optional
from urllib.parse import urlencode

import aiosqlite
from aiohttp import web, ClientSession
from aiogram import Bot
from aiogram.utils.web_app import safe_parse_webapp_init_data
from mutagen.mp3 import MP3
from mutagen.id3 import ID3, APIC
from config import DB_PATH, BASE_DIR, COVERS_DIR, MEDIA_SIGN_KEY

routes = web.RouteTableDef()
bot_instance: Bot = None
http_session: ClientSession = None

os.makedirs(COVERS_DIR, exist_ok=True)

METADATA_SEMAPHORE = asyncio.Semaphore(2)
_resolving_tasks: set[str] = set()
MEDIA_TOKEN_TTL = 12 * 3600


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


def sign_media_token(file_id: str, exp: Optional[int] = None) -> tuple[int, str]:
    """Генерирует временную HMAC-подпись для безопасного доступа к /api/stream и /api/cover."""
    if exp is None:
        exp = int(time.time()) + MEDIA_TOKEN_TTL
    payload = f"{file_id}:{exp}".encode("utf-8")
    sig = hmac.new(MEDIA_SIGN_KEY.encode("utf-8"), payload, hashlib.sha256).hexdigest()[:32]
    return exp, sig


def verify_media_token(file_id: str, exp_str: Optional[str], sig: Optional[str]) -> bool:
    if not file_id or not exp_str or not sig:
        return False
    try:
        exp = int(exp_str)
    except ValueError:
        return False
    if exp < int(time.time()):
        return False
    _, expected_sig = sign_media_token(file_id, exp)
    return hmac.compare_digest(sig, expected_sig)


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
                with open(cover_path, "wb") as f:
                    f.write(tag.data)
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
            file_info = await bot_instance.get_file(file_id)
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as temp_mp3:
                temp_name = temp_mp3.name

            await bot_instance.download_file(file_info.file_path, temp_name)

            try:
                title, performer = await asyncio.to_thread(_extract_id3_sync, temp_name, cover_path)
            except Exception as e:
                print(f"Ошибка чтения ID3: {e}")
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
            print(f"Ошибка загрузки файла для метаданных: {e}")
        finally:
            _resolving_tasks.discard(file_id)

    return title, performer


def schedule_metadata_resolution(file_id: str):
    """Запускает фоновое извлечение ID3-тегов без задержки открытия плейлиста"""
    if file_id not in _resolving_tasks:
        _resolving_tasks.add(file_id)
        asyncio.create_task(resolve_track_metadata(file_id))


@routes.get('/')
async def index(request):
    return web.FileResponse(os.path.join(BASE_DIR, 'playlist.html'))


@routes.get('/api/playlist')
async def get_playlist(request):
    user_id = _get_authenticated_user_id(request)
    if user_id is None:
        return web.json_response({'error': 'Unauthorized'}, status=401)
        
    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute("""
            SELECT p.file_id,
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
    for file_id, title, performer, raw_url in rows:
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

        exp, sig = sign_media_token(file_id)
        signed_query = urlencode({"file_id": file_id, "exp": exp, "sig": sig})

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
        await conn.execute("DELETE FROM playlist WHERE user_id = ? AND file_id = ?", (user_id, file_id))
        await conn.commit()
    return web.json_response({'status': 'deleted'})


@routes.get('/api/stream')
async def stream_audio(request):
    """Проксирует аудиопоток с поддержкой Range-запросов для плавной перемотки в плеере"""
    global http_session
    file_id = request.query.get('file_id')
    if not verify_media_token(file_id, request.query.get('exp'), request.query.get('sig')):
        return web.Response(status=403, text="Forbidden")
    try:
        file_info = await bot_instance.get_file(file_id)
        direct_url = f"https://api.telegram.org/file/bot{bot_instance.token}/{file_info.file_path}"
        
        headers = {}
        if 'Range' in request.headers:
            headers['Range'] = request.headers['Range']

        if http_session is None or http_session.closed:
            http_session = ClientSession()

        async with http_session.get(direct_url, headers=headers) as resp:
            response = web.StreamResponse(
                status=resp.status,
                headers={
                    'Content-Type': resp.headers.get('Content-Type', 'audio/mpeg'),
                    'Accept-Ranges': 'bytes',
                }
            )
            if 'Content-Range' in resp.headers:
                response.headers['Content-Range'] = resp.headers['Content-Range']
            if 'Content-Length' in resp.headers:
                response.headers['Content-Length'] = resp.headers['Content-Length']

            await response.prepare(request)
            async for chunk in resp.content.iter_chunked(65536):
                await response.write(chunk)
            await response.write_eof()
            return response
    except Exception as e:
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


@routes.get('/api/cover')
async def get_cover(request):
    file_id = request.query.get('file_id')
    if not verify_media_token(file_id, request.query.get('exp'), request.query.get('sig')):
        return web.Response(status=403, text="Forbidden")
        
    cover_path = get_cover_cache_path(file_id)
    
    if os.path.exists(cover_path):
        return web.FileResponse(cover_path, headers={"Cache-Control": "public, max-age=86400"})
        
    await resolve_track_metadata(file_id)
    
    if os.path.exists(cover_path):
        return web.FileResponse(cover_path, headers={"Cache-Control": "public, max-age=86400"})
         
    return web.Response(status=404)


async def _on_startup(app: web.Application):
    global http_session
    http_session = ClientSession()


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
    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)
    return app