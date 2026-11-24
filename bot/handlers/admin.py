import asyncio
import glob
import logging
import os
import tempfile
import time
from datetime import datetime, timedelta
from typing import Any, Optional

import aiosqlite
from aiogram import F, Router, types
from aiogram.filters import Command
from aiogram.types import BufferedInputFile, FSInputFile, InlineKeyboardButton, InlineKeyboardMarkup

from bot.config import ADMIN_ID, DB_PATH, DOWNLOAD_TIMEOUT, STORAGE_CHAT_ID, TOP_SONGS_FILE
from bot.handlers.downloads import process_and_send_download, process_direct_url_download
from services.cache import (
    DOWNLOAD_SEMAPHORE,
    build_spotdl_cmd,
    find_blacklisted_artist,
    find_cached_track,
    get_cookies_path,
    get_subprocess_env,
    parse_filename_meta,
    remove_cached_cover,
)
from services.downloader import download_cover_bytes, download_track_fast_sync, save_cover_to_cache
from services.monitor import build_server_report
from services.spotify import (
    discover_spotify_tracks_sync,
    inspect_spotify_metadata_sync,
    normalize_query,
    parse_external_media_url,
)

logger = logging.getLogger(__name__)

router = Router()

_seed_task: Optional[asyncio.Task] = None
_seed_stop_event: Optional[asyncio.Event] = None
_seed_state: dict[str, Any] = {}


SERVER_REFRESH_MARKUP = InlineKeyboardMarkup(inline_keyboard=[
    [InlineKeyboardButton(text="🔄 Обновить", callback_data="srv_refresh")]
])


@router.message(Command("server"))
async def cmd_server(message: types.Message):
    if message.from_user.id != ADMIN_ID:
        return
    report = await build_server_report()
    await message.answer(report, parse_mode="HTML", reply_markup=SERVER_REFRESH_MARKUP)


@router.callback_query(F.data == "srv_refresh")
async def cq_server_refresh(callback: types.CallbackQuery):
    if callback.from_user.id != ADMIN_ID:
        await callback.answer("Нет доступа", show_alert=True)
        return
    report = await build_server_report()
    try:
        await callback.message.edit_text(report, parse_mode="HTML", reply_markup=SERVER_REFRESH_MARKUP)
    except Exception:
        pass
    await callback.answer("🔄 Обновлено")


@router.message(Command("stats"))
async def cmd_stats(message: types.Message):
    if message.from_user.id != ADMIN_ID:
        return

    cutoff_iso = (datetime.now() - timedelta(days=30)).isoformat()

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute("SELECT COUNT(*) FROM tracks") as cur:
            tracks_count = (await cur.fetchone())[0]
        async with conn.execute("SELECT COUNT(DISTINCT user_id) FROM playlist") as cur:
            playlists_count = (await cur.fetchone())[0]
        async with conn.execute("SELECT COUNT(*) FROM request_logs") as cur:
            total_requests = (await cur.fetchone())[0]
        async with conn.execute("SELECT COUNT(*) FROM request_logs WHERE action LIKE 'blocked%'") as cur:
            blocks = (await cur.fetchone())[0]
        async with conn.execute(
            "SELECT COUNT(DISTINCT user_id) FROM request_logs WHERE created_at >= ?",
            (cutoff_iso,),
        ) as cur:
            monthly_users = (await cur.fetchone())[0]

    await message.answer(
        f"📊 <b>Статистика бота:</b>\n\n"
        f"🎵 Треков в кэше: <code>{tracks_count}</code>\n"
        f"👥 Пользователей с плейлистами: <code>{playlists_count}</code>\n"
        f"📅 Активных юзеров (30 дней): <code>{monthly_users}</code>\n"
        f"📈 Всего запросов: <code>{total_requests}</code>\n"
        f"🚫 Блокировок (блэклист): <code>{blocks}</code>",
        parse_mode="HTML",
    )


@router.message(Command("delcache"))
async def cmd_delcache(message: types.Message):
    """Удаление битого трека из кэша: Reply на аудио или /delcache <ссылка>."""
    if message.from_user.id != ADMIN_ID:
        return

    removed_rows: list[tuple[str, str, Optional[str], Optional[str]]] = []

    if message.reply_to_message and message.reply_to_message.audio:
        target_fid = message.reply_to_message.audio.file_id
        async with aiosqlite.connect(DB_PATH) as conn:
            async with conn.execute(
                "SELECT url, file_id, title, performer FROM tracks WHERE file_id = ?",
                (target_fid,),
            ) as cur:
                removed_rows = await cur.fetchall()
            await conn.execute("DELETE FROM tracks WHERE file_id = ?", (target_fid,))
            await conn.commit()
        remove_cached_cover(target_fid)
    else:
        parts = (message.text or "").split(maxsplit=1)
        if len(parts) < 2 or not parts[1].strip():
            await message.answer(
                "Использование:\n"
                "• Ответь (Reply) командой <code>/delcache</code> на неправильное аудио\n"
                "• Или напиши <code>/delcache &lt;ссылка&gt;</code>",
                parse_mode="HTML",
            )
            return
        raw_arg = parts[1].strip()
        norm_arg = await normalize_query(raw_arg)
        async with aiosqlite.connect(DB_PATH) as conn:
            async with conn.execute(
                "SELECT url, file_id, title, performer FROM tracks WHERE url = ? OR lower(url) = ?",
                (norm_arg, norm_arg.lower()),
            ) as cur:
                removed_rows = await cur.fetchall()
            await conn.execute(
                "DELETE FROM tracks WHERE url = ? OR lower(url) = ?",
                (norm_arg, norm_arg.lower()),
            )
            await conn.commit()
        for _, fid, _, _ in removed_rows:
            remove_cached_cover(fid)

    if not removed_rows:
        await message.answer("ℹ️ Этот трек не найден в кэше (таблице <code>tracks</code>).", parse_mode="HTML")
        return

    urls_list = "\n".join(f"• <code>{r[0]}</code>" for r in removed_rows[:5])
    await message.answer(
        f"🗑 Удалено из кэша записей: <code>{len(removed_rows)}</code>\n{urls_list}",
        parse_mode="HTML",
    )


@router.message(Command("recache"))
async def cmd_recache(message: types.Message):
    """Удаляет трек из кэша и сразу перекачивает его заново (Reply на аудио или /recache <ссылка>)."""
    if message.from_user.id != ADMIN_ID:
        return

    target_url: Optional[str] = None
    removed_fids: list[str] = []

    if message.reply_to_message and message.reply_to_message.audio:
        target_fid = message.reply_to_message.audio.file_id
        async with aiosqlite.connect(DB_PATH) as conn:
            async with conn.execute(
                "SELECT url, file_id FROM tracks WHERE file_id = ?",
                (target_fid,),
            ) as cur:
                rows = await cur.fetchall()
            await conn.execute("DELETE FROM tracks WHERE file_id = ?", (target_fid,))
            await conn.commit()
        removed_fids = [target_fid] + [r[1] for r in rows if r[1]]
        if rows:
            target_url = rows[0][0]
    else:
        parts = (message.text or "").split(maxsplit=1)
        if len(parts) >= 2 and parts[1].strip():
            target_url = await normalize_query(parts[1].strip())
            async with aiosqlite.connect(DB_PATH) as conn:
                async with conn.execute(
                    "SELECT file_id FROM tracks WHERE url = ? OR lower(url) = ?",
                    (target_url, target_url.lower()),
                ) as cur:
                    removed_fids = [r[0] for r in await cur.fetchall() if r[0]]
                await conn.execute(
                    "DELETE FROM tracks WHERE url = ? OR lower(url) = ?",
                    (target_url, target_url.lower()),
                )
                await conn.commit()

    for fid in set(removed_fids):
        remove_cached_cover(fid)

    if not target_url:
        await message.answer(
            "Использование:\n"
            "• Ответь (Reply) командой <code>/recache</code> на аудио из кэша\n"
            "• Или напиши <code>/recache &lt;ссылка&gt;</code>",
            parse_mode="HTML",
        )
        return

    ext_media = parse_external_media_url(target_url)
    if ext_media:
        source_name, canonical_url = ext_media
        await process_direct_url_download(
            target_message=message,
            user_id=message.from_user.id,
            source_name=source_name,
            clean_url=canonical_url,
        )
    else:
        cache_key = target_url if "spotify.com" in target_url else target_url.lower()
        await process_and_send_download(
            target_message=message,
            user_id=message.from_user.id,
            clean_query=target_url,
            cache_key=cache_key,
            status_text="🔄 Перекачиваю трек заново...",
        )


async def _run_seed_job(
    bot,
    admin_chat_id: int,
    status_msg: types.Message,
    tracks: list[dict],
    stop_event: asyncio.Event,
):
    global _seed_task, _seed_state
    total = len(tracks)
    saved = 0
    skipped = 0
    failed = 0
    upload_chat_id = STORAGE_CHAT_ID or admin_chat_id
    should_delete_msg = STORAGE_CHAT_ID is None

    _seed_state = {
        "total": total,
        "processed": 0,
        "saved": 0,
        "skipped": 0,
        "failed": 0,
        "started_at": time.monotonic(),
    }

    async def _update_status(force: bool = False):
        processed = _seed_state["processed"]
        if not force and processed % 5 != 0 and processed != total:
            return
        elapsed = int(time.monotonic() - _seed_state["started_at"])
        mins, secs = divmod(elapsed, 60)
        try:
            await status_msg.edit_text(
                f"🌱 <b>Пополнение базы данных</b>\n\n"
                f"Прогресс: <code>{processed}/{total}</code>\n"
                f"✅ Сохранено: <code>{saved}</code>\n"
                f"⏭ Пропущено (кэш/блэклист): <code>{skipped}</code>\n"
                f"❌ Ошибок: <code>{failed}</code>\n"
                f"⏱ Прошло: <code>{mins}м {secs}с</code>\n\n"
                f"Остановить: /seed_stop",
                parse_mode="HTML",
            )
        except Exception:
            pass

    try:
        for idx, track in enumerate(tracks, 1):
            if stop_event.is_set():
                break

            url = track["url"]
            full_label = f"{track['performer']} - {track['title']}"

            async with aiosqlite.connect(DB_PATH) as conn:
                if await find_cached_track(conn, url, full_label, exact_only=True):
                    skipped += 1
                    _seed_state.update(processed=idx, skipped=skipped)
                    await _update_status()
                    continue

            if find_blacklisted_artist(track["performer"]):
                skipped += 1
                _seed_state.update(processed=idx, skipped=skipped)
                await _update_status()
                continue

            async with DOWNLOAD_SEMAPHORE:
                if stop_event.is_set():
                    break
                with tempfile.TemporaryDirectory() as temp_dir:
                    try:
                        file_path, cover_bytes, thumb_bytes = await asyncio.wait_for(
                            asyncio.gather(
                                asyncio.to_thread(
                                    download_track_fast_sync,
                                    track["title"],
                                    track["performer"],
                                    temp_dir,
                                    track.get("duration_sec") or None,
                                    get_cookies_path(),
                                    None,
                                    track.get("isrc"),
                                    track.get("album"),
                                ),
                                download_cover_bytes(track.get("cover_url")),
                                download_cover_bytes(track.get("thumb_url")),
                            ),
                            timeout=DOWNLOAD_TIMEOUT,
                        )

                        if not file_path or not os.path.isfile(file_path):
                            cmd = build_spotdl_cmd(url, temp_dir)
                            proc = await asyncio.create_subprocess_exec(
                                *cmd,
                                stdout=asyncio.subprocess.PIPE,
                                stderr=asyncio.subprocess.PIPE,
                                env=get_subprocess_env(),
                            )
                            try:
                                await asyncio.wait_for(proc.communicate(), timeout=DOWNLOAD_TIMEOUT)
                            except asyncio.TimeoutError:
                                proc.kill()
                                await proc.wait()
                                failed += 1
                                _seed_state.update(processed=idx, failed=failed)
                                await _update_status()
                                continue

                            files = [
                                f for f in glob.glob(os.path.join(temp_dir, "*.*"))
                                if not f.endswith(".part") and not f.endswith(".ytdl")
                            ]
                            if not files:
                                failed += 1
                                _seed_state.update(processed=idx, failed=failed)
                                await _update_status()
                                continue
                            file_path = files[0]

                        f_title, f_perf = parse_filename_meta(file_path)
                        if find_blacklisted_artist(f_perf):
                            skipped += 1
                            _seed_state.update(processed=idx, skipped=skipped)
                            await _update_status()
                            continue

                        thumb_data = thumb_bytes or cover_bytes
                        thumbnail = (
                            BufferedInputFile(thumb_data, filename="cover.jpg")
                            if thumb_data else None
                        )
                        sent_msg = await bot.send_audio(
                            chat_id=upload_chat_id,
                            audio=FSInputFile(file_path),
                            title=track["title"] or f_title,
                            performer=track["performer"] or f_perf,
                            duration=track.get("duration_sec") or None,
                            thumbnail=thumbnail,
                            disable_notification=True,
                        )
                        file_id = sent_msg.audio.file_id
                        title = sent_msg.audio.title or track["title"] or f_title
                        performer = sent_msg.audio.performer or track["performer"] or f_perf

                        if cover_bytes or thumb_bytes:
                            save_cover_to_cache(file_id, cover_bytes or thumb_bytes)

                        async with aiosqlite.connect(DB_PATH) as conn:
                            await conn.execute(
                                "INSERT OR REPLACE INTO tracks (url, file_id, title, performer) VALUES (?, ?, ?, ?)",
                                (url, file_id, title, performer),
                            )
                            await conn.commit()

                        if should_delete_msg:
                            try:
                                await bot.delete_message(chat_id=upload_chat_id, message_id=sent_msg.message_id)
                            except Exception:
                                pass

                        saved += 1
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        logger.warning("Seed track error (%s): %s", url, e)
                        failed += 1

            _seed_state.update(processed=idx, saved=saved, skipped=skipped, failed=failed)
            await _update_status()
            await asyncio.sleep(2)

        elapsed = int(time.monotonic() - _seed_state["started_at"])
        mins, secs = divmod(elapsed, 60)
        header = "🛑 <b>Пополнение базы остановлено</b>" if stop_event.is_set() else "✅ <b>Пополнение базы завершено!</b>"
        await status_msg.edit_text(
            f"{header}\n\n"
            f"Обработано: <code>{_seed_state['processed']}/{total}</code>\n"
            f"✅ Сохранено в БД: <code>{saved}</code>\n"
            f"⏭ Пропущено: <code>{skipped}</code>\n"
            f"❌ Ошибок: <code>{failed}</code>\n"
            f"⏱ Затрачено: <code>{mins}м {secs}с</code>",
            parse_mode="HTML",
        )
    except asyncio.CancelledError:
        logger.info("Seed job cancelled")
    except Exception as e:
        logger.exception("Seed job failed unexpectedly: %s", e)
        try:
            await status_msg.edit_text(f"❌ Критическая ошибка пополнения: {e}")
        except Exception:
            pass
    finally:
        _seed_task = None
        _seed_state = {}


@router.message(Command("seed"))
async def cmd_seed(message: types.Message):
    """Массовое пополнение БД треками: /seed [кол-во] [ссылка_или_запрос]."""
    global _seed_task, _seed_stop_event
    if message.from_user.id != ADMIN_ID:
        return

    if _seed_task is not None and not _seed_task.done():
        await message.answer(
            "⏳ Пополнение базы уже запущено!\n"
            "Проверить прогресс: /seed_status\n"
            "Остановить: /seed_stop"
        )
        return

    parts = (message.text or "").split(maxsplit=2)
    target_count = 100
    source: Optional[str] = None

    if len(parts) >= 2:
        if parts[1].isdigit():
            target_count = max(1, min(int(parts[1]), 500))
            if len(parts) == 3:
                source = await normalize_query(parts[2])
        else:
            raw_source = (message.text or "").split(maxsplit=1)[1]
            source = await normalize_query(raw_source)

    status_msg = await message.answer(
        f"🔎 Подбираю до <code>{target_count}</code> новых треков из Spotify...",
        parse_mode="HTML",
    )

    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute("SELECT url FROM tracks") as cur:
            existing_urls = {row[0] for row in await cur.fetchall() if row[0]}

    try:
        tracks = await asyncio.to_thread(
            discover_spotify_tracks_sync,
            target_count,
            source,
            existing_urls,
        )
    except Exception as e:
        logger.warning("Seed discovery failed: %s", e)
        await status_msg.edit_text(f"❌ Не удалось получить треки из Spotify API: {e}")
        return

    if not tracks:
        await status_msg.edit_text("ℹ️ Новых треков для скачивания не найдено (все уже есть в базе или в блэклисте).")
        return

    _seed_stop_event = asyncio.Event()
    _seed_task = asyncio.create_task(
        _run_seed_job(
            bot=message.bot,
            admin_chat_id=message.chat.id,
            status_msg=status_msg,
            tracks=tracks,
            stop_event=_seed_stop_event,
        )
    )


@router.message(Command("seed_stop"))
async def cmd_seed_stop(message: types.Message):
    if message.from_user.id != ADMIN_ID:
        return
    if _seed_task is None or _seed_task.done():
        await message.answer("ℹ️ Сейчас пополнение базы не запущено.")
        return
    if _seed_stop_event:
        _seed_stop_event.set()
    await message.answer("🛑 Останавливаю пополнение после завершения текущего трека...")


@router.message(Command("seed_status"))
async def cmd_seed_status(message: types.Message):
    if message.from_user.id != ADMIN_ID:
        return
    if _seed_task is None or _seed_task.done() or not _seed_state:
        await message.answer("ℹ️ Сейчас пополнение базы не запущено.")
        return
    elapsed = int(time.monotonic() - _seed_state["started_at"])
    mins, secs = divmod(elapsed, 60)
    await message.answer(
        f"🌱 <b>Статус пополнения:</b>\n\n"
        f"Обработано: <code>{_seed_state['processed']}/{_seed_state['total']}</code>\n"
        f"✅ Сохранено: <code>{_seed_state['saved']}</code>\n"
        f"⏭ Пропущено: <code>{_seed_state['skipped']}</code>\n"
        f"❌ Ошибок: <code>{_seed_state['failed']}</code>\n"
        f"⏱ Прошло: <code>{mins}м {secs}с</code>",
        parse_mode="HTML",
    )


@router.message(Command("preload"))
async def cmd_preload(message: types.Message):
    if message.from_user.id != ADMIN_ID:
        return
    if not os.path.exists(TOP_SONGS_FILE):
        return
    with open(TOP_SONGS_FILE, "r", encoding="utf-8") as f:
        tracks = [line.strip() for line in f if line.strip()]
    await message.answer(f"🚀 Начинаю прогрев. Треков: {len(tracks)}")

    for query in tracks:
        cache_key = query.lower()
        async with aiosqlite.connect(DB_PATH) as conn:
            if await find_cached_track(conn, cache_key, query):
                continue

        meta = await asyncio.to_thread(inspect_spotify_metadata_sync, query)
        if meta and find_blacklisted_artist(meta["performer"]):
            continue

        async with DOWNLOAD_SEMAPHORE:
            with tempfile.TemporaryDirectory() as temp_dir:
                try:
                    cmd = build_spotdl_cmd(query, temp_dir)
                    proc = await asyncio.create_subprocess_exec(
                        *cmd,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        env=get_subprocess_env(),
                    )
                    try:
                        await asyncio.wait_for(proc.communicate(), timeout=DOWNLOAD_TIMEOUT)
                    except asyncio.TimeoutError:
                        proc.kill()
                        await proc.wait()
                        continue
                    files = [
                        f for f in glob.glob(os.path.join(temp_dir, "*.*"))
                        if not f.endswith(".part") and not f.endswith(".ytdl")
                    ]
                    if files:
                        f_title, f_perf = parse_filename_meta(files[0])
                        sent_msg = await message.answer_audio(audio=FSInputFile(files[0]), disable_notification=True)
                        title = sent_msg.audio.title or f_title
                        performer = sent_msg.audio.performer or f_perf
                        async with aiosqlite.connect(DB_PATH) as conn:
                            await conn.execute(
                                "INSERT OR IGNORE INTO tracks (url, file_id, title, performer) VALUES (?, ?, ?, ?)",
                                (cache_key, sent_msg.audio.file_id, title, performer),
                            )
                            await conn.commit()
                        await asyncio.sleep(3)
                except Exception:
                    pass
    await message.answer("✅ Прогрев завершен!")
