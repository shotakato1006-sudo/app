#!/usr/bin/env python3
"""動作確認用の架空の位置履歴（Android の Timeline.json 形式）を作る。

東京在住の人が、ふだんは通勤し、ときどき旅行する想定。
    python3 tools/make_sample.py out/Timeline.json
"""
import json
import math
import random
import sys
from datetime import datetime, timedelta, timezone

random.seed(7)
JST = timezone(timedelta(hours=9))
TWN = timezone(timedelta(hours=8))

HOME = (35.6467, 139.6533)    # 世田谷区
WORK = (35.6812, 139.7671)    # 東京駅
CAFE = (35.6595, 139.7005)    # 渋谷

segments = []
raw = []


def ll(p):
    return f"{p[0]:.7f}°, {p[1]:.7f}°"


def iso(t):
    return t.isoformat(timespec="milliseconds")


def visit(a, b, p, pid, sem="UNKNOWN"):
    segments.append({
        "startTime": iso(a), "endTime": iso(b),
        "startTimeTimezoneUtcOffsetMinutes": int(a.utcoffset().total_seconds() // 60),
        "endTimeTimezoneUtcOffsetMinutes": int(b.utcoffset().total_seconds() // 60),
        "visit": {"hierarchyLevel": 0, "probability": 0.9,
                  "topCandidate": {"placeId": pid, "semanticType": sem, "probability": 0.8,
                                   "placeLocation": {"latLng": ll(p)}}},
    })


def dist(p, q):
    r = 6371000
    dl = math.radians(q[0] - p[0]); dn = math.radians(q[1] - p[1])
    a = math.sin(dl / 2) ** 2 + math.cos(math.radians(p[0])) * math.cos(math.radians(q[0])) * math.sin(dn / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def move(a, b, p, q, mode, path=True):
    segments.append({
        "startTime": iso(a), "endTime": iso(b),
        "startTimeTimezoneUtcOffsetMinutes": int(a.utcoffset().total_seconds() // 60),
        "endTimeTimezoneUtcOffsetMinutes": int(b.utcoffset().total_seconds() // 60),
        "activity": {"start": {"latLng": ll(p)}, "end": {"latLng": ll(q)},
                     "distanceMeters": round(dist(p, q) * 1.25, 1),
                     "topCandidate": {"type": mode, "probability": 0.9}},
    })
    if not path:
        return
    n = max(3, int((b - a).total_seconds() // 120))
    pts = []
    for i in range(n + 1):
        f = i / n
        bend = math.sin(f * math.pi) * 0.08 * (dist(p, q) / 100000)
        pt = (p[0] + (q[0] - p[0]) * f + bend * 0.3 + random.uniform(-.0006, .0006),
              p[1] + (q[1] - p[1]) * f - bend + random.uniform(-.0006, .0006))
        pts.append({"point": ll(pt), "time": iso(a + (b - a) * f)})
    segments.append({"startTime": iso(a), "endTime": iso(b), "timelinePath": pts})


def at(day, h, m=0, tz=JST):
    return datetime(day.year, day.month, day.day, tzinfo=tz) + timedelta(hours=h, minutes=m)


def normal_day(day):
    wd = day.weekday()
    if wd < 5:
        visit(at(day, -2), at(day, 8, 5), HOME, "home1", "HOME")
        move(at(day, 8, 5), at(day, 8, 50), HOME, WORK, "IN_TRAIN")
        visit(at(day, 8, 50), at(day, 18, 30), WORK, "work1", "WORK")
        if random.random() < 0.3:
            move(at(day, 18, 30), at(day, 18, 50), WORK, CAFE, "IN_SUBWAY")
            visit(at(day, 18, 50), at(day, 20, 30), CAFE, "cafe1")
            move(at(day, 20, 30), at(day, 21), CAFE, HOME, "IN_TRAIN")
        else:
            move(at(day, 18, 30), at(day, 19, 15), WORK, HOME, "IN_TRAIN")
    else:
        visit(at(day, -2), at(day, 11), HOME, "home1", "HOME")
        park = (35.6716 + random.uniform(-.02, .02), 139.6949 + random.uniform(-.03, .03))
        move(at(day, 11), at(day, 11, 30), HOME, park, "WALKING")
        visit(at(day, 11, 30), at(day, 15), park, f"wk{day.isoformat()}")
        move(at(day, 15), at(day, 15, 40), park, HOME, "CYCLING")


def run():
    d = datetime(2023, 1, 1)
    end = datetime(2025, 11, 30)
    trips = {
        # 京都・大阪 2泊3日（2023年11月）
        datetime(2023, 11, 3): "kyoto",
        # 鎌倉 日帰り（2024年5月）
        datetime(2024, 5, 4): "kamakura",
        # 北海道 3泊4日（2024年8月、飛行機）
        datetime(2024, 8, 10): "hokkaido",
        # 台湾 2泊3日（2025年3月）
        datetime(2025, 3, 20): "taiwan",
        # 京都・大阪 2泊3日（2024年11月：1年前の今日が出るように）
        datetime(2024, 11, 23): "kyoto",
        # 箱根 1泊2日（2025年11月）
        datetime(2025, 11, 22): "hakone",
    }
    skip = 0
    while d <= end:
        if skip:
            skip -= 1
        elif d in trips:
            skip = globals()["trip_" + trips[d]](d) - 1
        else:
            normal_day(d)
        d += timedelta(days=1)


def trip_kyoto(d):
    tokyo_st = (35.6812, 139.7671)
    kyoto_st = (34.9858, 135.7588)
    kiyomizu = (34.9949, 135.7850)
    fushimi = (34.9671, 135.7727)
    hotel = (35.0040, 135.7680)
    arashi = (35.0094, 135.6668)
    osaka_dotonbori = (34.6687, 135.5013)
    osaka_castle = (34.6873, 135.5262)
    shin_osaka = (34.7334, 135.5001)
    d1, d2, d3 = d, d + timedelta(days=1), d + timedelta(days=2)
    visit(at(d1, -2), at(d1, 7, 30), HOME, "home1", "HOME")
    move(at(d1, 7, 30), at(d1, 8, 10), HOME, tokyo_st, "IN_TRAIN")
    move(at(d1, 8, 20), at(d1, 10, 35), tokyo_st, kyoto_st, "IN_TRAIN")
    visit(at(d1, 10, 35), at(d1, 11), kyoto_st, "kyoto_st")
    move(at(d1, 11), at(d1, 11, 25), kyoto_st, kiyomizu, "IN_BUS")
    visit(at(d1, 11, 25), at(d1, 14), kiyomizu, "kiyomizu")
    move(at(d1, 14), at(d1, 14, 30), kiyomizu, fushimi, "IN_PASSENGER_VEHICLE")
    visit(at(d1, 14, 30), at(d1, 16, 30), fushimi, "fushimi")
    move(at(d1, 16, 30), at(d1, 17), fushimi, hotel, "IN_TRAIN")
    visit(at(d1, 17), at(d2, 9), hotel, "hotel_kyoto")
    move(at(d2, 9), at(d2, 9, 40), hotel, arashi, "IN_TRAIN")
    visit(at(d2, 9, 40), at(d2, 13), arashi, "arashiyama")
    move(at(d2, 13), at(d2, 14, 10), arashi, osaka_castle, "IN_TRAIN")
    visit(at(d2, 14, 10), at(d2, 16), osaka_castle, "osaka_castle")
    move(at(d2, 16), at(d2, 16, 25), osaka_castle, osaka_dotonbori, "IN_SUBWAY")
    visit(at(d2, 16, 25), at(d3, 10), osaka_dotonbori, "dotonbori")
    move(at(d3, 10), at(d3, 10, 30), osaka_dotonbori, shin_osaka, "IN_SUBWAY")
    move(at(d3, 10, 40), at(d3, 13, 10), shin_osaka, tokyo_st, "IN_TRAIN")
    move(at(d3, 13, 15), at(d3, 14), tokyo_st, HOME, "IN_TRAIN")
    visit(at(d3, 14), at(d3, 23, 59), HOME, "home1", "HOME")
    return 3


def trip_kamakura(d):
    kamakura = (35.3192, 139.5467)
    daibutsu = (35.3167, 139.5359)
    enoshima = (35.2990, 139.4800)
    visit(at(d, -2), at(d, 8), HOME, "home1", "HOME")
    move(at(d, 8), at(d, 9, 10), HOME, kamakura, "IN_TRAIN")
    visit(at(d, 9, 10), at(d, 11), kamakura, "tsurugaoka")
    move(at(d, 11), at(d, 11, 30), kamakura, daibutsu, "WALKING")
    visit(at(d, 11, 30), at(d, 13), daibutsu, "daibutsu")
    move(at(d, 13), at(d, 13, 40), daibutsu, enoshima, "IN_TRAIN")
    visit(at(d, 13, 40), at(d, 17), enoshima, "enoshima")
    move(at(d, 17), at(d, 18, 20), enoshima, HOME, "IN_TRAIN")
    visit(at(d, 18, 20), at(d, 23, 59), HOME, "home1", "HOME")
    return 1


def trip_hokkaido(d):
    haneda = (35.5494, 139.7798)
    chitose = (42.7752, 141.6920)
    sapporo = (43.0687, 141.3508)
    otaru = (43.1979, 140.9944)
    furano = (43.3420, 142.3832)
    biei = (43.5884, 142.4669)
    days = [d + timedelta(days=i) for i in range(4)]
    visit(at(days[0], -2), at(days[0], 7), HOME, "home1", "HOME")
    move(at(days[0], 7), at(days[0], 8), HOME, haneda, "IN_TRAIN")
    visit(at(days[0], 8), at(days[0], 9), haneda, "haneda")
    move(at(days[0], 9), at(days[0], 10, 35), haneda, chitose, "FLYING", path=False)
    move(at(days[0], 10, 50), at(days[0], 11, 40), chitose, sapporo, "IN_TRAIN")
    visit(at(days[0], 11, 40), at(days[1], 9), sapporo, "sapporo_hotel")
    move(at(days[1], 9), at(days[1], 9, 45), sapporo, otaru, "IN_TRAIN")
    visit(at(days[1], 9, 45), at(days[1], 15), otaru, "otaru")
    move(at(days[1], 15), at(days[1], 15, 45), otaru, sapporo, "IN_TRAIN")
    visit(at(days[1], 15, 45), at(days[2], 8), sapporo, "sapporo_hotel")
    move(at(days[2], 8), at(days[2], 10, 30), sapporo, furano, "IN_PASSENGER_VEHICLE")
    visit(at(days[2], 10, 30), at(days[2], 13), furano, "farm_tomita")
    move(at(days[2], 13), at(days[2], 13, 50), furano, biei, "IN_PASSENGER_VEHICLE")
    visit(at(days[2], 13, 50), at(days[3], 9), biei, "biei_inn")
    move(at(days[3], 9), at(days[3], 11, 30), biei, chitose, "IN_PASSENGER_VEHICLE")
    visit(at(days[3], 11, 30), at(days[3], 13), chitose, "chitose")
    move(at(days[3], 13), at(days[3], 14, 40), chitose, haneda, "FLYING", path=False)
    move(at(days[3], 14, 50), at(days[3], 15, 50), haneda, HOME, "IN_PASSENGER_VEHICLE")
    visit(at(days[3], 15, 50), at(days[3], 23, 59), HOME, "home1", "HOME")
    return 4


def trip_taiwan(d):
    narita = (35.7720, 140.3929)
    taoyuan = (25.0797, 121.2342)
    taipei101 = (25.0340, 121.5645)
    hotel = (25.0478, 121.5170)
    jiufen = (25.1092, 121.8452)
    shilin = (25.0880, 121.5241)
    days = [d + timedelta(days=i) for i in range(3)]
    visit(at(days[0], -2), at(days[0], 6), HOME, "home1", "HOME")
    move(at(days[0], 6), at(days[0], 7, 30), HOME, narita, "IN_TRAIN")
    visit(at(days[0], 7, 30), at(days[0], 9, 30), narita, "narita")
    move(at(days[0], 9, 30), at(days[0], 12, 30, TWN), narita, taoyuan, "FLYING", path=False)
    move(at(days[0], 12, 50, TWN), at(days[0], 13, 40, TWN), taoyuan, hotel, "IN_TRAIN")
    visit(at(days[0], 13, 40, TWN), at(days[0], 15, 0, TWN), hotel, "tp_hotel")
    move(at(days[0], 15, 0, TWN), at(days[0], 15, 30, TWN), hotel, taipei101, "IN_SUBWAY")
    visit(at(days[0], 15, 30, TWN), at(days[0], 18, 0, TWN), taipei101, "taipei101")
    move(at(days[0], 18, 0, TWN), at(days[0], 18, 40, TWN), taipei101, shilin, "IN_SUBWAY")
    visit(at(days[0], 18, 40, TWN), at(days[0], 21, 0, TWN), shilin, "shilin")
    move(at(days[0], 21, 0, TWN), at(days[0], 21, 30, TWN), shilin, hotel, "IN_SUBWAY")
    visit(at(days[0], 21, 30, TWN), at(days[1], 9, 0, TWN), hotel, "tp_hotel")
    move(at(days[1], 9, 0, TWN), at(days[1], 10, 20, TWN), hotel, jiufen, "IN_BUS")
    visit(at(days[1], 10, 20, TWN), at(days[1], 16, 0, TWN), jiufen, "jiufen")
    move(at(days[1], 16, 0, TWN), at(days[1], 17, 20, TWN), jiufen, hotel, "IN_BUS")
    visit(at(days[1], 17, 20, TWN), at(days[2], 10, 0, TWN), hotel, "tp_hotel")
    move(at(days[2], 10, 0, TWN), at(days[2], 11, 0, TWN), hotel, taoyuan, "IN_TRAIN")
    visit(at(days[2], 11, 0, TWN), at(days[2], 13, 0, TWN), taoyuan, "taoyuan")
    move(at(days[2], 13, 0, TWN), at(days[2], 17, 10), taoyuan, narita, "FLYING", path=False)
    move(at(days[2], 17, 30), at(days[2], 19), narita, HOME, "IN_TRAIN")
    visit(at(days[2], 19), at(days[2], 23, 59), HOME, "home1", "HOME")
    return 3


def trip_hakone(d):
    odawara = (35.2564, 139.1551)
    yumoto = (35.2326, 139.1057)
    owakudani = (35.2445, 139.0197)
    ashinoko = (35.2048, 139.0247)
    ryokan = (35.2400, 139.0600)
    d1, d2 = d, d + timedelta(days=1)
    visit(at(d1, -2), at(d1, 9), HOME, "home1", "HOME")
    move(at(d1, 9), at(d1, 10, 30), HOME, odawara, "IN_TRAIN")
    visit(at(d1, 10, 30), at(d1, 12), odawara, "odawara_castle")
    move(at(d1, 12), at(d1, 12, 30), odawara, yumoto, "IN_TRAIN")
    visit(at(d1, 12, 30), at(d1, 14), yumoto, "yumoto")
    move(at(d1, 14), at(d1, 15), yumoto, ryokan, "IN_BUS")
    visit(at(d1, 15), at(d2, 10), ryokan, "ryokan")
    move(at(d2, 10), at(d2, 10, 40), ryokan, owakudani, "IN_BUS")
    visit(at(d2, 10, 40), at(d2, 12), owakudani, "owakudani")
    move(at(d2, 12), at(d2, 12, 40), owakudani, ashinoko, "IN_BUS")
    visit(at(d2, 12, 40), at(d2, 15), ashinoko, "ashinoko")
    move(at(d2, 15), at(d2, 17), ashinoko, HOME, "IN_PASSENGER_VEHICLE")
    visit(at(d2, 17), at(d2, 23, 59), HOME, "home1", "HOME")
    return 2


run()
out = {
    "semanticSegments": segments,
    "rawSignals": raw,
    "userLocationProfile": {"frequentPlaces": [
        {"placeId": "home1", "placeLocation": ll(HOME), "label": "HOME"},
        {"placeId": "work1", "placeLocation": ll(WORK), "label": "WORK"},
    ]},
}
path = sys.argv[1] if len(sys.argv) > 1 else "Timeline.json"
with open(path, "w") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(path, len(segments), "segments")
