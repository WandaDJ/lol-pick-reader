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

    def test_built_file_is_current(self):
        out = build_notes.build()
        saved = json.loads((ROOT / "data" / "champ-notes.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["version"], out["version"])
        self.assertEqual(len(saved["fields"]), 7)


if __name__ == "__main__":
    unittest.main()
