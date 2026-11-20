import asyncio
import logging
from aiohttp import web
from aiogram import Bot, Dispatcher
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application

from config import (
    BOT_TOKEN,
    USE_WEBHOOK,
    WEBHOOK_PATH,
    WEBHOOK_URL,
    WEBHOOK_SECRET
)
from database import init_db
from handlers import router
from webapp import create_web_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


async def on_startup(bot: Bot):
    if USE_WEBHOOK:
        await bot.set_webhook(
            url=WEBHOOK_URL,
            secret_token=WEBHOOK_SECRET,
            drop_pending_updates=True
        )
        logger.info("Webhook установлен: %s", WEBHOOK_URL)
    else:
        await bot.delete_webhook(drop_pending_updates=True)
        logger.info("Режим Polling активирован (Webhook отключен).")


async def on_shutdown(bot: Bot):
    await bot.session.close()


async def main():
    await init_db()
    
    bot = Bot(token=BOT_TOKEN)
    dp = Dispatcher()
    dp.include_router(router)
    
    dp.startup.register(on_startup)
    dp.shutdown.register(on_shutdown)

    app = create_web_app(bot)

    if USE_WEBHOOK:
        webhook_requests_handler = SimpleRequestHandler(
            dispatcher=dp,
            bot=bot,
            secret_token=WEBHOOK_SECRET,
        )
        webhook_requests_handler.register(app, path=WEBHOOK_PATH)
        setup_application(app, dp, bot=bot)

        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '0.0.0.0', 8080)
        await site.start()
        logger.info("Бот (Webhook) и Web-виджет запущены на порту 8080")
        
        try:
            await asyncio.Event().wait()
        finally:
            await runner.cleanup()
    else:
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '0.0.0.0', 8080)
        await site.start()
        logger.info("Web-виджет запущен на порту 8080")
        logger.info("Бот запущен в режиме Polling")
        try:
            await dp.start_polling(bot)
        finally:
            await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())