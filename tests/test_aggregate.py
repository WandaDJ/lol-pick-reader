"""가짜 경기 데이터로 집계 로직 검증: python -m unittest discover tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import collect  # noqa: E402

POS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]


def fake_match(i, duration_min, blue_win, top_gold):
    """블루 탑 Renekton vs 레드 탑 Nasus. top_gold = (10,20,30분 블루골드, 레드골드)"""
    parts = []
    for team, champs in ((100, ["Renekton", "LeeSin", "Ahri", "Jinx", "Thresh"]),
                         (200, ["Nasus", "Karthus", "Azir", "Caitlyn", "Lulu"])):
        for pos, c in zip(POS, champs):
            gold = {}
            if pos == "TOP":
                for idx, m in enumerate(("10", "20", "30")):
                    if int(m) <= duration_min:
                        gold[m] = top_gold[idx][0 if team == 100 else 1]
            parts.append({"champ": c, "pos": pos, "team": team,
                          "win": blue_win if team == 100 else not blue_win, "gold": gold})
    return {"id": f"KR_{i}", "patch": "26.21", "duration": duration_min * 60, "parts": parts}


class AggregateTest(unittest.TestCase):
    def setUp(self):
        recs = []
        # 레넥톤: 10분 +600, 20분까지 추가 +200, 30분 이후엔 역전당함. 짧은 게임은 이기고 긴 게임은 짐
        for i in range(40):
            recs.append(fake_match(i, 24, True, [(4000, 3400), (8800, 8000), (0, 0)]))
        for i in range(40, 80):
            recs.append(fake_match(i, 36, False, [(4000, 3400), (8800, 8000), (12500, 13300)]))
        recs.append(fake_match(999, 4, True, [(0, 0), (0, 0), (0, 0)]))  # 다시하기: 제외돼야 함
        self.out = collect.aggregate(recs, {"renekton": "레넥톤", "nasus": "나서스"}, ["26.21"], min_games=30)

    def test_counts(self):
        self.assertEqual(self.out["matchesUsed"], 80)
        r = self.out["champions"]["레넥톤"]["TOP"]
        self.assertEqual(r["games"], 80)
        self.assertAlmostEqual(r["winRate"], 0.5)
        self.assertEqual(r["wrByLength"]["<25"]["winRate"], 1.0)
        self.assertEqual(r["wrByLength"]["35+"]["winRate"], 0.0)

    def test_gold_diffs(self):
        r = self.out["champions"]["레넥톤"]["TOP"]
        self.assertEqual(r["gd10"], 600)
        self.assertEqual(r["gd20"], 800)
        self.assertEqual(r["gd30"], -800)

    def test_matchups(self):
        self.assertEqual(self.out["champions"]["레넥톤"]["TOP"]["vs"]["나서스"], [80, 40])
        self.assertEqual(self.out["champions"]["나서스"]["TOP"]["vs"]["레넥톤"], [80, 40])

    def test_phase_shape(self):
        ren = self.out["champions"]["레넥톤"]["TOP"]["phase"]
        nas = self.out["champions"]["나서스"]["TOP"]["phase"]
        self.assertGreater(ren[0], 3.5)   # 초반 강함
        self.assertLess(ren[2], 2.0)      # 20~30분 역전당함
        self.assertLess(ren[3], 3.0)      # 긴 게임 약함
        self.assertGreater(nas[3], 3.0)   # 나서스 반대
        self.assertTrue(all(1 <= v <= 5 for v in ren + nas))

    def test_compact(self):
        match = {"metadata": {"matchId": "KR_1"}, "info": {"queueId": 420, "gameVersion": "26.21.123.4", "gameDuration": 1800,
                 "participants": [{"participantId": 1, "championName": "Pyke", "teamPosition": "UTILITY", "teamId": 100, "win": True}]}}
        frames = [{"participantFrames": {"1": {"totalGold": m * 100}}} for m in range(31)]
        rec = collect.compact(match, {"info": {"frames": frames}})
        self.assertEqual(rec["patch"], "26.21")
        self.assertEqual(rec["parts"][0]["gold"], {"10": 1000, "20": 2000, "30": 3000})
        self.assertIsNone(collect.compact({"metadata": {"matchId": "x"}, "info": {"queueId": 450}}, None))


if __name__ == "__main__":
    unittest.main()
