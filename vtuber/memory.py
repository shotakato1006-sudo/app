"""ワールド別の短いメモ（次回への引き継ぎ）と、状態・選択・結果のログ。"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
WORLDS_DIR = DATA_DIR / "worlds"
LOGS_DIR = DATA_DIR / "logs"


def _safe(world_id: str) -> str:
    return re.sub(r"[^0-9A-Za-z_\-.぀-ヿ一-鿿]", "_", world_id)[:80] or "unknown"


def load_world_notes(world_id: str) -> dict[str, Any]:
    path = WORLDS_DIR / f"{_safe(world_id)}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"world_id": world_id, "sessions": []}


def save_session_note(world_id: str, note: dict[str, Any], keep: int = 10) -> Path:
    """その日のメモを追記する。古いものは keep 件だけ残す。"""
    WORLDS_DIR.mkdir(parents=True, exist_ok=True)
    data = load_world_notes(world_id)
    data["world_id"] = world_id
    data.setdefault("sessions", []).append({"date": datetime.now().isoformat(timespec="minutes"), **note})
    data["sessions"] = data["sessions"][-keep:]
    path = WORLDS_DIR / f"{_safe(world_id)}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


class StepLog:
    """1ステップごとに「状態・選択・結果」を JSONL で残す（MOS-1 の照合用）。"""

    def __init__(self) -> None:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        self.path = LOGS_DIR / f"play-{datetime.now():%Y%m%d-%H%M%S}.jsonl"

    def write(self, record: dict[str, Any]) -> None:
        record = {"t": datetime.now().isoformat(timespec="seconds"), **record}
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
