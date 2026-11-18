import os
import hashlib
from dotenv import load_dotenv

SERVER_DIR = "/home/muffin/spotyboty"
BASE_DIR = SERVER_DIR if os.path.exists(SERVER_DIR) else os.path.dirname(os.path.abspath(__file__))

load_dotenv(os.path.join(BASE_DIR, ".env"))

BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_ID = int(os.getenv("ADMIN_ID", 0))

SPOTIPY_CLIENT_ID = os.getenv("SPOTIPY_CLIENT_ID")
SPOTIPY_CLIENT_SECRET = os.getenv("SPOTIPY_CLIENT_SECRET")

COOLDOWN_SECONDS = 5  
PAGE_SIZE = 5 

DB_PATH = os.path.join(BASE_DIR, "tracks_cache.db")

WEBAPP_URL = os.getenv("WEBAPP_URL", "https://spotyboty.mardariev.me").rstrip("/")

WEBHOOK_PATH = "/webhook"
WEBHOOK_URL = f"{WEBAPP_URL}{WEBHOOK_PATH}"
WEBHOOK_SECRET = hashlib.sha256((BOT_TOKEN or "secret").encode()).hexdigest()[:32]

USE_WEBHOOK = os.getenv(
    "USE_WEBHOOK",
    "true" if WEBAPP_URL.startswith("https://") and "localhost" not in WEBAPP_URL else "false"
).lower() == "true"