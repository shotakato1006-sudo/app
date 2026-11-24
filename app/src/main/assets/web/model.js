// 位置履歴の整理: 日ごとのまとめ、自宅の推定、旅の自動検出、場所の集計
'use strict';

const DAY = 86400000;

const MODES = {
  walk:  { label: '徒歩',   color: '#E0782F', icon: '🚶' },
  run:   { label: 'ランニング', color: '#E0782F', icon: '🏃' },
  bike:  { label: '自転車', color: '#2A9D8F', icon: '🚲' },
  car:   { label: '車',     color: '#3D5A80', icon: '🚗' },
  bus:   { label: 'バス',   color: '#4F7CAC', icon: '🚌' },
  train: { label: '電車',   color: '#7B4FA0', icon: '🚃' },
  plane: { label: '飛行機', color: '#C2185B', icon: '✈️' },
  boat:  { label: '船',     color: '#1E88E5', icon: '⛴️' },
  other: { label: '移動',   color: '#8A8478', icon: '➜' },
};

function modeOf(raw) {
  const m = (raw || '').toUpperCase();
  if (!m) return 'other';
  if (m.includes('WALK') || m === 'ON_FOOT' || m.includes('HIK')) return 'walk';
  if (m.includes('RUN')) return 'run';
  if (m.includes('CYCL') || m.includes('BICYCLE') || m.includes('BIKE')) return 'bike';
  if (m.includes('FLY') || m.includes('PLANE')) return 'plane';
  if (m.includes('FERRY') || m.includes('BOAT') || m.includes('SAIL') || m.includes('KAYAK')) return 'boat';
  if (m.includes('TRAIN') || m.includes('SUBWAY') || m.includes('TRAM') || m.includes('RAIL') || m.includes('CABLE') || m.includes('FUNICULAR')) return 'train';
  if (m.includes('BUS')) return 'bus';
  if (m.includes('VEHICLE') || m.includes('CAR') || m.includes('DRIV') || m.includes('TAXI') || m.includes('MOTOR')) return 'car';
  return 'other';
}

function distM(lat1, lng1, lat2, lng2) {
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p, dLng = (lng2 - lng1) * p;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const Model = {
  ready: false,
  visits: [],   // {s,e,off,lat,lng,pid,sem,name,addr,key,day}
  acts: [],     // {s,e,off,mode,dist,slat,slng,elat,elng,day}
  pt: { t: null, lat: null, lng: null, n: 0 },  // t はミリ秒
  fav: [],
  days: new Map(),    // 'YYYY-MM-DD' -> day
  dayKeys: [],        // 昇順
  trips: [],
  places: new Map(),  // key -> place
  homeByMonth: new Map(),
  offIdx: { t: [], off: [] },
  user: { places: {}, trips: {}, days: {}, settings: {} },

  // ------------------------------------------------------------------ 読み込み
  ingest(raw) {
    this.visits = (raw.visits || []).map(x => ({
      s: x[0], e: x[1], off: x[2], lat: x[3], lng: x[4], pid: x[5] || '', sem: x[6] || '', name: x[7] || '', addr: x[8] || '',
    }));
    this.acts = (raw.acts || []).map(x => ({
      s: x[0], e: x[1], off: x[2], mode: modeOf(x[3]), dist: x[4] || 0, slat: x[5], slng: x[6], elat: x[7], elng: x[8],
    }));
    const p = raw.pts || [];
    const n = Math.floor(p.length / 3);
    const t = new Float64Array(n), la = new Float64Array(n), lo = new Float64Array(n);
    let ct = 0, cla = 0, clo = 0;
    for (let i = 0; i < n; i++) {
      ct += p[3 * i]; cla += p[3 * i + 1]; clo += p[3 * i + 2];
      t[i] = ct * 1000; la[i] = cla / 1e5; lo[i] = clo / 1e5;
    }
    this.pt = { t, lat: la, lng: lo, n };
    this.fav = (raw.fav || []).map(f => ({ pid: f[0], lat: f[1], lng: f[2], label: f[3] }));
    this.rebuild();
  },

  /** 利用者の設定（旅の判定距離・自宅）が変わったときも呼ぶ */
  rebuild() {
    this.buildOffsets();
    for (const v of this.visits) { v.key = this.placeKey(v); v.day = this.dayOf(v.s, v.off); }
    for (const a of this.acts) a.day = this.dayOf(a.s, a.off);
    this.buildDays();
    this.buildPlaces();
    this.buildHomes();
    this.buildTrips();
    this.ready = true;
  },

  // ------------------------------------------------------------------ 時刻
  buildOffsets() {
    const arr = [];
    for (const v of this.visits) if (v.off != null) arr.push([v.s, v.off]);
    for (const a of this.acts) if (a.off != null) arr.push([a.s, a.off]);
    arr.sort((a, b) => a[0] - b[0]);
    this.offIdx = { t: arr.map(x => x[0]), off: arr.map(x => x[1]) };
  },

  /** その時刻の現地の UTC との時差（分） */
  offsetAt(ms, known) {
    if (known != null) return known;
    const { t, off } = this.offIdx;
    if (t.length) {
      let lo = 0, hi = t.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t[m] <= ms) lo = m; else hi = m - 1; }
      if (Math.abs(t[lo] - ms) < 3 * DAY) return off[lo];
      const j = Math.min(lo + 1, t.length - 1);
      if (Math.abs(t[j] - ms) < 3 * DAY) return off[j];
    }
    return -new Date(ms).getTimezoneOffset();
  },

  /** 現地時刻を表す Date（UTC の getter で読む） */
  local(ms, known) { return new Date(ms + this.offsetAt(ms, known) * 60000); },

  dayOf(ms, known) { return this.local(ms, known).toISOString().slice(0, 10); },

  /** その日の 0:00〜24:00 を UNIX ミリ秒で */
  dayRange(key) {
    const base = Date.parse(key + 'T00:00:00Z');
    const off = this.offsetAt(base + 12 * 3600000);
    return [base - off * 60000, base - off * 60000 + DAY];
  },

  // ------------------------------------------------------------------ 場所
  placeKey(v) {
    if (v.pid) return v.pid;
    return 'g' + v.lat.toFixed(3) + ',' + v.lng.toFixed(3);
  },

  placeName(v) {
    const u = this.user.places[v.key];
    if (u && u.name) return u.name;
    if (v.name) return v.name;
    const f = this.fav.find(f => f.pid && f.pid === v.pid);
    if (f && /HOME/i.test(f.label)) return '自宅';
    if (f && /WORK/i.test(f.label)) return '職場';
    if (v.sem && /HOME/i.test(v.sem)) return '自宅';
    if (v.sem && /WORK/i.test(v.sem)) return '職場';
    const g = Geo.lookup(v.lat, v.lng);
    return g.name || '名前のない場所';
  },

  /** 地名（市区町村・国）。名前を付けた場所でも、地域名として使う */
  regionOf(lat, lng) { return Geo.lookup(lat, lng); },

  buildPlaces() {
    const map = new Map();
    for (const v of this.visits) {
      let p = map.get(v.key);
      if (!p) map.set(v.key, p = { key: v.key, lat: v.lat, lng: v.lng, count: 0, ms: 0, first: v.s, last: v.s, sample: v, days: new Set() });
      p.count++;
      p.ms += Math.max(0, v.e - v.s);
      p.last = v.s;
      p.days.add(v.day);
      if (!p.sample.name && v.name) p.sample = v;
    }
    this.places = map;
  },

  // ------------------------------------------------------------------ 日ごと
  buildDays() {
    const days = new Map();
    const get = k => {
      let d = days.get(k);
      if (!d) days.set(k, d = { key: k, visits: [], acts: [], p0: -1, p1: -1, dist: 0, maxAway: 0, trip: null });
      return d;
    };
    for (const v of this.visits) {
      get(v.day).visits.push(v);
      // 何日もまたがる滞在（旅先のホテルなど）は、その間の日にも入れる
      const lastDay = this.dayOf(Math.max(v.s, v.e - 60000), v.off);
      if (lastDay !== v.day) {
        let k = v.day;
        for (let i = 0; i < 30 && k < lastDay; i++) {
          k = new Date(Date.parse(k) + DAY).toISOString().slice(0, 10);
          get(k).visits.push(v);
        }
      }
    }
    for (const a of this.acts) { const d = get(a.day); d.acts.push(a); d.dist += a.dist; }
    const { t, lat, lng, n } = this.pt;
    let cur = null, prevI = -1;
    for (let i = 0; i < n; i++) {
      const k = this.dayOf(t[i]);
      if (!cur || cur.key !== k) { cur = get(k); if (cur.p0 < 0) cur.p0 = i; prevI = -1; }
      cur.p1 = i;
      if (!cur.acts.length && prevI >= 0) cur.ptDist = (cur.ptDist || 0) + distM(lat[prevI], lng[prevI], lat[i], lng[i]);
      prevI = i;
    }
    for (const d of days.values()) {
      if (!d.acts.length && d.ptDist) d.dist = d.ptDist;
      d.visits.sort((a, b) => a.s - b.s);
      d.acts.sort((a, b) => a.s - b.s);
    }
    this.days = days;
    this.dayKeys = [...days.keys()].sort();
  },

  /** その日の軌跡の点の番号の範囲 */
  dayPoints(d) {
    if (!d || d.p0 < 0) return [];
    const out = [];
    for (let i = d.p0; i <= d.p1; i++) out.push(i);
    return out;
  },

  // ------------------------------------------------------------------ 自宅
  buildHomes() {
    this.homeByMonth = new Map();
    const s = this.user.settings || {};
    if (s.home) { this.globalHome = s.home; return; }
    const fh = this.fav.find(f => /HOME/i.test(f.label));
    if (fh) { this.globalHome = { lat: fh.lat, lng: fh.lng }; }
    else this.globalHome = null;

    // 月ごとに「夜（2〜5時）にいちばん長くいた場所」を自宅とみなす（引っ越しにも対応）
    const byMonth = new Map();
    const total = new Map();
    for (const v of this.visits) {
      const night = this.nightOverlap(v);
      if (night <= 0) continue;
      const m = v.day.slice(0, 7);
      let mm = byMonth.get(m);
      if (!mm) byMonth.set(m, mm = new Map());
      const rec = mm.get(v.key) || { ms: 0, lat: v.lat, lng: v.lng };
      rec.ms += night;
      mm.set(v.key, rec);
      const tr = total.get(v.key) || { ms: 0, lat: v.lat, lng: v.lng };
      tr.ms += night;
      total.set(v.key, tr);
    }
    for (const [m, mm] of byMonth) {
      let best = null;
      for (const r of mm.values()) if (!best || r.ms > best.ms) best = r;
      // 旅行ばかりの月を避けるため、その月に7晩以上いた場所だけ採用
      if (best && best.ms >= 7 * 3 * 3600000) this.homeByMonth.set(m, { lat: best.lat, lng: best.lng });
    }
    if (!this.globalHome) {
      let best = null;
      for (const r of total.values()) if (!best || r.ms > best.ms) best = r;
      if (best) this.globalHome = { lat: best.lat, lng: best.lng };
    }
  },

  nightOverlap(v) {
    // 現地時刻で 2:00〜5:00 に重なる時間（ミリ秒）
    let sum = 0;
    const off = this.offsetAt(v.s, v.off) * 60000;
    const s = v.s + off, e = v.e + off;
    let day = Math.floor(s / DAY) * DAY;
    for (let i = 0; day < e && i < 60; i++, day += DAY) {
      const a = Math.max(s, day + 2 * 3600000), b = Math.min(e, day + 5 * 3600000);
      if (b > a) sum += b - a;
    }
    return sum;
  },

  homeFor(dayKey) {
    if (this.user.settings && this.user.settings.home) return this.user.settings.home;
    const m = dayKey.slice(0, 7);
    if (this.homeByMonth.has(m)) return this.homeByMonth.get(m);
    // 近い月の自宅を使う
    let best = null, bestGap = Infinity;
    const mt = Date.parse(m + '-01');
    for (const [k, h] of this.homeByMonth) {
      const g = Math.abs(Date.parse(k + '-01') - mt);
      if (g < bestGap) { bestGap = g; best = h; }
    }
    return best || this.globalHome;
  },

  // ------------------------------------------------------------------ 旅
  buildTrips() {
    const th = ((this.user.settings && this.user.settings.tripKm) || 50) * 1000;
    const { lat, lng } = this.pt;
    for (const k of this.dayKeys) {
      const d = this.days.get(k);
      const h = this.homeFor(k);
      d.maxAway = 0;
      d.far = [];
      if (!h) continue;
      for (const v of d.visits) {
        const dd = distM(h.lat, h.lng, v.lat, v.lng);
        if (dd > d.maxAway) d.maxAway = dd;
      }
      if (d.p0 >= 0) {
        const step = Math.max(1, Math.floor((d.p1 - d.p0) / 400));
        for (let i = d.p0; i <= d.p1; i += step) {
          const dd = distM(h.lat, h.lng, lat[i], lng[i]);
          if (dd > d.maxAway) d.maxAway = dd;
        }
      }
      for (const a of d.acts) {
        const dd = Math.max(distM(h.lat, h.lng, a.slat, a.slng), distM(h.lat, h.lng, a.elat, a.elng));
        if (dd > d.maxAway) d.maxAway = dd;
      }
      d.trip = null;
    }

    // 遠出した日が続く期間を1つの旅にまとめる（記録がない日を1日だけ挟むのは許す）
    const trips = [];
    let cur = null;
    let prevKey = null;
    for (const k of this.dayKeys) {
      const d = this.days.get(k);
      const away = d.maxAway >= th;
      if (away) {
        const gap = prevKey ? Math.round((Date.parse(k) - Date.parse(prevKey)) / DAY) : 99;
        if (cur && gap <= 2) cur.days.push(k);
        else { cur = { days: [k] }; trips.push(cur); }
        prevKey = k;
      } else {
        cur = null;
        prevKey = null;
      }
    }

    // 旅の情報を作る
    this.trips = trips.map(t => this.describeTrip(t, th)).filter(t => t);
    for (const t of this.trips) for (const k of t.days) { const d = this.days.get(k); if (d) d.trip = t; }
    this.trips.sort((a, b) => b.start.localeCompare(a.start));
  },

  describeTrip(t, th) {
    const id = t.days[0];
    const start = t.days[0], end = t.days[t.days.length - 1];
    const nDays = Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
    // 地域ごとの滞在時間（遠方の場所だけ）
    const regionMs = new Map(), prefSet = new Set(), countrySet = new Set();
    let dist = 0, visitsN = 0;
    const seenVisit = new Set();
    for (const k of t.days) {
      const d = this.days.get(k);
      if (!d) continue;
      dist += d.dist;
      const h = this.homeFor(k);
      for (const v of d.visits) {
        if (seenVisit.has(v)) continue;
        seenVisit.add(v);
        if (h && distM(h.lat, h.lng, v.lat, v.lng) < th * 0.6) continue;
        visitsN++;
        const g = this.regionOf(v.lat, v.lng);
        const name = g.country && g.country !== '日本' ? g.country : (g.short || g.pref);
        if (!name) continue;
        const ms = Math.max(5 * 60000, Math.min(v.e - v.s, 12 * 3600000));
        regionMs.set(name, (regionMs.get(name) || 0) + ms);
        if (g.pref) prefSet.add(g.pref);
        if (g.country) countrySet.add(g.country);
      }
    }
    let regions = [...regionMs.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
    // 海外旅行なら、空港など国内の立ち寄り先は名前に使わない
    const foreign = [...countrySet].filter(c => c && c !== '日本');
    if (foreign.length) regions = [...foreign, ...regions.filter(r => !foreign.includes(r))];
    const u = this.user.trips[id] || {};
    const titleParts = foreign.length ? foreign.slice(0, 3) : regions.slice(0, 2);
    const more = foreign.length ? foreign.length > 3 : regions.length > 2;
    const autoTitle = titleParts.length ? titleParts.join('・') + (more ? 'ほか' : '') : '遠出';
    return {
      id, start, end, days: t.days, nDays,
      nights: nDays - 1,
      regions, prefs: [...prefSet], countries: [...countrySet],
      dist, visitsN,
      autoTitle,
      title: u.title || autoTitle,
      memo: u.memo || '',
      hidden: !!u.hidden,
      abroad: [...countrySet].some(c => c && c !== '日本'),
    };
  },

  visibleTrips() { return this.trips.filter(t => !t.hidden); },

  // ------------------------------------------------------------------ 集計
  stats() {
    const prefFirst = new Map(), muniSet = new Map(), countryFirst = new Map();
    for (const v of this.visits) {
      const g = this.regionOf(v.lat, v.lng);
      if (g.pref && !prefFirst.has(g.pref)) prefFirst.set(g.pref, v.day);
      if (g.code && !muniSet.has(g.code)) muniSet.set(g.code, { name: g.name, pref: g.pref, day: v.day });
      if (g.country && !countryFirst.has(g.country)) countryFirst.set(g.country, v.day);
    }
    // 移動中に通過しただけの都道府県も「通過」として数える
    const passPref = new Set();
    const { lat, lng, n } = this.pt;
    const step = Math.max(1, Math.floor(n / 60000));
    for (let i = 0; i < n; i += step) {
      const g = this.regionOf(lat[i], lng[i]);
      if (g.pref && !prefFirst.has(g.pref)) passPref.add(g.pref);
      if (g.country && !countryFirst.has(g.country)) countryFirst.set(g.country, this.dayOf(this.pt.t[i]));
    }
    const byYear = new Map();
    for (const k of this.dayKeys) {
      const y = k.slice(0, 4);
      const d = this.days.get(k);
      const r = byYear.get(y) || { days: 0, dist: 0, modes: {} };
      r.days++;
      r.dist += d.dist;
      for (const a of d.acts) r.modes[a.mode] = (r.modes[a.mode] || 0) + a.dist;
      byYear.set(y, r);
    }
    return { prefFirst, passPref, muniSet, countryFirst, byYear };
  },
};
