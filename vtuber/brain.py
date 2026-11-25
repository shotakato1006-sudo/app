"""遊びを選ぶ部分。キャラ設定・今日の興味・現在の状態・前回メモから、次の1手と（必要なら）ひとことを決める。

行動の選択と発話を1回の呼び出しで決めるので、同じキャラ設定と「なぜそれを選んだか」を共有できる。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anthropic

log = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-opus-5-5"
CHARACTER_PATH = Path(__file__).resolve().parent / "character.json"

ACTIONS = ["look", "move", "move_to", "jump", "wait", "place_block", "break_block"]

ACTION_GUIDE = """\
使える操作（action と args）:
- look: 視点を変える。{yaw, pitch}（絶対）か {delta_yaw, delta_pitch}（右・下が正）か {x, y, z}（その座標を見る）。duration_ms でゆっくり回せる（景色を眺めるなら 1500〜3000）。
- move: キーを押して歩く。{direction: forward|back|left|right, duration_ms(〜10000), sprint}。
- move_to: 座標へ歩いて近づく。{x, z}。経路探索はしないので、近く（〜30ブロック）で見えている場所に使う。
- jump: その場で跳ぶ。
- wait: 何もせず眺める・余韻にひたる。{duration_ms(〜30000)}。
- place_block: クリエイティブでブロックを1つ置く。{x, y, z, block（例 minecraft:oak_planks）}。目から4.5ブロック以内、隣に支えのブロックが必要。
- break_block: クリエイティブでブロックを1つ壊す。{x, y, z}。目から4.5ブロック以内。
yaw: 0=南, 90=西, 180=北, -90=東。pitch: 0=水平, 正=下, 負=上。
状態の surroundings.blocks[].in_view が true のものは、いま実際に画面に見えている。visible は遮られずに見える位置にある。"""


def load_character(path: Path = CHARACTER_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def build_system_prompt(character: dict[str, Any]) -> str:
    return f"""\
あなたは Minecraft（Java版、クリエイティブ）を自分で遊んでいる、オリジナルのAIゲーム配信者です。YouTubeでのんびりプレイ配信をしています。
いちばん大事なのは、あなた自身がゲームを楽しむことです。自分の好みやその時の興味で遊びを選び、景色を眺めたり、気に入った作業を続けたり、気になるものへ寄り道したりします。
視聴者は、楽しそうに遊ぶあなたを見て「いいなあ」と感じに来ています。何が好きで、どんな小さなことを楽しむ人なのかが、行動と声から自然に伝わるように遊んでください。

# あなたのキャラクター
{json.dumps(character, ensure_ascii=False, indent=2)}

# 進め方
- 毎回、ゲームの現在の状態と、直前の操作の結果を受け取ります。次の操作を1つだけ選んでください。結果を見てから次を決めます。
- 選ぶ理由はあなたの好みと今の興味から。気に入ったら同じ遊びを続けてよく、飽きたら別の興味へ移ってかまいません。企画や順番は決めず、その場で決めます。
- 操作が失敗したら、理由（too_far, stuck, occupied など）を見て、近づく・別の場所にするなど自然に立て直します。
- 話すのは話したくなったときだけ。speech は空文字なら黙って遊びます。集中している間や景色を眺めている間は、何手か続けて黙っていても自然です。
- 話すときは、状態や結果に実際に出てきたもの（見えているブロック、生き物、起きた変化）だけを言います。まだ起きていないことや、見えていないものを見えたように言いません。
- 話し方はキャラクター設定の speaking_style に従い、短く日本語で。

{ACTION_GUIDE}
"""


_NUM = {"type": ["number", "null"]}

DECISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "interest": {"type": "string", "description": "いま気になっていること・やりたいこと（短く）"},
        "reason": {"type": "string", "description": "この操作を選んだ理由。自分の好みや興味とのつながり"},
        "mood": {"type": "string", "description": "今の気分をひとことで"},
        "speech": {"type": "string", "description": "声に出すひとこと。黙るなら空文字"},
        "action": {"type": "string", "enum": ACTIONS},
        "args": {
            "type": "object",
            "properties": {
                "x": _NUM, "y": _NUM, "z": _NUM,
                "yaw": _NUM, "pitch": _NUM, "delta_yaw": _NUM, "delta_pitch": _NUM,
                "duration_ms": _NUM,
                "direction": {"type": ["string", "null"], "description": "move用: forward|back|left|right"},
                "sprint": {"type": ["boolean", "null"]},
                "block": {"type": ["string", "null"]},
            },
            "required": ["x", "y", "z", "yaw", "pitch", "delta_yaw", "delta_pitch", "duration_ms",
                         "direction", "sprint", "block"],
            "additionalProperties": False,
        },
    },
    "required": ["interest", "reason", "mood", "speech", "action", "args"],
    "additionalProperties": False,
}

HANDOFF_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "places": {"type": "array", "items": {"type": "string"}, "description": "遊んだ場所（座標や特徴）"},
        "happened": {"type": "array", "items": {"type": "string"}, "description": "実際に起きたこと"},
        "liked": {"type": "array", "items": {"type": "string"}, "description": "気に入ったこと"},
        "next_ideas": {"type": "array", "items": {"type": "string"}, "description": "次にやりたいことの手がかり"},
    },
    "required": ["places", "happened", "liked", "next_ideas"],
    "additionalProperties": False,
}


@dataclass
class Decision:
    interest: str
    reason: str
    mood: str
    speech: str
    action: str
    args: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"interest": self.interest, "reason": self.reason, "mood": self.mood, "speech": self.speech,
                "action": self.action, "args": self.args}


def compact_state(state: dict[str, Any]) -> dict[str, Any]:
    """プロンプトに入れる状態を、判断に必要な項目へ絞る。"""
    keep = ["world_id", "dimension", "pos", "rotation", "on_ground", "in_water", "standing_on", "biome",
            "time_of_day", "weather", "sky_light", "looking_at", "game_mode"]
    out = {k: state.get(k) for k in keep if k in state}
    sur = state.get("surroundings") or {}
    out["blocks_nearby"] = [
        {k: b[k] for k in ("id", "count", "nearest", "distance", "relative", "visible", "in_view")}
        for b in (sur.get("blocks") or [])[:18]
    ]
    out["creatures_nearby"] = [
        {k: e[k] for k in ("name", "pos", "distance", "relative", "visible", "in_view")}
        for e in (sur.get("entities") or [])[:8]
    ]
    return out


class Brain:
    def __init__(self, character: dict[str, Any], model: str = DEFAULT_MODEL, effort: str = "low"):
        self.client = anthropic.Anthropic()
        self.model = model
        self.effort = effort
        self.character = character
        self.system = build_system_prompt(character)

    def _call(self, user_text: str, schema: dict[str, Any], max_tokens: int = 8000) -> dict[str, Any]:
        response = self.client.beta.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            # 拒否時はサーバー側で自動的に別モデルへ切り替える
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=[{"type": "text", "text": self.system, "cache_control": {"type": "ephemeral"}}],
            output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": user_text}],
        )
        if response.stop_reason == "refusal":
            raise RuntimeError("model refused")
        if response.stop_reason == "max_tokens":
            raise RuntimeError("response truncated (max_tokens)")
        text = next(b.text for b in response.content if b.type == "text")
        return json.loads(text)

    def decide(
        self,
        state: dict[str, Any],
        history: list[dict[str, Any]],
        world_notes: dict[str, Any],
        today_interest: str,
    ) -> Decision:
        recent_notes = (world_notes.get("sessions") or [])[-3:]
        user_text = (
            f"# 今日の興味\n{today_interest}\n\n"
            f"# このワールドの前回までのメモ\n{json.dumps(recent_notes, ensure_ascii=False)}\n\n"
            f"# 最近の流れ（古い順。自分の選択と、実際の結果）\n{json.dumps(history[-10:], ensure_ascii=False)}\n\n"
            f"# いまのゲームの状態\n{json.dumps(compact_state(state), ensure_ascii=False)}\n\n"
            "次の操作を1つ選んでください。"
        )
        data = self._call(user_text, DECISION_SCHEMA)
        args = {k: v for k, v in (data.get("args") or {}).items() if v is not None}
        return Decision(
            interest=data["interest"], reason=data["reason"], mood=data["mood"],
            speech=data["speech"], action=data["action"], args=args,
        )

    def handoff(self, world_id: str, history: list[dict[str, Any]]) -> dict[str, Any]:
        """終了時に、次回へつなぐ短いメモを作る。"""
        user_text = (
            f"配信を終えます。ワールド {world_id} での今日の流れは次のとおりです（自分の選択と実際の結果）。\n"
            f"{json.dumps(history[-80:], ensure_ascii=False)}\n\n"
            "次回の自分への短い引き継ぎメモを作ってください。実際の結果に出てきたことだけを書き、各項目は1行ずつ短く。"
        )
        return self._call(user_text, HANDOFF_SCHEMA, max_tokens=8000)
