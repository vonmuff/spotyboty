import os
import shutil
import time
from datetime import datetime, timedelta

import aiosqlite

from bot.config import COVERS_DIR, DATA_DIR, DB_PATH
from services.cache import DOWNLOAD_SEMAPHORE

BOT_STARTED_AT = time.monotonic()


def _bar(percent: float, length: int = 8) -> str:
    pct = max(0.0, min(100.0, percent))
    filled = int(round((pct / 100.0) * length))
    return f"{'▰' * filled}{'▱' * (length - filled)} {pct:.0f}%"


def _fmt_duration(seconds: float) -> str:
    total = max(0, int(seconds))
    days, rem = divmod(total, 86400)
    hours, rem = divmod(rem, 3600)
    mins, secs = divmod(rem, 60)
    if days > 0:
        return f"{days}д {hours}ч {mins}м"
    if hours > 0:
        return f"{hours}ч {mins}м"
    return f"{mins}м {secs}с"


def _fmt_bytes(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} Б"
    kb = num_bytes / 1024
    if kb < 1024:
        return f"{kb:.1f} КБ"
    mb = kb / 1024
    if mb < 1024:
        return f"{mb:.1f} МБ"
    return f"{mb / 1024:.2f} ГБ"


def _read_meminfo() -> dict[str, int]:
    info: dict[str, int] = {}
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and parts[0].endswith(":"):
                    info[parts[0][:-1]] = int(parts[1]) * 1024  # kB -> bytes
    except OSError:
        pass
    return info


def _read_bot_rss_bytes() -> int:
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    parts = line.split()
                    if len(parts) >= 2:
                        return int(parts[1]) * 1024
    except OSError:
        pass
    return 0


def _read_server_uptime() -> float:
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as f:
            return float(f.read().split()[0])
    except (OSError, ValueError, IndexError):
        return 0.0


def _get_db_size_bytes() -> int:
    total = 0
    for suffix in ("", "-wal", "-shm"):
        p = DB_PATH + suffix
        if os.path.isfile(p):
            try:
                total += os.path.getsize(p)
            except OSError:
                pass
    return total


def _get_dir_stats(path: str) -> tuple[int, int]:
    total_size = 0
    count = 0
    if not os.path.isdir(path):
        return 0, 0
    try:
        with os.scandir(path) as it:
            for entry in it:
                if entry.is_file(follow_symlinks=False):
                    count += 1
                    try:
                        total_size += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        pass
    except OSError:
        pass
    return total_size, count


async def build_server_report() -> str:
    """Собирает системные метрики Linux и состояние бота без сторонних агентов (0 МБ RAM)."""
    # CPU / Load Average
    cpu_count = os.cpu_count() or 1
    try:
        la1, la5, la15 = os.getloadavg()
        load_str = f"{la1:.2f} / {la5:.2f} / {la15:.2f}"
    except OSError:
        load_str = "н/д"

    # RAM & Swap
    mem = _read_meminfo()
    mem_total = mem.get("MemTotal", 0)
    mem_avail = mem.get("MemAvailable", mem.get("MemFree", 0))
    mem_used = max(0, mem_total - mem_avail)
    mem_pct = (mem_used / mem_total * 100.0) if mem_total else 0.0

    swap_total = mem.get("SwapTotal", 0)
    swap_free = mem.get("SwapFree", 0)
    swap_used = max(0, swap_total - swap_free)
    swap_pct = (swap_used / swap_total * 100.0) if swap_total else 0.0

    bot_rss = _read_bot_rss_bytes()

    # Disk & bot storage
    disk = shutil.disk_usage(DATA_DIR if os.path.isdir(DATA_DIR) else "/")
    disk_pct = (disk.used / disk.total * 100.0) if disk.total else 0.0
    db_size = _get_db_size_bytes()
    covers_size, covers_count = _get_dir_stats(COVERS_DIR)

    # Uptime
    server_up = _fmt_duration(_read_server_uptime())
    bot_up = _fmt_duration(time.monotonic() - BOT_STARTED_AT)

    # Live bot state
    active_downloads = max(0, 2 - getattr(DOWNLOAD_SEMAPHORE, "_value", 2))

    # In-memory cache sizes (lazy imports to avoid circular dependencies)
    from bot.handlers.search import _search_sessions
    from web.server import _file_path_cache

    # Request counts (last 1h & today)
    now = datetime.now()
    hour_ago_iso = (now - timedelta(hours=1)).isoformat()
    today_iso = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    req_hour, req_today = 0, 0
    try:
        async with aiosqlite.connect(DB_PATH) as conn:
            async with conn.execute(
                "SELECT COUNT(*) FROM request_logs WHERE created_at >= ?",
                (hour_ago_iso,),
            ) as cur:
                req_hour = (await cur.fetchone())[0]
            async with conn.execute(
                "SELECT COUNT(*) FROM request_logs WHERE created_at >= ?",
                (today_iso,),
            ) as cur:
                req_today = (await cur.fetchone())[0]
    except Exception:
        pass

    swap_line = (
        f"• Swap: <code>{_fmt_bytes(swap_used)} / {_fmt_bytes(swap_total)}</code> ({swap_pct:.0f}%)"
        if swap_total > 0
        else "• Swap: <code>отключен</code>"
    )

    return (
        f"🖥 <b>Мониторинг сервера и бота</b>\n\n"
        f"⚙️ <b>CPU ({cpu_count} vCPU)</b>\n"
        f"• Load (1/5/15м): <code>{load_str}</code>\n\n"
        f"🧠 <b>Память</b>\n"
        f"• RAM: <code>{_fmt_bytes(mem_used)} / {_fmt_bytes(mem_total)}</code>\n"
        f"  <code>{_bar(mem_pct)}</code>\n"
        f"{swap_line}\n"
        f"• Процесс бота: <code>{_fmt_bytes(bot_rss)}</code>\n\n"
        f"💾 <b>Диск</b>\n"
        f"• Занято: <code>{_fmt_bytes(disk.used)} / {_fmt_bytes(disk.total)}</code> (своб. <code>{_fmt_bytes(disk.free)}</code>)\n"
        f"  <code>{_bar(disk_pct)}</code>\n"
        f"• БД SQLite: <code>{_fmt_bytes(db_size)}</code>\n"
        f"• Обложки: <code>{_fmt_bytes(covers_size)}</code> (<code>{covers_count}</code> шт.)\n\n"
        f"🤖 <b>Состояние бота</b>\n"
        f"• Загрузки сейчас: <code>{active_downloads}/2</code>\n"
        f"• Запросов (час / сегодня): <code>{req_hour}</code> / <code>{req_today}</code>\n"
        f"• RAM-кэш: поиск <code>{len(_search_sessions)}</code> · файлы <code>{len(_file_path_cache)}</code>\n\n"
        f"⏱ <b>Аптайм</b>\n"
        f"• Сервер: <code>{server_up}</code> · Бот: <code>{bot_up}</code>\n"
        f"🕒 <i>Обновлено: {now.strftime('%H:%M:%S')}</i>"
    )
