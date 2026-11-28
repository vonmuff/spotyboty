#!/usr/bin/env python3
"""
End-to-end WebSocket test for rooms_elixir (Phoenix Channels v2 + Presence + TelegramAuth).
Usage:
    ./venv/bin/python rooms_elixir/test_e2e_ws.py [ws_url]
"""
import asyncio
import hashlib
import hmac
import json
import os
import sys
import time
from urllib.parse import urlencode

import aiohttp


def load_bot_token() -> str:
    token = os.getenv("BOT_TOKEN", "").strip()
    if token:
        return token
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.isfile(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("BOT_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("BOT_TOKEN not found in env or .env")


def make_init_data(bot_token: str, user_id: int, first_name: str, username: str) -> str:
    user_json = json.dumps(
        {"id": user_id, "first_name": first_name, "username": username},
        separators=(",", ":"),
    )
    params = [
        ("auth_date", str(int(time.time()))),
        ("user", user_json),
    ]
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(params))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    sig = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(params + [("hash", sig)])


class PhoenixClient:
    def __init__(self, ws: aiohttp.ClientWebSocketResponse, name: str):
        self.ws = ws
        self.name = name
        self.ref = 0
        self.join_ref = None
        self.events: list[tuple[str, str, dict]] = []

    async def push(self, topic: str, event: str, payload: dict, join_ref=None):
        self.ref += 1
        ref_str = str(self.ref)
        frame = [join_ref if join_ref is not None else self.join_ref, ref_str, topic, event, payload]
        await self.ws.send_str(json.dumps(frame))
        return await self.wait_reply(ref_str)

    async def wait_reply(self, target_ref: str, timeout: float = 4.0):
        deadline = time.monotonic() + timeout
        while True:
            rem = deadline - time.monotonic()
            if rem <= 0:
                raise TimeoutError(f"[{self.name}] timeout waiting reply for ref={target_ref}")
            msg = await asyncio.wait_for(self.ws.receive(), timeout=rem)
            if msg.type != aiohttp.WSMsgType.TEXT:
                raise RuntimeError(f"[{self.name}] unexpected ws msg: {msg}")
            _, ref, topic, event, payload = json.loads(msg.data)
            if event == "phx_reply" and ref == target_ref:
                return payload
            self.events.append((topic, event, payload))

    async def wait_event(self, target_event: str, predicate=None, timeout: float = 4.0):
        for idx, (topic, event, payload) in enumerate(self.events):
            if event == target_event and (predicate is None or predicate(payload)):
                self.events.pop(idx)
                return payload
        deadline = time.monotonic() + timeout
        while True:
            rem = deadline - time.monotonic()
            if rem <= 0:
                raise TimeoutError(f"[{self.name}] timeout waiting event={target_event}; seen={self.events}")
            msg = await asyncio.wait_for(self.ws.receive(), timeout=rem)
            if msg.type != aiohttp.WSMsgType.TEXT:
                raise RuntimeError(f"[{self.name}] unexpected ws msg: {msg}")
            _, _, topic, event, payload = json.loads(msg.data)
            if event == target_event and (predicate is None or predicate(payload)):
                return payload
            self.events.append((topic, event, payload))


async def main():
    ws_base = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:4000/ws/rooms/websocket"
    bot_token = load_bot_token()
    room_id = f"e2e_{int(time.time()) % 100000}"
    topic = f"room:{room_id}"

    alice_init = make_init_data(bot_token, 1001, "Alice", "alice_jam")
    bob_init = make_init_data(bot_token, 2002, "Bob", "bob_jam")

    async with aiohttp.ClientSession() as session:
        # 1. Tampered init_data must be rejected
        bad_url = f"{ws_base}?{urlencode({'vsn': '2.0.0', 'init_data': alice_init + 'tampered'})}"
        try:
            async with session.ws_connect(bad_url):
                raise AssertionError("Tampered init_data should have been rejected!")
        except aiohttp.WSServerHandshakeError as e:
            assert e.status in (401, 403), f"Expected 401/403, got {e.status}"
            print(f"[PASS] 1. Tampered init_data rejected (HTTP {e.status})")

        # 2. Connect Alice (Host) and Bob (Guest)
        alice_url = f"{ws_base}?{urlencode({'vsn': '2.0.0', 'init_data': alice_init})}"
        bob_url = f"{ws_base}?{urlencode({'vsn': '2.0.0', 'init_data': bob_init})}"

        ws_alice = await session.ws_connect(alice_url)
        ws_bob = await session.ws_connect(bob_url)
        alice = PhoenixClient(ws_alice, "Alice")
        bob = PhoenixClient(ws_bob, "Bob")

        # 3. Both join the same room
        alice.join_ref = "1"
        res_a = await alice.push(topic, "phx_join", {}, join_ref="1")
        assert res_a["status"] == "ok" and res_a["response"]["you"]["is_host"] is True
        print(f"[PASS] 2. Alice joined {topic} as host")

        bob.join_ref = "1"
        res_b = await bob.push(topic, "phx_join", {}, join_ref="1")
        assert res_b["status"] == "ok" and res_b["response"]["you"]["is_host"] is False
        print(f"[PASS] 3. Bob joined {topic} as guest")

        # 4. Presence shows both users online
        pres_b = await bob.wait_event("presence_state")
        assert "1001" in pres_b and "2002" in pres_b, f"Unexpected presence: {pres_b}"
        diff_a = await alice.wait_event("presence_diff", lambda p: "2002" in p.get("joins", {}))
        assert "2002" in diff_a["joins"]
        print("[PASS] 4. Phoenix.Presence synced both users online")

        # 5. NTP ping
        t0 = int(time.time() * 1000)
        ping_res = await bob.push(topic, "ping", {"client_time_ms": t0})
        assert ping_res["status"] == "ok" and isinstance(ping_res["response"]["server_time_ms"], int)
        print(f"[PASS] 5. NTP ping OK (server_time_ms={ping_res['response']['server_time_ms']})")

        # 6. Host sync_track -> Guest receives room_state
        track = {
            "file_id": "AwACAgIAAxkBAA_e2e",
            "title": "Midnight City",
            "performer": "M83",
            "stream_url": "/api/stream?id=1&exp=9999999999&sig=deadbeef",
            "cover_url": "/api/cover?id=1&exp=9999999999&sig=deadbeef",
        }
        res_track = await alice.push(topic, "sync_track", {"track": track, "is_playing": True})
        assert res_track["status"] == "ok"
        bob_state = await bob.wait_event("room_state", lambda s: s.get("track", {}).get("title") == "Midnight City")
        assert bob_state["is_playing"] is True
        print("[PASS] 6. Host sync_track delivered to Bob in real time")

        # 7. Guest cannot control in "host" mode
        res_forbid = await bob.push(topic, "sync_playback", {"is_playing": False, "position_sec": 10.0})
        assert res_forbid["status"] == "error" and res_forbid["response"]["reason"] == "forbidden"
        print("[PASS] 7. Guest playback control blocked in 'host' mode")

        # 8. Host switches control_mode -> "all", then Guest pauses at 42.5s
        res_mode = await alice.push(topic, "set_control_mode", {"mode": "all"})
        assert res_mode["status"] == "ok"
        await bob.wait_event("room_state", lambda s: s.get("control_mode") == "all")

        res_pause = await bob.push(topic, "sync_playback", {"is_playing": False, "position_sec": 42.5})
        assert res_pause["status"] == "ok"
        alice_state = await alice.wait_event("room_state", lambda s: s.get("is_playing") is False and abs(s.get("position_sec", 0) - 42.5) < 0.01)
        assert alice_state["actor_id"] == 2002
        print("[PASS] 8. Host enabled 'all' mode -> Bob paused at 42.5s -> Alice synced")

        # 9. Host leaves -> Bob promoted to host automatically
        await ws_alice.close()
        promoted = await bob.wait_event("room_state", lambda s: s.get("host_id") == 2002)
        assert promoted["host_id"] == 2002
        print("[PASS] 9. Host disconnected -> Bob automatically promoted to host!")

        await ws_bob.close()
        print("\nALL 9 E2E CHECKS PASSED!")


if __name__ == "__main__":
    asyncio.run(main())
