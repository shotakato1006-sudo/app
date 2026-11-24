package app.ashiato;

import android.util.JsonReader;
import android.util.JsonToken;
import android.util.JsonWriter;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Googleマップのタイムライン書き出しファイルを読み、アプリ内の共通形式に変換する。
 *
 * 対応形式:
 *  - Android 端末から書き出した Timeline.json（semanticSegments / rawSignals / userLocationProfile）
 *  - iPhone 版 Google マップから書き出した location-history.json（配列形式）
 *  - Google テイクアウトの Records.json（locations）
 *  - Google テイクアウトの「Semantic Location History」各月ファイル（timelineObjects）
 *  - 上記を含む ZIP（テイクアウトの ZIP をそのまま渡せる）
 *  - このアプリのバックアップファイル
 */
public class LocationImporter {

    public interface Progress {
        void onProgress(String message);
    }

    /** 1件の滞在 */
    public static class Visit {
        long s, e;            // 開始・終了（UNIX ミリ秒）
        Integer off;          // 現地の UTC からのずれ（分）。不明なら null
        double lat, lng;
        String pid = "", sem = "", name = "", addr = "";
    }

    /** 1件の移動 */
    public static class Act {
        long s, e;
        Integer off;
        String mode = "";
        double dist;          // メートル
        double slat, slng, elat, elng;
    }

    /** 軌跡の1点 */
    public static class Pt {
        long t; double lat, lng;
        Pt(long t, double lat, double lng) { this.t = t; this.lat = lat; this.lng = lng; }
    }

    public final List<Visit> visits = new ArrayList<>();
    public final List<Act> acts = new ArrayList<>();
    public final List<Pt> pts = new ArrayList<>();
    /** よく行く場所（自宅・職場）: [placeId, lat, lng, label] */
    public final List<Object[]> fav = new ArrayList<>();

    /** バックアップファイルを読んだ場合、名前やメモなどの利用者データが入る */
    public JSONObject backupUser;
    private boolean isBackup = false;

    public int filesRead = 0;
    private long count = 0;
    private final Progress progress;

    public LocationImporter(Progress progress) { this.progress = progress; }

    // ------------------------------------------------------------------ 入口

    public void read(InputStream raw, String displayName) throws IOException {
        BufferedInputStream in = new BufferedInputStream(raw, 1 << 16);
        in.mark(4);
        int b0 = in.read(), b1 = in.read();
        in.reset();
        if (b0 == 'P' && b1 == 'K') {
            readZip(in);
        } else {
            readJson(in, displayName);
        }
    }

    private void readZip(InputStream in) throws IOException {
        ZipInputStream zip = new ZipInputStream(in);
        ZipEntry entry;
        while ((entry = zip.getNextEntry()) != null) {
            if (entry.isDirectory()) continue;
            String name = entry.getName();
            String lower = name.toLowerCase(Locale.ROOT);
            if (!lower.endsWith(".json")) continue;
            // テイクアウトには位置と無関係な JSON（設定など）も入っているので、中身で判定する
            InputStream nonClosing = new FilterInputStream(zip) {
                @Override public void close() { /* ZIP 全体は閉じない */ }
            };
            try {
                readJson(nonClosing, name);
            } catch (Exception ex) {
                // 1ファイル壊れていても他は続ける
            }
            zip.closeEntry();
        }
    }

    private void readJson(InputStream in, String name) throws IOException {
        JsonReader r = new JsonReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        r.setLenient(true);
        JsonToken tok = r.peek();
        if (tok == JsonToken.BEGIN_ARRAY) {
            // iPhone 形式: セグメントの配列
            r.beginArray();
            while (r.hasNext()) {
                Object o = readValue(r);
                if (o instanceof JSONObject) handleIosSegment((JSONObject) o);
                tick();
            }
            r.endArray();
            filesRead++;
        } else if (tok == JsonToken.BEGIN_OBJECT) {
            boolean any = false;
            r.beginObject();
            while (r.hasNext()) {
                String key = r.nextName();
                switch (key) {
                    case "semanticSegments":
                        any = true;
                        eachInArray(r, this::handleSemanticSegment);
                        break;
                    case "rawSignals":
                        any = true;
                        eachInArray(r, this::handleRawSignal);
                        break;
                    case "userLocationProfile": {
                        any = true;
                        Object o = readValue(r);
                        if (o instanceof JSONObject) handleProfile((JSONObject) o);
                        break;
                    }
                    case "locations":
                        any = true;
                        eachInArray(r, this::handleRecord);
                        break;
                    case "timelineObjects":
                        any = true;
                        eachInArray(r, this::handleTimelineObject);
                        break;
                    case "ashiatoBackup":
                        any = true;
                        isBackup = true;
                        r.skipValue();
                        break;
                    case "visits":
                    case "acts":
                    case "pts":
                    case "fav":
                        // バックアップファイル（このアプリの形式）
                        if (isBackup) readOwnKey(r, key); else r.skipValue();
                        break;
                    case "user": {
                        Object o = readValue(r);
                        if (o instanceof JSONObject) backupUser = (JSONObject) o;
                        break;
                    }
                    default:
                        r.skipValue();
                }
            }
            r.endObject();
            if (any) filesRead++;
        } else {
            r.skipValue();
        }
    }

    private interface ObjHandler { void handle(JSONObject o); }

    private void eachInArray(JsonReader r, ObjHandler h) throws IOException {
        if (r.peek() != JsonToken.BEGIN_ARRAY) { r.skipValue(); return; }
        r.beginArray();
        while (r.hasNext()) {
            Object o = readValue(r);
            if (o instanceof JSONObject) {
                try { h.handle((JSONObject) o); } catch (Exception ignore) { }
            }
            tick();
        }
        r.endArray();
    }

    private void tick() {
        count++;
        if (count % 5000 == 0 && progress != null) {
            progress.onProgress(String.format(Locale.JAPAN, "読み込み中… %,d件", count));
        }
    }

    /** JsonReader から1つの値を org.json の木として読む */
    static Object readValue(JsonReader r) throws IOException {
        switch (r.peek()) {
            case BEGIN_OBJECT: {
                JSONObject o = new JSONObject();
                r.beginObject();
                while (r.hasNext()) {
                    String k = r.nextName();
                    try { o.put(k, readValue(r)); } catch (JSONException ignore) { }
                }
                r.endObject();
                return o;
            }
            case BEGIN_ARRAY: {
                JSONArray a = new JSONArray();
                r.beginArray();
                while (r.hasNext()) a.put(readValue(r));
                r.endArray();
                return a;
            }
            case STRING: return r.nextString();
            case NUMBER: {
                String s = r.nextString();
                try { return Double.parseDouble(s); } catch (NumberFormatException e) { return s; }
            }
            case BOOLEAN: return r.nextBoolean();
            case NULL: r.nextNull(); return JSONObject.NULL;
            default: r.skipValue(); return JSONObject.NULL;
        }
    }

    // ------------------------------------------------------------ 新しい Android 形式

    private void handleSemanticSegment(JSONObject seg) {
        long s = parseTime(seg.optString("startTime"));
        long e = parseTime(seg.optString("endTime"));
        Integer off = seg.has("startTimeTimezoneUtcOffsetMinutes")
                ? (int) seg.optDouble("startTimeTimezoneUtcOffsetMinutes")
                : parseOffset(seg.optString("startTime"));

        JSONObject visit = seg.optJSONObject("visit");
        if (visit != null && s > 0) {
            JSONObject top = visit.optJSONObject("topCandidate");
            if (top != null) {
                double[] ll = null;
                Object loc = top.opt("placeLocation");
                if (loc instanceof JSONObject) ll = parseLatLng(((JSONObject) loc).optString("latLng"));
                else if (loc instanceof String) ll = parseLatLng((String) loc);
                if (ll != null) {
                    Visit v = new Visit();
                    v.s = s; v.e = e > 0 ? e : s; v.off = off;
                    v.lat = ll[0]; v.lng = ll[1];
                    v.pid = top.optString("placeId", "");
                    v.sem = top.optString("semanticType", "");
                    visits.add(v);
                }
            }
        }

        JSONObject act = seg.optJSONObject("activity");
        if (act != null && s > 0) {
            Act a = new Act();
            a.s = s; a.e = e > 0 ? e : s; a.off = off;
            double[] st = parseLatLng(optLatLng(act.opt("start")));
            double[] en = parseLatLng(optLatLng(act.opt("end")));
            if (st != null) { a.slat = st[0]; a.slng = st[1]; }
            if (en != null) { a.elat = en[0]; a.elng = en[1]; }
            a.dist = act.optDouble("distanceMeters", 0);
            JSONObject top = act.optJSONObject("topCandidate");
            if (top != null) a.mode = normMode(top.optString("type"));
            if (st != null && en != null) acts.add(a);
        }

        JSONArray path = seg.optJSONArray("timelinePath");
        if (path != null) {
            for (int i = 0; i < path.length(); i++) {
                JSONObject p = path.optJSONObject(i);
                if (p == null) continue;
                double[] ll = parseLatLng(p.optString("point"));
                long t = parseTime(p.optString("time"));
                if (ll != null && t > 0) pts.add(new Pt(t, ll[0], ll[1]));
            }
        }
    }

    private static String optLatLng(Object o) {
        if (o instanceof JSONObject) return ((JSONObject) o).optString("latLng");
        if (o instanceof String) return (String) o;
        return null;
    }

    private void handleRawSignal(JSONObject sig) {
        JSONObject pos = sig.optJSONObject("position");
        if (pos == null) return;
        double acc = pos.optDouble("accuracyMeters", 0);
        if (acc > 200) return;
        double[] ll = parseLatLng(pos.optString("LatLng", pos.optString("latLng")));
        long t = parseTime(pos.optString("timestamp"));
        if (ll != null && t > 0) pts.add(new Pt(t, ll[0], ll[1]));
    }

    private void handleProfile(JSONObject prof) {
        JSONArray fp = prof.optJSONArray("frequentPlaces");
        if (fp == null) return;
        for (int i = 0; i < fp.length(); i++) {
            JSONObject p = fp.optJSONObject(i);
            if (p == null) continue;
            double[] ll = parseLatLng(p.optString("placeLocation"));
            if (ll == null) continue;
            fav.add(new Object[]{p.optString("placeId", ""), ll[0], ll[1], p.optString("label", "")});
        }
    }

    // ------------------------------------------------------------ iPhone 形式

    private void handleIosSegment(JSONObject seg) {
        long s = parseTime(seg.optString("startTime"));
        long e = parseTime(seg.optString("endTime"));
        Integer off = parseOffset(seg.optString("startTime"));
        if (s <= 0) return;

        JSONObject visit = seg.optJSONObject("visit");
        if (visit != null) {
            JSONObject top = visit.optJSONObject("topCandidate");
            if (top != null) {
                double[] ll = parseLatLng(top.optString("placeLocation"));
                if (ll != null) {
                    Visit v = new Visit();
                    v.s = s; v.e = e > 0 ? e : s; v.off = off;
                    v.lat = ll[0]; v.lng = ll[1];
                    v.pid = top.optString("placeID", top.optString("placeId", ""));
                    v.sem = top.optString("semanticType", "");
                    visits.add(v);
                }
            }
        }
        JSONObject act = seg.optJSONObject("activity");
        if (act != null) {
            double[] st = parseLatLng(act.optString("start"));
            double[] en = parseLatLng(act.optString("end"));
            if (st != null && en != null) {
                Act a = new Act();
                a.s = s; a.e = e > 0 ? e : s; a.off = off;
                a.slat = st[0]; a.slng = st[1]; a.elat = en[0]; a.elng = en[1];
                a.dist = parseNum(act.opt("distanceMeters"));
                JSONObject top = act.optJSONObject("topCandidate");
                if (top != null) a.mode = normMode(top.optString("type"));
                acts.add(a);
            }
        }
        JSONArray path = seg.optJSONArray("timelinePath");
        if (path != null) {
            for (int i = 0; i < path.length(); i++) {
                JSONObject p = path.optJSONObject(i);
                if (p == null) continue;
                double[] ll = parseLatLng(p.optString("point"));
                double mins = parseNum(p.opt("durationMinutesOffsetFromStartTime"));
                if (ll != null) pts.add(new Pt(s + (long) (mins * 60000), ll[0], ll[1]));
            }
        }
    }

    // ------------------------------------------------------------ テイクアウト Records.json

    private void handleRecord(JSONObject loc) {
        if (!loc.has("latitudeE7")) return;
        double acc = loc.optDouble("accuracy", 0);
        if (acc > 200) return;
        double lat = loc.optDouble("latitudeE7") / 1e7;
        double lng = loc.optDouble("longitudeE7") / 1e7;
        long t = loc.has("timestamp") ? parseTime(loc.optString("timestamp"))
                : (long) parseNum(loc.opt("timestampMs"));
        if (t > 0 && validLatLng(lat, lng)) pts.add(new Pt(t, lat, lng));
    }

    // ------------------------------------------------------------ テイクアウト Semantic Location History

    private void handleTimelineObject(JSONObject obj) {
        JSONObject pv = obj.optJSONObject("placeVisit");
        if (pv != null) {
            JSONObject loc = pv.optJSONObject("location");
            JSONObject dur = pv.optJSONObject("duration");
            if (loc != null && dur != null) {
                double lat = loc.optDouble("latitudeE7", Double.NaN) / 1e7;
                double lng = loc.optDouble("longitudeE7", Double.NaN) / 1e7;
                if (Double.isNaN(lat)) {
                    lat = pv.optDouble("centerLatE7", Double.NaN) / 1e7;
                    lng = pv.optDouble("centerLngE7", Double.NaN) / 1e7;
                }
                long s = durTime(dur, "start"), e = durTime(dur, "end");
                if (s > 0 && validLatLng(lat, lng)) {
                    Visit v = new Visit();
                    v.s = s; v.e = e > 0 ? e : s;
                    v.off = parseOffset(dur.optString("startTimestamp"));
                    v.lat = lat; v.lng = lng;
                    v.pid = loc.optString("placeId", "");
                    v.sem = loc.optString("semanticType", "");
                    v.name = loc.optString("name", "");
                    v.addr = loc.optString("address", "");
                    visits.add(v);
                }
            }
        }
        JSONObject as = obj.optJSONObject("activitySegment");
        if (as != null) {
            JSONObject dur = as.optJSONObject("duration");
            JSONObject sl = as.optJSONObject("startLocation");
            JSONObject el = as.optJSONObject("endLocation");
            if (dur != null && sl != null && el != null) {
                long s = durTime(dur, "start"), e = durTime(dur, "end");
                Act a = new Act();
                a.s = s; a.e = e > 0 ? e : s;
                a.off = parseOffset(dur.optString("startTimestamp"));
                a.slat = sl.optDouble("latitudeE7") / 1e7; a.slng = sl.optDouble("longitudeE7") / 1e7;
                a.elat = el.optDouble("latitudeE7") / 1e7; a.elng = el.optDouble("longitudeE7") / 1e7;
                a.dist = as.optDouble("distance", as.optDouble("waypointPath_distanceMeters", 0));
                a.mode = normMode(as.optString("activityType"));
                if (s > 0) acts.add(a);

                JSONObject raw = as.optJSONObject("simplifiedRawPath");
                JSONArray rp = raw != null ? raw.optJSONArray("points") : null;
                boolean hadRaw = false;
                if (rp != null) {
                    for (int i = 0; i < rp.length(); i++) {
                        JSONObject p = rp.optJSONObject(i);
                        if (p == null) continue;
                        long t = p.has("timestamp") ? parseTime(p.optString("timestamp"))
                                : (long) parseNum(p.opt("timestampMs"));
                        double lat = p.optDouble("latE7") / 1e7, lng = p.optDouble("lngE7") / 1e7;
                        if (t > 0 && validLatLng(lat, lng)) { pts.add(new Pt(t, lat, lng)); hadRaw = true; }
                    }
                }
                JSONObject wp = as.optJSONObject("waypointPath");
                JSONArray ws = wp != null ? wp.optJSONArray("waypoints") : null;
                if (!hadRaw && ws != null && ws.length() > 0 && s > 0 && e > s) {
                    // 経由点には時刻がないので、開始〜終了の間に均等に割り振る
                    int n = ws.length();
                    for (int i = 0; i < n; i++) {
                        JSONObject p = ws.optJSONObject(i);
                        if (p == null) continue;
                        double lat = p.optDouble("latE7") / 1e7, lng = p.optDouble("lngE7") / 1e7;
                        long t = s + (e - s) * (i + 1) / (n + 1);
                        if (validLatLng(lat, lng)) pts.add(new Pt(t, lat, lng));
                    }
                }
            }
        }
    }

    private static long durTime(JSONObject dur, String which) {
        if (dur.has(which + "Timestamp")) return parseTime(dur.optString(which + "Timestamp"));
        if (dur.has(which + "TimestampMs")) return (long) parseNum(dur.opt(which + "TimestampMs"));
        return 0;
    }

    // ------------------------------------------------------------ 共通の小道具

    static boolean validLatLng(double lat, double lng) {
        return !Double.isNaN(lat) && !Double.isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
                && !(lat == 0 && lng == 0);
    }

    static double parseNum(Object o) {
        if (o instanceof Number) return ((Number) o).doubleValue();
        if (o instanceof String) {
            try { return Double.parseDouble((String) o); } catch (NumberFormatException e) { return 0; }
        }
        return 0;
    }

    /** "35.6812°, 139.7671°" / "geo:35.68,139.76" / "35.68, 139.76" */
    static double[] parseLatLng(String s) {
        if (s == null || s.isEmpty()) return null;
        String t = s.replace("geo:", "").replace("°", "").trim();
        int c = t.indexOf(',');
        if (c < 0) return null;
        try {
            double lat = Double.parseDouble(t.substring(0, c).trim());
            double lng = Double.parseDouble(t.substring(c + 1).trim());
            return validLatLng(lat, lng) ? new double[]{lat, lng} : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    static long parseTime(String s) {
        if (s == null || s.isEmpty()) return 0;
        try {
            return OffsetDateTime.parse(s).toInstant().toEpochMilli();
        } catch (DateTimeParseException e) {
            try { return (long) Double.parseDouble(s); } catch (NumberFormatException e2) { return 0; }
        }
    }

    /** 時刻文字列に書かれた UTC との時差（分）。"Z" は書き出し側が UTC に揃えただけなので不明扱い */
    static Integer parseOffset(String s) {
        if (s == null || s.isEmpty() || s.endsWith("Z")) return null;
        try {
            return OffsetDateTime.parse(s).getOffset().getTotalSeconds() / 60;
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    static String normMode(String m) {
        if (m == null) return "";
        return m.trim().toUpperCase(Locale.ROOT).replace(' ', '_');
    }

    // ------------------------------------------------------------ 既存データとの統合・保存形式

    /** 保存済みデータ（このアプリの形式）を読み込んで、今回分に足す */
    public void loadExisting(InputStream in) throws IOException {
        JsonReader r = new JsonReader(new InputStreamReader(new BufferedInputStream(in, 1 << 16), StandardCharsets.UTF_8));
        List<Object[]> newFav = new ArrayList<>(fav);
        fav.clear();
        r.beginObject();
        while (r.hasNext()) {
            if (!readOwnKey(r, r.nextName())) r.skipValue();
        }
        r.endObject();
        // 保存済みのプロフィールを前に置き、今回読んだものを後勝ちにする
        fav.addAll(newFav);
    }

    /** このアプリの保存形式のキーなら読み込んで true を返す */
    private boolean readOwnKey(JsonReader r, String key) throws IOException {
            switch (key) {
                case "visits":
                    r.beginArray();
                    while (r.hasNext()) {
                        r.beginArray();
                        Visit v = new Visit();
                        v.s = r.nextLong(); v.e = r.nextLong();
                        v.off = nextIntOrNull(r);
                        v.lat = r.nextDouble(); v.lng = r.nextDouble();
                        v.pid = r.nextString(); v.sem = r.nextString();
                        v.name = r.nextString(); v.addr = r.nextString();
                        while (r.hasNext()) r.skipValue();
                        r.endArray();
                        visits.add(v);
                    }
                    r.endArray();
                    break;
                case "acts":
                    r.beginArray();
                    while (r.hasNext()) {
                        r.beginArray();
                        Act a = new Act();
                        a.s = r.nextLong(); a.e = r.nextLong();
                        a.off = nextIntOrNull(r);
                        a.mode = r.nextString(); a.dist = r.nextDouble();
                        a.slat = r.nextDouble(); a.slng = r.nextDouble();
                        a.elat = r.nextDouble(); a.elng = r.nextDouble();
                        while (r.hasNext()) r.skipValue();
                        r.endArray();
                        acts.add(a);
                    }
                    r.endArray();
                    break;
                case "pts": {
                    r.beginArray();
                    long t = 0, la = 0, lo = 0;
                    while (r.hasNext()) {
                        t += r.nextLong(); la += r.nextLong(); lo += r.nextLong();
                        pts.add(new Pt(t * 1000L, la / 1e5, lo / 1e5));
                    }
                    r.endArray();
                    break;
                }
                case "fav":
                    r.beginArray();
                    while (r.hasNext()) {
                        r.beginArray();
                        fav.add(new Object[]{r.nextString(), r.nextDouble(), r.nextDouble(), r.nextString()});
                        while (r.hasNext()) r.skipValue();
                        r.endArray();
                    }
                    r.endArray();
                    break;
                default:
                    return false;
            }
            return true;
    }

    private static Integer nextIntOrNull(JsonReader r) throws IOException {
        if (r.peek() == JsonToken.NULL) { r.nextNull(); return null; }
        return r.nextInt();
    }

    /**
     * 読み込んだ全データ（既存分を含む）を重複なく整理して書き出す。
     * 同じ期間を二度読み込んでも重複しない。戻り値は件数。
     */
    public int[] writeMerged(Writer writer) throws IOException {
        // --- 滞在: 開始時刻順に並べ、ほぼ同時刻・同じ場所なら1つにまとめる
        Collections.sort(visits, (a, b) -> Long.compare(a.s, b.s));
        List<Visit> outV = new ArrayList<>();
        for (Visit v : visits) {
            Visit last = outV.isEmpty() ? null : outV.get(outV.size() - 1);
            if (last != null && Math.abs(v.s - last.s) < 5 * 60000 && dist(v.lat, v.lng, last.lat, last.lng) < 500) {
                if (last.name.isEmpty()) last.name = v.name;
                if (last.addr.isEmpty()) last.addr = v.addr;
                if (last.pid.isEmpty()) last.pid = v.pid;
                if (last.off == null) last.off = v.off;
                last.e = Math.max(last.e, v.e);
                continue;
            }
            outV.add(v);
        }

        // --- 移動
        Collections.sort(acts, (a, b) -> Long.compare(a.s, b.s));
        List<Act> outA = new ArrayList<>();
        for (Act a : acts) {
            Act last = outA.isEmpty() ? null : outA.get(outA.size() - 1);
            if (last != null && Math.abs(a.s - last.s) < 2 * 60000) {
                if (last.mode.isEmpty() || last.mode.startsWith("UNKNOWN")) last.mode = a.mode;
                if (last.off == null) last.off = a.off;
                continue;
            }
            outA.add(a);
        }

        // --- 軌跡: 時刻順に並べて間引く（同じ場所に留まっている点や、数秒おきの点を減らす）
        Collections.sort(pts, (a, b) -> Long.compare(a.t, b.t));
        int nP = 0;
        Pt kept = null;
        for (int i = 0; i < pts.size(); i++) {
            Pt p = pts.get(i);
            boolean keep;
            if (kept == null) keep = true;
            else {
                long dt = p.t - kept.t;
                double d = dist(p.lat, p.lng, kept.lat, kept.lng);
                keep = dt >= 1000 && ((d >= 40 && dt >= 10000) || dt >= 30 * 60000);
            }
            if (keep) { pts.set(nP++, p); kept = p; }
        }

        // --- よく行く場所: placeId とラベルの組ごとに最新を残す
        List<Object[]> outF = new ArrayList<>();
        for (int i = fav.size() - 1; i >= 0; i--) {
            Object[] f = fav.get(i);
            boolean dup = false;
            for (Object[] g : outF) {
                if (String.valueOf(g[0]).equals(String.valueOf(f[0])) && String.valueOf(g[3]).equals(String.valueOf(f[3]))) { dup = true; break; }
            }
            if (!dup) outF.add(f);
        }
        Collections.reverse(outF);

        JsonWriter w = new JsonWriter(writer);
        w.beginObject();
        w.name("v").value(1);
        w.name("visits").beginArray();
        for (Visit v : outV) {
            w.beginArray();
            w.value(v.s).value(v.e);
            if (v.off == null) w.nullValue(); else w.value(v.off);
            w.value(round5(v.lat)).value(round5(v.lng))
                    .value(v.pid).value(v.sem).value(v.name).value(v.addr);
            w.endArray();
        }
        w.endArray();
        w.name("acts").beginArray();
        for (Act a : outA) {
            w.beginArray();
            w.value(a.s).value(a.e);
            if (a.off == null) w.nullValue(); else w.value(a.off);
            w.value(a.mode).value(Math.round(a.dist))
                    .value(round5(a.slat)).value(round5(a.slng)).value(round5(a.elat)).value(round5(a.elng));
            w.endArray();
        }
        w.endArray();
        // 軌跡は [秒の差, 緯度×1e5 の差, 経度×1e5 の差] を並べた差分形式で小さくする
        w.name("pts").beginArray();
        long pt = 0, pla = 0, plo = 0;
        for (int i = 0; i < nP; i++) {
            Pt p = pts.get(i);
            long t = p.t / 1000, la = Math.round(p.lat * 1e5), lo = Math.round(p.lng * 1e5);
            w.value(t - pt).value(la - pla).value(lo - plo);
            pt = t; pla = la; plo = lo;
        }
        w.endArray();
        w.name("fav").beginArray();
        for (Object[] f : outF) {
            w.beginArray().value(String.valueOf(f[0])).value((Double) f[1]).value((Double) f[2]).value(String.valueOf(f[3])).endArray();
        }
        w.endArray();
        w.endObject();
        w.flush();
        return new int[]{outV.size(), outA.size(), nP};
    }

    public long newItems() { return visits.size() + acts.size() + pts.size(); }

    static double round5(double d) { return Math.round(d * 1e5) / 1e5; }

    static double dist(double lat1, double lng1, double lat2, double lng2) {
        double r = 6371000, p = Math.PI / 180;
        double dLat = (lat2 - lat1) * p, dLng = (lng2 - lng1) * p;
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
    }
}
