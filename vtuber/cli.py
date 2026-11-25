"""手動テスト用のコマンド。作業順1（マイクラ接続の技術試験）はここで確かめる。

例:
  python -m vtuber.cli state
  python -m vtuber.cli look --delta-yaw 90
  python -m vtuber.cli move --direction forward --ms 1500
  python -m vtuber.cli goto 120 -40
  python -m vtuber.cli place 10 64 -3 --block minecraft:oak_planks
  python -m vtuber.cli stop
  python -m vtuber.cli check      # 状態取得 → 視点変更 → 移動 → 結果確認 → 停止 を通しで確認
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from .bridge import DEFAULT_PORT, BridgeClient

LOG_DIR = Path(__file__).resolve().parent.parent / "data" / "logs"


def _print(obj: Any) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def _summary(state: dict[str, Any]) -> str:
    if not state.get("in_world"):
        return "ワールドに入っていません"
    p, r = state["pos"], state["rotation"]
    return (
        f"world={state['world_id']} pos=({p['x']}, {p['y']}, {p['z']}) "
        f"yaw={r['yaw']} pitch={r['pitch']} ({r['facing']}向き) "
        f"足元={state['standing_on']} 視線={state['looking_at'].get('block') or state['looking_at'].get('type')}"
    )


async def run_check(client: BridgeClient) -> bool:
    """作業順1の完了条件を通しで確かめ、検証ログを data/logs/ に残す。"""
    log: list[dict[str, Any]] = []
    ok_all = True

    def step(name: str, ok: bool, detail: Any) -> None:
        nonlocal ok_all
        ok_all &= ok
        log.append({"step": name, "ok": ok, "detail": detail})
        print(f"[{'OK' if ok else 'NG'}] {name}")

    state = await client.get_state()
    step("状態取得", bool(state.get("in_world")), _summary(state))
    if not state.get("in_world"):
        return False
    world = state["world_id"]
    if state.get("screen_open"):
        print("  メニューが開いています。ゲーム画面に戻ってから再実行してください。")
        return False

    r = await client.act("look", {"delta_yaw": 90, "duration_ms": 800}, world_id=world)
    turned = abs(((r.observed.get("yaw_after", 0) - r.observed.get("yaw_before", 0)) + 180) % 360 - 180)
    step("視点変更（右へ90度）", r.ok and turned > 80, r.to_dict())

    r = await client.act("look", {"delta_yaw": -90, "duration_ms": 800}, world_id=world)
    step("視点変更（元に戻す）", r.ok, r.to_dict())

    r = await client.act("move", {"direction": "forward", "duration_ms": 1200}, world_id=world)
    step("移動（前へ1.2秒）", r.ok, r.to_dict())
    if not r.ok:
        print(f"  理由: {r.reason}（前が壁なら、開けた場所で再実行してください）")

    # 停止の確認: 長めの移動を始めてすぐ止め、入力が残らないことを見る
    act_task = asyncio.create_task(
        client.act("move", {"direction": "back", "duration_ms": 5000}, world_id=world)
    )
    await asyncio.sleep(0.6)
    await client.stop()
    r = await act_task
    s1 = await client.get_state()
    await asyncio.sleep(1.0)
    s2 = await client.get_state()
    drift = abs(s2["pos"]["x"] - s1["pos"]["x"]) + abs(s2["pos"]["z"] - s1["pos"]["z"])
    held = s1.get("inputs_held", []) + s2.get("inputs_held", [])
    step(
        "停止後に入力が残らない",
        (not r.ok) and r.reason == "stopped_by_client" and not held and s2.get("current_action") is None,
        {"result": r.to_dict(), "inputs_held_after_stop": held, "drift_after_stop": round(drift, 3),
         "standing_on": s2.get("standing_on")},
    )
    if drift >= 0.05 and not held:
        print(f"  （停止後に{drift:.2f}ブロック動きましたが、押下中の入力はありません。足元 {s2.get('standing_on')} の慣性です）")

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = LOG_DIR / f"check-{datetime.now():%Y%m%d-%H%M%S}.json"
    path.write_text(json.dumps({"world_id": world, "ok": ok_all, "steps": log}, ensure_ascii=False, indent=2),
                    encoding="utf-8")
    print(f"\n{'すべてOK' if ok_all else 'NGあり'}。検証ログ: {path}")
    print("※ F8 を押してAI操作を止め、もう一度 F8 で再開できることも手で確認してください。")
    return ok_all


async def main_async(ns: argparse.Namespace) -> int:
    client = BridgeClient(port=ns.port)
    try:
        hello = await client.connect()
    except OSError as e:
        print(f"Modに接続できません（127.0.0.1:{ns.port}）。Minecraftを起動してワールドに入っていますか？ {e}")
        return 2
    try:
        cmd = ns.cmd
        if cmd == "hello":
            _print(hello)
        elif cmd == "state":
            state = await client.get_state()
            _print(state) if ns.json else print(_summary(state))
            if not ns.json:
                for b in state.get("surroundings", {}).get("blocks", [])[:12]:
                    print(f"  {b['id']:<32} x{b['count']:<5} 最寄り{b['distance']:>5}m {b['relative']}"
                          f"{' 見えている' if b['in_view'] else ''}")
                for e in state.get("surroundings", {}).get("entities", []):
                    print(f"  [生き物/物] {e['name']} {e['distance']}m {e['relative']}")
        elif cmd == "stop":
            await client.stop()
            print("停止しました（入力を解除）")
        elif cmd == "check":
            return 0 if await run_check(client) else 1
        else:
            args: dict[str, Any]
            if cmd == "look":
                args = {k: v for k, v in {
                    "yaw": ns.yaw, "pitch": ns.pitch, "delta_yaw": ns.delta_yaw, "delta_pitch": ns.delta_pitch,
                    "x": ns.x, "y": ns.y, "z": ns.z, "duration_ms": ns.ms}.items() if v is not None}
            elif cmd == "move":
                args = {"direction": ns.direction, "duration_ms": ns.ms, "sprint": ns.sprint, "jump": ns.jump}
            elif cmd == "goto":
                args = {"x": ns.x, "z": ns.z, "sprint": ns.sprint}
            elif cmd == "wait":
                args = {"duration_ms": ns.ms}
            elif cmd in ("place", "break"):
                args = {"x": ns.x, "y": ns.y, "z": ns.z}
                if cmd == "place":
                    args["block"] = ns.block
            else:
                args = {}
            action = {"goto": "move_to", "place": "place_block", "break": "break_block"}.get(cmd, cmd)
            result = await client.act(action, args)
            _print(result.to_dict())
            return 0 if result.ok else 1
        return 0
    except KeyboardInterrupt:
        await client.stop()
        return 130
    finally:
        await client.close()


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m vtuber.cli", description="VTuber Bridge 手動テスト")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("hello")
    s = sub.add_parser("state")
    s.add_argument("--json", action="store_true", help="全項目をJSONで表示")
    sub.add_parser("stop")
    sub.add_parser("check", help="作業順1の通し確認")
    s = sub.add_parser("look")
    for k in ("yaw", "pitch", "delta-yaw", "delta-pitch", "x", "y", "z"):
        s.add_argument(f"--{k}", type=float)
    s.add_argument("--ms", type=int, default=600)
    s = sub.add_parser("move")
    s.add_argument("--direction", choices=["forward", "back", "left", "right"], default="forward")
    s.add_argument("--ms", type=int, default=1000)
    s.add_argument("--sprint", action="store_true")
    s.add_argument("--jump", action="store_true")
    s = sub.add_parser("goto")
    s.add_argument("x", type=float)
    s.add_argument("z", type=float)
    s.add_argument("--sprint", action="store_true")
    sub.add_parser("jump")
    s = sub.add_parser("wait")
    s.add_argument("--ms", type=int, default=2000)
    for name in ("place", "break"):
        s = sub.add_parser(name)
        s.add_argument("x", type=float)
        s.add_argument("y", type=float)
        s.add_argument("z", type=float)
        if name == "place":
            s.add_argument("--block", default="minecraft:oak_planks")
    return ap


def main() -> None:
    ns = build_parser().parse_args()
    try:
        sys.exit(asyncio.run(main_async(ns)))
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
