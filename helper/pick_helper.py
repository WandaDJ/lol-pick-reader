#!/usr/bin/env python3
"""
픽창 판독기 PC 도우미

롤 클라이언트가 켜져 있으면 클라이언트의 로컬 API(LCU)에서 픽창 상태를 읽어
http://127.0.0.1:27150/ 에 픽창 판독기 페이지를 띄우고 자동으로 채워줍니다.

- 읽는 정보: 내 포지션, 양 팀 챔피언(확정·고민 중), 밴, 지금 누구 차례인지,
  그리고 로그인한 내 계정의 최근 전적·챔피언 숙련도 (챔프폭 계산용)
- 읽지 않는 정보: 아군·상대의 닉네임, 계정 ID 등 개인 정보 (Riot 정책상 금지)
- 모든 통신은 내 PC 안(127.0.0.1)에서만 이뤄지고, 외부로는 GitHub Pages에서
  페이지와 도우미 최신본을 받아올 때만 접속해요.
- Riot API 키(선택): 넣으면 내 계정 전적을 Riot 공식 기록에서 최근 300판까지 받아요.
  키는 이 PC의 ~/.lol-pick-reader/config.json 에만 저장되고, Riot 서버에만 보내요.
- 자동 업데이트: 켤 때 도우미 코드 최신본을 확인해 새 버전이면 그걸로 실행하고,
  켜져 있는 동안 10분마다 페이지 최신본을 받아요.

실행: python3 pick_helper.py      (Python 3.9 이상, 외부 패키지 필요 없음)
종료: 이 창을 닫거나 Ctrl+C
"""
from __future__ import annotations

import base64
import collections
import json
import os
import platform
import re
import runpy
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.6.0"
PORT = int(os.environ.get("PICK_HELPER_PORT", "27150"))
SITE = os.environ.get("PICK_HELPER_SITE", "https://wandadj.github.io/lol-pick-reader/")
SITE_FILES = ["index.html", "matchup.js", "data/stats.json", "data/config.json", "data/champ-notes.json", "data/matchups.json"]
LANE = {"top": "TOP", "jungle": "JGL", "middle": "MID", "bottom": "ADC", "utility": "SUP"}
ALLOWED_ORIGINS = {"https://wandadj.github.io", f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}


# ---------------------------------------------------------------- 경로
def bundled_dir() -> Path:
    """실행 파일에 묶인 페이지 사본 위치 (없으면 저장소 루트)."""
    if hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "site"
    return Path(__file__).resolve().parents[1]


def cache_dir() -> Path:
    d = Path.home() / ".lol-pick-reader" / "site"
    d.mkdir(parents=True, exist_ok=True)
    return d


def https_context() -> ssl.SSLContext:
    try:
        import certifi  # 실행 파일 빌드에 포함됨
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


# ---------------------------------------------------------------- 클라이언트 찾기
def lockfile_candidates() -> list[Path]:
    env = os.environ.get("LOL_LOCKFILE")
    if env:
        return [Path(env)]
    system = platform.system()
    if system == "Darwin":
        return [
            Path("/Applications/League of Legends.app/Contents/LoL/lockfile"),
            Path.home() / "Applications/League of Legends.app/Contents/LoL/lockfile",
        ]
    if system == "Windows":
        out = []
        for drive in "CDEFG":
            out += [Path(f"{drive}:/Riot Games/League of Legends/lockfile"),
                    Path(f"{drive}:/Program Files/Riot Games/League of Legends/lockfile")]
        return out
    return []


def parse_lockfile(text: str) -> tuple[int, str] | None:
    """lockfile 형식: 이름:PID:포트:비밀번호:프로토콜"""
    parts = text.strip().split(":")
    if len(parts) >= 5 and parts[2].isdigit():
        return int(parts[2]), parts[3]
    return None


def parse_process_args(args: str) -> tuple[int, str] | None:
    port = re.search(r"--app-port=(\d+)", args)
    token = re.search(r"--remoting-auth-token=([\w-]+)", args)
    if port and token:
        return int(port.group(1)), token.group(1)
    return None


def credentials_from_process() -> tuple[int, str] | None:
    """lockfile을 못 찾을 때: 실행 중인 클라이언트의 실행 인자에서 찾기 (설치 위치가 다른 경우)."""
    try:
        if platform.system() == "Windows":
            cmd = ["powershell", "-NoProfile", "-Command",
                   "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | "
                   "Select-Object -ExpandProperty CommandLine"]
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=8, creationflags=flags).stdout
        else:
            out = subprocess.run(["ps", "-A", "-o", "args="], capture_output=True, text=True, timeout=8).stdout
        for line in out.splitlines():
            if "LeagueClientUx" in line:
                found = parse_process_args(line)
                if found:
                    return found
    except Exception:
        pass
    return None


def find_credentials() -> tuple[int, str] | None:
    for p in lockfile_candidates():
        try:
            if p.exists():
                found = parse_lockfile(p.read_text(encoding="utf-8", errors="ignore"))
                if found:
                    return found
        except OSError:
            continue
    return credentials_from_process()


# ---------------------------------------------------------------- 클라이언트 API
class NotRunning(Exception):
    pass


class LCU:
    def __init__(self):
        self.creds: tuple[int, str] | None = None
        self.names: dict[int, str] = {}
        self.ctx = ssl.create_default_context()
        self.ctx.check_hostname = False
        self.ctx.verify_mode = ssl.CERT_NONE  # 클라이언트는 자체 서명 인증서를 씀 (127.0.0.1 전용)

    def get(self, path: str):
        if not self.creds:
            self.creds = find_credentials()
            self.names = {}
            if not self.creds:
                raise NotRunning()
        port, pw = self.creds
        token = base64.b64encode(f"riot:{pw}".encode()).decode()
        req = urllib.request.Request(f"https://127.0.0.1:{port}{path}",
                                     headers={"Authorization": f"Basic {token}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=3) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:  # 픽창이 아님
                return None
            if e.code in (401, 403):
                self.creds = None
                raise NotRunning()
            raise
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            self.creds = None
            raise NotRunning()

    def champion_names(self) -> dict[int, str]:
        if not self.names:
            rows = self.get("/lol-game-data/assets/v1/champion-summary.json") or []
            self.names = {int(r["id"]): r["name"] for r in rows if int(r.get("id", -1)) > 0}
        return self.names


# ---------------------------------------------------------------- 픽창 해석
def parse_session(sess: dict | None, names: dict[int, str]) -> dict:
    """
    클라이언트 픽창 정보를 페이지용으로 정리.
    챔피언·포지션·밴·차례만 남기고 소환사 이름, ID, puuid 등은 버린다.
    """
    if not sess:
        return {"inChampSelect": False}
    me = sess.get("localPlayerCellId")
    actions = [a for group in (sess.get("actions") or []) for a in group]

    locked = {a.get("actorCellId") for a in actions if a.get("type") == "pick" and a.get("completed")}
    bans = set()
    for a in actions:
        if a.get("type") == "ban" and a.get("completed") and (a.get("championId") or 0) > 0:
            bans.add(names.get(a["championId"]))
    b = sess.get("bans") or {}
    for cid in (b.get("myTeamBans") or []) + (b.get("theirTeamBans") or []):
        if cid and cid > 0:
            bans.add(names.get(cid))
    bans.discard(None)

    my_turn = None
    for a in actions:
        if a.get("actorCellId") == me and a.get("isInProgress") and not a.get("completed"):
            my_turn = a.get("type")

    allies = []
    for p in sess.get("myTeam") or []:
        cid = p.get("championId") or 0
        intent = p.get("championPickIntent") or 0
        chosen = cid if cid > 0 else intent
        allies.append({
            "lane": LANE.get(str(p.get("assignedPosition") or "").lower()),
            "champ": names.get(chosen) if chosen > 0 else None,
            "locked": p.get("cellId") in locked and cid > 0,
            "me": p.get("cellId") == me,
        })

    enemies = []
    for p in sess.get("theirTeam") or []:
        cid = p.get("championId") or 0
        if cid > 0:
            enemies.append({"champ": names.get(cid)})

    me_row = next((a for a in allies if a["me"]), None)
    return {
        "inChampSelect": True,
        "phase": (sess.get("timer") or {}).get("phase"),
        "myPosition": me_row and me_row["lane"],
        "myTurn": my_turn,
        "allies": allies,
        "enemies": enemies,
        "bans": sorted(bans),
    }


# ---------------------------------------------------------------- 내 챔프폭 (클라이언트에 로그인한 계정)
POOL_QUEUES = {400, 420, 430, 440, 480, 490}  # 일반(드래프트·블라인드), 솔로·자유 랭크, 신속 대전, 빠른 대전
RANKED_QUEUES = {420, 440}
MATCH_LANE = {"TOP": "TOP", "JUNGLE": "JGL", "MIDDLE": "MID", "MID": "MID"}


def match_lane(timeline: dict) -> str | None:
    lane = str(timeline.get("lane") or "").upper()
    role = str(timeline.get("role") or "").upper()
    if lane in MATCH_LANE:
        return MATCH_LANE[lane]
    if lane in ("BOTTOM", "BOT"):
        return "SUP" if "SUPPORT" in role else "ADC"
    return None


def parse_pool(summoner: dict, games: list[dict], mastery: list[dict], names: dict[int, str]) -> dict:
    """클라이언트 전적·숙련도를 중계 서버(/pool)와 같은 모양으로 정리."""
    puuid = summoner.get("puuid")
    positions: dict[str, list] = {}
    pos_games: dict[str, int] = {}
    unknown: list[dict] = []          # 포지션 정보가 없는 경기 (페이지가 챔피언으로 추정)
    skipped = {"mode": 0, "short": 0}
    total = ranked = 0
    seen = set()

    def add(lane, champ, win):
        row = next((r for r in positions.setdefault(lane, []) if r["name"] == champ), None)
        if not row:
            row = {"name": champ, "games": 0, "wins": 0}
            positions[lane].append(row)
        row["games"] += 1
        row["wins"] += 1 if win else 0
        pos_games[lane] = pos_games.get(lane, 0) + 1

    for g in games:
        gid = g.get("gameId")
        if gid in seen:
            continue
        seen.add(gid)
        if g.get("queueId") not in POOL_QUEUES:
            skipped["mode"] += 1
            continue
        if (g.get("gameDuration") or 0) < 15 * 60:
            skipped["short"] += 1
            continue
        parts = g.get("participants") or []
        me = parts[0] if len(parts) == 1 else None
        if me is None:  # 10명 전체가 들어있는 형식이면 내 participantId를 찾음
            pid = next((x.get("participantId") for x in g.get("participantIdentities") or []
                        if (x.get("player") or {}).get("puuid") == puuid), None)
            me = next((x for x in parts if x.get("participantId") == pid), None)
        champ = names.get((me or {}).get("championId") or 0)
        if not champ:
            continue
        win = bool((me.get("stats") or {}).get("win"))
        total += 1
        ranked += g.get("queueId") in RANKED_QUEUES
        lane = match_lane(me.get("timeline") or {})
        if lane:
            add(lane, champ, win)
        else:
            unknown.append({"name": champ, "win": win})
    for rows in positions.values():
        rows.sort(key=lambda r: (-r["games"], -r["wins"]))
    main = max(pos_games, key=pos_games.get) if pos_games else None
    top = sorted(mastery or [], key=lambda m: -(m.get("championPoints") or 0))[:40]
    return {
        "riotId": f"{summoner.get('gameName', '')}#{summoner.get('tagLine', '')}",
        "mainPosition": main,
        "totalGames": total,
        "rankedGames": ranked,
        "checkedGames": len(seen),
        "skipped": skipped,
        "unknownLane": unknown,
        "pending": 0,
        "stored": True,
        "source": "client",
        "positions": positions,
        "positionGames": pos_games,
        "mastery": [{"name": names.get(m.get("championId")), "points": m.get("championPoints") or 0,
                     "level": m.get("championLevel") or 0} for m in top if names.get(m.get("championId"))],
    }


# ---------------------------------------------------------------- Riot API로 내 전적 더 받기 (선택)
RIOT_HOST = os.environ.get("PICK_HELPER_RIOT_HOST", "https://asia.api.riotgames.com")
KEEP_MATCHES = 300
TEAM_POS = {"TOP": "TOP", "JUNGLE": "JGL", "MIDDLE": "MID", "BOTTOM": "ADC", "UTILITY": "SUP"}
KEY_RE = re.compile(r"^RGAPI-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def config_path() -> Path:
    return cache_dir().parent / "config.json"


def load_config() -> dict:
    try:
        return json.loads(config_path().read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(cfg: dict):
    p = config_path()
    p.write_text(json.dumps(cfg), encoding="utf-8")
    try:
        os.chmod(p, 0o600)  # 내 계정만 읽을 수 있게
    except OSError:
        pass


class BadKey(Exception):
    pass


class RiotSync:
    """내 계정(puuid)의 경기만 받아서 이 PC에 저장. 요청 한도(1초 20회, 2분 100회)를 지킴."""

    def __init__(self):
        self.status: dict = {"state": "off"}
        self.thread: threading.Thread | None = None
        self.calls: collections.deque = collections.deque()
        self.lock = threading.Lock()

    def path(self, puuid: str) -> Path:
        return cache_dir().parent / f"matches-{puuid[:16]}.json"

    def records(self, puuid: str) -> dict:
        with self.lock:
            try:
                return json.loads(self.path(puuid).read_text(encoding="utf-8"))
            except Exception:
                return {}

    def _save(self, puuid: str, recs: dict):
        with self.lock:
            self.path(puuid).write_text(json.dumps(recs, ensure_ascii=False), encoding="utf-8")

    def _wait(self):
        while True:
            now = time.monotonic()
            while self.calls and now - self.calls[0] > 120:
                self.calls.popleft()
            recent = [t for t in self.calls if now - t < 1]
            wait = 0.0
            if len(recent) >= 18:
                wait = 1 - (now - recent[0]) + 0.05
            if len(self.calls) >= 95:
                wait = max(wait, 120 - (now - self.calls[0]) + 0.5)
            if wait <= 0:
                self.calls.append(now)
                return
            time.sleep(wait)

    def get(self, key: str, path: str):
        for attempt in range(6):
            self._wait()
            req = urllib.request.Request(RIOT_HOST + path, headers={"X-Riot-Token": key, "User-Agent": "lol-pick-reader-helper"})
            try:
                with urllib.request.urlopen(req, context=https_context(), timeout=15) as r:
                    return json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(int(e.headers.get("Retry-After", "10")) + 1)
                    continue
                if e.code in (401, 403):
                    raise BadKey()
                if e.code == 404:
                    return None
                time.sleep(2 ** attempt)
            except (urllib.error.URLError, TimeoutError, OSError):
                time.sleep(2 ** attempt)
        return None

    def check_key(self, key: str, puuid: str) -> bool:
        try:
            return bool(self.get(key, f"/riot/account/v1/accounts/by-puuid/{puuid}"))
        except BadKey:
            return False

    def start(self, key: str, puuid: str, names: dict):
        if self.thread and self.thread.is_alive():
            return
        if self.status.get("state") == "done" and time.time() - self.status.get("at", 0) < 600:
            return  # 10분 안에 다시 동기화하지 않음
        self.thread = threading.Thread(target=self._run, args=(key, puuid, names), daemon=True)
        self.thread.start()

    def _run(self, key: str, puuid: str, names: dict):
        try:
            recs = self.records(puuid)
            ids: list[str] = []
            for start in range(0, KEEP_MATCHES, 100):
                got = self.get(key, f"/lol/match/v5/matches/by-puuid/{puuid}/ids?start={start}&count=100") or []
                ids += got
                if len(got) < 100:
                    break
            todo = [m for m in ids if m not in recs]
            done = len(ids) - len(todo)
            self.status = {"state": "syncing", "total": len(ids), "done": done}
            for i, mid in enumerate(todo, 1):
                m = self.get(key, f"/lol/match/v5/matches/{mid}")
                info = (m or {}).get("info") or {}
                me = next((p for p in info.get("participants") or [] if p.get("puuid") == puuid), None)
                recs[mid] = {"q": info.get("queueId"), "d": info.get("gameDuration") or 0, "t": info.get("gameCreation") or 0,
                             "lane": TEAM_POS.get((me or {}).get("teamPosition") or ""),
                             "c": names.get((me or {}).get("championId") or 0) or (me or {}).get("championName"),
                             "w": bool((me or {}).get("win"))} if me else {"q": None}
                self.status = {"state": "syncing", "total": len(ids), "done": done + i}
                if i % 10 == 0:
                    self._save(puuid, recs)
            keep = set(ids)
            recs = {k: v for k, v in recs.items() if k in keep}
            self._save(puuid, recs)
            self.status = {"state": "done", "total": len(ids), "done": len(ids), "at": time.time()}
        except BadKey:
            self.status = {"state": "badkey"}
        except Exception as e:
            self.status = {"state": "error", "error": str(e)[:200]}


SYNC = RiotSync()


def pool_from_records(summoner: dict, recs: dict, mastery: list[dict], names: dict[int, str]) -> dict:
    """Riot API 기록을 클라이언트 전적과 같은 형식으로 바꿔서 parse_pool로 집계."""
    games = []
    for i, (mid, r) in enumerate(sorted(recs.items(), key=lambda kv: -(kv[1].get("t") or 0))):
        if not r.get("c"):
            continue
        lane = {"TOP": ("TOP", "SOLO"), "JGL": ("JUNGLE", "NONE"), "MID": ("MIDDLE", "SOLO"),
                "ADC": ("BOTTOM", "DUO_CARRY"), "SUP": ("BOTTOM", "DUO_SUPPORT")}.get(r.get("lane"), ("NONE", "NONE"))
        cid = next((k for k, v in names.items() if v == r["c"]), 0)
        games.append({"gameId": mid, "queueId": r.get("q"), "gameDuration": r.get("d") or 0,
                      "participants": [{"championId": cid, "stats": {"win": r.get("w")},
                                        "timeline": {"lane": lane[0], "role": lane[1]}}]})
    out = parse_pool(summoner, games, mastery, names)
    out["source"] = "api"
    return out


# ---------------------------------------------------------------- 클라이언트 전적 누적 (이 PC)
def my_participant(g: dict, puuid: str) -> dict | None:
    parts = g.get("participants") or []
    if len(parts) == 1:
        return parts[0]
    pid = next((x.get("participantId") for x in g.get("participantIdentities") or []
                if (x.get("player") or {}).get("puuid") == puuid), None)
    return next((x for x in parts if x.get("participantId") == pid), None)


def match_id(g: dict) -> str:
    return f"{g.get('platformId') or 'KR'}_{g.get('gameId')}"


def accumulate_client_games(puuid: str, games: list[dict]) -> tuple[dict, list[dict]]:
    """
    클라이언트가 보여주는 최근 20판 정도를 경기 ID 기준으로 이 PC에 쌓아서 최근 300판까지 유지.
    내 기록만 남기고 다른 플레이어 정보는 저장하지 않음. (쌓인 전체, 이번에 읽은 경기) 반환
    """
    path = cache_dir().parent / f"client-matches-{puuid[:16]}.json"
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        stored = {}
    fresh = []
    for g in games:
        me = my_participant(g, puuid)
        if not me or not g.get("gameId"):
            continue
        slim = {"gameId": match_id(g), "queueId": g.get("queueId"), "gameDuration": g.get("gameDuration") or 0,
                "gameCreation": g.get("gameCreation") or 0,
                "participants": [{"championId": me.get("championId"), "stats": {"win": bool((me.get("stats") or {}).get("win"))},
                                  "timeline": {"lane": (me.get("timeline") or {}).get("lane"), "role": (me.get("timeline") or {}).get("role")}}]}
        stored[slim["gameId"]] = slim
        fresh.append(slim)
    newest = sorted(stored.values(), key=lambda x: -(x.get("gameCreation") or int(str(x["gameId"]).split("_")[-1] or 0)))[:KEEP_MATCHES]
    stored = {x["gameId"]: x for x in newest}
    try:
        path.write_text(json.dumps(stored, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    return stored, fresh


def client_records(games: list[dict], names: dict[int, str]) -> list[dict]:
    out = []
    for g in games:
        me = g["participants"][0]
        champ = names.get(me.get("championId") or 0)
        if champ:
            out.append({"id": g["gameId"], "q": g.get("queueId"), "d": g.get("gameDuration") or 0, "t": g.get("gameCreation") or 0,
                        "lane": match_lane(me.get("timeline") or {}), "c": champ, "w": bool(me["stats"]["win"])})
    return out


def load_pool(lcu: LCU) -> dict:
    names = lcu.champion_names()
    summoner = lcu.get("/lol-summoner/v1/current-summoner") or {}
    if not summoner.get("puuid"):
        raise NotRunning()
    key = load_config().get("riotApiKey")
    if key:
        SYNC.start(key, summoner["puuid"], names)
        recs = SYNC.records(summoner["puuid"])
        if len(recs) >= 5 or SYNC.status.get("state") == "done":
            try:
                mastery = lcu.get("/lol-champion-mastery/v1/local-player/champion-mastery") or []
            except NotRunning:
                raise
            except Exception:
                mastery = []
            out = pool_from_records(summoner, recs, mastery, names)
            out["sync"] = dict(SYNC.status)
            return out
    games: list[dict] = []
    ids = set()
    beg = 0
    while beg < 200 and len(ids) < 100:  # 최근 100판까지, 클라이언트가 주는 만큼
        try:
            data = lcu.get(f"/lol-match-history/v1/products/lol/current-summoner/matches?begIndex={beg}&endIndex={beg + 19}") or {}
        except NotRunning:
            raise
        except Exception:
            break
        chunk = ((data.get("games") or {}).get("games")) or []
        new = [g for g in chunk if g.get("gameId") not in ids]
        if not new:
            break
        for g in new:
            ids.add(g.get("gameId"))
        games += new
        beg += len(chunk)
    try:
        mastery = lcu.get("/lol-champion-mastery/v1/local-player/champion-mastery") or []
    except NotRunning:
        raise
    except Exception:
        mastery = []
    stored, fresh = accumulate_client_games(summoner["puuid"], games)
    out = parse_pool(summoner, list(stored.values()), mastery, names)
    out["fetchedGames"] = len(games)
    out["records"] = client_records(fresh, names)  # 중계 서버에 올릴 이번 기록 (내 기록만)
    if key:
        out["sync"] = dict(SYNC.status)
    return out


# ---------------------------------------------------------------- 상태 갱신
STATE = {"helper": VERSION, "client": "waiting", "inChampSelect": False, "updated": 0}
LOCK = threading.Lock()


LCU_CLIENT: LCU | None = None


def poll_loop(lcu: LCU, interval: float = 1.0):
    last_msg = None
    while True:
        try:
            names = lcu.champion_names()
            sess = lcu.get("/lol-champ-select/v1/session")
            st = parse_session(sess, names)
            st.update(client="connected")
            msg = "픽창 진행 중" if st["inChampSelect"] else "클라이언트 연결됨 · 픽창 대기 중"
            wait = interval
        except NotRunning:
            st = {"client": "waiting", "inChampSelect": False}
            msg = "롤 클라이언트를 기다리는 중이에요"
            wait = 3.0
        except Exception as e:  # 클라이언트 업데이트 등으로 응답 형식이 바뀐 경우
            st = {"client": "error", "inChampSelect": False, "error": str(e)[:200]}
            msg = f"클라이언트 응답을 읽지 못했어요: {e}"
            wait = 3.0
        st.update(helper=VERSION, site=SITE_STAMP, updated=time.time())
        with LOCK:
            STATE.clear()
            STATE.update(st)
        if msg != last_msg:
            print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)
            last_msg = msg
        time.sleep(wait)


def refresh_site():
    """페이지 최신본을 받아 캐시에 저장. 실패하면 실행 파일에 묶인 사본을 씀."""
    ctx = https_context()
    for f in SITE_FILES:
        try:
            with urllib.request.urlopen(SITE + f, context=ctx, timeout=10) as r:
                data = r.read()
            dest = cache_dir() / f
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        except Exception:
            pass


SITE_STAMP = ""  # 페이지가 바뀌면 달라지는 값 (페이지 자동 새로고침용)


def update_stamp():
    global SITE_STAMP
    import hashlib
    data = site_file("index.html") or b""
    SITE_STAMP = hashlib.sha1(data).hexdigest()[:12]


def refresh_loop(every: float = 600):
    while True:
        time.sleep(every)
        refresh_site()
        update_stamp()


def version_tuple(v: str) -> tuple:
    try:
        return tuple(int(x) for x in v.split("."))
    except ValueError:
        return (0,)


def self_update() -> bool:
    """
    GitHub Pages에 올라간 도우미 코드가 더 새 버전이면 받아서 그걸로 실행.
    새 코드 실행에 실패하면 False를 돌려주고 지금 버전으로 계속 실행.
    """
    if os.environ.get("PICK_HELPER_NO_UPDATE") or os.environ.get("PICK_HELPER_CHILD"):
        return False
    path = cache_dir().parent / "pick_helper.py"
    try:
        with urllib.request.urlopen(SITE + "helper/pick_helper.py", context=https_context(), timeout=10) as r:
            code = r.read().decode("utf-8")
        if re.search(r'^VERSION = "([\d.]+)"', code, re.M):
            path.write_text(code, encoding="utf-8")
    except Exception:
        pass  # 오프라인이면 예전에 받아둔 최신본이 있는지만 확인
    if not path.exists():
        return False
    m = re.search(r'^VERSION = "([\d.]+)"', path.read_text(encoding="utf-8", errors="ignore"), re.M)
    if not m or version_tuple(m.group(1)) <= version_tuple(VERSION):
        return False
    print(f"새 버전 {m.group(1)}을(를) 받았어요. 새 버전으로 실행합니다. (설치된 버전 {VERSION})")
    os.environ["PICK_HELPER_CHILD"] = "1"
    try:
        runpy.run_path(str(path), run_name="__main__")
        return True
    except SystemExit:
        return True
    except Exception as e:
        print(f"새 버전 실행에 실패해서 설치된 버전으로 실행해요: {e}")
        return False


def site_file(name: str) -> bytes | None:
    for base in (cache_dir(), bundled_dir()):
        p = base / name
        if p.is_file():
            return p.read_bytes()
    return None


# ---------------------------------------------------------------- 내 PC 전용 서버
class Handler(BaseHTTPRequestHandler):
    server_version = f"PickHelper/{VERSION}"

    def cors(self):
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def send_json(self, status: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        # 키 설정은 도우미가 띄운 페이지에서만 (다른 사이트가 몰래 바꾸지 못하게)
        if self.headers.get("Origin") not in (f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
            self.send_json(403, {"error": "허용되지 않은 요청이에요."})
            return
        if self.path.split("?")[0] != "/config":
            self.send_json(404, {"error": "없는 주소예요."})
            return
        try:
            data = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 4096)) or b"{}")
        except Exception:
            self.send_json(400, {"error": "요청 형식이 잘못됐어요."})
            return
        cfg = load_config()
        key = str(data.get("riotApiKey") or "").strip()
        if not key:
            cfg.pop("riotApiKey", None)
            save_config(cfg)
            SYNC.status = {"state": "off"}
            self.send_json(200, {"hasKey": False})
            return
        if not KEY_RE.match(key):
            self.send_json(400, {"error": "키 형식이 아니에요. RGAPI-로 시작하는 키를 그대로 붙여넣으세요."})
            return
        try:
            puuid = ((LCU_CLIENT or LCU()).get("/lol-summoner/v1/current-summoner") or {}).get("puuid")
        except NotRunning:
            puuid = None
        if not puuid:
            self.send_json(503, {"error": "롤 클라이언트에 로그인한 뒤 다시 시도하세요. (키 확인에 내 계정이 필요해요)"})
            return
        if not SYNC.check_key(key, puuid):
            self.send_json(400, {"error": "Riot이 이 키를 거절했어요. 만료됐거나 잘못 복사한 키인지 확인하세요."})
            return
        cfg["riotApiKey"] = key
        save_config(cfg)
        SYNC.status = {"state": "off"}
        self.send_json(200, {"hasKey": True})

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0].lstrip("/") or "index.html"
        if path == "pool":
            try:
                body = json.dumps(load_pool(LCU_CLIENT or LCU()), ensure_ascii=False).encode("utf-8")
                status = 200
            except NotRunning:
                body = json.dumps({"error": "롤 클라이언트에 로그인한 뒤 다시 시도하세요."}, ensure_ascii=False).encode("utf-8")
                status = 503
            except Exception as e:
                body = json.dumps({"error": f"클라이언트 전적을 읽지 못했어요: {e}"}, ensure_ascii=False).encode("utf-8")
                status = 500
            self.send_response(status)
            self.cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "config":
            self.send_json(200, {"hasKey": bool(load_config().get("riotApiKey")), "sync": dict(SYNC.status)})
            return
        if path == "state":
            with LOCK:
                body = json.dumps(STATE, ensure_ascii=False).encode("utf-8")
            ctype = "application/json; charset=utf-8"
        elif path in SITE_FILES:
            body = site_file(path)
            if body is None:
                self.send_error(404)
                return
            ctype = "text/html; charset=utf-8" if path.endswith(".html") else "text/javascript; charset=utf-8" if path.endswith(".js") else "application/json; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # 브라우저가 응답 도중 연결을 끊은 경우(새로고침, 탭 닫기)는 정상이라 조용히 넘김
        err = sys.exc_info()[1]
        if isinstance(err, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def main():
    if self_update():
        return
    url = f"http://127.0.0.1:{PORT}/"
    print(f"픽창 판독기 PC 도우미 {VERSION}")
    try:
        server = QuietServer(("127.0.0.1", PORT), Handler)
    except OSError:
        print("이미 실행 중이에요. 브라우저를 엽니다.")
        webbrowser.open(url)
        return
    if not os.environ.get("PICK_HELPER_NO_UPDATE"):
        refresh_site()
        threading.Thread(target=refresh_loop, daemon=True).start()
    update_stamp()
    global LCU_CLIENT
    LCU_CLIENT = LCU()
    threading.Thread(target=poll_loop, args=(LCU_CLIENT,), daemon=True).start()
    print(f"브라우저에서 {url} 를 여세요. (자동으로 열려요)")
    print("끝내려면 이 창을 닫거나 Ctrl+C를 누르세요.\n")
    if not os.environ.get("PICK_HELPER_NO_BROWSER"):
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")


if __name__ == "__main__":
    main()
