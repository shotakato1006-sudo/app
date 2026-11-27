// 東京湾の AIS データを aisstream.io から数分間受信し、
// 「面白い船」に分類して data/vessels.json に書き出す。
// ANTHROPIC_API_KEY があれば、新しく見つかった船の解説文を Claude で作ってキャッシュする。
//
// 環境変数:
//   AISSTREAM_API_KEY  (必須) aisstream.io の API キー
//   ANTHROPIC_API_KEY  (任意) なければ AI 解説はスキップ（ページ側で簡易解説を表示）
//   AI_MODEL           (任意) 既定 claude-opus-5-5
//   DURATION_SEC       (任意) 受信する秒数。既定 330
//   MAX_AI             (任意) 1回の実行で新しく作る解説の上限。既定 25
//   OUT_DIR            (任意) 出力先。既定 site
//   CACHE_DIR          (任意) キャッシュ置き場。既定 .cache

import fs from "node:fs";
import path from "node:path";

const OUT_DIR = process.env.OUT_DIR || "site";
const CACHE_DIR = process.env.CACHE_DIR || ".cache";
const DURATION_SEC = Number(process.env.DURATION_SEC || 330);
const MAX_AI = Number(process.env.MAX_AI || 25);
const AI_MODEL = process.env.AI_MODEL || "claude-opus-5-5";
// 東京湾＋浦賀水道あたり
const BBOX = [[34.9, 139.55], [35.75, 140.2]];
// 前回の実行で見えていた船を、この時間までは残す
const KEEP_MS = 40 * 60 * 1000;

// ---------- 分類 ----------
export const BBOX_TOKYO_BAY = BBOX;
export const CATS = ["passenger", "giant", "pleasure", "highspeed", "work", "fishing", "other"];

export function typeName(t) {
  if (t == null || t === 0) return "不明";
  if (t >= 20 && t <= 29) return "WIG（表面効果翼船）";
  if (t === 30) return "漁船";
  if (t === 31 || t === 32) return "曳航中の船";
  if (t === 33) return "浚渫・水中作業船";
  if (t === 34) return "潜水作業船";
  if (t === 35) return "軍艦・自衛艦";
  if (t === 36) return "ヨット（帆船）";
  if (t === 37) return "プレジャーボート";
  if (t >= 40 && t <= 49) return "高速船";
  if (t === 50) return "パイロットボート（水先船）";
  if (t === 51) return "捜索救助船";
  if (t === 52) return "タグボート";
  if (t === 53) return "港湾作業船";
  if (t === 54) return "汚染防除船";
  if (t === 55) return "巡視船・警備艇";
  if (t === 58) return "医療船";
  if (t >= 60 && t <= 69) return "客船・フェリー";
  if (t >= 70 && t <= 79) return "貨物船";
  if (t >= 80 && t <= 89) return "タンカー";
  return "その他";
}

export function categorize(t, len) {
  if (t >= 60 && t <= 69) return "passenger";
  if (len >= 200) return "giant";
  if (t === 36 || t === 37) return "pleasure";
  if (t >= 40 && t <= 49) return "highspeed";
  if ([31, 32, 33, 34, 35, 50, 51, 52, 53, 54, 55, 58].includes(t)) return "work";
  if (t === 30) return "fishing";
  return "other";
}

// MMSI 先頭3桁（MID）→ 船籍
const MID = {
  431: "日本", 432: "日本", 351: "パナマ", 352: "パナマ", 353: "パナマ", 354: "パナマ", 355: "パナマ",
  356: "パナマ", 357: "パナマ", 370: "パナマ", 371: "パナマ", 372: "パナマ", 373: "パナマ", 374: "パナマ",
  636: "リベリア", 637: "リベリア", 538: "マーシャル諸島", 563: "シンガポール", 564: "シンガポール",
  565: "シンガポール", 566: "シンガポール", 477: "香港", 412: "中国", 413: "中国", 414: "中国",
  440: "韓国", 441: "韓国", 416: "台湾", 209: "キプロス", 210: "キプロス", 212: "キプロス",
  215: "マルタ", 229: "マルタ", 248: "マルタ", 249: "マルタ", 256: "マルタ", 308: "バハマ", 309: "バハマ",
  311: "バハマ", 237: "ギリシャ", 239: "ギリシャ", 240: "ギリシャ", 241: "ギリシャ", 219: "デンマーク",
  220: "デンマーク", 257: "ノルウェー", 258: "ノルウェー", 259: "ノルウェー", 232: "イギリス",
  233: "イギリス", 234: "イギリス", 235: "イギリス", 366: "アメリカ", 367: "アメリカ", 368: "アメリカ",
  369: "アメリカ", 338: "アメリカ", 303: "アメリカ", 211: "ドイツ", 218: "ドイツ", 244: "オランダ",
  245: "オランダ", 246: "オランダ", 226: "フランス", 227: "フランス", 228: "フランス", 247: "イタリア",
  224: "スペイン", 225: "スペイン", 255: "ポルトガル", 548: "フィリピン", 533: "マレーシア",
  525: "インドネシア", 574: "ベトナム", 567: "タイ", 419: "インド", 503: "オーストラリア",
  512: "ニュージーランド", 273: "ロシア", 205: "ベルギー", 230: "フィンランド", 265: "スウェーデン",
  266: "スウェーデン", 271: "トルコ", 403: "サウジアラビア", 470: "UAE", 471: "UAE", 576: "バヌアツ",
  577: "バヌアツ", 518: "クック諸島", 620: "コモロ", 667: "シエラレオネ", 312: "ベリーズ", 341: "セントクリストファー・ネービス",
  375: "セントビンセント", 376: "セントビンセント", 377: "セントビンセント", 457: "モンゴル", 511: "パラオ",
};
export function flagOf(mmsi) {
  return MID[Math.floor(Number(mmsi) / 1e6)] || null;
}

const clean = (s) => (typeof s === "string" ? s.replace(/@+/g, "").replace(/\s+/g, " ").trim() : "");
const dimLen = (d) => (d && d.A + d.B > 0 && d.A + d.B < 500 ? d.A + d.B : 0);
const dimBeam = (d) => (d && d.C + d.D > 0 && d.C + d.D < 80 ? d.C + d.D : 0);

// ---------- メッセージ処理 ----------
export function applyMessage(msg, stat, pos) {
  const meta = msg.MetaData || {};
  const mmsi = String(meta.MMSI || "");
  if (!mmsi) return;
  const m = msg.Message || {};
  const now = Date.now();
  const s = (stat[mmsi] ||= {});
  const metaName = clean(meta.ShipName);
  if (metaName && !s.name) s.name = metaName;

  const t = msg.MessageType;
  if (t === "ShipStaticData") {
    const d = m.ShipStaticData || {};
    if (clean(d.Name)) s.name = clean(d.Name);
    if (d.Type) s.type = d.Type;
    if (dimLen(d.Dimension)) s.len = dimLen(d.Dimension);
    if (dimBeam(d.Dimension)) s.beam = dimBeam(d.Dimension);
    if (clean(d.Destination)) s.dest = clean(d.Destination);
    if (clean(d.CallSign)) s.call = clean(d.CallSign);
    if (d.ImoNumber) s.imo = d.ImoNumber;
    if (d.MaximumStaticDraught) s.draught = d.MaximumStaticDraught;
    s.ts = now;
  } else if (t === "StaticDataReport") {
    const d = m.StaticDataReport || {};
    if (d.PartA && clean(d.PartA.Name)) s.name = clean(d.PartA.Name);
    if (d.PartB) {
      if (d.PartB.ShipType) s.type = d.PartB.ShipType;
      if (dimLen(d.PartB.Dimension)) s.len = dimLen(d.PartB.Dimension);
      if (dimBeam(d.PartB.Dimension)) s.beam = dimBeam(d.PartB.Dimension);
      if (clean(d.PartB.CallSign)) s.call = clean(d.PartB.CallSign);
    }
    s.ts = now;
  } else {
    const p = m.PositionReport || m.StandardClassBPositionReport || m.ExtendedClassBPositionReport;
    if (!p) return;
    if (t === "ExtendedClassBPositionReport") {
      if (clean(p.Name)) s.name = clean(p.Name);
      if (p.Type) s.type = p.Type;
      if (dimLen(p.Dimension)) s.len = dimLen(p.Dimension);
      if (dimBeam(p.Dimension)) s.beam = dimBeam(p.Dimension);
    }
    const lat = p.Latitude ?? meta.latitude, lon = p.Longitude ?? meta.longitude;
    if (typeof lat !== "number" || typeof lon !== "number" || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    pos[mmsi] = {
      lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      sog: p.Sog != null && p.Sog < 102.3 ? +p.Sog.toFixed(1) : null,
      cog: p.Cog != null && p.Cog < 360 ? Math.round(p.Cog) : null,
      hdg: p.TrueHeading != null && p.TrueHeading < 360 ? p.TrueHeading : null,
      nav: p.NavigationalStatus ?? null,
      t: now,
    };
  }
}

// ---------- キャッシュ ----------
export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
export function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

// ---------- 受信 ----------
async function listen(stat, pos) {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) throw new Error("AISSTREAM_API_KEY が設定されていません");
  let count = 0;
  await new Promise((resolve) => {
    const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, DURATION_SEC * 1000);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        APIKey: key,
        BoundingBoxes: [BBOX],
        FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"],
      }));
      console.log("connected");
    };
    ws.onmessage = async (ev) => {
      try {
        const text = typeof ev.data === "string" ? ev.data
          : ev.data instanceof Blob ? await ev.data.text()
          : Buffer.from(ev.data).toString("utf8");
        const msg = JSON.parse(text);
        if (msg.error) { console.error("aisstream error:", msg.error); return; }
        applyMessage(msg, stat, pos);
        count++;
      } catch (e) { console.error("parse error", e.message); }
    };
    ws.onerror = (e) => console.error("ws error", e.message || e.type);
    ws.onclose = () => { clearTimeout(timer); resolve(); };
  });
  console.log(`received ${count} messages`);
  return count;
}

// ---------- AI 解説 ----------
export const SYSTEM = `あなたは東京湾の船を一般の人にやさしく紹介するガイドです。
船のAISデータ（船名・船種・大きさ・速さ・目的地など）を受け取り、その船の短い解説文を日本語で書きます。

書き方:
- 2〜3文、全体で120字前後。です・ます調で、海や船に詳しくない人が「へえ」と思える内容にする。
- 大きさは身近なものにたとえる（例: 全長300mなら東京タワーを横にしたくらい、電車1両は約20m）。
- 有名な船（客船・フェリー・練習船・巡視船など）で、船名から確かに分かることだけは触れてよい。少しでも自信がなければ、個別の経歴は書かず、その種類の船が一般にどんな仕事をしているかを説明する。
- データにない数字や事実を作らない。目的地はAISの略号（例: JP TYO=東京）なら分かる範囲で日本語にする。
- 停泊中（速さ0付近）か航行中かが分かれば一言添えてよい。
- 前置きや見出し、箇条書き、絵文字は使わず、解説文だけを返す。`;

export function aiKey(s) {
  return [s.name || "", s.type || 0, s.len || 0].join("|");
}

// 1隻ぶんの解説を作る（失敗したら例外。拒否されたら null）
export async function explainOne(client, v, model = AI_MODEL) {
  const info = {
    船名: v.name, 船種: v.typeName, 全長m: v.len || "不明", 幅m: v.beam || "不明",
    船籍: v.flag || "不明", 速さノット: v.sog ?? "不明", 目的地AIS表記: v.dest || "不明",
    呼出符号: v.call || "不明", IMO番号: v.imo || "なし",
  };
  const res = await client.beta.messages.create({
    model,
    max_tokens: 2000,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(info, null, 1) }],
  });
  if (res.stop_reason === "refusal") return null;
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim() || null;
}

async function explainAll(list, aiCache) {
  if (!process.env.ANTHROPIC_API_KEY) { console.log("ANTHROPIC_API_KEY なし: AI解説をスキップ"); return; }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const prio = { passenger: 0, giant: 1, pleasure: 2, highspeed: 3, work: 4, fishing: 5 };
  const todo = list
    .filter((v) => v.cat !== "other" && v.name && (!aiCache[v.mmsi] || aiCache[v.mmsi].key !== aiKey(v)))
    .sort((a, b) => prio[a.cat] - prio[b.cat] || (b.len || 0) - (a.len || 0))
    .slice(0, MAX_AI);
  console.log(`AI explanations to create: ${todo.length}`);
  for (const v of todo) {
    try {
      const text = await explainOne(client, v);
      if (text) aiCache[v.mmsi] = { key: aiKey(v), text, at: Date.now() };
      else console.warn("refused:", v.name);
    } catch (e) {
      console.error(`AI error for ${v.name}:`, e.status || "", e.message);
      if (e.status === 401 || e.status === 403) break;
    }
  }
}

// 位置と静的情報を合わせて、ページに渡す一覧を作る
export function buildList(stat, pos, aiCache = {}) {
  const list = [];
  for (const [mmsi, p] of Object.entries(pos)) {
    const s = stat[mmsi] || {};
    const type = s.type || 0, len = s.len || 0;
    const v = {
      mmsi, name: s.name || "", type, typeName: typeName(type), cat: categorize(type, len),
      len, beam: s.beam || 0, dest: s.dest || "", call: s.call || "", imo: s.imo || 0,
      flag: flagOf(mmsi), ...p,
    };
    const a = aiCache[mmsi];
    if (a && a.key === aiKey(v)) v.ai = a.text;
    list.push(v);
  }
  return list;
}

// 古すぎるキャッシュを捨てる（静的情報 30日・解説 60日）
export function pruneCaches(stat, aiCache, now = Date.now()) {
  for (const [k, s] of Object.entries(stat)) if (s.ts && now - s.ts > 30 * 864e5) delete stat[k];
  for (const [k, a] of Object.entries(aiCache)) if (now - a.at > 60 * 864e5) delete aiCache[k];
}

// ---------- メイン（GitHub Actions 用：数分だけ受信して書き出す） ----------
async function main() {
  const stat = readJSON(path.join(CACHE_DIR, "static.json"), {});
  const prevPos = readJSON(path.join(CACHE_DIR, "pos.json"), {});
  const aiCache = readJSON(path.join(CACHE_DIR, "ai.json"), {});
  const pos = {};
  const now = Date.now();
  for (const [k, p] of Object.entries(prevPos)) if (now - p.t < KEEP_MS) pos[k] = p;

  await listen(stat, pos);

  await explainAll(buildList(stat, pos), aiCache);
  const list = buildList(stat, pos, aiCache);
  pruneCaches(stat, aiCache, now);

  writeJSON(path.join(CACHE_DIR, "static.json"), stat);
  writeJSON(path.join(CACHE_DIR, "pos.json"), pos);
  writeJSON(path.join(CACHE_DIR, "ai.json"), aiCache);
  writeJSON(path.join(OUT_DIR, "data", "vessels.json"), { updated: new Date().toISOString(), vessels: list });
  const byCat = Object.fromEntries(CATS.map((c) => [c, list.filter((v) => v.cat === c).length]));
  console.log(`wrote ${list.length} vessels`, byCat);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
