from aiogram import F, Router, types
from aiogram.filters import Command
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

from bot.config import WEBAPP_URL
from bot.keyboards import main_keyboard

router = Router()


@router.message(Command("start"))
async def cmd_start(message: types.Message):
    await message.answer(
        "Привет! Я музыкальный бот 🎧\n\n"
        "Отправь мне ссылку на <b>Spotify, YouTube, YouTube Music или SoundCloud</b> либо просто напиши название песни.\n"
        "⚠️ <b>Совет:</b> для точного поиска по тексту пиши ИМЯ АВТОРА и название (например, <code>Queen - Bohemian Rhapsody</code>).",
        reply_markup=main_keyboard,
        parse_mode="HTML",
    )


@router.message(F.text == "🆘 Как пользоваться")
async def btn_help(message: types.Message):
    await message.answer(
        "Просто скинь мне название трека или ссылку на Spotify, YouTube, YouTube Music или SoundCloud.\n"
        "При поиске по тексту я предложу 5 вариантов с листанием (треки с пометкой ⚡️ загружаются мгновенно из кэша)."
    )


@router.message(F.text == "ℹ️ О боте")
async def btn_info(message: types.Message):
    await message.answer(
        "Музыкальный Бот\n\n"
        "Ищет треки по названию и скачивает по ссылкам Spotify, YouTube, YouTube Music и SoundCloud. "
        "Позволяет собирать свой плейлист прямо в Telegram. Блокирует поиск и скачивание треков авторов из россии."
    )


@router.message(F.text == "🎵 Мой плейлист")
async def btn_playlist(message: types.Message):
    markup = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(
            text="📱 Открыть плейлист",
            web_app=WebAppInfo(url=WEBAPP_URL),
        )]
    ])
    await message.answer("🎧 Управляй своими сохраненными треками в удобном меню:", reply_markup=markup)
