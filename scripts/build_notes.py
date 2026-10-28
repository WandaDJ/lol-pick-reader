#!/usr/bin/env python3
"""
data/notes/*.json (챔피언별 상황 문장)을 data/champ-notes.json 하나로 합쳐요.
문장을 고친 뒤 이 스크립트를 실행하면 버전이 바뀌고, 페이지가 새 문장을 받아요.

  python scripts/build_notes.py
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIELDS = ["spike", "early", "mid", "late", "ahead", "behind", "against"]
LABELS = {"spike": "강해지는 시점", "early": "0~10분", "mid": "10~20분", "late": "20분 이후",
          "ahead": "이기고 있을 때", "behind": "지고 있을 때", "against": "상대할 때"}
# 최근에 나왔거나 크게 바뀌어서 문장이 부정확할 수 있는 챔피언
REVIEW = ["자헨", "유나라", "멜", "암베사", "오로라", "흐웨이", "스몰더", "나피리", "브라이어", "밀리오", "스카너"]


LANE_KEYS = ["TOP", "JGL", "MID", "ADC", "SUP"]


def build():
    champs = {}
    for f in sorted((ROOT / "data" / "notes").glob("[0-9]*.json")):
        part = json.loads(f.read_text(encoding="utf-8"))
        for name, lines in part.items():
            if name in champs:
                raise SystemExit(f"{name}: {f.name}에 중복")
            if not (isinstance(lines, list) and len(lines) == len(FIELDS) and all(isinstance(x, str) and x.strip() for x in lines)):
                raise SystemExit(f"{name}: 문장 {len(FIELDS)}개가 모두 있어야 해요 ({f.name})")
            champs[name] = lines
    # 포지션별 문장: "챔피언|포지션" → 7개 문장 (대표 포지션이 아닐 때 기본 문장 대신 보여줌)
    lanes = {}
    for f in sorted((ROOT / "data" / "notes").glob("lanes-*.json")):
        for key, lines in json.loads(f.read_text(encoding="utf-8")).items():
            name, _, lane = key.partition("|")
            if name not in champs or lane not in LANE_KEYS:
                raise SystemExit(f"{key}: 모르는 챔피언이나 포지션 ({f.name})")
            if key in lanes:
                raise SystemExit(f"{key}: 중복 ({f.name})")
            if not (isinstance(lines, list) and len(lines) == len(FIELDS) and all(isinstance(x, str) and x.strip() for x in lines)):
                raise SystemExit(f"{key}: 문장 {len(FIELDS)}개가 모두 있어야 해요 ({f.name})")
            lanes[key] = lines
    # 포지션별 기본 세팅 한 줄: 주문 · 아이템 방향 · 역할
    setup = {k: {} for k in LANE_KEYS}
    files = {"top.json": "TOP", "jgl.json": "JGL", "mid.json": "MID"}
    for f in sorted((ROOT / "data" / "setup").glob("*.json")):
        part = json.loads(f.read_text(encoding="utf-8"))
        groups = {files[f.name]: part} if f.name in files else part
        for lane, rows in groups.items():
            for name, text in rows.items():
                if name not in champs:
                    raise SystemExit(f"{lane} {name}: 모르는 챔피언 ({f.name})")
                setup[lane][name] = text.strip()
    body = json.dumps([champs, lanes, setup], ensure_ascii=False, sort_keys=True)
    out = {
        "version": hashlib.sha1(body.encode("utf-8")).hexdigest()[:10],
        "fields": FIELDS,
        "labels": LABELS,
        "review": [n for n in REVIEW if n in champs],
        "champions": champs,
        "lanes": lanes,
        "setup": setup,
    }
    (ROOT / "data" / "champ-notes.json").write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf-8")
    return out


if __name__ == "__main__":
    out = build()
    print(f"챔피언 {len(out['champions'])}개, 버전 {out['version']}", file=sys.stderr)
