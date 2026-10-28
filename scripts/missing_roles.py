#!/usr/bin/env python3
"""
통계(data/stats.json)에 새로 보이는 챔피언·포지션 중 아직 설명이 없는 것을 찾아요.
매일 예약 작업이 이 목록을 보고 포지션 전용 문장과 기본 세팅을 써 넣어요.

  python scripts/missing_roles.py          # 사람이 읽는 목록
  python scripts/missing_roles.py --json   # 기계용
기준: 그 포지션 판수 30판 이상이고, 그 챔피언 전체 판수의 10% 이상
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_notes  # noqa: E402

MIN_GAMES, MIN_SHARE = 30, 0.10


def norm(s: str) -> str:
    return re.sub(r"\s+", "", s).lower()


def page_lanes() -> dict[str, list[str]]:
    src = (ROOT / "index.html").read_text(encoding="utf-8")
    block = re.search(r"const R=\{(.*?)\n\};", src, re.S).group(1)
    return {k: v.split(",") for k, v in re.findall(r'(\w+):"([^"]+)"', block)}


def find(stats: dict | None = None) -> list[dict]:
    path = ROOT / "data" / "stats.json"
    if stats is None:
        if not path.exists():
            return []
        stats = json.loads(path.read_text(encoding="utf-8"))
    notes = build_notes.build()
    by_norm = {norm(k): k for k in notes["champions"]}
    lanes = page_lanes()
    out = []
    for raw, per in (stats.get("champions") or {}).items():
        name = by_norm.get(norm(raw))
        if not name:
            out.append({"champion": raw, "lane": "*", "games": sum(r["games"] for r in per.values()),
                        "need": ["새 챔피언: 기본 문장·특성표부터 필요"]})
            continue
        total = sum(r["games"] for r in per.values()) or 1
        for ln, r in per.items():
            if r["games"] < MIN_GAMES or r["games"] / total < MIN_SHARE:
                continue
            need = []
            if name not in lanes.get(ln, []):
                need.append("포지션 목록(index.html R)")
            if name not in notes["setup"].get(ln, {}):
                need.append("기본 세팅(data/setup)")
            in_lanes = [l for l, cs in lanes.items() if name in cs]
            if (in_lanes and ln not in in_lanes) and f"{name}|{ln}" not in notes["lanes"]:
                need.append("포지션 전용 문장(data/notes/lanes-*.json)")
            if need:
                out.append({"champion": name, "lane": ln, "games": r["games"], "share": round(r["games"] / total, 2), "need": need})
    return sorted(out, key=lambda x: -x["games"])


if __name__ == "__main__":
    rows = find()
    if "--json" in sys.argv:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
    elif not rows:
        print("새로 설명이 필요한 챔피언·포지션이 없어요.")
    else:
        for r in rows:
            print(f"{r['champion']} {r['lane']} ({r['games']}판): {', '.join(r['need'])}")
