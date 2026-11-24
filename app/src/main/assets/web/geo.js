// 緯度経度 → 市区町村・都道府県・国 を、端末内の境界データだけで調べる（ネット不要）
'use strict';

const Geo = (() => {
  let muni = null;     // {feats:[{name,city,pref,code,bbox,polys}], grid:Map}
  let world = null;    // {feats:[{name,bbox,polys}], grid:Map}
  let prefGeo = null;  // GeoJSON（都道府県、地図表示用）
  let worldGeo = null; // GeoJSON（国、地図表示用）
  const cache = new Map();

  // 国名（よく行く国だけ日本語にする。それ以外は英語のまま）
  const JA = {
    'Japan': '日本', 'South Korea': '韓国', 'Korea': '韓国', 'China': '中国', 'Taiwan': '台湾',
    'Hong Kong': '香港', 'Macao': 'マカオ', 'Thailand': 'タイ', 'Vietnam': 'ベトナム', 'Singapore': 'シンガポール',
    'Malaysia': 'マレーシア', 'Indonesia': 'インドネシア', 'Philippines': 'フィリピン', 'Cambodia': 'カンボジア',
    'Laos': 'ラオス', 'Myanmar': 'ミャンマー', 'India': 'インド', 'Nepal': 'ネパール', 'Sri Lanka': 'スリランカ',
    'Maldives': 'モルディブ', 'Mongolia': 'モンゴル', 'United States of America': 'アメリカ', 'Canada': 'カナダ',
    'Mexico': 'メキシコ', 'Brazil': 'ブラジル', 'Argentina': 'アルゼンチン', 'Peru': 'ペルー', 'Chile': 'チリ',
    'United Kingdom': 'イギリス', 'Ireland': 'アイルランド', 'France': 'フランス', 'Germany': 'ドイツ', 'Italy': 'イタリア',
    'Spain': 'スペイン', 'Portugal': 'ポルトガル', 'Netherlands': 'オランダ', 'Belgium': 'ベルギー', 'Switzerland': 'スイス',
    'Austria': 'オーストリア', 'Czechia': 'チェコ', 'Poland': 'ポーランド', 'Hungary': 'ハンガリー', 'Greece': 'ギリシャ',
    'Turkey': 'トルコ', 'Denmark': 'デンマーク', 'Norway': 'ノルウェー', 'Sweden': 'スウェーデン', 'Finland': 'フィンランド',
    'Iceland': 'アイスランド', 'Croatia': 'クロアチア', 'Russia': 'ロシア', 'Egypt': 'エジプト', 'Morocco': 'モロッコ',
    'South Africa': '南アフリカ', 'Kenya': 'ケニア', 'United Arab Emirates': 'アラブ首長国連邦', 'Qatar': 'カタール',
    'Israel': 'イスラエル', 'Jordan': 'ヨルダン', 'Australia': 'オーストラリア', 'New Zealand': 'ニュージーランド',
    'Fiji': 'フィジー', 'Guam': 'グアム', 'N. Mariana Is.': '北マリアナ諸島', 'Palau': 'パラオ', 'Fr. Polynesia': 'フランス領ポリネシア',
    'New Caledonia': 'ニューカレドニア', 'Cuba': 'キューバ', 'Uzbekistan': 'ウズベキスタン', 'Kazakhstan': 'カザフスタン',
    'Bhutan': 'ブータン', 'Brunei': 'ブルネイ', 'Luxembourg': 'ルクセンブルク', 'Monaco': 'モナコ', 'Vatican': 'バチカン',
    'Estonia': 'エストニア', 'Latvia': 'ラトビア', 'Lithuania': 'リトアニア', 'Slovenia': 'スロベニア', 'Slovakia': 'スロバキア',
    'Romania': 'ルーマニア', 'Bulgaria': 'ブルガリア', 'Serbia': 'セルビア', 'Malta': 'マルタ', 'Cyprus': 'キプロス',
    'Puerto Rico': 'プエルトリコ', 'Jamaica': 'ジャマイカ', 'Colombia': 'コロンビア', 'Bolivia': 'ボリビア', 'Ecuador': 'エクアドル',
    'Tanzania': 'タンザニア', 'Saudi Arabia': 'サウジアラビア', 'Oman': 'オマーン', 'Pakistan': 'パキスタン', 'Bangladesh': 'バングラデシュ',
  };

  function bboxOf(polys) {
    let a = 180, b = 90, c = -180, d = -90;
    for (const poly of polys) for (const p of poly[0]) {
      if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0];
      if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1];
    }
    return [a, b, c, d];
  }

  function polysOf(geom) {
    if (!geom) return [];
    if (geom.type === 'Polygon') return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
  }

  function buildIndex(feats, cell) {
    const grid = new Map();
    feats.forEach((f, i) => {
      const [a, b, c, d] = f.bbox;
      for (let x = Math.floor(a / cell); x <= Math.floor(c / cell); x++)
        for (let y = Math.floor(b / cell); y <= Math.floor(d / cell); y++) {
          const k = x + ':' + y;
          let arr = grid.get(k);
          if (!arr) grid.set(k, arr = []);
          arr.push(i);
        }
    });
    return grid;
  }

  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function inPolys(x, y, polys) {
    for (const poly of polys) {
      if (!inRing(x, y, poly[0])) continue;
      let hole = false;
      for (let h = 1; h < poly.length; h++) if (inRing(x, y, poly[h])) { hole = true; break; }
      if (!hole) return true;
    }
    return false;
  }

  function find(idx, lng, lat, cell, nearKm) {
    const k = Math.floor(lng / cell) + ':' + Math.floor(lat / cell);
    const cand = idx.grid.get(k) || [];
    for (const i of cand) {
      const f = idx.feats[i];
      const [a, b, c, d] = f.bbox;
      if (lng < a || lng > c || lat < b || lat > d) continue;
      if (inPolys(lng, lat, f.polys)) return f;
    }
    // 海岸沿いや港などで境界のわずかに外側になった場合は、近くの境界線を探す
    if (!nearKm) return null;
    const r = nearKm / 111;
    let best = null, bestD = Infinity;
    const seen = new Set();
    for (let x = Math.floor((lng - r) / cell); x <= Math.floor((lng + r) / cell); x++)
      for (let y = Math.floor((lat - r) / cell); y <= Math.floor((lat + r) / cell); y++) {
        for (const i of idx.grid.get(x + ':' + y) || []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const f = idx.feats[i];
          const [a, b, c, d] = f.bbox;
          if (lng < a - r || lng > c + r || lat < b - r || lat > d + r) continue;
          for (const poly of f.polys) for (const p of poly[0]) {
            const dx = (p[0] - lng) * Math.cos(lat * Math.PI / 180), dy = p[1] - lat;
            const dd = dx * dx + dy * dy;
            if (dd < bestD) { bestD = dd; best = f; }
          }
        }
      }
    return bestD <= r * r ? best : null;
  }

  async function load() {
    const [m, p, w] = await Promise.all([
      fetch('geo/muni.json').then(r => r.json()),
      fetch('geo/pref.json').then(r => r.json()),
      fetch('geo/world.json').then(r => r.json()),
    ]);
    const mg = topojson.feature(m, m.objects.muni);
    const mf = mg.features.map(f => {
      const polys = polysOf(f.geometry);
      return { ...f.properties, polys, bbox: bboxOf(polys) };
    }).filter(f => f.polys.length);
    muni = { feats: mf, grid: buildIndex(mf, 0.25) };
    prefGeo = topojson.feature(p, p.objects.pref);

    worldGeo = topojson.feature(w, w.objects.countries);
    const wf = worldGeo.features.map(f => {
      const polys = polysOf(f.geometry);
      const en = (f.properties && f.properties.name) || '';
      return { name: JA[en] || en, en, polys, bbox: bboxOf(polys) };
    }).filter(f => f.polys.length);
    world = { feats: wf, grid: buildIndex(wf, 5) };
  }

  /**
   * その地点の地名。
   * 日本: {country:'日本', pref:'京都府', city:'京都市', name:'京都市東山区', short:'京都市'}
   * 海外: {country:'台湾', pref:'', city:'', name:'台湾', short:'台湾'}
   */
  function lookup(lat, lng) {
    const key = lat.toFixed(3) + ',' + lng.toFixed(3);
    let r = cache.get(key);
    if (r !== undefined) return r;
    r = null;
    if (muni && lat > 20 && lat < 46.5 && lng > 122 && lng < 154.5) {
      const f = find(muni, lng, lat, 0.25, 3);
      if (f) r = { country: '日本', pref: f.pref, city: f.city, name: f.name, short: f.city || f.name, code: f.code };
    }
    if (!r && world) {
      const f = find(world, lng, lat, 5, 25);
      if (f) r = { country: f.name, pref: '', city: '', name: f.name, short: f.name, code: '' };
    }
    if (!r) r = { country: '', pref: '', city: '', name: '', short: '', code: '' };
    cache.set(key, r);
    return r;
  }

  return {
    load, lookup,
    get prefGeo() { return prefGeo; },
    get worldGeo() { return worldGeo; },
    get muniFeats() { return muni ? muni.feats : []; },
  };
})();
