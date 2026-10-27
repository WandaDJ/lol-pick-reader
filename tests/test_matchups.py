"""맞라인 문장 파일 검사: 특성표가 모든 챔피언에 있고, 저장된 파일이 최신이며, 모든 조합 문장이 정상인지"""
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_matchups  # noqa: E402


class MatchupsTest(unittest.TestCase):
    def test_built_file_is_current(self):
        out = build_matchups.build()
        saved = json.loads((ROOT / "data" / "matchups.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["version"], out["version"])
        self.assertEqual(len(saved["traits"]), 172)

    @unittest.skipUnless(shutil.which("node"), "node 없음")
    def test_every_pair_reads_well(self):
        r = subprocess.run(["node", str(ROOT / "tests" / "matchup.test.mjs")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
