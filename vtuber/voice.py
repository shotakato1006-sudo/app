"""発話。音声再生中もプレイを続けられるよう別スレッドで再生し、古くなった発話は捨てる。"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import sys
import time
import urllib.parse
import urllib.request
import wave

log = logging.getLogger(__name__)


class Speaker:
    """発話キュー。max_age 秒より古い発話は、再生前に捨てる（古い出来事の発話が後から続かないように）。"""

    def __init__(self, max_age: float = 8.0):
        self.max_age = max_age
        self._queue: asyncio.Queue[tuple[float, str]] = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self.speaking = False

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def close(self) -> None:
        if self._task:
            self._task.cancel()

    def say(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        # 新しい発話が来たら、まだ話していない古い発話は捨てる
        while not self._queue.empty():
            self._queue.get_nowait()
        self._queue.put_nowait((time.monotonic(), text))

    async def _loop(self) -> None:
        while True:
            created, text = await self._queue.get()
            if time.monotonic() - created > self.max_age:
                continue
            self.speaking = True
            try:
                await asyncio.to_thread(self.speak_blocking, text)
            except Exception as e:  # 音声が失敗しても遊びは止めない
                log.warning("speech failed: %s", e)
            finally:
                self.speaking = False

    def speak_blocking(self, text: str) -> None:
        print(f"🗨  {text}", flush=True)


class VoicevoxSpeaker(Speaker):
    """ローカルの VOICEVOX エンジン（既定 http://127.0.0.1:50021）で日本語音声を合成して再生する。"""

    def __init__(self, speaker_id: int = 8, url: str = "http://127.0.0.1:50021", max_age: float = 8.0):
        super().__init__(max_age)
        self.speaker_id = speaker_id
        self.url = url.rstrip("/")

    def speak_blocking(self, text: str) -> None:
        print(f"🗨  {text}", flush=True)
        q = urllib.parse.urlencode({"text": text, "speaker": self.speaker_id})
        req = urllib.request.Request(f"{self.url}/audio_query?{q}", method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            query = json.loads(r.read())
        req = urllib.request.Request(
            f"{self.url}/synthesis?speaker={self.speaker_id}",
            data=json.dumps(query).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            wav_bytes = r.read()
        play_wav(wav_bytes)


def play_wav(wav_bytes: bytes) -> None:
    if sys.platform == "win32":
        import winsound

        winsound.PlaySound(wav_bytes, winsound.SND_MEMORY)
        return
    # Windows以外（開発用）: 長さだけ待つ
    with wave.open(io.BytesIO(wav_bytes)) as w:
        time.sleep(w.getnframes() / float(w.getframerate()))
