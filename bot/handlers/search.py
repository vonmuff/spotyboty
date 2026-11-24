import asyncio
import logging
import secrets
import time
from typing import Optional

import aiosqlite
from aiogram import F, Router, types
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from bot.config import DB_PATH
from bot.database import log_request
from bot.handlers.downloads import process_and_send_download, process_direct_url_download
from services.cache import find_cached_track
from services.spotify import normalize_query, parse_external_media_url, search_spotify_sync

logger = logging.getLogger(__name__)

router = Router()

SEARCH_PAGE_SIZE = 5
SEARCH_SESSION_TTL = 1800  # 30 минут
SEARCH_SESSION_MAX = 500
_search_sessions: dict[str, tuple[str, float]] = {}


def _create_search_session(query: str) -> str:
    now = time.monotonic()
    if len(_search_sessions) >= SEARCH_SESSION_MAX:
        expired = [k for k, (_, exp) in _search_sessions.items() if exp <= now]
        for k in expired:
            _search_sessions.pop(k, None)
        if len(_search_sessions) >= SEARCH_SESSION_MAX:
            _search_sessions.pop(next(iter(_search_sessions)))
    sid = secrets.token_hex(4)
    _search_sessions[sid] = (query, now + SEARCH_SESSION_TTL)
    return sid


def _get_search_session(sid: str) -> Optional[str]:
    entry = _search_sessions.get(sid)
    if not entry:
        return None
    query, exp = entry
    if exp <= time.monotonic():
        _search_sessions.pop(sid, None)
        return None
    return query


async def _build_search_markup(
    results: list[dict],
    sid: str,
    offset: int,
) -> InlineKeyboardMarkup:
    buttons = []
    async with aiosqlite.connect(DB_PATH) as conn:
        for item in results:
            full_title = f"{item['performer']} - {item['title']}"
            is_cached = await find_cached_track(conn, item["url"], full_title, exact_only=True)
            prefix = "⚡️ " if is_cached else "🎵 "
            btn_label = f"{prefix}{item['performer']} — {item['title']} ({item['duration']})"
            if len(btn_label) > 60:
                btn_label = btn_label[:57] + "..."

            buttons.append([
                InlineKeyboardButton(
                    text=btn_label,
                    callback_data=f"dl_sp:{item['id']}",
                )
            ])

    nav_row = []
    if offset > 0:
        prev_offset = max(0, offset - SEARCH_PAGE_SIZE)
        nav_row.append(InlineKeyboardButton(text="⬅️ Назад", callback_data=f"sp_page:{sid}:{prev_offset}"))
    if len(results) == SEARCH_PAGE_SIZE and offset + SEARCH_PAGE_SIZE < 100:
        next_offset = offset + SEARCH_PAGE_SIZE
        nav_row.append(InlineKeyboardButton(text="Ещё 5 вариантов ➡️", callback_data=f"sp_page:{sid}:{next_offset}"))
    if nav_row:
        buttons.append(nav_row)

    buttons.append([InlineKeyboardButton(text="✖️ Отмена", callback_data="cancel_search")])
    return InlineKeyboardMarkup(inline_keyboard=buttons)


@router.callback_query(F.data == "cancel_search")
async def cq_cancel_search(callback: types.CallbackQuery):
    await callback.answer("Поиск отменен")
    try:
        await callback.message.delete()
    except Exception:
        pass


@router.callback_query(F.data.startswith("dl_sp:"))
async def cq_download_selected_spotify(callback: types.CallbackQuery):
    """Обработчик выбора одного из предложенных вариантов трека."""
    track_id = callback.data.split(":", 1)[1]
    spotify_url = f"https://open.spotify.com/track/{track_id}"
    await callback.answer("🎧 Проверяю трек...")

    await process_and_send_download(
        target_message=callback.message,
        user_id=callback.from_user.id,
        clean_query=spotify_url,
        cache_key=spotify_url,
        status_text="⏳ Скачиваю выбранный трек...",
        existing_status_msg=callback.message,
    )


@router.callback_query(F.data.startswith("sp_page:"))
async def cq_search_page(callback: types.CallbackQuery):
    """Пагинация результатов поиска в Spotify (Ещё 5 вариантов / Назад)."""
    parts = callback.data.split(":")
    if len(parts) != 3 or not parts[2].isdigit():
        await callback.answer("Некорректная страница")
        return

    sid = parts[1]
    offset = int(parts[2])
    query = _get_search_session(sid)
    if not query:
        await callback.answer("⏳ Поиск устарел — отправь запрос ещё раз.", show_alert=True)
        return

    try:
        results = await asyncio.to_thread(search_spotify_sync, query, SEARCH_PAGE_SIZE, offset)
    except Exception as e:
        logger.warning("Spotipy pagination error (offset=%s): %s", offset, e)
        await callback.answer("❌ Ошибка поиска, попробуй чуть позже.", show_alert=True)
        return

    if not results:
        await callback.answer("Больше результатов не найдено.")
        return

    page_num = offset // SEARCH_PAGE_SIZE + 1
    markup = await _build_search_markup(results, sid, offset)
    try:
        await callback.message.edit_text(
            f"🔎 Результаты по запросу «{query}» (стр. {page_num})\n"
            f"Выбери нужный вариант (⚡️ — мгновенно из кэша):",
            reply_markup=markup,
        )
    except Exception:
        pass
    await callback.answer()


@router.message(F.text)
async def handle_music_request(message: types.Message):
    query = message.text.strip()
    clean_query = await normalize_query(query)
    ext_media = parse_external_media_url(clean_query)
    cache_key = clean_query if ("spotify.com" in clean_query or ext_media) else clean_query.lower()

    await log_request(
        user_id=message.from_user.id,
        full_name=message.from_user.full_name,
        username=message.from_user.username,
        request=query,
        cache_key=cache_key,
        action="allowed",
    )

    if ext_media:
        source_name, canonical_url = ext_media
        await process_direct_url_download(
            target_message=message,
            user_id=message.from_user.id,
            source_name=source_name,
            clean_url=canonical_url,
        )
        return

    if "spotify.com" not in clean_query:
        try:
            results = await asyncio.to_thread(search_spotify_sync, clean_query, SEARCH_PAGE_SIZE, 0)
        except Exception as e:
            logger.warning("Spotipy search error: %s", e)
            results = []

        if results:
            sid = _create_search_session(clean_query)
            markup = await _build_search_markup(results, sid, 0)
            await message.answer(
                f"🔎 Результаты по запросу «{query}»\n"
                f"Выбери нужный вариант (⚡️ — мгновенно из кэша):",
                reply_markup=markup,
            )
            return

    status_text = "⏳ Качаю по ссылке..." if "spotify.com" in clean_query else f"🔍 Ищу и скачиваю: «{query}»..."
    await process_and_send_download(
        target_message=message,
        user_id=message.from_user.id,
        clean_query=clean_query,
        cache_key=cache_key,
        status_text=status_text,
    )
