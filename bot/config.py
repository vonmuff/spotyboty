import os
import hashlib
from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.getenv("DATA_DIR", BASE_DIR)
LISTS_DIR = os.path.join(BASE_DIR, "lists")
WEB_STATIC_DIR = os.path.join(BASE_DIR, "web", "static")
os.makedirs(DATA_DIR, exist_ok=True)

load_dotenv(os.path.join(BASE_DIR, ".env"))

BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_ID = int(os.getenv("ADMIN_ID", 0))
STORAGE_CHAT_ID = int(os.getenv("STORAGE_CHAT_ID", 0)) or None

SPOTIPY_CLIENT_ID = os.getenv("SPOTIPY_CLIENT_ID")
SPOTIPY_CLIENT_SECRET = os.getenv("SPOTIPY_CLIENT_SECRET")

COOLDOWN_SECONDS = 5

DOWNLOAD_TIMEOUT = int(os.getenv("DOWNLOAD_TIMEOUT", 180))
COLLECTION_DOWNLOAD_TIMEOUT = int(os.getenv("COLLECTION_DOWNLOAD_TIMEOUT", 600))
MAX_COLLECTION_TRACKS = int(os.getenv("MAX_COLLECTION_TRACKS", 50))

DB_PATH = os.path.join(DATA_DIR, "tracks_cache.db")
COVERS_DIR = os.path.join(DATA_DIR, "covers_cache")
LOG_FILE = os.path.join(DATA_DIR, "bot_log.jsonl")
COOKIES_FILE = os.path.join(DATA_DIR, "cookies.txt")
BLACKLIST_FILE = os.path.join(LISTS_DIR, "blacklist.txt")
TOP_SONGS_FILE = os.path.join(LISTS_DIR, "top_songs.txt")

WEBAPP_URL = os.getenv("WEBAPP_URL", "https://spotyboty.mardariev.me").rstrip("/")

WEBHOOK_PATH = "/webhook"
WEBHOOK_URL = f"{WEBAPP_URL}{WEBHOOK_PATH}"
WEBHOOK_SECRET = hashlib.sha256((BOT_TOKEN or "secret").encode()).hexdigest()[:32]
MEDIA_SIGN_KEY = hashlib.sha256(f"media:{BOT_TOKEN or 'secret'}".encode()).hexdigest()

USE_WEBHOOK = os.getenv(
    "USE_WEBHOOK",
    "true" if WEBAPP_URL.startswith("https://") and "localhost" not in WEBAPP_URL else "false"
).lower() == "true"