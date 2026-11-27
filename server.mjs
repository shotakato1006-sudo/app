// 東京湾ふねウォッチ ローカル版サーバー
// aisstream.io にずっと接続したままにして、ほぼリアルタイムで船の位置を更新する。
// 使い方: .env に API キーを書いて `node server.mjs` → http://localhost:8080 を開く
//
// .env の項目:
//   AISSTREAM_API_KEY=...   (必須)
//   ANTHROPIC_API_KEY=...   (任意。あると船をクリックしたときに AI 解説を作る)
//   AI_MODEL=claude-opus-5-5 (任意)
//   PORT=8080               (任意)
//   PHONE=0                 (任意) 0 にすると同じWi-Fiのスマホから見られなくなる（このパソコンだけ）

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- .env を読む（依存パッケージなし） ----
try {
  for (const line of fs.readFileSync(path.join(here, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const {
  applyMessage, buildList, pruneCaches, explainOne, aiKey, readJSON, writeJSON, BBOX_TOKYO_BAY,
} = await import("./scripts/collect.mjs");

const PORT = Number(process.env.PORT || 8080);
const CACHE_DIR = path.join(here, ".cache");
const KEEP_MS = 30 * 60 * 1000; // 30分以上位置が来ない船は消す

const stat = readJSON(path.join(CACHE_DIR, "static.json"), {});
const aiCache = readJSON(path.join(CACHE_DIR, "ai.json"), {});
const pos = {};
let lastMsgAt = 0, msgCount = 0, wsState = "未接続", wsError = "";

function save() {
  pruneCaches(stat, aiCache);
  writeJSON(path.join(CACHE_DIR, "static.json"), stat);
  writeJSON(path.join(CACHE_DIR, "ai.json"), aiCache);
}
setInterval(save, 5 * 60 * 1000);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { save(); process.exit(0); });

// ---- aisstream.io に常時接続（切れたら再接続） ----
let retry = 2000;
function connect() {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) { wsState = "APIキー未設定"; console.error("※ .env に AISSTREAM_API_KEY を書いてください"); return; }
  wsState = "接続中…";
  const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
  ws.onopen = () => {
    ws.send(JSON.stringify({
      APIKey: key,
      BoundingBoxes: [BBOX_TOKYO_BAY],
      FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"],
    }));
    wsState = "受信中"; wsError = ""; retry = 2000;
    console.log("aisstream.io に接続しました");
  };
  ws.onmessage = async (ev) => {
    try {
      const text = typeof ev.data === "string" ? ev.data
        : ev.data instanceof Blob ? await ev.data.text()
        : Buffer.from(ev.data).toString("utf8");
      const msg = JSON.parse(text);
      if (msg.error) { wsError = String(msg.error); console.error("aisstream:", msg.error); return; }
      applyMessage(msg, stat, pos);
      lastMsgAt = Date.now(); msgCount++;
    } catch {}
  };
  ws.onerror = (e) => { wsError = e.message || "接続エラー"; };
  ws.onclose = () => {
    wsState = "再接続待ち";
    console.log(`切断されました。${retry / 1000}秒後に再接続します`);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 60000);
  };
}
connect();

// ---- AI 解説（クリックされた船だけ、その場で作る） ----
let client = null;
const inflight = new Map();
async function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    try { const { default: Anthropic } = await import("@anthropic-ai/sdk"); client = new Anthropic(); }
    catch { console.error("※ AI解説には `npm install` が必要です"); return null; }
  }
  return client;
}
async function explain(mmsi) {
  const v = buildList(stat, { [mmsi]: pos[mmsi] || {} })[0];
  if (!v || !v.name) return { error: "この船は名前がまだ分からないため、解説を作れません" };
  const cached = aiCache[mmsi];
  if (cached && cached.key === aiKey(v)) return { text: cached.text };
  const c = await getClient();
  if (!c) return { error: "AI解説はオフです（.env に ANTHROPIC_API_KEY がありません）" };
  if (!inflight.has(mmsi)) {
    inflight.set(mmsi, explainOne(c, v, process.env.AI_MODEL || undefined)
      .then((text) => { if (text) aiCache[mmsi] = { key: aiKey(v), text, at: Date.now() }; return text; })
      .finally(() => inflight.delete(mmsi)));
  }
  try {
    const text = await inflight.get(mmsi);
    return text ? { text } : { error: "この船の解説は作れませんでした" };
  } catch (e) {
    console.error("AI error:", e.status || "", e.message);
    return { error: "AI解説の作成に失敗しました（" + (e.status || e.message) + "）" };
  }
}

// ---- HTTP サーバー ----
const FILES = { "/": "index.html", "/index.html": "index.html", "/tokyobay_ais_live.html": "tokyobay_ais_live.html" };
function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (FILES[url.pathname]) {
    return send(res, 200, fs.readFileSync(path.join(here, FILES[url.pathname])), "text/html; charset=utf-8");
  }
  if (url.pathname === "/data/vessels.json") {
    const now = Date.now();
    for (const [k, p] of Object.entries(pos)) if (now - p.t > KEEP_MS) delete pos[k];
    return send(res, 200, JSON.stringify({
      updated: new Date(lastMsgAt || now).toISOString(),
      live: true, status: wsState, error: wsError, messages: msgCount,
      vessels: buildList(stat, pos, aiCache),
    }));
  }
  if (url.pathname === "/api/explain") {
    const mmsi = url.searchParams.get("mmsi") || "";
    if (!/^\d{6,9}$/.test(mmsi)) return send(res, 400, JSON.stringify({ error: "bad mmsi" }));
    return send(res, 200, JSON.stringify(await explain(mmsi)));
  }
  send(res, 404, "not found", "text/plain; charset=utf-8");
});
const PHONE = process.env.PHONE !== "0";
server.listen(PORT, PHONE ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`\n  東京湾ふねウォッチ（ローカル版）`);
  console.log(`  このパソコンで見る: http://localhost:${PORT}`);
  if (PHONE) {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
    for (const ip of ips) console.log(`  スマホで見る（同じWi-Fiで）: http://${ip}:${PORT}`);
  }
  console.log(`  止めるときは Ctrl+C\n`);
});
