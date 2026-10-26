#!/usr/bin/env python3
"""
Riot 공식 API(League-V4, Match-V5)로 랭크 경기를 모아 챔피언·포지션별 시간대 지표를 계산합니다.

결과물: data/stats.json
  - 10/20/30분 시점 같은 포지션 상대와의 골드 차이 (구간별 우세의 근거)
  - 게임 길이별 승률 (25분 미만 / 25~30 / 30~35 / 35분 이상)
  - 위 값을 1~5점으로 바꾼 구간 점수 phase = [0~10분, 10~20분, 20~30분, 30분 이후]

사용법:
  export RIOT_API_KEY=RGAPI-...
  python scripts/collect.py --max-matches 1500

필요한 것: Python 3.9+ (외부 패키지 없음)
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]
POS_SHORT = {"TOP": "TOP", "JUNGLE": "JGL", "MIDDLE": "MID", "BOTTOM": "ADC", "UTILITY": "SUP"}
LENGTH_BUCKETS = [("<25", 0, 25), ("25-30", 25, 30), ("30-35", 30, 35), ("35+", 35, 10_000)]
RANKED_SOLO = 420


# ---------------------------------------------------------------- HTTP / 속도 제한
class RiotClient:
    """개인/개발 키 기본 한도(1초 20회, 2분 100회)를 지키는 단순 클라이언트."""

    def __init__(self, key: str, platform: str, region: str, limits=((20, 1.0), (100, 120.0))):
        self.key = key
        self.platform = platform
        self.region = region
        self.limits = limits
        self.calls: collections.deque[float] = collections.deque()

    def _wait(self):
        while True:
            now = time.monotonic()
            longest = max(w for _, w in self.limits)
            while self.calls and now - self.calls[0] > longest:
                self.calls.popleft()
            sleep_for = 0.0
            for count, window in self.limits:
                recent = [t for t in self.calls if now - t < window]
                if len(recent) >= count:
                    sleep_for = max(sleep_for, window - (now - recent[0]) + 0.05)
            if sleep_for <= 0:
                self.calls.append(now)
                return
            time.sleep(sleep_for)

    def get(self, host: str, path: str, params: dict | None = None, retries: int = 5):
        url = f"https://{host}.api.riotgames.com{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        for attempt in range(retries):
            self._wait()
            req = urllib.request.Request(url, headers={"X-Riot-Token": self.key, "User-Agent": "lol-pick-reader"})
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait = int(e.headers.get("Retry-After", "10"))
                    print(f"  속도 제한(429): {wait}초 대기", file=sys.stderr)
                    time.sleep(wait + 1)
                    continue
                if e.code in (500, 502, 503, 504):
                    time.sleep(2 ** attempt)
                    continue
                if e.code == 404:
                    return None
                if e.code in (401, 403):
                    raise SystemExit("API 키가 없거나 만료됐어요. RIOT_API_KEY를 확인하세요 (개발 키는 24시간마다 만료).")
                raise
            except urllib.error.URLError:
                time.sleep(2 ** attempt)
        return None

    def platform_get(self, path, params=None):
        return self.get(self.platform, path, params)

    def region_get(self, path, params=None):
        return self.get(self.region, path, params)


# ---------------------------------------------------------------- 수집
def fetch_players(api: RiotClient, tiers: list[str], divisions: list[str], limit: int) -> list[str]:
    puuids: list[str] = []
    for tier in tiers:
        for div in divisions:
            page = 1
            while len(puuids) < limit:
                rows = api.platform_get(f"/lol/league/v4/entries/RANKED_SOLO_5x5/{tier}/{div}", {"page": page})
                if not rows:
                    break
                puuids.extend(r["puuid"] for r in rows if r.get("puuid"))
                page += 1
                if page > 3:  # 구간당 너무 많이 가져가지 않도록
                    break
            if len(puuids) >= limit:
                break
        if len(puuids) >= limit:
            break
    seen, out = set(), []
    for p in puuids:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out[:limit]


def compact(match: dict, timeline: dict | None) -> dict | None:
    """원본 경기 + 타임라인에서 필요한 값만 남긴 기록."""
    info = match.get("info") or {}
    if info.get("queueId") != RANKED_SOLO:
        return None
    gold_at: dict[int, dict[int, int]] = {}
    if timeline:
        frames = (timeline.get("info") or {}).get("frames") or []
        for minute in (10, 20, 30):
            if len(frames) > minute:
                pf = frames[minute].get("participantFrames") or {}
                gold_at[minute] = {int(k): v.get("totalGold", 0) for k, v in pf.items()}
    parts = []
    for p in info.get("participants", []):
        pid = p.get("participantId")
        parts.append({
            "champ": p.get("championName"),
            "pos": p.get("teamPosition") or "",
            "team": p.get("teamId"),
            "win": bool(p.get("win")),
            "gold": {str(m): g.get(pid) for m, g in gold_at.items() if g.get(pid) is not None},
        })
    version = info.get("gameVersion", "")
    patch = ".".join(version.split(".")[:2])
    return {"id": match["metadata"]["matchId"], "patch": patch, "duration": info.get("gameDuration", 0), "parts": parts}


def collect(api: RiotClient, args) -> list[dict]:
    cache_dir = Path(args.cache)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / "matches.jsonl"
    records: dict[str, dict] = {}
    if cache_file.exists():
        for line in cache_file.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                records[r["id"]] = r
    print(f"캐시된 경기: {len(records)}")

    start_time = int((datetime.now(timezone.utc) - timedelta(days=args.days)).timestamp())
    players = fetch_players(api, args.tiers, args.divisions, args.players)
    print(f"플레이어 {len(players)}명에서 경기 목록 수집")

    match_ids: list[str] = []
    for i, puuid in enumerate(players, 1):
        ids = api.region_get(f"/lol/match/v5/matches/by-puuid/{puuid}/ids",
                             {"queue": RANKED_SOLO, "start": 0, "count": args.per_player, "startTime": start_time}) or []
        match_ids.extend(ids)
        if i % 25 == 0:
            print(f"  {i}/{len(players)}명 확인, 경기 후보 {len(set(match_ids))}개")
    todo = [m for m in dict.fromkeys(match_ids) if m not in records][: max(0, args.max_matches - len(records))]
    print(f"새로 받을 경기: {len(todo)}개 (경기당 요청 2회)")

    with cache_file.open("a", encoding="utf-8") as fh:
        for i, mid in enumerate(todo, 1):
            match = api.region_get(f"/lol/match/v5/matches/{mid}")
            if not match:
                continue
            timeline = api.region_get(f"/lol/match/v5/matches/{mid}/timeline")
            rec = compact(match, timeline)
            if rec:
                records[mid] = rec
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if i % 50 == 0:
                print(f"  {i}/{len(todo)}경기 완료")
    return list(records.values())


# ---------------------------------------------------------------- 집계
def shrink(mean: float, n: int, k: int) -> float:
    """표본이 적을수록 0 쪽으로 당겨서 우연한 값이 튀지 않게 함."""
    return mean * n / (n + k) if n else 0.0


def clamp(x: float, lo: float = 1.0, hi: float = 5.0) -> float:
    return max(lo, min(hi, x))


def aggregate(records: list[dict], champ_names: dict[str, str], patches: list[str] | None = None,
              min_games: int = 30) -> dict:
    acc = collections.defaultdict(lambda: {
        "games": 0, "wins": 0,
        "gd10": [0.0, 0], "gain20": [0.0, 0], "gain30": [0.0, 0],
        "len": {b[0]: [0, 0] for b in LENGTH_BUCKETS},
        "long": [0, 0],
    })
    used = 0
    for rec in records:
        if patches and rec["patch"] not in patches:
            continue
        minutes = rec["duration"] / 60
        if minutes < 15:  # 다시하기·조기 항복 제외
            continue
        used += 1
        by_slot = {(p["team"], p["pos"]): p for p in rec["parts"] if p["pos"] in POSITIONS}
        for (team, pos), p in by_slot.items():
            opp = next((q for (t, ps), q in by_slot.items() if ps == pos and t != team), None)
            a = acc[(p["champ"], pos)]
            a["games"] += 1
            a["wins"] += p["win"]
            for name, lo, hi in LENGTH_BUCKETS:
                if lo <= minutes < hi:
                    a["len"][name][0] += 1
                    a["len"][name][1] += p["win"]
            if minutes >= 30:
                a["long"][0] += 1
                a["long"][1] += p["win"]
            if not opp:
                continue
            g, og = p["gold"], opp["gold"]
            d = {m: g[m] - og[m] for m in ("10", "20", "30") if m in g and m in og}
            if "10" in d:
                a["gd10"][0] += d["10"]; a["gd10"][1] += 1
            if "20" in d and "10" in d:
                a["gain20"][0] += d["20"] - d["10"]; a["gain20"][1] += 1
            if "30" in d and "20" in d:
                a["gain30"][0] += d["30"] - d["20"]; a["gain30"][1] += 1

    champions: dict[str, dict] = {}
    for (champ, pos), a in acc.items():
        if a["games"] < min_games:
            continue
        def mean(pair):
            return pair[0] / pair[1] if pair[1] else 0.0
        gd10 = shrink(mean(a["gd10"]), a["gd10"][1], 20)
        gain20 = shrink(mean(a["gain20"]), a["gain20"][1], 20)
        gain30 = shrink(mean(a["gain30"]), a["gain30"][1], 20)
        long_n, long_w = a["long"]
        wr_long = (long_w + 15) / (long_n + 30)  # 50% 쪽으로 보정
        phase = [
            round(clamp(3 + gd10 / 300), 2),
            round(clamp(3 + gain20 / 400), 2),
            round(clamp(3 + gain30 / 500), 2),
            round(clamp(3 + (wr_long - 0.5) * 25), 2),
        ]
        name = champ_names.get(champ.lower(), champ)
        champions.setdefault(name, {})[POS_SHORT[pos]] = {
            "games": a["games"],
            "winRate": round(a["wins"] / a["games"], 4),
            "gd10": round(mean(a["gd10"])),
            "gd20": round(mean(a["gd10"]) + mean(a["gain20"])),
            "gd30": round(mean(a["gd10"]) + mean(a["gain20"]) + mean(a["gain30"])),
            "wrByLength": {k: {"games": v[0], "winRate": round(v[1] / v[0], 4) if v[0] else None} for k, v in a["len"].items()},
            "phase": phase,
        }
    return {"matchesUsed": used, "champions": champions}


# ---------------------------------------------------------------- 한국어 이름
def korean_names() -> tuple[dict[str, str], str]:
    def j(url):
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    version = j("https://ddragon.leagueoflegends.com/api/versions.json")[0]
    data = j(f"https://ddragon.leagueoflegends.com/cdn/{version}/data/ko_KR/champion.json")["data"]
    names = {v["id"].lower(): v["name"] for v in data.values()}
    names["fiddlesticks"] = names.get("fiddlesticks", "피들스틱")
    return names, version


def main(argv=None):
    ap = argparse.ArgumentParser(description="Riot API로 챔피언 시간대 지표 수집")
    ap.add_argument("--platform", default="kr")
    ap.add_argument("--region", default="asia")
    ap.add_argument("--tiers", default="EMERALD,DIAMOND", help="쉼표 구분 (IRON~DIAMOND)")
    ap.add_argument("--divisions", default="I,II,III,IV")
    ap.add_argument("--players", type=int, default=300)
    ap.add_argument("--per-player", type=int, default=15)
    ap.add_argument("--max-matches", type=int, default=1500)
    ap.add_argument("--days", type=int, default=14, help="최근 며칠 경기만")
    ap.add_argument("--patches", default="", help="이 패치만 집계 (예: 26.21). 비우면 수집된 경기 중 최신 2개 패치")
    ap.add_argument("--min-games", type=int, default=30)
    ap.add_argument("--cache", default="data/cache")
    ap.add_argument("--out", default="data/stats.json")
    args = ap.parse_args(argv)
    args.tiers = [t.strip().upper() for t in args.tiers.split(",") if t.strip()]
    args.divisions = [d.strip().upper() for d in args.divisions.split(",") if d.strip()]

    key = os.environ.get("RIOT_API_KEY")
    if not key:
        raise SystemExit("RIOT_API_KEY 환경변수를 설정하세요.")
    api = RiotClient(key, args.platform, args.region)
    records = collect(api, args)

    if args.patches:
        patches = [p.strip() for p in args.patches.split(",")]
    else:
        def pkey(p):
            try:
                return tuple(int(x) for x in p.split("."))
            except ValueError:
                return (0,)
        patches = sorted({r["patch"] for r in records}, key=pkey)[-2:]

    names, dd_version = korean_names()
    result = aggregate(records, names, patches, args.min_games)
    out = {
        "meta": {
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "platform": args.platform,
            "tiers": args.tiers,
            "patches": patches,
            "matches": result["matchesUsed"],
            "minGames": args.min_games,
            "ddragon": dd_version,
            "method": "10/20/30분 같은 포지션 상대와의 골드 차이 + 30분 이상 경기 승률",
        },
        "champions": result["champions"],
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"저장: {args.out} · 경기 {result['matchesUsed']}개 · 챔피언 {len(result['champions'])}개 · 패치 {patches}")


if __name__ == "__main__":
    main()
