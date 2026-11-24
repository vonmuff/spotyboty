from aiogram import Router

from bot.config import COOLDOWN_SECONDS
from bot.middlewares import ThrottlingMiddleware
from bot.handlers import admin, common, playlist, search

router = Router()
router.message.middleware(ThrottlingMiddleware(COOLDOWN_SECONDS))

# Порядок важен: команды и кнопки меню регистрируются ДО универсального F.text в search.router
router.include_router(common.router)
router.include_router(playlist.router)
router.include_router(admin.router)
router.include_router(search.router)
