import asyncio
import glob
import logging
import os
import tempfile
import time
import zipfile
from typing import Optional

import aiosqlite
from aiogram import types
from aiogram.enums import ChatAction
from aiogram.types import BufferedInputFile, FSInputFile

from bot.config import (
    ADMIN_ID,
    COLLECTION_DOWNLOAD_TIMEOUT,
    DB_PATH,
    DOWNLOAD_TIMEOUT,
    MAX_COLLECTION_TRACKS,
)
from bot.database import log_request
from bot.keyboards import get_playlist_keyboard
from services.cache import (
    DOWNLOAD_SEMAPHORE,
    build_spotdl_cmd,
    find_blacklisted_artist,
    find_cached_track,
    get_cookies_path,
    get_subprocess_env,
    parse_filename_meta,
)
from services.downloader import (
    download_cover_bytes,
    download_direct_url_sync,
    download_track_fast_sync,
    inspect_direct_url_sync,
    save_cover_to_cache,
)
from services.spotify import inspect_spotify_metadata_sync, parse_spotify_url

logger = logging.getLogger(__name__)

MAX_DIRECT_AUDIO_DURATION = 20 * 60  # 20 минут (защита от стримов и лимита 50 МБ Telegram)


async def process_and_send_download(
    target_message: types.Message,
    user_id: int,
    clean_query: str,
    cache_key: str,
    status_text: str,
    existing_status_msg: Optional[types.Message] = None,
    extra_lookup_text: Optional[str] = None,
):
    """
    1) Мгновенно получает метаданные из Spotify API и проверяет автора по блэклисту ДО запуска загрузки.
    2) Если автор разрешен — проверяет локальный кэш.
    3) Если в кэше нет — ставит скачивание в очередь семафора, отправляет трек и сохраняет в БД.
    """
    meta = await asyncio.to_thread(inspect_spotify_metadata_sync, clean_query)
    if meta:
        bad_artist = find_blacklisted_artist(meta["performer"])
        if bad_artist:
            await log_request(
                user_id=user_id,
                request=clean_query,
                cache_key=cache_key,
                action="blocked_by_metadata_precheck",
                details={
                    "blocked_artist": bad_artist,
                    "performer": meta["performer"],
                    "title": meta["title"],
                },
            )

            block_text = f"🚫 Скачивание запрещено: исполнитель «{meta['performer']}» находится в черном списке."
            if existing_status_msg:
                await existing_status_msg.edit_text(block_text)
            else:
                await target_message.answer(block_text)
            return

        if meta.get("type") in ("album", "playlist") and meta.get("total_tracks", 0) > MAX_COLLECTION_TRACKS:
            limit_text = (
                f"🚫 Слишком большой {('альбом' if meta['type'] == 'album' else 'плейлист')} "
                f"({meta['total_tracks']} треков). Максимальный лимит: {MAX_COLLECTION_TRACKS} треков."
            )
            if existing_status_msg:
                await existing_status_msg.edit_text(limit_text)
            else:
                await target_message.answer(limit_text)
            return

        if not extra_lookup_text and meta.get("type") == "track":
            extra_lookup_text = f"{meta['performer']} - {meta['title']}"

    lookup_text = extra_lookup_text or clean_query
    is_url_key = cache_key.startswith(("http://", "https://"))

    async with aiosqlite.connect(DB_PATH) as conn:
        cached_file_id = await find_cached_track(conn, cache_key, lookup_text, exact_only=is_url_key)

    if cached_file_id:
        markup = await get_playlist_keyboard(user_id, cached_file_id)
        await target_message.answer_audio(
            audio=cached_file_id,
            caption="⚡️ Моментально из кэша",
            reply_markup=markup,
        )
        if existing_status_msg:
            try:
                await existing_status_msg.delete()
            except Exception:
                pass
        return

    if existing_status_msg:
        status_msg = existing_status_msg
        if DOWNLOAD_SEMAPHORE.locked():
            try:
                await status_msg.edit_text("⏳ Сервер занят другими загрузками, ваш запрос в очереди...")
            except Exception:
                pass
        else:
            try:
                await status_msg.edit_text(status_text)
            except Exception:
                pass
    else:
        if DOWNLOAD_SEMAPHORE.locked():
            status_msg = await target_message.answer("⏳ Сервер занят другими загрузками, ваш запрос в очереди...")
        else:
            status_msg = await target_message.answer(status_text)

    async with DOWNLOAD_SEMAPHORE:
        async with aiosqlite.connect(DB_PATH) as conn:
            cached_file_id = await find_cached_track(conn, cache_key, lookup_text, exact_only=is_url_key)

        if cached_file_id:
            markup = await get_playlist_keyboard(user_id, cached_file_id)
            await target_message.answer_audio(
                audio=cached_file_id,
                caption="⚡️ Моментально из кэша",
                reply_markup=markup,
            )
            try:
                await status_msg.delete()
            except Exception:
                pass
            return

        try:
            await status_msg.edit_text(status_text)
        except Exception:
            pass

        with tempfile.TemporaryDirectory() as temp_dir:
            try:
                start_time = time.time()

                # Быстрый путь в памяти (ytmusicapi + yt-dlp в m4a без перекодировки ffmpeg) для одиночного трека
                if meta and meta.get("type") == "track":
                    loop = asyncio.get_running_loop()
                    track_header = f"🎧 {meta['performer']} — {meta['title']}"
                    stage_state = {"last_text": "", "closed": False, "task": None}

                    async def _apply_stage_edit(text: str):
                        if stage_state["closed"]:
                            return
                        try:
                            await status_msg.edit_text(text)
                        except Exception:
                            pass

                    def _on_stage(stage: str):
                        if stage_state["closed"]:
                            return
                        text = f"{track_header}\n{stage}"
                        if text == stage_state["last_text"]:
                            return
                        stage_state["last_text"] = text

                        def _schedule():
                            if stage_state["closed"]:
                                return
                            stage_state["task"] = asyncio.create_task(_apply_stage_edit(text))

                        loop.call_soon_threadsafe(_schedule)

                    try:
                        fast_file, cover_bytes, thumb_bytes = await asyncio.wait_for(
                            asyncio.gather(
                                asyncio.to_thread(
                                    download_track_fast_sync,
                                    meta["title"],
                                    meta["performer"],
                                    temp_dir,
                                    meta.get("duration_sec") or None,
                                    get_cookies_path(),
                                    _on_stage,
                                    meta.get("isrc"),
                                    meta.get("album"),
                                ),
                                download_cover_bytes(meta.get("cover_url")),
                                download_cover_bytes(meta.get("thumb_url")),
                            ),
                            timeout=DOWNLOAD_TIMEOUT,
                        )
                    except asyncio.TimeoutError:
                        fast_file, cover_bytes, thumb_bytes = None, None, None
                        logger.warning("Fast download timed out for %r, falling back to spotdl", clean_query)
                    except Exception as e:
                        fast_file, cover_bytes, thumb_bytes = None, None, None
                        logger.warning("Fast download error for %r: %s", clean_query, e)
                    finally:
                        stage_state["closed"] = True
                        pending = stage_state["task"]
                        if pending is not None and not pending.done():
                            pending.cancel()

                    if fast_file and os.path.isfile(fast_file):
                        try:
                            await status_msg.edit_text(f"{track_header}\n📤 Отправляю в Telegram...")
                            await target_message.bot.send_chat_action(
                                chat_id=target_message.chat.id,
                                action=ChatAction.UPLOAD_DOCUMENT,
                            )
                        except Exception:
                            pass

                        download_time = round(time.time() - start_time, 2)
                        thumb_data = thumb_bytes or cover_bytes
                        thumbnail = (
                            BufferedInputFile(thumb_data, filename="cover.jpg")
                            if thumb_data else None
                        )
                        sent_msg = await target_message.answer_audio(
                            audio=FSInputFile(fast_file),
                            title=meta["title"],
                            performer=meta["performer"],
                            duration=meta.get("duration_sec") or None,
                            thumbnail=thumbnail,
                            caption=f"⏱ Загружено за {download_time} сек.",
                        )
                        file_id = sent_msg.audio.file_id
                        title = sent_msg.audio.title or meta["title"]
                        performer = sent_msg.audio.performer or meta["performer"]

                        if cover_bytes or thumb_bytes:
                            save_cover_to_cache(file_id, cover_bytes or thumb_bytes)

                        async with aiosqlite.connect(DB_PATH) as conn:
                            await conn.execute(
                                "INSERT OR REPLACE INTO tracks (url, file_id, title, performer) VALUES (?, ?, ?, ?)",
                                (cache_key, file_id, title, performer),
                            )
                            await conn.commit()

                        markup = await get_playlist_keyboard(user_id, file_id)
                        await target_message.bot.edit_message_reply_markup(
                            chat_id=target_message.chat.id,
                            message_id=sent_msg.message_id,
                            reply_markup=markup,
                        )
                        await status_msg.delete()
                        return

                    try:
                        await status_msg.edit_text(f"{track_header}\n🔄 Пробую резервный загрузчик...")
                    except Exception:
                        pass

                cmd = build_spotdl_cmd(clean_query, temp_dir)
                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=get_subprocess_env(),
                )

                async def progress_updater():
                    last_count = -1
                    while process.returncode is None:
                        await asyncio.sleep(4)
                        current_files = len([
                            f for f in glob.glob(os.path.join(temp_dir, "*.*"))
                            if not f.endswith(".part") and not f.endswith(".ytdl")
                        ])
                        if current_files != last_count and current_files > 0:
                            try:
                                await status_msg.edit_text(f"{status_text}\n📥 Уже скачано файлов: {current_files} ...")
                                last_count = current_files
                            except Exception:
                                pass

                updater_task = asyncio.create_task(progress_updater())
                is_collection = (meta and meta.get("type") in ("album", "playlist")) or (
                    parse_spotify_url(clean_query) is not None and parse_spotify_url(clean_query)[0] in ("album", "playlist")
                )
                timeout_sec = COLLECTION_DOWNLOAD_TIMEOUT if is_collection else DOWNLOAD_TIMEOUT

                try:
                    stdout_bytes, stderr_bytes = await asyncio.wait_for(
                        process.communicate(),
                        timeout=timeout_sec,
                    )
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
                    await status_msg.edit_text(
                        "⏱ Превышено время ожидания скачивания. Попробуй еще раз позже или выбери отдельный трек."
                    )
                    return
                finally:
                    updater_task.cancel()

                download_time = round(time.time() - start_time, 2)
                downloaded_files = [
                    f for f in glob.glob(os.path.join(temp_dir, "*.*"))
                    if not f.endswith(".part") and not f.endswith(".ytdl")
                ]

                if downloaded_files:
                    safe_files = []

                    for file_path in downloaded_files:
                        f_title, f_perf = parse_filename_meta(file_path)
                        bad_artist = find_blacklisted_artist(f_perf)
                        if bad_artist:
                            await log_request(
                                user_id=user_id,
                                request=clean_query,
                                cache_key=cache_key,
                                action="blocked_by_file",
                                details={
                                    "blocked_artist": bad_artist,
                                    "filename": os.path.basename(file_path),
                                },
                            )
                        else:
                            safe_files.append(file_path)

                    if not safe_files:
                        await status_msg.edit_text("🚫 Исполнитель этого трека находится в черном списке.")
                        return

                    if len(safe_files) == 1:
                        file_path = safe_files[0]
                        f_title, f_perf = parse_filename_meta(file_path)

                        sent_msg = await target_message.answer_audio(
                            audio=FSInputFile(file_path),
                            caption=f"⏱ Загружено с нуля за {download_time} сек.",
                        )
                        file_id = sent_msg.audio.file_id
                        title = sent_msg.audio.title or (meta["title"] if meta else None) or f_title
                        performer = sent_msg.audio.performer or (meta["performer"] if meta else None) or f_perf

                        async with aiosqlite.connect(DB_PATH) as conn:
                            await conn.execute(
                                "INSERT OR REPLACE INTO tracks (url, file_id, title, performer) VALUES (?, ?, ?, ?)",
                                (cache_key, file_id, title, performer),
                            )
                            await conn.commit()

                        markup = await get_playlist_keyboard(user_id, file_id)
                        await target_message.bot.edit_message_reply_markup(
                            chat_id=target_message.chat.id,
                            message_id=sent_msg.message_id,
                            reply_markup=markup,
                        )
                    else:
                        await status_msg.edit_text(f"🚀 Упаковываем плейлист ({len(safe_files)} треков) в ZIP-архивы...")

                        MAX_ZIP_SIZE = 45 * 1024 * 1024
                        zip_index = 1
                        current_zip_size = 0
                        zip_parts = []

                        current_zip_name = os.path.join(temp_dir, f"Playlist_part{zip_index}.zip")
                        zipf = zipfile.ZipFile(current_zip_name, "w", zipfile.ZIP_DEFLATED)

                        for f_path in safe_files:
                            file_size = os.path.getsize(f_path)

                            if current_zip_size + file_size > MAX_ZIP_SIZE and current_zip_size > 0:
                                zipf.close()
                                zip_parts.append(current_zip_name)

                                zip_index += 1
                                current_zip_name = os.path.join(temp_dir, f"Playlist_part{zip_index}.zip")
                                zipf = zipfile.ZipFile(current_zip_name, "w", zipfile.ZIP_DEFLATED)
                                current_zip_size = 0

                            zipf.write(f_path, os.path.basename(f_path))
                            current_zip_size += file_size

                        zipf.close()
                        if current_zip_size > 0:
                            zip_parts.append(current_zip_name)

                        for idx, part_name in enumerate(zip_parts, 1):
                            await target_message.answer_document(
                                document=FSInputFile(part_name),
                                caption=f"📦 Плейлист (Часть {idx} из {len(zip_parts)})",
                            )
                            await asyncio.sleep(1)

                    await status_msg.delete()
                else:
                    out_str = (
                        stdout_bytes.decode("utf-8", errors="ignore") + "\n" + stderr_bytes.decode("utf-8", errors="ignore")
                    ).strip()
                    logger.warning("spotdl returned no files for query=%r:\n%s", clean_query, out_str)
                    if user_id == ADMIN_ID and out_str:
                        short_err = out_str[-600:]
                        await status_msg.edit_text(f"❌ Ничего не найдено.\n\n🛠 Лог для админа:\n{short_err}")
                    else:
                        await status_msg.edit_text("❌ Ничего не найдено.")
            except Exception as e:
                logger.exception("Download processing error for query=%r", clean_query)
                await status_msg.edit_text(f"❌ Ошибка: {e}")


async def process_direct_url_download(
    target_message: types.Message,
    user_id: int,
    source_name: str,
    clean_url: str,
):
    """Скачивает аудио напрямую по ссылке YouTube / YouTube Music / SoundCloud с кэшем и блэклистом."""
    async with aiosqlite.connect(DB_PATH) as conn:
        cached_file_id = await find_cached_track(conn, clean_url, clean_url, exact_only=True)

    if cached_file_id:
        markup = await get_playlist_keyboard(user_id, cached_file_id)
        await target_message.answer_audio(
            audio=cached_file_id,
            caption="⚡️ Моментально из кэша",
            reply_markup=markup,
        )
        return

    label = "YouTube" if source_name == "youtube" else "SoundCloud"
    status_msg = await target_message.answer(f"🔎 Получаю информацию с {label}...")

    meta = await asyncio.to_thread(inspect_direct_url_sync, clean_url, get_cookies_path())
    if not meta:
        await status_msg.edit_text(f"❌ Не удалось получить трек с {label}. Проверь ссылку или попробуй позже.")
        return

    if meta.get("is_live"):
        await status_msg.edit_text("🚫 Прямые эфиры и стримы нельзя скачать.")
        return

    duration_sec = meta.get("duration_sec") or 0
    if duration_sec > MAX_DIRECT_AUDIO_DURATION:
        mins = duration_sec // 60
        await status_msg.edit_text(
            f"🚫 Трек слишком длинный ({mins} мин). Максимальная длительность: {MAX_DIRECT_AUDIO_DURATION // 60} мин."
        )
        return

    title = meta["title"]
    performer = meta["performer"]

    bad_artist = find_blacklisted_artist(performer) or find_blacklisted_artist(title)
    if bad_artist:
        await log_request(
            user_id=user_id,
            request=clean_url,
            cache_key=clean_url,
            action="blocked_by_direct_url",
            details={
                "source": source_name,
                "blocked_artist": bad_artist,
                "performer": performer,
                "title": title,
            },
        )
        await status_msg.edit_text(f"🚫 Скачивание запрещено: исполнитель «{performer}» находится в черном списке.")
        return

    track_header = f"🎧 {performer} — {title}"
    if DOWNLOAD_SEMAPHORE.locked():
        try:
            await status_msg.edit_text(f"{track_header}\n⏳ Сервер занят другими загрузками, ваш запрос в очереди...")
        except Exception:
            pass
    else:
        try:
            await status_msg.edit_text(f"{track_header}\n⬇️ Скачиваю аудио...")
        except Exception:
            pass

    async with DOWNLOAD_SEMAPHORE:
        try:
            await status_msg.edit_text(f"{track_header}\n⬇️ Скачиваю аудио...")
        except Exception:
            pass

        with tempfile.TemporaryDirectory() as temp_dir:
            try:
                start_time = time.time()
                file_path, cover_bytes = await asyncio.wait_for(
                    asyncio.gather(
                        asyncio.to_thread(
                            download_direct_url_sync,
                            clean_url,
                            temp_dir,
                            title,
                            performer,
                            get_cookies_path(),
                        ),
                        download_cover_bytes(meta.get("cover_url")),
                    ),
                    timeout=DOWNLOAD_TIMEOUT,
                )
            except asyncio.TimeoutError:
                await status_msg.edit_text("⏱ Превышено время ожидания скачивания. Попробуй ещё раз позже.")
                return
            except Exception as e:
                logger.exception("Direct URL download error (%s): %s", clean_url, e)
                await status_msg.edit_text(f"❌ Ошибка загрузки: {e}")
                return

            if not file_path or not os.path.isfile(file_path):
                await status_msg.edit_text(f"❌ Не удалось скачать аудио с {label} (возможно, файл превышает 48 МБ или ограничен).")
                return

            try:
                await status_msg.edit_text(f"{track_header}\n📤 Отправляю в Telegram...")
                await target_message.bot.send_chat_action(
                    chat_id=target_message.chat.id,
                    action=ChatAction.UPLOAD_DOCUMENT,
                )
            except Exception:
                pass

            download_time = round(time.time() - start_time, 2)
            thumbnail = (
                BufferedInputFile(cover_bytes, filename="cover.jpg")
                if cover_bytes and cover_bytes[:2] == b"\xff\xd8" and len(cover_bytes) <= 200 * 1024
                else None
            )

            sent_msg = await target_message.answer_audio(
                audio=FSInputFile(file_path),
                title=title,
                performer=performer,
                duration=duration_sec or None,
                thumbnail=thumbnail,
                caption=f"⏱ Загружено с {label} за {download_time} сек.",
            )
            file_id = sent_msg.audio.file_id
            saved_title = sent_msg.audio.title or title
            saved_perf = sent_msg.audio.performer or performer

            if cover_bytes:
                save_cover_to_cache(file_id, cover_bytes)

            async with aiosqlite.connect(DB_PATH) as conn:
                await conn.execute(
                    "INSERT OR REPLACE INTO tracks (url, file_id, title, performer) VALUES (?, ?, ?, ?)",
                    (clean_url, file_id, saved_title, saved_perf),
                )
                await conn.commit()

            markup = await get_playlist_keyboard(user_id, file_id)
            await target_message.bot.edit_message_reply_markup(
                chat_id=target_message.chat.id,
                message_id=sent_msg.message_id,
                reply_markup=markup,
            )
            try:
                await status_msg.delete()
            except Exception:
                pass
