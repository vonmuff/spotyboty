import asyncio
import hashlib
import os
import re
import shutil
import sys
from typing import Optional

import aiosqlite

from bot.config import (
    BASE_DIR,
    BLACKLIST_FILE,
    COOKIES_FILE,
    COVERS_DIR,
    SPOTIPY_CLIENT_ID,
    SPOTIPY_CLIENT_SECRET,
)

DOWNLOAD_SEMAPHORE = asyncio.Semaphore(2)

_blacklist_cache: tuple[Optional[float], Optional[re.Pattern]] = (None, None)


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
    Проверяет строку исполнителя на наличие запрещенных артистов из blacklist.txt.
    Ищет только полные совпадения слов/имён по границам слов.
    """
    if not artist_text:
        return None

    pattern = _get_blacklist_pattern()
    if pattern is None:
        return None

    match = pattern.search(artist_text.lower())
    return match.group(0) if match else None


def remove_cached_cover(file_id: str) -> None:
    if not file_id:
        return
    safe_hash = hashlib.md5(file_id.encode("utf-8")).hexdigest()
    cover_path = os.path.join(COVERS_DIR, f"{safe_hash}.jpg")
    if os.path.isfile(cover_path):
        try:
            os.unlink(cover_path)
        except OSError:
            pass


async def find_cached_track(
    conn: aiosqlite.Connection,
    cache_key: str,
    raw_query: str,
    exact_only: bool = False,
) -> Optional[str]:
    """
    Ищет трек в локальной базе:
    1) Сначала по точному совпадению ключа (ссылка или текст запроса).
    2) Если exact_only=False и запрос текстовый (минимум 2 слова) — ищет по словам в title/performer.
    Для прямых ссылок (Spotify/YouTube/SoundCloud) всегда используется только точное совпадение URL.
    """
    async with conn.execute("SELECT file_id FROM tracks WHERE url = ?", (cache_key,)) as cur:
        row = await cur.fetchone()
        if row:
            return row[0]

    if exact_only or cache_key.startswith(("http://", "https://")):
        return None

    low_q = raw_query.lower()
    if any(domain in low_q for domain in ("spotify.com", "youtube.com", "youtu.be", "soundcloud.com")):
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


def get_cookies_path() -> Optional[str]:
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
        "--output", temp_dir,
        "--client-id", client_id,
        "--client-secret", client_secret,
    ]

    cookies_path = get_cookies_path()
    if cookies_path:
        cmd.extend(["--cookie-file", cookies_path])

    return cmd


def parse_filename_meta(file_path: str) -> tuple[str, str]:
    """Извлекает исполнителя и название из имени файла spotdl (Artist - Title.mp3)."""
    base = os.path.splitext(os.path.basename(file_path))[0]
    if " - " in base:
        performer, title = base.split(" - ", 1)
        return title.strip(), performer.strip()
    return base.strip(), "Spotify"
