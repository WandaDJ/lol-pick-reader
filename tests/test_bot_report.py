import random, sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import bot_report


def game(i, a1, s1, a2, s2, win100):
    parts = []
    for team, a, s in ((100, a1, s1), (200, a2, s2)):
        w = win100 if team == 100 else not win100
        for pos, c in (("TOP", "Garen"), ("JUNGLE", "Vi"), ("MIDDLE", "Ahri"), ("BOTTOM", a), ("UTILITY", s)):
            parts.append({"champ": c, "pos": pos, "team": team, "win": w,
                          "gold": {"10": 4000 if (pos == "BOTTOM" and w) else 3500},
                          "spells": [4, 7] if pos == "BOTTOM" else [4, 14], "key": 8005,
                          "items": [3031, 3006, 6672] if pos == "BOTTOM" else [3190, 3109]})
    return {"id": f"KR_{i}", "patch": "16.22", "duration": 1800, "parts": parts}


class BotReportTest(unittest.TestCase):
    def test_report(self):
        random.seed(1)
        recs = [game(i, "Jinx", "Thresh", "Caitlyn", "Lux", i % 3 != 0) for i in range(30)]
        names = {"jinx": "징크스", "thresh": "쓰레쉬", "caitlyn": "케이틀린", "lux": "럭스"}
        dd = {"spells": {"4": "점멸", "7": "회복", "14": "점화"}, "runes": {"8005": "집중 공격"},
              "items": {"3031": {"name": "무한의 대검", "tags": [], "completed": True},
                        "6672": {"name": "크라켄", "tags": [], "completed": True},
                        "3006": {"name": "광전사의 군화", "tags": ["Boots"], "completed": False},
                        "3190": {"name": "솔라리", "tags": [], "completed": True},
                        "3109": {"name": "기사의 맹세", "tags": [], "completed": True}}}
        r = bot_report.build_report(recs, names, dd)
        self.assertEqual(r["meta"]["matches"], 30)
        d = r["duos"]["징크스|쓰레쉬"]
        self.assertEqual(d["games"], 30)
        self.assertAlmostEqual(d["winRate"], 20 / 30, places=3)
        self.assertEqual(r["duoVs"]["징크스|쓰레쉬 vs 케이틀린|럭스"]["games"], 30)
        jx = r["champions"]["ADC"]["징크스"]
        self.assertEqual({x[0] for x in jx["items"]}, {"무한의 대검", "크라켄"})
        self.assertEqual(jx["boots"][0][0], "광전사의 군화")
        self.assertEqual(jx["core"][0][0], "무한의 대검 + 크라켄")
        self.assertEqual(jx["spells"][0][0], "점멸+회복")
        self.assertEqual(r["champions"]["SUP"]["쓰레쉬"]["keystones"][0][0], "집중 공격")
        self.assertEqual(r["gd10WinRate"]["250~750"]["winRate"], 1.0)


if __name__ == "__main__":
    unittest.main()
