import time
from typing import Any, Awaitable, Callable, Dict

from aiogram import BaseMiddleware, types

MENU_BUTTONS = {"🆘 Как пользоваться", "ℹ️ О боте", "🎵 Мой плейлист"}


class ThrottlingMiddleware(BaseMiddleware):
    """Анти-спам Middleware с автоматической очисткой памяти от старых записей."""

    def __init__(self, cooldown: float, max_cache_size: int = 2000):
        self.cooldown = cooldown
        self.max_cache_size = max_cache_size
        self.users: Dict[int, float] = {}

    async def __call__(
        self,
        handler: Callable[[types.Message, Dict[str, Any]], Awaitable[Any]],
        event: types.Message,
        data: Dict[str, Any],
    ) -> Any:
        if not event.text or event.text.startswith("/") or event.text in MENU_BUTTONS:
            return await handler(event, data)

        user_id = event.from_user.id
        now = time.monotonic()

        if len(self.users) > self.max_cache_size:
            cutoff = now - self.cooldown
            self.users = {uid: ts for uid, ts in self.users.items() if ts > cutoff}

        last_time = self.users.get(user_id)
        if last_time is not None and (now - last_time) < self.cooldown:
            remaining = round(self.cooldown - (now - last_time), 1)
            await event.answer(f"⏳ Не так быстро! Подожди еще {remaining} сек.")
            return

        self.users[user_id] = now
        return await handler(event, data)
