"""바텀 듀오 분석: 수집 캐시(data/cache/matches.jsonl)의 원본 경기에서 원딜+서폿 조합 통계를 뽑아요.

python scripts/bot_report.py [--cache data/cache/matches.jsonl] [--out data/bot-report.json]

- 듀오(원딜|서폿)별 판수·승률·10분 골드 차이(우리 듀오 합 - 상대 듀오 합)·평균 게임 시간
- 듀오 대 듀오 맞대결
- 원딜·서폿 챔피언별 최종 아이템(보유 시 승률), 완성 아이템 조합, 소환사 주문, 핵심 룬
- 10분 바텀 골드 차이 구간별 승률
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect  # noqa: E402

GD_BUCKETS = [(-10**9, -1500), (-1500, -750), (-750, -250), (-250, 250), (250, 750), (750, 1500), (1500, 10**9)]


def bucket_name(lo, hi):
    if lo < -10**8:
        return f"~{hi}"
    if hi > 10**8:
        return f"{lo}~"
    return f"{lo}~{hi}"


def load(cache: Path) -> list[dict]:
    out = {}
    for line in cache.read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["id"]] = r
    return list(out.values())


def bot_of(parts, team):
    a = [p for p in parts if p["team"] == team and p["pos"] == "BOTTOM"]
    s = [p for p in parts if p["team"] == team and p["pos"] == "UTILITY"]
    return (a[0], s[0]) if len(a) == 1 and len(s) == 1 else None


def g10(p):
    return (p.get("gold") or {}).get("10")


def build_report(records, names, dd, min_duo=5, min_vs=4):
    nm = lambda c: names.get((c or "").lower(), c)
    items_dd = (dd or {}).get("items", {})
    item_name = lambda i: items_dd.get(str(i), {}).get("name", str(i))
    completed = lambda i: items_dd.get(str(i), {}).get("completed", False) if items_dd else True
    is_boots = lambda i: "Boots" in items_dd.get(str(i), {}).get("tags", [])
    spell_name = lambda s: (dd or {}).get("spells", {}).get(str(s), str(s))
    rune_name = lambda r: (dd or {}).get("runes", {}).get(str(r), str(r))

    duo = collections.defaultdict(lambda: [0, 0, 0, 0, 0])          # games, wins, gd10 sum, gd10 n, duration sum
    vs = collections.defaultdict(lambda: [0, 0])
    gdb = collections.defaultdict(lambda: [0, 0])
    champ = {"ADC": {}, "SUP": {}}
    patches = collections.Counter()
    used = 0

    def cstat(role, c):
        d = champ[role].get(c)
        if d is None:
            d = champ[role][c] = {"games": 0, "wins": 0, "items": collections.defaultdict(lambda: [0, 0]),
                                  "core": collections.defaultdict(lambda: [0, 0]), "spells": collections.defaultdict(lambda: [0, 0]),
                                  "keys": collections.defaultdict(lambda: [0, 0]), "boots": collections.defaultdict(lambda: [0, 0])}
        return d

    for r in records:
        b = {t: bot_of(r["parts"], t) for t in (100, 200)}
        if not b[100] or not b[200]:
            continue
        used += 1
        patches[r["patch"]] += 1
        for t, o in ((100, 200), (200, 100)):
            (a, s), (ea, es) = b[t], b[o]
            win = a["win"]
            k = f"{nm(a['champ'])}|{nm(s['champ'])}"
            ek = f"{nm(ea['champ'])}|{nm(es['champ'])}"
            d = duo[k]
            d[0] += 1; d[1] += win; d[4] += r.get("duration", 0)
            gs = [g10(a), g10(s), g10(ea), g10(es)]
            if None not in gs:
                gd = gs[0] + gs[1] - gs[2] - gs[3]
                d[2] += gd; d[3] += 1
                for lo, hi in GD_BUCKETS:
                    if lo <= gd < hi:
                        x = gdb[bucket_name(lo, hi)]; x[0] += 1; x[1] += win
                        break
            v = vs[f"{k} vs {ek}"]; v[0] += 1; v[1] += win
            for role, p in (("ADC", a), ("SUP", s)):
                c = cstat(role, nm(p["champ"]))
                c["games"] += 1; c["wins"] += win
                its = [i for i in (p.get("items") or []) if i]
                for i in set(its):
                    if is_boots(i):
                        x = c["boots"][item_name(i)]; x[0] += 1; x[1] += win
                    elif completed(i):
                        x = c["items"][item_name(i)]; x[0] += 1; x[1] += win
                core = sorted({item_name(i) for i in its if completed(i) and not is_boots(i)})
                if len(core) >= 2:
                    # 완성 아이템 2개 조합마다 세서 "같이 가는 핵심템"을 봐요 (최종 인벤토리라 순서는 없음)
                    for x1 in range(len(core)):
                        for x2 in range(x1 + 1, len(core)):
                            x = c["core"][f"{core[x1]} + {core[x2]}"]; x[0] += 1; x[1] += win
                sp = "+".join(sorted(spell_name(s_) for s_ in (p.get("spells") or []) if s_))
                x = c["spells"][sp]; x[0] += 1; x[1] += win
                if p.get("key"):
                    x = c["keys"][rune_name(p["key"])]; x[0] += 1; x[1] += win

    def top(dct, n, total):
        rows = sorted(dct.items(), key=lambda kv: -kv[1][0])[:n]
        return [[k, v[0], round(v[0] / total, 3), round(v[1] / v[0], 3)] for k, v in rows if v[0]]

    champs = {}
    for role, dct in champ.items():
        champs[role] = {}
        for c, d in sorted(dct.items(), key=lambda kv: -kv[1]["games"]):
            if d["games"] < 20:
                continue
            g = d["games"]
            champs[role][c] = {"games": g, "winRate": round(d["wins"] / g, 3),
                               "items": top(d["items"], 10, g), "core": top(d["core"], 6, g),
                               "boots": top(d["boots"], 4, g), "spells": top(d["spells"], 3, g), "keystones": top(d["keys"], 3, g)}

    duos = {k: {"games": v[0], "winRate": round(v[1] / v[0], 3),
                "gd10": round(v[2] / v[3]) if v[3] else None, "minutes": round(v[4] / v[0] / 60, 1)}
            for k, v in sorted(duo.items(), key=lambda kv: -kv[1][0]) if v[0] >= min_duo}
    vss = {k: {"games": v[0], "winRate": round(v[1] / v[0], 3)}
           for k, v in sorted(vs.items(), key=lambda kv: -kv[1][0]) if v[0] >= min_vs}
    gd = {bucket_name(lo, hi): ({"games": gdb[bucket_name(lo, hi)][0],
                                 "winRate": round(gdb[bucket_name(lo, hi)][1] / gdb[bucket_name(lo, hi)][0], 3)}
                                if gdb[bucket_name(lo, hi)][0] else None) for lo, hi in GD_BUCKETS}
    return {"meta": {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "matches": used,
                     "patches": dict(sorted(patches.items(), key=lambda kv: collect.patch_key(kv[0]))),
                     "note": "아이템은 경기 끝 인벤토리 기준(산 순서 아님). 듀오 판수는 양 팀을 따로 셈."},
            "duos": duos, "duoVs": vss, "gd10WinRate": gd, "champions": champs}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cache", default="data/cache/matches.jsonl")
    ap.add_argument("--out", default="data/bot-report.json")
    args = ap.parse_args(argv)
    cache = Path(args.cache)
    if not cache.exists():
        raise SystemExit(f"캐시 없음: {cache}")
    records = load(cache)
    names, ver = collect.korean_names()
    try:
        dd = collect.ddragon_data(ver)
    except Exception as e:
        print(f"Data Dragon 실패, 아이템은 번호로 남아요: {e}")
        dd = None
    rep = build_report(records, names, dd)
    Path(args.out).write_text(json.dumps(rep, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"바텀 분석 저장: {args.out} · 경기 {rep['meta']['matches']} · 듀오 {len(rep['duos'])} · 맞대결 {len(rep['duoVs'])}")


if __name__ == "__main__":
    main()
