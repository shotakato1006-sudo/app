"""AI VTuber がマイクラを自分で遊ぶメインループ。

  python -m vtuber.play                       # 発話は画面に表示のみ
  python -m vtuber.play --voice voicevox      # VOICEVOX で日本語音声を再生
  python -m vtuber.play --interest "今日は水辺を探したい"

止め方:
  - ゲーム内で F8 … AI操作を一時停止（入力を解除）。もう一度 F8 で再開。
  - このウィンドウで Ctrl+C … 操作を止めて入力を解除し、今日のメモを保存して終了。
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import random
import sys
from typing import Any

from . import memory
from .bridge import DEFAULT_PORT, ActionResult, BridgeClient, ConnectionLost
from .brain import DEFAULT_MODEL, Brain, load_character
from .voice import Speaker, VoicevoxSpeaker

log = logging.getLogger("vtuber.play")


def pick_today_interest(character: dict[str, Any]) -> str:
    likes = character.get("likes") or ["気になったものを見に行くこと"]
    return f"今日はなんとなく「{random.choice(likes)}」の気分。でも、気になるものがあれば寄り道してもいい。"


class Player:
    def __init__(self, ns: argparse.Namespace):
        self.ns = ns
        self.character = load_character()
        self.brain = Brain(self.character, model=ns.model, effort=ns.effort)
        self.speaker: Speaker = (
            VoicevoxSpeaker(speaker_id=ns.voicevox_speaker, url=ns.voicevox_url)
            if ns.voice == "voicevox" else Speaker()
        )
        self.client = BridgeClient(port=ns.port)
        self.history: list[dict[str, Any]] = []
        self.steplog = memory.StepLog()
        self.world_id: str | None = None
        self.paused = False
        self.stopping = False
        self.handoff_done = False

    async def run(self) -> int:
        try:
            hello = await self.client.connect()
        except OSError as e:
            print(f"Modに接続できません（127.0.0.1:{self.ns.port}）。Minecraftでワールドに入っていますか？ {e}")
            return 2
        self.paused = not hello.get("ai_enabled", True)
        self.speaker.start()
        state = await self.client.get_state()
        if not state.get("in_world"):
            print("ワールドに入ってから起動してください。")
            return 2
        self.world_id = state["world_id"]
        notes = memory.load_world_notes(self.world_id)
        interest = self.ns.interest or pick_today_interest(self.character)
        print(f"接続しました: {self.world_id}\n今日の興味: {interest}\n（ゲーム内F8で一時停止、ここでCtrl+Cで終了）\n")
        self.steplog.write({"kind": "session_start", "world_id": self.world_id, "interest": interest,
                            "model": self.ns.model})
        try:
            steps = 0
            while not self.stopping and (self.ns.max_steps <= 0 or steps < self.ns.max_steps):
                await self._drain_events()
                if self.paused:
                    await asyncio.sleep(0.5)
                    continue
                state = await self.client.get_state()
                if not state.get("in_world") or state.get("world_id") != self.world_id:
                    print("ワールドが変わった/出たので終了します。")
                    break
                if state.get("screen_open"):
                    await asyncio.sleep(1.0)
                    continue
                await self._step(state, notes, interest)
                steps += 1
        except ConnectionLost:
            print("ゲームとの連携が切れました。新しい操作を止めます。")
        finally:
            await self.shutdown()
        return 0

    async def _drain_events(self) -> None:
        while not self.client.events.empty():
            ev = self.client.events.get_nowait()
            name = ev.get("event")
            if name == "ai_disabled":
                self.paused = True
                print("⏸  F8でAI操作が止められました（再開はもう一度F8）")
            elif name == "ai_enabled":
                self.paused = False
                print("▶  AI操作を再開します")
            elif name in ("world_left", "connection_lost"):
                self.stopping = True

    async def _step(self, state: dict[str, Any], notes: dict[str, Any], interest: str) -> None:
        try:
            decision = await asyncio.to_thread(self.brain.decide, state, self.history, notes, interest)
        except Exception as e:  # API エラーなどでは少し待って続ける
            log.warning("decide failed: %s", e)
            await asyncio.sleep(3.0)
            return
        if self.paused or self.stopping:
            return  # 考えている間に止められたら、その操作は実行しない
        print(f"[{decision.mood}] {decision.interest} → {decision.action} {decision.args}  ({decision.reason})")
        if decision.speech:
            self.speaker.say(decision.speech)

        result: ActionResult = await self.client.act(decision.action, decision.args, world_id=self.world_id)
        if not result.ok:
            print(f"   ✗ {result.reason}")
        obs = result.observed
        entry = {
            "interest": decision.interest,
            "reason": decision.reason,
            "speech": decision.speech,
            "action": decision.action,
            "args": decision.args,
            "result": {
                "ok": result.ok,
                "reason": result.reason,
                "moved": obs.get("moved"),
                "pos_after": obs.get("pos_after"),
                "facing_after": obs.get("facing_after"),
                "block_at_target": obs.get("block_at_target"),
                "remaining_distance": obs.get("remaining_distance"),
            },
        }
        self.history.append(entry)
        self.steplog.write({"kind": "step", "state": state, "decision": decision.to_dict(),
                            "result": result.to_dict()})

    async def shutdown(self) -> None:
        self.stopping = True
        if self.client.connected:
            await self.client.stop()
        await self.speaker.close()
        await self.client.close()
        if self.world_id and self.history and not self.ns.no_handoff and not self.handoff_done:
            self.handoff_done = True
            print("今日のメモを作っています…")
            try:
                note = await asyncio.to_thread(self.brain.handoff, self.world_id, self.history)
                path = memory.save_session_note(self.world_id, note)
                print(f"メモを保存しました: {path}")
                for like in note.get("liked", []):
                    print(f"  ♡ {like}")
            except Exception as e:
                log.warning("handoff failed: %s", e)
        print(f"ログ: {self.steplog.path}")


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m vtuber.play", description="AI VTuber がマイクラを遊ぶ")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--effort", default="low", choices=["low", "medium", "high"],
                    help="考える深さ。low が応答が速い")
    ap.add_argument("--interest", help="今日の興味（省略時はキャラの好みから選ぶ）")
    ap.add_argument("--voice", choices=["console", "voicevox"], default="console")
    ap.add_argument("--voicevox-speaker", type=int, default=8, help="VOICEVOX の話者ID")
    ap.add_argument("--voicevox-url", default="http://127.0.0.1:50021")
    ap.add_argument("--max-steps", type=int, default=0, help="0で無制限")
    ap.add_argument("--no-handoff", action="store_true", help="終了時のメモ作成をしない")
    ap.add_argument("-v", "--verbose", action="store_true")
    ns = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if ns.verbose else logging.INFO, format="%(levelname)s %(message)s")

    player = Player(ns)
    try:
        sys.exit(asyncio.run(player.run()))
    except KeyboardInterrupt:
        # asyncio.run がキャンセルした後でも、入力解除とメモ保存を確実に行う
        asyncio.run(_emergency_stop(ns.port))
        if player.world_id and player.history and not ns.no_handoff and not player.handoff_done:
            try:
                note = player.brain.handoff(player.world_id, player.history)
                print(f"メモを保存しました: {memory.save_session_note(player.world_id, note)}")
            except Exception as e:
                log.warning("handoff failed: %s", e)
        sys.exit(130)


async def _emergency_stop(port: int) -> None:
    c = BridgeClient(port=port)
    try:
        await c.connect(timeout=2.0)
        await c.stop()
        print("操作を止め、入力を解除しました。")
    except Exception:
        pass
    finally:
        await c.close()


if __name__ == "__main__":
    main()
