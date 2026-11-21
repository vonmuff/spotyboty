import json
import logging
import os
from datetime import datetime
from typing import Optional

import aiosqlite
from bot.config import DB_PATH, LOG_FILE

logger = logging.getLogger(__name__)


async def init_db():
    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA synchronous=NORMAL")

        await conn.execute("""
            CREATE TABLE IF NOT EXISTS tracks (
                url TEXT PRIMARY KEY,
                file_id TEXT,
                title TEXT,
                performer TEXT
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS playlist (
                user_id INTEGER,
                file_id TEXT,
                title TEXT,
                performer TEXT,
                UNIQUE(user_id, file_id)
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS request_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                username TEXT,
                full_name TEXT,
                request TEXT,
                cache_key TEXT,
                action TEXT NOT NULL,
                details TEXT
            )
        """)
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_request_logs_action ON request_logs(action)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id)")

        for table in ("tracks", "playlist"):
            for col in ("title", "performer"):
                try:
                    await conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} TEXT")
                except aiosqlite.OperationalError:
                    pass

        await _migrate_jsonl_logs(conn)
        await conn.commit()


async def _migrate_jsonl_logs(conn: aiosqlite.Connection):
    """Однократно переносит историю из bot_log.jsonl в SQLite, если таблица request_logs пуста."""
    if not os.path.isfile(LOG_FILE):
        return

    async with conn.execute("SELECT COUNT(*) FROM request_logs") as cur:
        existing_count = (await cur.fetchone())[0]
    if existing_count > 0:
        return

    rows = []
    try:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                created_at = entry.get("timestamp") or datetime.now().isoformat()
                user_id = entry.get("user_id")
                if user_id is None:
                    continue
                extra = {
                    k: v for k, v in entry.items()
                    if k not in {"timestamp", "user_id", "username", "full_name", "request", "cache_key", "action"}
                }
                rows.append((
                    created_at,
                    int(user_id),
                    entry.get("username"),
                    entry.get("full_name"),
                    entry.get("request"),
                    entry.get("cache_key"),
                    entry.get("action", "allowed"),
                    json.dumps(extra, ensure_ascii=False) if extra else None,
                ))
    except OSError as e:
        logger.warning("Failed to read legacy log file %s: %s", LOG_FILE, e)
        return

    if rows:
        await conn.executemany(
            """
            INSERT INTO request_logs (created_at, user_id, username, full_name, request, cache_key, action, details)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        logger.info("Migrated %d log records from %s to SQLite", len(rows), LOG_FILE)


async def log_request(
    user_id: int,
    request: str,
    action: str,
    cache_key: Optional[str] = None,
    username: Optional[str] = None,
    full_name: Optional[str] = None,
    details: Optional[dict] = None,
):
    try:
        async with aiosqlite.connect(DB_PATH) as conn:
            await conn.execute(
                """
                INSERT INTO request_logs (created_at, user_id, username, full_name, request, cache_key, action, details)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    datetime.now().isoformat(),
                    user_id,
                    username,
                    full_name,
                    request,
                    cache_key,
                    action,
                    json.dumps(details, ensure_ascii=False) if details else None,
                ),
            )
            await conn.commit()
    except Exception as e:
        logger.exception("Failed to write request log to SQLite: %s", e)