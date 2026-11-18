import aiosqlite
from config import DB_PATH

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
        
        for table in ("tracks", "playlist"):
            for col in ("title", "performer"):
                try:
                    await conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} TEXT")
                except aiosqlite.OperationalError:
                    pass
                    
        await conn.commit()