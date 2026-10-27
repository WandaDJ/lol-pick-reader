#!/usr/bin/env python3
"""
data/traits.json(특성표)와 data/pairs/*.json(직접 쓴 맞라인 문장)을 data/matchups.json 하나로 합쳐요.

  python scripts/build_matchups.py
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build():
    notes = json.loads((ROOT / "data" / "champ-notes.json").read_text(encoding="utf-8"))["champions"]
    raw = json.loads((ROOT / "data" / "traits.json").read_text(encoding="utf-8"))
    fields = raw.pop("_fields")
    raw.pop("_help", None)
    for name, t in raw.items():
        if name not in notes:
            raise SystemExit(f"특성표에 모르는 이름: {name}")
        if not (isinstance(t, list) and len(t) == len(fields) and all(isinstance(x, int) for x in t)):
            raise SystemExit(f"{name}: 특성 {len(fields)}개(정수)가 필요해요")
        if not (1 <= t[0] <= 3 and all(0 <= x <= 3 for x in t[1:])):
            raise SystemExit(f"{name}: 범위를 벗어난 값 {t}")
    missing = set(notes) - set(raw)
    if missing:
        raise SystemExit(f"특성표에 없는 챔피언: {sorted(missing)}")
    pairs = {}
    for f in sorted((ROOT / "data" / "pairs").glob("*.json")):
        for me, foes in json.loads(f.read_text(encoding="utf-8")).items():
            for foe, text in foes.items():
                if me not in notes or foe not in notes:
                    raise SystemExit(f"{f.name}: 모르는 이름 {me} / {foe}")
                if not text.strip():
                    raise SystemExit(f"{f.name}: {me}|{foe} 문장이 비어 있어요")
                key = f"{me}|{foe}"
                if key in pairs:
                    raise SystemExit(f"{key}: 중복 ({f.name})")
                pairs[key] = text.strip()
    body = json.dumps({"t": raw, "p": pairs}, ensure_ascii=False, sort_keys=True)
    out = {"version": hashlib.sha1(body.encode("utf-8")).hexdigest()[:10], "fields": fields, "traits": raw, "pairs": pairs}
    (ROOT / "data" / "matchups.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return out


if __name__ == "__main__":
    out = build()
    print(f"특성 {len(out['traits'])}개, 직접 쓴 상대 {len(out['pairs'])}개, 버전 {out['version']}", file=sys.stderr)
