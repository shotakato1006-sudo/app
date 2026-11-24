// あしあと: 画面
'use strict';

// ブラウザで動作確認するときは Android の代わりにこれを使う
const Native = window.Android || {
  pickImport() { const i = document.createElement('input'); i.type = 'file'; i.click(); },
  getUser() { try { return localStorage.getItem('ashiato-user') || '{}'; } catch (e) { return '{}'; } },
  saveUser(s) { try { localStorage.setItem('ashiato-user', s); } catch (e) { } return true; },
  exportBackup() { toast('バックアップはアプリ版でのみ使えます'); },
  clearAll() { try { localStorage.removeItem('ashiato-user'); } catch (e) { } },
  openMap(lat, lng) { window.open('https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng); },
  openUrl(u) { window.open(u); },
  version() { return 'web'; },
};

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WD = ['日', '月', '火', '水', '木', '金', '土'];

// ---------------------------------------------------------------- 表示の書式
function fmtDate(key, withWd = true) {
  const [y, m, d] = key.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${y}年${m}月${d}日` + (withWd ? `（${WD[wd]}）` : '');
}
function fmtMD(key) { const [, m, d] = key.split('-').map(Number); return `${m}月${d}日`; }
function fmtRange(a, b) {
  if (a === b) return fmtDate(a);
  const [y1, m1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
  if (y1 !== y2) return `${fmtDate(a, false)} 〜 ${fmtDate(b, false)}`;
  if (m1 !== m2) return `${fmtDate(a, false)} 〜 ${m2}月${d2}日`;
  return `${fmtDate(a, false)} 〜 ${d2}日`;
}
function fmtTime(ms, off) {
  const d = Model.local(ms, off);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間` + (m % 60 ? `${m % 60}分` : '');
  const d = Math.floor(h / 24);
  return `${d}日` + (h % 24 ? `${h % 24}時間` : '');
}
function fmtKm(m) {
  if (m < 1000) return `${Math.round(m)}m`;
  if (m < 100000) return `${(m / 1000).toFixed(1)}km`;
  return `${Math.round(m / 1000).toLocaleString('ja-JP')}km`;
}
function fmtN(n) { return Number(n).toLocaleString('ja-JP'); }
function stayLabel(t) { return t.nights > 0 ? `${t.nights}泊${t.nDays}日` : '日帰り'; }
function todayKey() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function busy(msg) {
  if (msg == null) { $('#busy').classList.add('hidden'); return; }
  $('#busy-msg').textContent = msg;
  $('#busy').classList.remove('hidden');
}

// ---------------------------------------------------------------- 利用者データ（名前・メモ・設定）
function loadUser() {
  let u = {};
  try { u = JSON.parse(Native.getUser() || '{}') || {}; } catch (e) { u = {}; }
  u.places = u.places || {}; u.trips = u.trips || {}; u.days = u.days || {}; u.settings = u.settings || {};
  Model.user = u;
}
let saveTimer = null;
function saveUser(now) {
  clearTimeout(saveTimer);
  const doSave = () => Native.saveUser(JSON.stringify(Model.user));
  if (now) doSave(); else saveTimer = setTimeout(doSave, 400);
}
function settings() { return Model.user.settings; }

// ---------------------------------------------------------------- 地図
const Maps = {
  live: new Set(),
  create(el, opt = {}) {
    const map = L.map(el, {
      zoomControl: false, attributionControl: true, preferCanvas: true,
      worldCopyJump: true, minZoom: 2, maxZoom: settings().osm ? 19 : 15, zoomSnap: 0.25,
      ...opt,
    });
    map.attributionControl.setPrefix(false);
    this.addBase(map);
    this.live.add(map);
    return map;
  },
  addBase(map) {
    const r = L.canvas({ padding: 0.3 });
    if (settings().osm) {
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      return;
    }
    if (Geo.worldGeo) L.geoJSON(Geo.worldGeo, {
      renderer: r, interactive: false,
      style: { color: '#CFC6B5', weight: 0.8, fillColor: '#FBF8F1', fillOpacity: 1 },
    }).addTo(map);
    if (Geo.prefGeo) L.geoJSON(Geo.prefGeo, {
      renderer: r, interactive: false,
      style: { color: '#C8BEAA', weight: 0.8, fill: false },
    }).addTo(map);
    map.attributionControl.addAttribution('国土数値情報・Natural Earth');
  },
  destroy(map) { if (map) { try { map.remove(); } catch (e) { } this.live.delete(map); } },
};

/** 複数日の軌跡を地図に描く。戻り値は表示範囲 */
function drawRoutes(map, dayKeys, opt = {}) {
  const r = L.canvas({ padding: 0.4 });
  const bounds = L.latLngBounds([]);
  const { t, lat, lng } = Model.pt;
  for (const k of dayKeys) {
    const d = Model.days.get(k);
    if (!d) continue;
    // 軌跡の点と滞在場所を時刻順に並べる
    const items = [];
    if (d.p0 >= 0) for (let i = d.p0; i <= d.p1; i++) items.push([t[i], lat[i], lng[i]]);
    const [ds, de] = Model.dayRange(k);
    for (const v of d.visits) {
      if (v.s >= ds && v.s < de) items.push([v.s, v.lat, v.lng]);
      if (v.e >= ds && v.e < de) items.push([v.e, v.lat, v.lng]);
    }
    for (const a of d.acts) {
      // 点が少ない移動（飛行機など）は出発地と到着地を足す
      items.push([a.s, a.slat, a.slng]);
      items.push([a.e, a.elat, a.elng]);
    }
    items.sort((x, y) => x[0] - y[0]);
    if (items.length < 2) { if (items.length) bounds.extend([items[0][1], items[0][2]]); continue; }

    const acts = d.acts;
    const modeAt = ms => {
      for (const a of acts) if (ms >= a.s && ms <= a.e) return a.mode;
      return null;
    };
    let run = null;
    const runs = [];
    for (let i = 1; i < items.length; i++) {
      const p = items[i - 1], q = items[i];
      if (p[1] === q[1] && p[2] === q[2]) continue;
      const m = modeAt((p[0] + q[0]) / 2) || 'other';
      if (!run || run.mode !== m) { run = { mode: m, pts: [[p[1], p[2]]] }; runs.push(run); }
      run.pts.push([q[1], q[2]]);
    }
    for (const ru of runs) {
      const md = MODES[ru.mode] || MODES.other;
      L.polyline(ru.pts, {
        renderer: r, color: md.color, weight: opt.weight || 4, opacity: 0.85,
        dashArray: ru.mode === 'plane' ? '6 8' : (ru.mode === 'other' ? '2 6' : null),
        lineCap: 'round', lineJoin: 'round', interactive: false,
      }).addTo(map);
      for (const p of ru.pts) bounds.extend(p);
    }
  }
  return bounds;
}

/** 滞在場所に番号付きのピンを立てる */
function drawStops(map, stops, onTap) {
  const markers = [];
  stops.forEach((s, i) => {
    const home = isHome(s.v);
    const icon = L.divIcon({ className: 'pin-num' + (home ? ' home' : ''), html: home ? '⌂' : String(i + 1), iconSize: [24, 24] });
    const m = L.marker([s.v.lat, s.v.lng], { icon, keyboard: false }).addTo(map);
    m.on('click', () => onTap && onTap(i));
    markers.push(m);
  });
  return markers;
}

function isHome(v) {
  const n = Model.placeName(v);
  if (n === '自宅') return true;
  const h = Model.homeFor(v.day);
  return h && distM(h.lat, h.lng, v.lat, v.lng) < 150;
}

/** 小さな軌跡の絵（カード用） */
function sketch(canvas, latlngs, opt = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 76, h = canvas.clientHeight || 76;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d');
  c.scale(dpr, dpr);
  c.fillStyle = '#DCE8EC';
  c.fillRect(0, 0, w, h);
  if (!latlngs.length) return;
  let a = 90, b = 180, cc = -90, dd = -180;
  for (const [la, lo] of latlngs) { a = Math.min(a, la); cc = Math.max(cc, la); b = Math.min(b, lo); dd = Math.max(dd, lo); }
  const k = Math.cos(((a + cc) / 2) * Math.PI / 180);
  let sw = (dd - b) * k, sh = cc - a;
  const minSpan = 0.01;
  if (sw < minSpan && sh < minSpan) { sw = sh = minSpan; }
  const pad = 10;
  const sc = Math.min((w - pad * 2) / (sw || 1e-9), (h - pad * 2) / (sh || 1e-9));
  const cx = (b + dd) / 2, cy = (a + cc) / 2;
  const X = lo => w / 2 + (lo - cx) * k * sc, Y = la => h / 2 - (la - cy) * sc;

  // 背景に都道府県の形をうっすら描く
  if (opt.land !== false && Geo.prefGeo && sw < 20) {
    c.fillStyle = '#FBF8F1'; c.strokeStyle = '#D8CFBF'; c.lineWidth = 0.6;
    for (const f of Geo.prefGeo.features) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) {
        const ring = poly[0];
        // 画面外の島は飛ばす
        let vis = false;
        for (let i = 0; i < ring.length; i += 8) { const x = X(ring[i][0]), y = Y(ring[i][1]); if (x > -50 && x < w + 50 && y > -50 && y < h + 50) { vis = true; break; } }
        if (!vis) continue;
        c.beginPath();
        ring.forEach((p, i) => i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1])));
        c.closePath(); c.fill(); c.stroke();
      }
    }
  }
  c.strokeStyle = opt.color || '#2F5D50';
  c.lineWidth = 2; c.lineJoin = 'round'; c.lineCap = 'round';
  c.beginPath();
  latlngs.forEach(([la, lo], i) => i ? c.lineTo(X(lo), Y(la)) : c.moveTo(X(lo), Y(la)));
  c.stroke();
  const [la0, lo0] = latlngs[0], [la1, lo1] = latlngs[latlngs.length - 1];
  c.fillStyle = '#E8B04B';
  c.beginPath(); c.arc(X(lo1), Y(la1), 3.5, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#2F5D50';
  c.beginPath(); c.arc(X(lo0), Y(la0), 2.5, 0, Math.PI * 2); c.fill();
}

/** 日々の滞在＋軌跡を、絵を描くための点列にする（最大 n 点） */
function sketchPoints(dayKeys, n = 300) {
  const items = [];
  const { t, lat, lng } = Model.pt;
  for (const k of dayKeys) {
    const d = Model.days.get(k);
    if (!d) continue;
    for (const v of d.visits) items.push([v.s, v.lat, v.lng]);
    for (const a of d.acts) { items.push([a.s, a.slat, a.slng]); items.push([a.e, a.elat, a.elng]); }
    if (d.p0 >= 0) {
      const step = Math.max(1, Math.floor((d.p1 - d.p0) / 120));
      for (let i = d.p0; i <= d.p1; i += step) items.push([t[i], lat[i], lng[i]]);
    }
  }
  items.sort((a, b) => a[0] - b[0]);
  const step = Math.max(1, Math.floor(items.length / n));
  const out = [];
  for (let i = 0; i < items.length; i += step) out.push([items[i][1], items[i][2]]);
  return out;
}

// ---------------------------------------------------------------- 画面の切り替え
const Nav = {
  tab: 'home',
  stack: [],   // 重なっている詳細画面
  tabMaps: [],
  go(tab) {
    while (this.stack.length) this.pop(true);
    this.tab = tab;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    this.renderTab();
  },
  renderTab() {
    this.tabMaps.forEach(m => Maps.destroy(m));
    this.tabMaps = [];
    const v = $('#view');
    v.className = 'view';
    v.scrollTop = 0;
    v.innerHTML = '';
    if (!Model.ready || !Model.dayKeys.length) { if (this.tab === 'home') return Views.welcome(v); }
    (Views[this.tab] || Views.home)(v);
  },
  /** 詳細画面を重ねる。render(body, page) は後片付け関数を返してよい */
  push(title, render, opt = {}) {
    const page = document.createElement('section');
    page.className = 'page';
    page.innerHTML = `<header class="page-head"><button class="iconbtn back" aria-label="戻る">←</button><h1>${esc(title)}</h1><span class="acts"></span></header><div class="page-body"></div>`;
    document.body.appendChild(page);
    $('.back', page).onclick = () => this.pop();
    const entry = { page, cleanup: null, maps: [] };
    this.stack.push(entry);
    entry.cleanup = render($('.page-body', page), page, entry) || null;
    return entry;
  },
  pop(silent) {
    const e = this.stack.pop();
    if (!e) return false;
    try { e.cleanup && e.cleanup(); } catch (err) { }
    e.maps.forEach(m => Maps.destroy(m));
    e.page.remove();
    if (!silent && e.onClosed) e.onClosed();
    return true;
  },
  refresh() {
    // データや名前が変わったので、表示中の画面を描き直す
    const titles = this.stack.map(e => e.reopen).filter(Boolean);
    while (this.stack.length) this.pop(true);
    this.renderTab();
    titles.forEach(fn => fn());
  },
};

window.handleBack = function () {
  const sheet = document.querySelector('.sheet-bg');
  if (sheet) { sheet.remove(); return true; }
  if (Nav.stack.length) { Nav.pop(); return true; }
  if (Nav.tab !== 'home') { Nav.go('home'); return true; }
  return false;
};

function sheet(html, bind) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet">${html}</div>`;
  bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bind && bind($('.sheet', bg), close);
  return close;
}

// ---------------------------------------------------------------- 各画面
const Views = {};

// ---- はじめて（データがまだない）
Views.welcome = function (v) {
  v.innerHTML = `<div class="pad">
    <div class="welcome">
      <div class="logo">👣</div>
      <h1>あしあと</h1>
      <p class="muted">これまでに行った場所を、旅の思い出として見返せるアプリです。</p>
    </div>
    <div class="card" style="margin-top:18px">
      <b>はじめに：Googleマップの位置履歴を読み込みます</b>
      <p class="small muted" style="margin:6px 0 0">スマホに保存されている「タイムライン」の記録を書き出して、このアプリで開きます。データはこのスマホの中だけで使われます。</p>
      <div class="btns"><button class="btn" id="w-guide">書き出し方を見る</button></div>
      <div class="btns" style="margin-top:8px"><button class="btn ghost" id="w-import">ファイルを選んで読み込む</button></div>
    </div>
    <p class="small muted" style="margin-top:16px;text-align:center">Googleテイクアウトの ZIP（Records.json、月ごとのファイル）にも対応しています。</p>
  </div>`;
  $('#w-guide', v).onclick = () => Views.guide();
  $('#w-import', v).onclick = () => startImport();
};

// ---- 書き出し方の説明
Views.guide = function () {
  Nav.push('位置履歴の書き出し方', body => {
    body.innerHTML = `<div class="pad">
      <div class="card">
        <b>方法1：スマホの設定から（おすすめ）</b>
        <ol class="steps" style="margin-top:12px">
          <li>スマホの「<b>設定</b>」アプリを開く</li>
          <li>「<b>位置情報</b>」→「<b>位置情報サービス</b>」→「<b>タイムライン</b>」を開く</li>
          <li>「<b>タイムライン データをエクスポート</b>」を押す</li>
          <li>保存先（「ダウンロード」など）を選んで保存する。ファイル名は「Timeline.json」になります</li>
          <li>このアプリに戻って「ファイルを選んで読み込む」から、保存したファイルを選ぶ</li>
        </ol>
        <p class="small muted" style="margin:0">機種によっては「位置情報」の中の項目名が少し違います。設定アプリの検索で「タイムライン」と入れると見つかります。</p>
      </div>
      <div class="card">
        <b>方法2：Googleマップのアプリから</b>
        <ol class="steps" style="margin-top:12px">
          <li>Googleマップを開き、右上の自分のアイコン →「<b>タイムライン</b>」</li>
          <li>右上の「︙」→「<b>位置情報とプライバシーの設定</b>」</li>
          <li>「<b>タイムライン データをエクスポート</b>」を押して保存する</li>
        </ol>
      </div>
      <div class="note">タイムラインがオフだった期間の記録はありません。また、以前の記録を消していた場合、その分は書き出されません。</div>
      <div class="btns"><button class="btn block" id="g-import">ファイルを選んで読み込む</button></div>
    </div>`;
    $('#g-import', body).onclick = () => startImport();
  });
};

// ---- ホーム
Views.home = function (v) {
  const trips = Model.visibleTrips();
  const st = Model.statsCache || (Model.statsCache = Model.stats());
  const first = Model.dayKeys[0], last = Model.dayKeys[Model.dayKeys.length - 1];
  v.innerHTML = `<div class="pad">
    <div class="hello">
      <div><h1>あしあと</h1><p>${fmtDate(first, false)} 〜 ${fmtDate(last, false)} の記録</p></div>
      <button class="iconbtn" id="h-set" aria-label="設定">⚙️</button>
    </div>
    <div class="kpis">
      <div class="kpi"><b>${fmtN(trips.length)}</b><span>旅・遠出</span></div>
      <div class="kpi"><b>${st.prefFirst.size}<small style="font-size:12px;color:var(--sub)">/47</small></b><span>都道府県</span></div>
      <div class="kpi"><b>${fmtN(Model.dayKeys.length)}</b><span>記録した日</span></div>
    </div>
    <div id="h-mem"></div>
    <h2 class="sec">最近の旅 <small>${trips.length ? '' : '遠出の記録はまだありません'}</small></h2>
    <div id="h-trips"></div>
    ${trips.length > 3 ? '<div class="btns"><button class="btn ghost block" id="h-all">すべての旅を見る</button></div>' : ''}
  </div>`;
  $('#h-set', v).onclick = () => Views.settings();
  const all = $('#h-all', v); if (all) all.onclick = () => Nav.go('trips');
  const box = $('#h-trips', v);
  trips.slice(0, 3).forEach(t => box.appendChild(tripCard(t)));

  // 〇年前の今日（前後3日）
  const today = todayKey();
  const mem = [];
  const ty = +today.slice(0, 4);
  for (let y = ty - 1; y >= +first.slice(0, 4); y--) {
    for (const delta of [0, -1, 1, -2, 2, -3, 3]) {
      const base = Date.parse(`${y}${today.slice(4)}T00:00:00Z`);
      if (isNaN(base)) continue;
      const k = new Date(base + delta * DAY).toISOString().slice(0, 10);
      const d = Model.days.get(k);
      if (d && d.trip && !d.trip.hidden) { mem.push({ y, k, d, delta }); break; }
    }
  }
  // この時期の旅がなければ、過去の旅をひとつ選んで見せる（日替わり）
  let memTitle = `この日の思い出 <small>${fmtMD(today)}ごろ</small>`;
  if (!mem.length && trips.length > 3) {
    const t = trips[(Date.parse(today) / DAY) % trips.length | 0];
    mem.push({ y: +t.start.slice(0, 4), k: t.start, d: Model.days.get(t.start), delta: 0, pick: true });
    memTitle = '今日のふりかえり';
  }
  if (mem.length) {
    const el = $('#h-mem', v);
    el.innerHTML = `<h2 class="sec">${memTitle}</h2><div class="memories"></div>`;
    const row = $('.memories', el);
    for (const m of mem) {
      const card = document.createElement('div');
      card.className = 'card memory tap';
      const title = m.d.trip ? m.d.trip.title : dayTitle(m.d);
      const ago = ty - m.y;
      const agoText = m.pick ? (ago > 0 ? `${ago}年前の旅` : '今年の旅') : `${ago}年前${m.delta ? (m.delta > 0 ? `の${m.delta}日後` : `の${-m.delta}日前`) : 'の今日'}`;
      card.innerHTML = `<canvas></canvas><div class="ago">${agoText}</div>
        <div class="mt">${esc(title)}</div><div class="md">${fmtDate(m.k)}</div>`;
      card.onclick = () => m.d.trip ? Views.trip(m.d.trip) : Views.day(m.k);
      row.appendChild(card);
      requestAnimationFrame(() => sketch($('canvas', card), sketchPoints(m.d.trip ? m.d.trip.days : [m.k])));
    }
  }
};

function dayTitle(d) {
  // その日にいちばん長くいた（自宅以外の）場所の地名
  let best = null, ms = -1;
  for (const v of d.visits) {
    if (isHome(v)) continue;
    const dur = v.e - v.s;
    if (dur > ms) { ms = dur; best = v; }
  }
  if (!best) return d.visits.length ? '自宅周辺' : '移動の記録';
  return Model.placeName(best);
}

function tripSub(t) {
  const r = t.regions.slice(0, 4).join('・');
  const parts = [];
  if (r && !t.title.startsWith(r)) parts.push(r);
  else if (t.prefs.length > 1) parts.push(t.prefs.join('・'));
  if (t.dist) parts.push('移動 ' + fmtKm(t.dist));
  return parts.join('　');
}

function tripCard(t) {
  const el = document.createElement('div');
  el.className = 'card trip tap';
  el.innerHTML = `<canvas></canvas><div class="tb">
    <div class="tt">${esc(t.title)}</div>
    <div class="td">${fmtRange(t.start, t.end)}<span class="badge ${t.nights ? 'gold' : ''}">${stayLabel(t)}</span></div>
    <div class="td">${t.abroad ? '🌏 ' : ''}${esc(tripSub(t))}</div>
  </div>`;
  el.onclick = () => Views.trip(t);
  requestAnimationFrame(() => sketch($('canvas', el), sketchPoints(t.days)));
  return el;
}

// ---- 旅の一覧
Views.trips = function (v) {
  const trips = Model.visibleTrips();
  const th = settings().tripKm || 50;
  v.innerHTML = `<div class="pad">
    <div class="hello"><div><h1>旅の記録</h1><p>自宅から${th}km以上離れた日を、旅としてまとめています</p></div></div>
    <div id="t-list"></div>
  </div>`;
  const list = $('#t-list', v);
  if (!trips.length) { list.innerHTML = `<div class="empty">まだ旅の記録がありません。<br>設定で「旅とみなす距離」を短くすると、近場のお出かけも表示されます。</div>`; return; }
  let year = null;
  // 長い一覧でも軽く動くよう、少しずつ足す
  let i = 0;
  const addMore = () => {
    const end = Math.min(trips.length, i + 30);
    for (; i < end; i++) {
      const t = trips[i];
      const y = t.start.slice(0, 4);
      if (y !== year) {
        year = y;
        const n = trips.filter(x => x.start.startsWith(y)).length;
        const h = document.createElement('div');
        h.className = 'year-h';
        h.textContent = `${y}年（${n}回）`;
        list.appendChild(h);
      }
      const c = tripCard(t);
      c.style.marginTop = '10px';
      list.appendChild(c);
    }
  };
  addMore();
  v.onscroll = () => { if (i < trips.length && v.scrollTop + v.clientHeight > v.scrollHeight - 600) addMore(); };
};

// ---- 旅の詳細
Views.trip = function (t) {
  const entry = Nav.push(t.title, (body, page, entry) => {
    const u = Model.user.trips[t.id] || {};
    body.innerHTML = `
      <div class="map-wrap"><div class="map tall" id="tr-map"></div></div>
      <div class="legend" id="tr-legend"></div>
      <div class="pad" style="padding-top:10px">
        <div class="card">
          <div style="display:flex;gap:8px;align-items:flex-start">
            <div style="flex:1;min-width:0">
              <div style="font-weight:800;font-size:19px;line-height:1.35" id="tr-title">${esc(t.title)}</div>
              <div class="small muted">${fmtRange(t.start, t.end)}<span class="badge ${t.nights ? 'gold' : ''}">${stayLabel(t)}</span></div>
            </div>
            <button class="iconbtn" id="tr-edit" aria-label="名前を変える">✏️</button>
          </div>
          <div class="kpis" style="margin-top:12px">
            <div class="kpi"><b>${fmtKm(t.dist)}</b><span>移動</span></div>
            <div class="kpi"><b>${t.prefs.length || t.countries.length}</b><span>${t.prefs.length ? '都道府県' : '国'}</span></div>
            <div class="kpi"><b>${t.visitsN}</b><span>立ち寄り</span></div>
          </div>
          <p class="small muted" style="margin:10px 0 0">${esc(t.regions.join('・'))}</p>
        </div>
        <h2 class="sec">思い出メモ</h2>
        <textarea class="memo" id="tr-memo" placeholder="誰と行った？ 何がおいしかった？ 覚えていることを書いておきましょう">${esc(u.memo || '')}</textarea>
        <div class="saved" id="tr-saved"></div>
        <h2 class="sec">行程</h2>
        <div class="tl" id="tr-tl"></div>
        <div class="btns" style="margin-top:24px"><button class="btn danger block" id="tr-hide">この旅を一覧から外す</button></div>
      </div>`;

    const map = Maps.create($('#tr-map', body));
    entry.maps.push(map);
    const bounds = drawRoutes(map, t.days);
    legend($('#tr-legend', body), t.days);
    const stops = timeline($('#tr-tl', body), t.days, map, true);
    stops.forEach(s => bounds.extend([s.v.lat, s.v.lng]));
    fit(map, bounds);

    $('#tr-memo', body).oninput = e => {
      (Model.user.trips[t.id] = Model.user.trips[t.id] || {}).memo = e.target.value;
      t.memo = e.target.value;
      saveUser();
      $('#tr-saved', body).textContent = '保存しました';
    };
    $('#tr-edit', body).onclick = () => editText('旅の名前', t.title, t.autoTitle, val => {
      (Model.user.trips[t.id] = Model.user.trips[t.id] || {}).title = val;
      t.title = val || t.autoTitle;
      saveUser(true);
      $('#tr-title', body).textContent = t.title;
      entry.dirty = true;
      $('h1', page).textContent = t.title;
    });
    $('#tr-hide', body).onclick = () => confirmSheet('この旅を一覧から外しますか？', '日々のカレンダーからは引き続き見られます。設定から元に戻せます。', '外す', () => {
      (Model.user.trips[t.id] = Model.user.trips[t.id] || {}).hidden = true;
      t.hidden = true;
      saveUser(true);
      entry.dirty = true;
      Nav.pop();
    });
  });
  entry.reopen = () => { const t2 = Model.trips.find(x => x.id === t.id); if (t2) Views.trip(t2); };
  // 名前を変えた・外したときだけ、戻った先の一覧を描き直す
  entry.onClosed = () => { if (entry.dirty) Nav.renderTab(); };
};

function fit(map, bounds) {
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 14 });
  } else {
    map.setView([36.5, 138], 5);
  }
  setTimeout(() => map.invalidateSize(), 50);
}

function legend(el, dayKeys) {
  const used = new Set();
  for (const k of dayKeys) { const d = Model.days.get(k); if (d) d.acts.forEach(a => used.add(a.mode)); }
  el.innerHTML = [...used].filter(m => m !== 'other').map(m => `<span><i style="background:${MODES[m].color}"></i>${MODES[m].label}</span>`).join('');
}

/** 行程（滞在と移動）の一覧を描く。戻り値は滞在の配列 */
function timeline(el, dayKeys, map, showDayHeads) {
  const stops = [];
  const seen = new Set();
  let html = '';
  for (const k of dayKeys) {
    const d = Model.days.get(k);
    if (!d) continue;
    if (showDayHeads) html += `<div class="tl-day">${fmtDate(k)}<span class="muted">${d.dist ? fmtKm(d.dist) : ''}</span><button class="go" data-day="${k}" style="margin-left:auto">この日を見る</button></div>`;
    const [ds, de] = Model.dayRange(k);
    const items = [];
    for (const v of d.visits) if (!seen.has(v)) { seen.add(v); items.push({ type: 'v', s: v.s, v }); }
    for (const a of d.acts) if (a.s >= ds - 3600000 && a.s < de) items.push({ type: 'a', s: a.s, a });
    items.sort((x, y) => x.s - y.s);
    let prevA = null;
    for (const it of items) {
      if (it.type === 'a') {
        const a = it.a, md = MODES[a.mode] || MODES.other;
        html += `<div class="move"><i style="background:${md.color}"></i>${md.icon} ${md.label}　${a.dist ? fmtKm(a.dist) + '・' : ''}${fmtDur(a.e - a.s)}</div>`;
        prevA = a;
        continue;
      }
      const v = it.v;
      const i = stops.length;
      stops.push({ v });
      const name = Model.placeName(v);
      const g = Model.regionOf(v.lat, v.lng);
      const region = g.country && g.country !== '日本' ? g.country : g.name;
      const home = isHome(v);
      const prevDay = new Date(Date.parse(k) - DAY).toISOString().slice(0, 10);
      const nextDay = new Date(Date.parse(k) + DAY).toISOString().slice(0, 10);
      const sDay = Model.dayOf(v.s, v.off), eDay = Model.dayOf(v.e, v.off);
      const sLabel = v.s >= ds ? `<b>${fmtTime(v.s, v.off)}</b>` : `<b>${sDay === prevDay ? '前日' : fmtMD(sDay)}から</b>`;
      const eLabel = v.e <= de ? fmtTime(v.e, v.off) : (eDay === nextDay ? '翌日' : fmtMD(eDay)) + 'まで';
      const named = !!(Model.user.places[v.key] || v.name) || home;
      html += `<div class="stop" data-i="${i}" style="margin-top:6px">
        <div class="time">${sLabel}${eLabel}</div>
        <div class="dot ${home ? 'home' : ''}"></div>
        <div class="sb tap" data-edit="${i}">
          <div class="sn">${home ? '⌂ ' : `${i + 1}. `}${esc(name)}</div>
          <div class="sr">${esc(region && region !== name ? region + '・' : '')}${fmtDur(v.e - v.s)}${v.addr && !Model.user.places[v.key] ? ' ・' + esc(v.addr) : ''}${named ? '' : '<span class="hint">　✏️ 名前を付ける</span>'}</div>
        </div>
        <button class="go" data-map="${i}">地図</button>
      </div>`;
    }
  }
  if (!html) html = '<div class="empty">この期間の滞在記録はありません</div>';
  el.innerHTML = html;

  let markers = [];
  if (map) markers = drawStops(map, stops, i => {
    const row = el.querySelector(`.stop[data-i="${i}"]`);
    if (row) { select(i); row.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });
  const select = i => {
    el.querySelectorAll('.stop.sel').forEach(r => r.classList.remove('sel'));
    const row = el.querySelector(`.stop[data-i="${i}"]`);
    if (row) row.classList.add('sel');
  };
  el.querySelectorAll('[data-map]').forEach(b => b.onclick = () => {
    const i = +b.dataset.map, v = stops[i].v;
    if (map) {
      select(i);
      map.setView([v.lat, v.lng], Math.max(map.getZoom(), 14));
      const scroller = el.closest('.page-body') || el.closest('.view');
      if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
  el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => placeSheet(stops[+b.dataset.edit].v));
  el.querySelectorAll('[data-day]').forEach(b => b.onclick = () => Views.day(b.dataset.day));
  return stops;
}

/** 場所の詳細（名前を付ける・Googleマップで開く） */
function placeSheet(v) {
  const p = Model.places.get(v.key);
  const name = Model.placeName(v);
  const g = Model.regionOf(v.lat, v.lng);
  const u = Model.user.places[v.key] || {};
  sheet(`<h3>${esc(name)}</h3>
    <div class="small muted">${esc([g.pref, g.name !== g.pref ? g.name : '', g.country !== '日本' ? g.country : ''].filter(Boolean).join(' '))}${v.addr ? '<br>' + esc(v.addr) : ''}</div>
    ${p ? `<div class="small muted" style="margin-top:6px">ここに来た回数：${fmtN(p.days.size)}日（はじめて ${fmtDate(Model.dayOf(p.first), false)}）</div>` : ''}
    <h2 class="sec" style="margin-top:16px">名前を付ける</h2>
    <input class="txt" id="ps-name" value="${esc(u.name || '')}" placeholder="${esc(name)}">
    <div class="btns"><button class="btn" id="ps-save">保存</button><button class="btn ghost" id="ps-gm">Googleマップで見る</button></div>
    <div class="btns" style="margin-top:8px">
      ${p && p.days.size > 1 ? '<button class="btn ghost" id="ps-hist">ここに来た日</button>' : ''}
      <button class="btn ghost" id="ps-home">ここを自宅にする</button>
    </div>`, (el, close) => {
    $('#ps-save', el).onclick = () => {
      const val = $('#ps-name', el).value.trim();
      if (val) Model.user.places[v.key] = { ...u, name: val };
      else delete Model.user.places[v.key];
      saveUser(true);
      close();
      Model.rebuild();
      Model.statsCache = null;
      Nav.refresh();
      toast(val ? `「${val}」と名前を付けました` : '名前を元に戻しました');
    };
    $('#ps-gm', el).onclick = () => Native.openMap(v.lat, v.lng, v.name || '');
    const hist = $('#ps-hist', el);
    if (hist) hist.onclick = () => { close(); Views.placeHistory(v); };
    $('#ps-home', el).onclick = () => {
      settings().home = { lat: v.lat, lng: v.lng };
      Model.user.places[v.key] = { ...u, name: (u.name || '自宅') };
      saveUser(true);
      close();
      busy('旅をまとめ直しています…');
      setTimeout(() => { Model.rebuild(); Model.statsCache = null; busy(null); Nav.refresh(); toast('自宅を設定しました'); }, 30);
    };
  });
}

/** その場所に行った日の一覧 */
Views.placeHistory = function (v) {
  const p = Model.places.get(v.key);
  Nav.push(Model.placeName(v), body => {
    const days = [...p.days].sort().reverse();
    body.innerHTML = `<div class="pad"><p class="muted small" style="margin-top:0">${fmtN(days.length)}日 訪れています</p><div id="ph"></div></div>`;
    const box = $('#ph', body);
    for (const k of days.slice(0, 500)) {
      const d = Model.days.get(k);
      const row = document.createElement('div');
      row.className = 'row tap';
      row.innerHTML = `<div class="grow"><div class="rt">${fmtDate(k)}</div><div class="rv">${d && d.trip ? '🧳 ' + esc(d.trip.title) : ''}</div></div><div class="rv">›</div>`;
      row.onclick = () => Views.day(k);
      box.appendChild(row);
    }
  });
};

// ---- 1日の詳細
Views.day = function (k) {
  const d = Model.days.get(k);
  const entry = Nav.push(fmtDate(k), (body, page, entry) => {
    const memo = (Model.user.days[k] || {}).memo || '';
    body.innerHTML = `
      <div class="map-wrap"><div class="map tall" id="dy-map"></div></div>
      <div class="legend" id="dy-legend"></div>
      <div class="pad" style="padding-top:10px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="chip" id="dy-prev">‹ 前の日</button>
          <span class="small muted" style="flex:1;text-align:center">${d ? `移動 ${fmtKm(d.dist)}` : ''}</span>
          <button class="chip" id="dy-next">次の日 ›</button>
        </div>
        ${d && d.trip ? `<div class="card tap" id="dy-trip" style="margin-top:12px"><span class="badge gold">旅</span> <b>${esc(d.trip.title)}</b><div class="small muted">${fmtRange(d.trip.start, d.trip.end)}</div></div>` : ''}
        <h2 class="sec">この日のメモ</h2>
        <textarea class="memo" id="dy-memo" placeholder="この日の出来事を書いておきましょう">${esc(memo)}</textarea>
        <div class="saved" id="dy-saved"></div>
        <h2 class="sec">行程</h2>
        <div class="tl" id="dy-tl"></div>
      </div>`;
    const map = Maps.create($('#dy-map', body));
    entry.maps.push(map);
    const bounds = drawRoutes(map, [k]);
    legend($('#dy-legend', body), [k]);
    const stops = timeline($('#dy-tl', body), [k], map, false);
    stops.forEach(s => bounds.extend([s.v.lat, s.v.lng]));
    fit(map, bounds);
    $('#dy-memo', body).oninput = e => {
      (Model.user.days[k] = Model.user.days[k] || {}).memo = e.target.value;
      saveUser();
      $('#dy-saved', body).textContent = '保存しました';
    };
    const idx = Model.dayKeys.indexOf(k);
    const prev = Model.dayKeys[idx - 1], next = Model.dayKeys[idx + 1];
    const pb = $('#dy-prev', body), nb = $('#dy-next', body);
    if (!prev) pb.disabled = true, pb.style.opacity = .4;
    if (!next) nb.disabled = true, nb.style.opacity = .4;
    pb.onclick = () => { if (prev) { Nav.pop(true); Views.day(prev); } };
    nb.onclick = () => { if (next) { Nav.pop(true); Views.day(next); } };
    const tb = $('#dy-trip', body);
    if (tb) tb.onclick = () => Views.trip(d.trip);
  });
  entry.reopen = () => Views.day(k);
};

// ---- カレンダー
Views.cal = function (v) {
  const keys = Model.dayKeys;
  if (!Views.cal.month) Views.cal.month = keys[keys.length - 1].slice(0, 7);
  const draw = () => {
    const ym = Views.cal.month;
    const [y, m] = ym.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const nDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const years = [...new Set(keys.map(k => k.slice(0, 4)))];
    const tk = todayKey();
    let cells = WD.map((w, i) => `<div class="wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('');
    for (let i = 0; i < first.getUTCDay(); i++) cells += '<div></div>';
    let monthDist = 0, monthDays = 0;
    for (let dd = 1; dd <= nDays; dd++) {
      const k = `${ym}-${String(dd).padStart(2, '0')}`;
      const d = Model.days.get(k);
      const wd = (first.getUTCDay() + dd - 1) % 7;
      const cls = ['cal-cell', wd === 0 ? 'sun' : wd === 6 ? 'sat' : '', d ? 'has tap' : '', d && d.trip && !d.trip.hidden ? 'trip' : '', k === tk ? 'today' : ''].join(' ');
      if (d) { monthDist += d.dist; monthDays++; }
      cells += `<div class="${cls}" ${d ? `data-k="${k}"` : ''}><span class="n">${dd}</span>${d && d.dist >= 1000 ? `<span class="km">${fmtKm(d.dist).replace('km', '')}</span>` : ''}</div>`;
    }
    const monthTrips = Model.visibleTrips().filter(t => t.start.slice(0, 7) <= ym && t.end.slice(0, 7) >= ym).reverse();
    v.innerHTML = `<div class="pad">
      <div class="cal-years">${years.map(yy => `<button class="chip ${yy === String(y) ? 'on' : ''}" data-y="${yy}">${yy}年</button>`).join('')}</div>
      <div class="cal-head">
        <button class="iconbtn" id="c-prev">‹</button>
        <h2>${y}年${m}月</h2>
        <button class="iconbtn" id="c-next">›</button>
      </div>
      <div class="cal-grid">${cells}</div>
      <p class="small muted" style="margin:10px 2px 0">記録 ${monthDays}日・移動 ${fmtKm(monthDist)}　<span class="badge gold">旅</span> の日は色付き。数字は移動したkm</p>
      ${monthTrips.length ? '<h2 class="sec">この月の旅</h2><div id="c-trips"></div>' : ''}
    </div>`;
    v.querySelectorAll('[data-k]').forEach(c => c.onclick = () => Views.day(c.dataset.k));
    v.querySelectorAll('[data-y]').forEach(c => c.onclick = () => {
      const yy = c.dataset.y;
      const inYear = keys.filter(k => k.startsWith(yy));
      Views.cal.month = (inYear.length ? inYear[inYear.length - 1] : yy + '-01').slice(0, 7);
      draw();
    });
    const shift = delta => {
      const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
      Views.cal.month = dt.toISOString().slice(0, 7);
      draw();
    };
    $('#c-prev', v).onclick = () => shift(-1);
    $('#c-next', v).onclick = () => shift(1);
    const tb = $('#c-trips', v);
    if (tb) monthTrips.forEach(t => { const c = tripCard(t); c.style.marginTop = '10px'; tb.appendChild(c); });
  };
  draw();
};

// ---- 地図（全期間）
Views.map = function (v) {
  v.className = 'view full';
  const years = [...new Set(Model.dayKeys.map(k => k.slice(0, 4)))].reverse();
  if (Views.map.year === undefined) Views.map.year = 'all';
  v.innerHTML = `<div class="map-wrap" style="position:absolute;inset:0">
    <div class="map fill" id="m-map"></div>
    <div class="map-float" id="m-chips">
      <button class="chip" data-y="all">すべて</button>
      ${years.map(y => `<button class="chip" data-y="${y}">${y}年</button>`).join('')}
    </div>
  </div>`;
  const map = Maps.create($('#m-map', v));
  Nav.tabMaps.push(map);
  let layer = L.layerGroup().addTo(map);
  const draw = () => {
    layer.clearLayers();
    v.querySelectorAll('[data-y]').forEach(c => c.classList.toggle('on', c.dataset.y === Views.map.year));
    const y = Views.map.year;
    const keys = Model.dayKeys.filter(k => y === 'all' || k.startsWith(y));
    const r = L.canvas({ padding: 0.4 });
    const bounds = L.latLngBounds([]);

    // 行ったことのある市区町村を塗る
    const codes = new Set();
    const keySet = new Set(keys);
    for (const p of Model.places.values()) {
      if (y !== 'all' && ![...p.days].some(k => keySet.has(k))) continue;
      const g = Model.regionOf(p.lat, p.lng);
      if (g.code) codes.add(g.code);
    }
    const feats = Geo.muniFeats.filter(f => codes.has(f.code));
    for (const f of feats) {
      L.polygon(f.polys.map(poly => poly.map(ring => ring.map(p => [p[1], p[0]]))), {
        renderer: r, stroke: false, fillColor: '#2F5D50', fillOpacity: 0.16, interactive: false,
      }).addTo(layer);
    }

    // 1日ごとの軌跡（間引いて軽くする）
    const { lat, lng } = Model.pt;
    const total = keys.reduce((s, k) => { const d = Model.days.get(k); return s + (d && d.p0 >= 0 ? d.p1 - d.p0 + 1 : 0); }, 0);
    const step = Math.max(1, Math.floor(total / 60000));
    for (const k of keys) {
      const d = Model.days.get(k);
      if (!d || d.p0 < 0) continue;
      const pts = [];
      for (let i = d.p0; i <= d.p1; i += step) pts.push([lat[i], lng[i]]);
      if (pts.length > 1) L.polyline(pts, { renderer: r, color: '#2F5D50', weight: 2, opacity: 0.45, interactive: false }).addTo(layer);
    }
    // 移動（飛行機など、点の少ない移動）
    for (const k of keys) {
      const d = Model.days.get(k);
      if (!d) continue;
      for (const a of d.acts) if (a.mode === 'plane' || (d.p0 < 0 && a.dist > 30000)) {
        L.polyline([[a.slat, a.slng], [a.elat, a.elng]], { renderer: r, color: a.mode === 'plane' ? MODES.plane.color : '#2F5D50', weight: 1.5, opacity: 0.5, dashArray: '4 6', interactive: false }).addTo(layer);
      }
    }
    // 滞在した場所
    for (const p of Model.places.values()) {
      if (y !== 'all' && ![...p.days].some(k => keySet.has(k))) continue;
      const m = L.circleMarker([p.lat, p.lng], {
        renderer: r, radius: Math.min(9, 3 + Math.log2(p.days.size + 1)), color: '#fff', weight: 1,
        fillColor: '#E8B04B', fillOpacity: 0.95,
      }).addTo(layer);
      m.on('click', () => placeSheet(p.sample));
      bounds.extend([p.lat, p.lng]);
    }
    if (Views.map.view) map.setView(Views.map.view[0], Views.map.view[1]);
    else fit(map, bounds);
  };
  map.on('moveend', () => { Views.map.view = [map.getCenter(), map.getZoom()]; });
  v.querySelectorAll('[data-y]').forEach(c => c.onclick = () => { Views.map.year = c.dataset.y; Views.map.view = null; draw(); });
  setTimeout(draw, 0);
};

// ---- 記録（都道府県・国・距離）
Views.stats = function (v) {
  const st = Model.statsCache || (Model.statsCache = Model.stats());
  const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
  const years = [...st.byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const maxDist = Math.max(1, ...years.map(([, r]) => r.dist));
  const countries = [...st.countryFirst.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const topPlaces = [...Model.places.values()].filter(p => !isHome(p.sample)).sort((a, b) => b.days.size - a.days.size).slice(0, 10);
  v.innerHTML = `<div class="pad">
    <div class="hello"><div><h1>記録</h1><p>これまでに行ったところ</p></div></div>
    <div class="card">
      <div style="display:flex;align-items:flex-end;gap:12px">
        <div class="big-count">${st.prefFirst.size}<small>/ 47 都道府県</small></div>
      </div>
      <div class="small muted" style="margin-top:4px">市区町村 ${fmtN(st.muniSet.size)}か所${st.passPref.size ? `・通過しただけ ${st.passPref.size}県` : ''}</div>
      <div class="map" id="s-map" style="height:300px;border-radius:12px;margin-top:12px;overflow:hidden"></div>
      <div class="pref-grid">${PREFS.map(p => `<span class="${st.prefFirst.has(p) ? 'v' : st.passPref.has(p) ? 'p' : ''}">${p.replace(/[都府県]$/, '')}</span>`).join('')}</div>
      <div class="legend" style="padding:8px 0 0"><span><i style="background:#2F5D50;height:10px"></i>立ち寄った</span><span><i style="background:#BFD6CB;height:10px"></i>通過した</span></div>
    </div>
    ${countries.length > 1 || (countries.length === 1 && countries[0][0] !== '日本') ? `
    <h2 class="sec">行った国 <small>${countries.length}か国</small></h2>
    <div class="card">${countries.map(([c, k]) => `<div class="row"><div class="grow rt">${esc(c)}</div><div class="rv">${fmtDate(k, false)}〜</div></div>`).join('')}</div>` : ''}
    <h2 class="sec">年ごとの移動距離</h2>
    <div class="card">${years.map(([y, r]) => {
      const modes = Object.entries(r.modes).sort((a, b) => b[1] - a[1]);
      const sum = modes.reduce((s, m) => s + m[1], 0) || 1;
      return `<div class="row" style="display:block">
        <div style="display:flex;justify-content:space-between"><b>${y}年</b><span class="rv">${fmtKm(r.dist)}・${r.days}日</span></div>
        <div class="bar" style="margin-top:6px;width:${Math.max(4, r.dist / maxDist * 100)}%">${modes.map(([m, dd]) => `<i style="width:${dd / sum * 100}%;background:${(MODES[m] || MODES.other).color}"></i>`).join('')}</div>
      </div>`;
    }).join('')}
      <div class="legend" style="padding:10px 0 0">${['walk', 'bike', 'car', 'train', 'plane', 'boat'].map(m => `<span><i style="background:${MODES[m].color}"></i>${MODES[m].label}</span>`).join('')}</div>
    </div>
    ${topPlaces.length ? `<h2 class="sec">よく行った場所</h2>
    <div class="card">${topPlaces.map((p, i) => `<div class="row tap" data-p="${esc(p.key)}"><div class="rv" style="width:20px">${i + 1}</div><div class="grow"><div class="rt">${esc(Model.placeName(p.sample))}</div><div class="rv">${esc(Model.regionOf(p.lat, p.lng).name)}</div></div><div class="rv">${fmtN(p.days.size)}日</div></div>`).join('')}</div>` : ''}
  </div>`;
  v.querySelectorAll('[data-p]').forEach(r => r.onclick = () => placeSheet(Model.places.get(r.dataset.p).sample));

  // 都道府県の塗り分け地図
  const map = Maps.create($('#s-map', v), { dragging: true, scrollWheelZoom: false });
  Nav.tabMaps.push(map);
  if (Geo.prefGeo) {
    L.geoJSON(Geo.prefGeo, {
      renderer: L.canvas(),
      style: f => {
        const p = f.properties.pref;
        const vis = st.prefFirst.has(p), pass = st.passPref.has(p);
        return { color: '#fff', weight: 0.8, fillColor: vis ? '#2F5D50' : pass ? '#BFD6CB' : '#E6DFD1', fillOpacity: 1 };
      },
      onEachFeature: (f, layer) => {
        const p = f.properties.pref;
        layer.on('click', () => toast(st.prefFirst.has(p) ? `${p}：はじめて ${fmtDate(st.prefFirst.get(p), false)}` : st.passPref.has(p) ? `${p}：通過しただけ` : `${p}：まだ行っていません`));
      },
    }).addTo(map);
  }
  map.setView([37.5, 137.5], 4.5);
  setTimeout(() => { map.invalidateSize(); map.fitBounds([[30.5, 128.5], [45.6, 146]]); }, 60);
};

// ---- 設定
Views.settings = function () {
  Nav.push('設定', body => {
    const s = settings();
    const hidden = Model.trips.filter(t => t.hidden);
    const st = Model.pt;
    body.innerHTML = `<div class="pad">
      <div class="card">
        <div class="setting"><div class="grow"><div class="st">位置履歴を読み込む</div><div class="sd">新しく書き出したファイルを読み込むと、今までの記録に追加されます（重なった期間は1つにまとめます）</div></div></div>
        <div class="btns" style="margin-top:0"><button class="btn" id="s-import">読み込む</button><button class="btn ghost" id="s-guide">書き出し方</button></div>
        <p class="small muted" style="margin:10px 0 0">今の記録：滞在 ${fmtN(Model.visits.length)}件・移動 ${fmtN(Model.acts.length)}件・軌跡 ${fmtN(st.n)}点</p>
      </div>
      <div class="card">
        <div class="setting">
          <div class="grow"><div class="st">旅とみなす距離</div><div class="sd">自宅からこれ以上離れた日を「旅・遠出」にまとめます</div></div>
          <select class="sel" id="s-km">${[10, 20, 30, 50, 80, 100, 200].map(n => `<option value="${n}" ${(s.tripKm || 50) === n ? 'selected' : ''}>${n}km</option>`).join('')}</select>
        </div>
        <div class="setting">
          <div class="grow"><div class="st">自宅の場所</div><div class="sd">${s.home ? '手動で設定済み' : '夜に長くいた場所から自動で判断しています（引っ越しにも対応）'}。行程の場所を押すと「ここを自宅にする」で変えられます</div></div>
          ${s.home ? '<button class="chip" id="s-home-reset">自動に戻す</button>' : ''}
        </div>
        <div class="setting">
          <div class="grow"><div class="st">詳しい地図を使う</div><div class="sd">道路や駅名の入った地図（OpenStreetMap）を表示します。オンにすると、表示している範囲の地図画像をインターネットから取得します。位置履歴そのものは送信しません</div></div>
          <label class="switch"><input type="checkbox" id="s-osm" ${s.osm ? 'checked' : ''}><span></span></label>
        </div>
      </div>
      ${hidden.length ? `<div class="card"><div class="st" style="font-weight:600">一覧から外した旅</div>${hidden.map(t => `<div class="row"><div class="grow"><div class="rt">${esc(t.title)}</div><div class="rv">${fmtRange(t.start, t.end)}</div></div><button class="chip" data-unhide="${t.id}">戻す</button></div>`).join('')}</div>` : ''}
      <div class="card">
        <div class="setting"><div class="grow"><div class="st">バックアップ</div><div class="sd">記録と、付けた名前・メモを1つのファイルに保存します。機種変更のときは、新しいスマホでこのファイルを「読み込む」と元に戻せます</div></div></div>
        <div class="btns" style="margin-top:0"><button class="btn ghost block" id="s-backup">バックアップを保存</button></div>
      </div>
      <div class="card">
        <div class="setting"><div class="grow"><div class="st">すべてのデータを消す</div><div class="sd">このアプリに読み込んだ記録・名前・メモを削除します。Googleマップ側の記録は消えません</div></div></div>
        <div class="btns" style="margin-top:0"><button class="btn danger block" id="s-clear">すべて消す</button></div>
      </div>
      <p class="small muted" style="text-align:center;margin-top:18px">あしあと ${esc(Native.version())}<br>地図データ：国土数値情報（行政区域）・Natural Earth・Leaflet<br>${s.osm ? '© OpenStreetMap contributors' : ''}</p>
    </div>`;
    $('#s-import', body).onclick = () => startImport();
    $('#s-guide', body).onclick = () => Views.guide();
    $('#s-km', body).onchange = e => {
      s.tripKm = +e.target.value;
      saveUser(true);
      busy('旅をまとめ直しています…');
      setTimeout(() => { Model.rebuild(); Model.statsCache = null; busy(null); toast(`${s.tripKm}km以上の遠出を旅にしました（${Model.visibleTrips().length}件）`); }, 30);
    };
    const hr = $('#s-home-reset', body);
    if (hr) hr.onclick = () => {
      delete s.home; saveUser(true);
      busy('旅をまとめ直しています…');
      setTimeout(() => { Model.rebuild(); Model.statsCache = null; busy(null); Nav.pop(); Views.settings(); toast('自宅を自動判定に戻しました'); }, 30);
    };
    $('#s-osm', body).onchange = e => { s.osm = e.target.checked; saveUser(true); toast(s.osm ? '詳しい地図をオンにしました' : '詳しい地図をオフにしました'); };
    body.querySelectorAll('[data-unhide]').forEach(b => b.onclick = () => {
      const id = b.dataset.unhide;
      if (Model.user.trips[id]) delete Model.user.trips[id].hidden;
      const t = Model.trips.find(x => x.id === id); if (t) t.hidden = false;
      saveUser(true);
      b.closest('.row').remove();
      toast('旅の一覧に戻しました');
    });
    $('#s-backup', body).onclick = () => Native.exportBackup();
    $('#s-clear', body).onclick = () => confirmSheet('すべてのデータを消しますか？', '読み込んだ記録・付けた名前・メモがこのアプリから消えます。元に戻せません。', '消す', () => {
      Native.clearAll();
      Model.ready = false; Model.dayKeys = []; Model.days = new Map(); Model.trips = []; Model.visits = []; Model.acts = [];
      Model.pt = { t: new Float64Array(0), lat: new Float64Array(0), lng: new Float64Array(0), n: 0 };
      loadUser();
      Nav.go('home');
      toast('すべて消しました');
    });
  });
};

function editText(title, value, placeholder, onSave) {
  sheet(`<h3>${esc(title)}</h3>
    <input class="txt" id="et-v" value="${esc(value)}" placeholder="${esc(placeholder || '')}" style="margin-top:10px">
    <p class="small muted" style="margin:6px 0 0">空にすると自動で付けた名前に戻ります</p>
    <div class="btns"><button class="btn" id="et-ok">保存</button><button class="btn ghost" id="et-cancel">やめる</button></div>`, (el, close) => {
    const inp = $('#et-v', el);
    setTimeout(() => inp.focus(), 50);
    $('#et-ok', el).onclick = () => { onSave(inp.value.trim()); close(); };
    $('#et-cancel', el).onclick = close;
  });
}

function confirmSheet(title, text, okLabel, onOk) {
  sheet(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>
    <div class="btns"><button class="btn danger" id="cf-ok">${esc(okLabel)}</button><button class="btn ghost" id="cf-cancel">やめる</button></div>`, (el, close) => {
    $('#cf-ok', el).onclick = () => { close(); onOk(); };
    $('#cf-cancel', el).onclick = close;
  });
}

// ---------------------------------------------------------------- 読み込み
function startImport() { Native.pickImport(); }

window.onImportProgress = msg => busy(msg);
window.onImportCancel = () => busy(null);
window.onImportError = msg => { busy(null); sheet(`<h3>読み込めませんでした</h3><p class="muted" style="white-space:pre-line">${esc(msg)}</p><div class="btns"><button class="btn ghost" id="ie-ok">閉じる</button></div>`, (el, close) => { $('#ie-ok', el).onclick = close; }); };
window.onImportDone = async res => {
  // バックアップから戻したときは、名前やメモも戻す（今あるものは残す）
  if (res.user) {
    const u = Model.user, b = res.user;
    for (const k of ['places', 'trips', 'days']) u[k] = { ...(b[k] || {}), ...(u[k] || {}) };
    u.settings = { ...(b.settings || {}), ...(u.settings || {}) };
    saveUser(true);
  }
  busy('記録を整理しています…');
  await loadData();
  busy(null);
  while (Nav.stack.length) Nav.pop(true);
  Nav.go('home');
  toast(`読み込みました\n滞在 ${fmtN(res.visits)}件・移動 ${fmtN(res.acts)}件・軌跡 ${fmtN(res.pts)}点`, 4000);
};
window.onBackupDone = ok => toast(ok ? 'バックアップを保存しました' : 'バックアップを保存できませんでした');

async function loadData() {
  let raw = {};
  try {
    const r = await fetch('/userdata/locations.json?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) raw = await r.json();
  } catch (e) { raw = {}; }
  Model.statsCache = null;
  if (raw && (raw.visits || raw.pts)) Model.ingest(raw);
  else Model.ready = false;
}

// ---------------------------------------------------------------- 起動
async function boot() {
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => Nav.go(b.dataset.tab));
  busy('準備しています…');
  loadUser();
  try { await Geo.load(); } catch (e) { console.error(e); }
  await loadData();
  busy(null);
  Nav.go('home');
}
boot();
