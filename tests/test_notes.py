"""챔피언 문장 파일 검사: 페이지의 모든 챔피언에 7개 문장이 있는지"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_notes  # noqa: E402


def page_champions():
    src = (ROOT / "index.html").read_text(encoding="utf-8")
    block = re.search(r"const D=\{(.*?)\n\};", src, re.S).group(1)
    return set(re.findall(r'"([^"]+)":\[', block))


class NotesTest(unittest.TestCase):
    def test_every_champion_has_notes(self):
        out = build_notes.build()
        missing = page_champions() - set(out["champions"])
        self.assertFalse(missing, f"문장이 없는 챔피언: {sorted(missing)}")
        extra = set(out["champions"]) - page_champions()
        self.assertFalse(extra, f"페이지에 없는 이름: {sorted(extra)}")

    def test_every_lane_has_setup_and_lane_notes(self):
        src = (ROOT / "index.html").read_text(encoding="utf-8")
        block = re.search(r"const R=\{(.*?)\n\};", src, re.S).group(1)
        lanes = {k: v.split(",") for k, v in re.findall(r'(\w+):"([^"]+)"', block)}
        out = build_notes.build()
        missing = [f"{ln} {c}" for ln, cs in lanes.items() for c in cs if c not in out["setup"][ln]]
        self.assertFalse(missing, f"기본 세팅이 없는 포지션: {missing}")
        where = {}
        for ln, cs in lanes.items():
            for c in cs:
                where.setdefault(c, []).append(ln)
        thin = [c for c, ls in where.items() if len(ls) > 1 and sum(f"{c}|{ln}" in out["lanes"] for ln in ls) < len(ls) - 1]
        self.assertFalse(thin, f"여러 포지션인데 포지션별 문장이 부족한 챔피언: {thin}")

    def test_script_version_matches_page(self):
        src = (ROOT / "index.html").read_text(encoding="utf-8")
        ver = re.search(r"PAGE_VERSION='([^']+)'", src).group(1)
        self.assertIn(f'matchup.js?v={ver}"', src, "matchup.js 주소의 ?v= 값을 PAGE_VERSION과 맞춰주세요")

    def test_built_file_is_current(self):
        out = build_notes.build()
        saved = json.loads((ROOT / "data" / "champ-notes.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["version"], out["version"])
        self.assertEqual(len(saved["fields"]), 7)


if __name__ == "__main__":
    unittest.main()
