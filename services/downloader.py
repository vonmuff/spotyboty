import asyncio
import hashlib
import logging
import os
import re
import subprocess
from typing import Callable, Optional

import aiohttp
import yt_dlp
from ytmusicapi import YTMusic

from bot.config import COVERS_DIR

logger = logging.getLogger(__name__)

_ytm_client: Optional[YTMusic] = None


def get_ytmusic_client() -> YTMusic:
    """Ленивая инициализация YTMusic один раз в памяти (0 сек на повторные вызовы)."""
    global _ytm_client
    if _ytm_client is None:
        _ytm_client = YTMusic()
    return _ytm_client


def _sanitize_filename(name: str) -> str:
    cleaned = re.sub(r'[\\/*?:"<>|\n\r\t]+', "_", name).strip()
    return cleaned[:120] or "track"


def _parse_ytm_duration(duration_str: Optional[str]) -> Optional[int]:
    if not duration_str:
        return None
    parts = duration_str.split(":")
    try:
        nums = [int(p) for p in parts]
        if len(nums) == 2:
            return nums[0] * 60 + nums[1]
        if len(nums) == 3:
            return nums[0] * 3600 + nums[1] * 60 + nums[2]
    except ValueError:
        return None
    return None


def find_ytmusic_video_id(
    title: str,
    performer: str,
    expected_duration: Optional[int] = None,
) -> Optional[str]:
    """Ищет наиболее точный videoId трека на YouTube Music по названию, автору и длительности."""
    ytm = get_ytmusic_client()
    query = f"{performer} - {title}" if performer and performer.lower() != "spotify" else title

    for search_filter in ("songs", "videos"):
        try:
            results = ytm.search(query, filter=search_filter, limit=5)
        except Exception as e:
            logger.warning("YTMusic search (%s) failed for %r: %s", search_filter, query, e)
            continue

        candidates = [r for r in results if r.get("videoId")]
        if not candidates:
            continue

        if expected_duration and expected_duration > 0:
            def _score(item: dict) -> tuple[int, int]:
                dur = item.get("duration_seconds") or _parse_ytm_duration(item.get("duration"))
                if dur is None:
                    return (1, 9999)
                diff = abs(int(dur) - expected_duration)
                return (0 if diff <= 15 else 1, diff)

            candidates.sort(key=_score)

        return candidates[0]["videoId"]

    return None


def _ensure_telegram_compatible_audio(file_path: str, temp_dir: str) -> str:
    """
    Если yt-dlp скачал m4a или mp3 — отдаём как есть БЕЗ перекодировки ffmpeg (0 сек CPU).
    Конвертируем в m4a (AAC 192k) только если YouTube отдал webm/opus.
    """
    ext = os.path.splitext(file_path)[1].lower()
    if ext in (".m4a", ".mp3"):
        return file_path

    out_path = os.path.join(temp_dir, os.path.splitext(os.path.basename(file_path))[0] + ".m4a")
    cmd = [
        "ffmpeg", "-y", "-i", file_path,
        "-vn", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        out_path,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if proc.returncode == 0 and os.path.isfile(out_path):
        try:
            os.unlink(file_path)
        except OSError:
            pass
        return out_path
    return file_path


def download_track_fast_sync(
    title: str,
    performer: str,
    temp_dir: str,
    expected_duration: Optional[int] = None,
    cookies_path: Optional[str] = None,
    stage_callback: Optional[Callable[[str], None]] = None,
) -> Optional[str]:
    """
    Быстрое скачивание одиночного трека в памяти через ytmusicapi + yt-dlp (m4a без перекодировки).
    Возвращает путь к скачанному файлу или None (для fallback на spotdl).
    """
    def _report(stage: str):
        if stage_callback:
            try:
                stage_callback(stage)
            except Exception:
                pass

    _report("🔎 Ищу трек...")
    video_id = find_ytmusic_video_id(title, performer, expected_duration=expected_duration)
    if not video_id:
        return None

    _report("⬇️ Скачиваю аудио...")
    url = f"https://music.youtube.com/watch?v={video_id}"
    safe_base = _sanitize_filename(f"{performer} - {title}")
    outtmpl = os.path.join(temp_dir, f"{safe_base}.%(ext)s")

    ydl_opts = {
        "format": "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
        "outtmpl": outtmpl,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "nocheckcertificate": True,
        "concurrent_fragment_downloads": 4,
        "socket_timeout": 15,
        "retries": 2,
    }
    if cookies_path and os.path.isfile(cookies_path):
        ydl_opts["cookiefile"] = cookies_path

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if not info:
                return None
            downloaded_path = ydl.prepare_filename(info)
            if not os.path.isfile(downloaded_path):
                # На случай если расширение отличалось от prepare_filename
                for fname in os.listdir(temp_dir):
                    full = os.path.join(temp_dir, fname)
                    if os.path.isfile(full) and not fname.endswith((".part", ".ytdl", ".jpg")):
                        downloaded_path = full
                        break
            if os.path.isfile(downloaded_path):
                return _ensure_telegram_compatible_audio(downloaded_path, temp_dir)
    except Exception as e:
        logger.warning("Fast yt-dlp download failed for %r (%s): %s", f"{performer} - {title}", video_id, e)

    return None


async def download_cover_bytes(cover_url: Optional[str]) -> Optional[bytes]:
    """Асинхронно скачивает обложку трека из Spotify CDN (параллельно со скачиванием аудио)."""
    if not cover_url:
        return None
    try:
        timeout = aiohttp.ClientTimeout(total=6)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(cover_url) as resp:
                if resp.status == 200:
                    data = await resp.read()
                    if data and len(data) <= 2 * 1024 * 1024:
                        return data
    except Exception as e:
        logger.debug("Cover download failed (%s): %s", cover_url, e)
    return None


def save_cover_to_cache(file_id: str, cover_bytes: Optional[bytes]) -> None:
    """Сразу сохраняет обложку в covers_cache, чтобы WebApp отдавал её мгновенно без повторного скачивания MP3."""
    if not file_id or not cover_bytes:
        return
    try:
        os.makedirs(COVERS_DIR, exist_ok=True)
        safe_hash = hashlib.md5(file_id.encode("utf-8")).hexdigest()
        cover_path = os.path.join(COVERS_DIR, f"{safe_hash}.jpg")
        with open(cover_path, "wb") as f:
            f.write(cover_bytes)
    except OSError as e:
        logger.warning("Failed to save cover cache for %s: %s", file_id, e)
