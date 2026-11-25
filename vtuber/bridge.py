"""Minecraft の VTuber Bridge Mod と話すクライアント（127.0.0.1、1行1JSON）。"""
from __future__ import annotations

import asyncio
import itertools
import json
import logging
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 25599


class BridgeError(Exception):
    pass


class ConnectionLost(BridgeError):
    pass


@dataclass
class ActionResult:
    id: str
    action: str
    ok: bool
    reason: str | None = None
    observed: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_msg(cls, msg: dict[str, Any]) -> "ActionResult":
        return cls(
            id=msg.get("id", ""),
            action=msg.get("action", ""),
            ok=bool(msg.get("ok")),
            reason=msg.get("reason"),
            observed=msg.get("observed") or {},
        )

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "action": self.action, "ok": self.ok, "reason": self.reason, "observed": self.observed}


class BridgeClient:
    """要求には id を付け、同じ id の応答を待つ。Mod からのイベントは events キューに入る。"""

    def __init__(self, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT):
        self.host = host
        self.port = port
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._pending: dict[str, dict[str, asyncio.Future]] = {}
        self._ids = itertools.count(1)
        self._recv_task: asyncio.Task | None = None
        self.events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.connected = False

    async def connect(self, timeout: float = 5.0) -> dict[str, Any]:
        self._reader, self._writer = await asyncio.wait_for(
            asyncio.open_connection(self.host, self.port), timeout
        )
        self.connected = True
        self._recv_task = asyncio.create_task(self._recv_loop())
        return await self.request({"type": "hello"}, expect="hello")

    async def close(self) -> None:
        self.connected = False
        if self._writer is not None:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except Exception:
                pass
        if self._recv_task is not None:
            self._recv_task.cancel()

    def _next_id(self, prefix: str) -> str:
        return f"{prefix}{next(self._ids)}"

    async def _send(self, msg: dict[str, Any]) -> None:
        if not self.connected or self._writer is None:
            raise ConnectionLost("not connected")
        self._writer.write((json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))
        await self._writer.drain()

    def _waiter(self, msg_id: str, kind: str) -> asyncio.Future:
        fut = asyncio.get_running_loop().create_future()
        self._pending.setdefault(msg_id, {})[kind] = fut
        return fut

    async def request(self, msg: dict[str, Any], expect: str, timeout: float = 10.0) -> dict[str, Any]:
        msg_id = msg.get("id") or self._next_id("r")
        msg["id"] = msg_id
        fut = self._waiter(msg_id, expect)
        try:
            await self._send(msg)
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg_id, None)

    async def get_state(self) -> dict[str, Any]:
        reply = await self.request({"type": "get_state"}, expect="state")
        return reply["state"]

    async def act(
        self,
        action: str,
        args: dict[str, Any] | None = None,
        world_id: str | None = None,
        timeout: float = 70.0,
    ) -> ActionResult:
        """操作を送り、結果（成否と実際の変化）が返るまで待つ。"""
        msg_id = self._next_id("a")
        msg: dict[str, Any] = {"type": "act", "id": msg_id, "action": action, "args": args or {}}
        if world_id:
            msg["world_id"] = world_id
        fut = self._waiter(msg_id, "result")
        try:
            await self._send(msg)
            reply = await asyncio.wait_for(fut, timeout)
            return ActionResult.from_msg(reply)
        except asyncio.TimeoutError:
            # 結果が来ない場合は必ず止めて入力を解除させる
            await self.stop()
            return ActionResult(id=msg_id, action=action, ok=False, reason="client_timeout")
        finally:
            self._pending.pop(msg_id, None)

    async def stop(self) -> None:
        """実行中の操作を中断し、押下中の入力を解除させる。"""
        try:
            await self.request({"type": "stop"}, expect="stopped", timeout=3.0)
        except (BridgeError, asyncio.TimeoutError, OSError) as e:
            log.warning("stop failed: %s", e)

    async def _recv_loop(self) -> None:
        assert self._reader is not None
        try:
            while True:
                line = await self._reader.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line.decode("utf-8"))
                except json.JSONDecodeError:
                    continue
                kind = msg.get("type")
                msg_id = msg.get("id")
                if kind == "event":
                    await self.events.put(msg)
                    continue
                waiters = self._pending.get(msg_id) if msg_id else None
                if waiters:
                    fut = waiters.get(kind)
                    if fut is None and kind == "error":
                        fut = next(iter(waiters.values()), None)
                    if fut is not None and not fut.done():
                        if kind == "error":
                            fut.set_exception(BridgeError(msg.get("reason", "error")))
                        else:
                            fut.set_result(msg)
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            self.connected = False
            for waiters in self._pending.values():
                for fut in waiters.values():
                    if not fut.done():
                        fut.set_exception(ConnectionLost("connection lost"))
            await self.events.put({"type": "event", "event": "connection_lost"})
