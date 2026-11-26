import asyncio
from difflib import SequenceMatcher
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
from services.cache import write_optimized_cover

logger = logging.getLogger(__name__)

_ytm_client: Optional[YTMusic] = None

UNWANTED_VERSION_TAGS = (
    "remix",
    "slowed",
    "sped up",
    "speed up",
    "nightcore",
    "cover",
    "live",
    "karaoke",
    "instrumental",
    "acoustic",
    "8d",
    "reverb",
    "bass boosted",
    "mashup",
    "edit",
    "tribute",
    "parody",
    "concert",
    "bootleg",
    "lo-fi",
    "lofi",
    "chopped",
    "screwed",
)

MIN_MATCH_SCORE = 45.0


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


def _norm_text(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", (text or "").lower())).strip()


def _has_tag(text: str, tag: str) -> bool:
    return bool(re.search(rf"(?<![a-zа-яё0-9]){re.escape(tag)}(?![a-zа-яё0-9])", (text or "").lower()))


def _score_ytm_candidate(
    item: dict,
    title: str,
    performer: str,
    expected_duration: Optional[int] = None,
    album: Optional[str] = None,
    is_song_result: bool = True,
) -> float:
    """
    Оценивает кандидата с YouTube Music по названию, исполнителю, альбому, длительности
    и штрафует за нежелательные теги (remix/slowed/cover/live и т.п.), если их нет в оригинале Spotify.
    """
    cand_title = (item.get("title") or "").strip()
    cand_artists_list = [a.get("name", "").strip() for a in (item.get("artists") or []) if a.get("name")]
    cand_artists_str = ", ".join(cand_artists_list)
    cand_album = ((item.get("album") or {}).get("name") or "").strip() if isinstance(item.get("album"), dict) else ""

    score = 10.0 if is_song_result else 0.0

    # 1. Схожесть названия (0..40)
    norm_sp_title = _norm_text(title)
    norm_cand_title = _norm_text(cand_title)
    if norm_sp_title and norm_cand_title:
        ratio = SequenceMatcher(None, norm_sp_title, norm_cand_title).ratio()
        sp_words = set(norm_sp_title.split())
        cand_words = set(norm_cand_title.split())
        overlap = len(sp_words & cand_words) / max(1, len(sp_words))
        score += 40.0 * max(ratio, overlap * 0.95)

    # 2. Совпадение исполнителя (-35..+35)
    sp_artists = [a.strip() for a in re.split(r"[,&/]|feat\.|ft\.", performer or "", flags=re.I) if a.strip()]
    if sp_artists and sp_artists[0].lower() != "spotify":
        cand_artist_haystack = _norm_text(f"{cand_artists_str} {cand_title}")
        best_artist_sim = 0.0
        for sp_a in sp_artists:
            norm_a = _norm_text(sp_a)
            if not norm_a:
                continue
            if norm_a in cand_artist_haystack:
                best_artist_sim = 1.0
                break
            for ca in cand_artists_list:
                sim = SequenceMatcher(None, norm_a, _norm_text(ca)).ratio()
                if sim > best_artist_sim:
                    best_artist_sim = sim
        if best_artist_sim >= 0.8:
            score += 35.0 * best_artist_sim
        elif best_artist_sim >= 0.55:
            score += 15.0 * best_artist_sim
        else:
            score -= 35.0

    # 3. Бонус за совпадение альбома (+12)
    if album and cand_album:
        alb_sim = SequenceMatcher(None, _norm_text(album), _norm_text(cand_album)).ratio()
        if alb_sim >= 0.75:
            score += 12.0

    # 4. Разница длительности (-40..+20)
    if expected_duration and expected_duration > 0:
        dur = item.get("duration_seconds") or _parse_ytm_duration(item.get("duration"))
        if dur is not None:
            diff = abs(int(dur) - expected_duration)
            if diff <= 3:
                score += 20.0
            elif diff <= 8:
                score += 12.0
            elif diff <= 15:
                score += 4.0
            elif diff <= 25:
                score -= 10.0
            else:
                score -= 40.0

    # 5. Штраф за ремиксы / каверы / slowed / live, если их НЕТ в оригинале Spotify
    sp_context = f"{title} {album or ''}"
    for tag in UNWANTED_VERSION_TAGS:
        in_sp = _has_tag(sp_context, tag)
        in_cand = _has_tag(cand_title, tag)
        if in_cand and not in_sp:
            score -= 45.0
        elif in_sp and in_cand:
            score += 10.0
        elif in_sp and not in_cand:
            score -= 20.0

    return score


def find_ytmusic_video_id(
    title: str,
    performer: str,
    expected_duration: Optional[int] = None,
    isrc: Optional[str] = None,
    album: Optional[str] = None,
) -> Optional[str]:
    """
    Ищет наиболее точный videoId трека на YouTube Music:
      1) Сначала по ISRC-коду (точная официальная студийная запись).
      2) Затем текстовым поиском с умным скорингом и фильтром от ремиксов/каверов/лайвов.
      3) Если ни один кандидат не прошёл порог уверенности — возвращает None (для fallback на spotdl).
    """
    ytm = get_ytmusic_client()

    # 1. Точный поиск по ISRC
    if isrc:
        try:
            isrc_results = ytm.search(isrc, filter="songs", limit=3)
            isrc_candidates = [r for r in isrc_results if r.get("videoId")]
            if isrc_candidates:
                best_isrc = max(
                    isrc_candidates,
                    key=lambda r: _score_ytm_candidate(
                        r, title, performer, expected_duration=expected_duration, album=album, is_song_result=True
                    ),
                )
                isrc_score = _score_ytm_candidate(
                    best_isrc, title, performer, expected_duration=expected_duration, album=album, is_song_result=True
                )
                if isrc_score >= MIN_MATCH_SCORE:
                    return best_isrc["videoId"]
        except Exception as e:
            logger.debug("YTMusic ISRC search failed for %s: %s", isrc, e)

    # 2. Поиск по названию и исполнителю с ранжированием
    query = f"{performer} - {title}" if performer and performer.lower() != "spotify" else title
    best_video_id: Optional[str] = None
    best_score = float("-inf")

    for search_filter in ("songs", "videos"):
        try:
            results = ytm.search(query, filter=search_filter, limit=8)
        except Exception as e:
            logger.warning("YTMusic search (%s) failed for %r: %s", search_filter, query, e)
            continue

        is_song = search_filter == "songs"
        for item in results:
            vid = item.get("videoId")
            if not vid:
                continue
            sc = _score_ytm_candidate(
                item,
                title,
                performer,
                expected_duration=expected_duration,
                album=album,
                is_song_result=is_song,
            )
            if sc > best_score:
                best_score = sc
                best_video_id = vid

        # Если среди официальных songs уже есть уверенное совпадение — videos не ищем
        if is_song and best_score >= 65.0:
            break

    if best_video_id and best_score >= MIN_MATCH_SCORE:
        return best_video_id

    logger.info(
        "No confident YTMusic match for %r (best_score=%.1f < %.1f), falling back to spotdl",
        query,
        best_score,
        MIN_MATCH_SCORE,
    )
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
    isrc: Optional[str] = None,
    album: Optional[str] = None,
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
    video_id = find_ytmusic_video_id(
        title,
        performer,
        expected_duration=expected_duration,
        isrc=isrc,
        album=album,
    )
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


def _clean_yt_meta(info: dict) -> tuple[str, str]:
    """Извлекает чистые (title, performer) из словаря метаданных yt-dlp (YouTube / YT Music / SoundCloud)."""
    raw_title = (info.get("track") or info.get("title") or "Без названия").strip()
    raw_artist = (info.get("artist") or info.get("creator") or "").strip()

    if not raw_artist and " - " in raw_title:
        left, right = raw_title.split(" - ", 1)
        if left.strip() and right.strip():
            return right.strip(), left.strip()

    uploader = (info.get("uploader") or info.get("channel") or "Audio").strip()
    # YouTube Music auto-generated channels end with " - Topic"
    if uploader.endswith(" - Topic"):
        uploader = uploader[:-8].strip()

    return raw_title, (raw_artist or uploader or "Audio")


def inspect_direct_url_sync(
    url: str,
    cookies_path: Optional[str] = None,
) -> Optional[dict]:
    """Получает метаданные трека с YouTube / YouTube Music / SoundCloud без скачивания."""
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "nocheckcertificate": True,
        "socket_timeout": 15,
    }
    if cookies_path and os.path.isfile(cookies_path):
        ydl_opts["cookiefile"] = cookies_path

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                return None
            if info.get("_type") == "playlist":
                entries = info.get("entries") or []
                info = entries[0] if entries else None
                if not info:
                    return None
            title, performer = _clean_yt_meta(info)
            return {
                "title": title,
                "performer": performer,
                "duration_sec": int(info.get("duration") or 0),
                "is_live": bool(info.get("is_live")),
                "cover_url": info.get("thumbnail"),
                "webpage_url": info.get("webpage_url") or url,
            }
    except Exception as e:
        logger.warning("Direct URL metadata inspect failed (%s): %s", url, e)
        return None


def download_direct_url_sync(
    url: str,
    temp_dir: str,
    title: str,
    performer: str,
    cookies_path: Optional[str] = None,
    stage_callback: Optional[Callable[[str], None]] = None,
) -> Optional[str]:
    """Скачивает аудио напрямую по ссылке YouTube / YouTube Music / SoundCloud через yt-dlp (m4a/mp3)."""
    if stage_callback:
        try:
            stage_callback("⬇️ Скачиваю аудио...")
        except Exception:
            pass

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
        "max_filesize": 48 * 1024 * 1024,
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
                for fname in os.listdir(temp_dir):
                    full = os.path.join(temp_dir, fname)
                    if os.path.isfile(full) and not fname.endswith((".part", ".ytdl", ".jpg")):
                        downloaded_path = full
                        break
            if os.path.isfile(downloaded_path):
                return _ensure_telegram_compatible_audio(downloaded_path, temp_dir)
    except Exception as e:
        logger.warning("Direct URL download failed (%s): %s", url, e)

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
    """Сразу сохраняет оптимизированную обложку (400×400 JPEG) в covers_cache."""
    if not file_id or not cover_bytes:
        return
    try:
        os.makedirs(COVERS_DIR, exist_ok=True)
        safe_hash = hashlib.md5(file_id.encode("utf-8")).hexdigest()
        cover_path = os.path.join(COVERS_DIR, f"{safe_hash}.jpg")
        write_optimized_cover(cover_path, cover_bytes)
    except OSError as e:
        logger.warning("Failed to save cover cache for %s: %s", file_id, e)
