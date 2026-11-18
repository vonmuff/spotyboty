import aiosqlite
from aiogram.types import ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton
from config import DB_PATH

main_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="🎵 Мой плейлист")],
        [
            KeyboardButton(text="🆘 Как пользоваться"),
            KeyboardButton(text="ℹ️ О боте")
        ]
    ],
    resize_keyboard=True,
    input_field_placeholder="Отправь ссылку или название трека..."
)

async def get_playlist_keyboard(user_id: int, file_id: str) -> InlineKeyboardMarkup:
    async with aiosqlite.connect(DB_PATH) as conn:
        async with conn.execute(
            "SELECT 1 FROM playlist WHERE user_id = ? AND file_id = ?",
            (user_id, file_id)
        ) as cursor:
            exists = await cursor.fetchone()
    
    if exists:
        return InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="❌ Убрать из плейлиста", callback_data="remove_from_pl")]
        ])
    else:
        return InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="➕ В плейлист", callback_data="add_to_pl")]
        ])

def get_pagination_keyboard(current_page: int, total_pages: int) -> InlineKeyboardMarkup:
    buttons = []
    if current_page > 1:
        buttons.append(InlineKeyboardButton(text="⬅️", callback_data=f"page_{current_page - 1}"))
    buttons.append(InlineKeyboardButton(text=f"{current_page}/{total_pages}", callback_data="ignore"))
    if current_page < total_pages:
        buttons.append(InlineKeyboardButton(text="➡️", callback_data=f"page_{current_page + 1}"))
    return InlineKeyboardMarkup(inline_keyboard=[buttons])