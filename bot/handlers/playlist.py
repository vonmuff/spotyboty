import aiosqlite
from aiogram import F, Router, types

from bot.config import DB_PATH
from bot.keyboards import get_playlist_keyboard

router = Router()


@router.callback_query(F.data == "add_to_pl")
async def cq_add_to_pl(callback: types.CallbackQuery):
    audio = callback.message.audio
    file_id = audio.file_id
    user_id = callback.from_user.id

    title = audio.title or (audio.file_name.rsplit(".", 1)[0] if audio.file_name else None)
    performer = audio.performer or "Неизвестный исполнитель"

    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute(
            "INSERT OR REPLACE INTO playlist (user_id, file_id, title, performer) VALUES (?, ?, ?, ?)",
            (user_id, file_id, title, performer),
        )
        if title:
            await conn.execute(
                "UPDATE tracks SET title = COALESCE(title, ?), performer = COALESCE(performer, ?) WHERE file_id = ?",
                (title, performer, file_id),
            )
        await conn.commit()

    await callback.answer("✅ Добавлено в плейлист!")
    markup = await get_playlist_keyboard(user_id, file_id)
    await callback.message.edit_reply_markup(reply_markup=markup)


@router.callback_query(F.data == "remove_from_pl")
async def cq_remove_from_pl(callback: types.CallbackQuery):
    file_id = callback.message.audio.file_id
    user_id = callback.from_user.id
    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute("DELETE FROM playlist WHERE user_id = ? AND file_id = ?", (user_id, file_id))
        await conn.commit()

    await callback.answer("❌ Удалено из плейлиста!")
    markup = await get_playlist_keyboard(user_id, file_id)
    await callback.message.edit_reply_markup(reply_markup=markup)
