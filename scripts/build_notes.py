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


def build():
    champs = {}
    for f in sorted((ROOT / "data" / "notes").glob("*.json")):
        part = json.loads(f.read_text(encoding="utf-8"))
        for name, lines in part.items():
            if name in champs:
                raise SystemExit(f"{name}: {f.name}에 중복")
            if not (isinstance(lines, list) and len(lines) == len(FIELDS) and all(isinstance(x, str) and x.strip() for x in lines)):
                raise SystemExit(f"{name}: 문장 {len(FIELDS)}개가 모두 있어야 해요 ({f.name})")
            champs[name] = lines
    body = json.dumps(champs, ensure_ascii=False, sort_keys=True)
    out = {
        "version": hashlib.sha1(body.encode("utf-8")).hexdigest()[:10],
        "fields": FIELDS,
        "labels": LABELS,
        "review": [n for n in REVIEW if n in champs],
        "champions": champs,
    }
    (ROOT / "data" / "champ-notes.json").write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf-8")
    return out


if __name__ == "__main__":
    out = build()
    print(f"챔피언 {len(out['champions'])}개, 버전 {out['version']}", file=sys.stderr)
