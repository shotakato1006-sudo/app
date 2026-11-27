// 東京湾ふねウォッチ（ローカル版）
// このパソコンで aisstream.io にずっと接続し、受け取った船の位置をページに渡す小さなサーバー。
// 追加のインストールは不要（Node.js 22 以上だけ）。
//
// 設定は同じフォルダの「設定.txt」に書く:
//   AISSTREAM_API_KEY=（aisstream.io で作った無料のキー）
//   PORT=8080   （任意）
//   PHONE=1     （任意。0 にするとスマホから見られなくなる）

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
for (const name of ["設定.txt", ".env"]) {
  try {
    for (const line of fs.readFileSync(path.join(here, name), "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const PORT = Number(process.env.PORT || 8080);
const PHONE = process.env.PHONE !== "0";
const BBOX = [[34.9, 139.55], [35.75, 140.2]]; // 東京湾＋浦賀水道
const KEEP_MS = 30 * 60 * 1000; // 30分位置が来ない船は消す
const CACHE = path.join(here, "船の情報キャッシュ.json");

// ---------- 分類 ----------
const BBOX_TOKYO_BAY = BBOX;
const CATS = ["passenger", "giant", "pleasure", "highspeed", "work", "fishing", "other"];

function typeName(t) {
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

function categorize(t, len) {
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
function flagOf(mmsi) {
  return MID[Math.floor(Number(mmsi) / 1e6)] || null;
}

const clean = (s) => (typeof s === "string" ? s.replace(/@+/g, "").replace(/\s+/g, " ").trim() : "");
const dimLen = (d) => (d && d.A + d.B > 0 && d.A + d.B < 500 ? d.A + d.B : 0);
const dimBeam = (d) => (d && d.C + d.D > 0 && d.C + d.D < 80 ? d.C + d.D : 0);

// ---------- メッセージ処理 ----------
function applyMessage(msg, stat, pos) {
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


// ---------- 状態 ----------
let stat = {};
try { stat = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch {}
const pos = {};
let lastMsgAt = 0, msgCount = 0, status = "未接続", lastError = "";
function save() {
  const now = Date.now();
  for (const [k, s] of Object.entries(stat)) if (s.ts && now - s.ts > 30 * 864e5) delete stat[k];
  try { fs.writeFileSync(CACHE, JSON.stringify(stat)); } catch {}
}
setInterval(save, 5 * 60 * 1000);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { save(); process.exit(0); });

// ---------- aisstream.io に常時接続（切れたら自動で再接続） ----------
let retry = 2000;
function connect() {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) { status = "キー未設定"; lastError = "設定.txt に AISSTREAM_API_KEY を書いて、起動し直してください"; console.error("※ " + lastError); return; }
  status = "接続中";
  const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
  ws.onopen = () => {
    ws.send(JSON.stringify({
      APIKey: key,
      BoundingBoxes: [BBOX],
      FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"],
    }));
    status = "受信中"; lastError = ""; retry = 2000;
    console.log("aisstream.io に接続しました");
  };
  ws.onmessage = async (ev) => {
    try {
      const text = typeof ev.data === "string" ? ev.data
        : ev.data instanceof Blob ? await ev.data.text() : Buffer.from(ev.data).toString("utf8");
      const msg = JSON.parse(text);
      if (msg.error) { lastError = String(msg.error); console.error("aisstream:", msg.error); return; }
      applyMessage(msg, stat, pos);
      lastMsgAt = Date.now(); msgCount++;
    } catch {}
  };
  ws.onerror = (e) => { lastError = e.message || "接続エラー"; };
  ws.onclose = () => {
    status = "再接続待ち";
    console.log(`切断されました。${retry / 1000}秒後に再接続します`);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 60000);
  };
}
connect();

function vessels() {
  const now = Date.now(), list = [];
  for (const [mmsi, p] of Object.entries(pos)) {
    if (now - p.t > KEEP_MS) { delete pos[mmsi]; continue; }
    const s = stat[mmsi] || {};
    const type = s.type || 0, len = s.len || 0;
    list.push({
      mmsi, name: s.name || "", type, typeName: typeName(type), cat: categorize(type, len),
      len, beam: s.beam || 0, dest: s.dest || "", flag: flagOf(mmsi), ...p,
    });
  }
  return list;
}

// ---------- ページを配る ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(path.join(here, "index.html")));
  }
  if (url.pathname === "/api/vessels") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ now: Date.now(), lastMsgAt, msgCount, status, error: lastError, vessels: vessels() }));
  }
  res.writeHead(404); res.end("not found");
});
server.listen(PORT, PHONE ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`\n  東京湾ふねウォッチ（ローカル版）`);
  console.log(`  パソコンで見る: http://localhost:${PORT}`);
  if (PHONE) {
    for (const i of Object.values(os.networkInterfaces()).flat()) {
      if (i && i.family === "IPv4" && !i.internal) console.log(`  スマホで見る（同じWi-Fiで）: http://${i.address}:${PORT}`);
    }
  }
  console.log(`  止めるときはこの画面を閉じるか Ctrl+C\n`);
});
