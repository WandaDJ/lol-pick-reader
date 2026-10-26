"""PC 도우미 픽창 해석 검증: python -m unittest discover tests"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helper"))
import pick_helper as h  # noqa: E402

NAMES = {58: "레넥톤", 64: "리 신", 103: "아리", 222: "징크스", 412: "쓰레쉬", 555: "파이크",
         75: "나서스", 30: "카서스", 119: "드레이븐", 89: "레오나", 157: "야스오", 238: "제드"}


def session():
    """솔로 랭크 픽창 중간 상황: 밴 끝, 아군 3명 확정, 나는 서폿으로 쓰레쉬 고민 중, 상대 2명 확정"""
    mine = [("top", 58, 0), ("jungle", 64, 0), ("middle", 103, 0), ("bottom", 0, 222), ("utility", 0, 412)]
    my_team = [{"cellId": i, "assignedPosition": pos, "championId": cid, "championPickIntent": intent,
                "summonerId": 1000 + i, "puuid": f"secret-{i}", "gameName": f"아군{i}", "nameVisibilityType": "HIDDEN"}
               for i, (pos, cid, intent) in enumerate(mine)]
    their = [{"cellId": 5 + i, "assignedPosition": "", "championId": cid, "summonerId": 0, "puuid": ""}
             for i, cid in enumerate([75, 30, 0, 0, 0])]
    actions = [
        [{"actorCellId": c, "championId": cid, "completed": True, "isInProgress": False, "type": "ban"}
         for c, cid in enumerate([157, 238, 0, 0, 0, 555, 0, 0, 0, 0])],
        [{"actorCellId": 0, "championId": 58, "completed": True, "isInProgress": False, "type": "pick"},
         {"actorCellId": 5, "championId": 75, "completed": True, "isInProgress": False, "type": "pick"}],
        [{"actorCellId": 1, "championId": 64, "completed": True, "isInProgress": False, "type": "pick"},
         {"actorCellId": 2, "championId": 103, "completed": True, "isInProgress": False, "type": "pick"}],
        [{"actorCellId": 6, "championId": 30, "completed": True, "isInProgress": False, "type": "pick"}],
        [{"actorCellId": 4, "championId": 0, "completed": False, "isInProgress": True, "type": "pick"}],
    ]
    return {"localPlayerCellId": 4, "myTeam": my_team, "theirTeam": their, "actions": actions,
            "bans": {"myTeamBans": [], "theirTeamBans": []}, "timer": {"phase": "BAN_PICK"}}


class HelperTest(unittest.TestCase):
    def test_parse_session(self):
        st = h.parse_session(session(), NAMES)
        self.assertTrue(st["inChampSelect"])
        self.assertEqual(st["myPosition"], "SUP")
        self.assertEqual(st["myTurn"], "pick")
        self.assertEqual([a["lane"] for a in st["allies"]], ["TOP", "JGL", "MID", "ADC", "SUP"])
        self.assertEqual([a["champ"] for a in st["allies"]], ["레넥톤", "리 신", "아리", "징크스", "쓰레쉬"])
        self.assertEqual([a["locked"] for a in st["allies"]], [True, True, True, False, False])
        self.assertEqual([e["champ"] for e in st["enemies"]], ["나서스", "카서스"])
        self.assertEqual(st["bans"], sorted(["야스오", "제드", "파이크"]))

    def test_no_personal_info(self):
        text = json.dumps(h.parse_session(session(), NAMES), ensure_ascii=False)
        for secret in ("secret-", "아군0", "1000", "summonerId", "puuid", "gameName"):
            self.assertNotIn(secret, text)

    def test_not_in_champ_select(self):
        self.assertEqual(h.parse_session(None, NAMES), {"inChampSelect": False})

    def test_credentials(self):
        self.assertEqual(h.parse_lockfile("LeagueClient:12345:54321:abcDEF-123:https"), (54321, "abcDEF-123"))
        self.assertIsNone(h.parse_lockfile("broken"))
        args = '"/Applications/League of Legends.app/.../LeagueClientUx" --remoting-auth-token=Xy-9_z --app-port=60123 --install-directory=/x'
        self.assertEqual(h.parse_process_args(args), (60123, "Xy-9_z"))


if __name__ == "__main__":
    unittest.main()
