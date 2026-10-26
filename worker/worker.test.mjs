// 가짜 Riot 응답으로 중계 서버 검증: node worker/worker.test.mjs
import assert from "node:assert/strict";
import worker, { parseRiotId } from "./worker.js";

const ME = "puuid-me";
const champs = { Thresh: ["412", "쓰레쉬"], Pyke: ["555", "파이크"], Nautilus: ["111", "노틸러스"], Ahri: ["103", "아리"] };

// 최근 랭크 75판: 서포터 위주, 미드 몇 판, 다시하기 1판
const matches = [];
for (let i = 0; i < 75; i++) {
  const pos = i % 10 === 9 ? "MIDDLE" : "UTILITY";
  const champ = pos === "MIDDLE" ? "Ahri" : ["Thresh", "Thresh", "Pyke", "Nautilus"][i % 4];
  matches.push({ pos, champ, win: i % 3 !== 0, dur: i === 5 ? 300 : 1800 });
}

let calls = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls++;
  const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
  if (u.includes("ddragon") && u.endsWith("versions.json")) return ok(["26.21.1"]);
  if (u.includes("ddragon")) return ok({ data: Object.fromEntries(Object.entries(champs).map(([id, [key, name]]) => [id, { id, key, name }])) });
  assert.equal(init.headers["X-Riot-Token"], "TEST-KEY");
  if (u.includes("by-riot-id/%EB%8F%99%EC%9E%AC/KR1")) return ok({ puuid: ME, gameName: "동재", tagLine: "KR1" });
  if (u.includes("by-riot-id")) return new Response("{}", { status: 404 });
  if (u.includes("champion-masteries")) {
    assert.match(u, /count=40/);
    return ok([{ championId: 412, championPoints: 250000, championLevel: 30 }, { championId: 111, championPoints: 120000, championLevel: 20 }]);
  }
  if (u.includes("/ids?")) {
    assert.match(u, /count=100/);
    if (!u.includes("type=ranked")) return ok([]);          // 일반 큐 기록 없음
    const start = Number(u.match(/start=(\d+)/)[1]);
    return ok(matches.map((_, i) => `KR_${1000 - i}`).slice(start, start + 100));  // 최신순
  }
  const i = 1000 - Number(u.split("KR_")[1]);
  const m = matches[i];
  return ok({ info: { gameDuration: m.dur, gameCreation: 1e12 - i, participants: [
    { puuid: "other", teamPosition: "TOP", championName: "Garen", win: !m.win },
    { puuid: ME, teamPosition: m.pos, championName: m.champ, win: m.win },
  ] } });
};

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, v); }
}

const ctx = { waitUntil() {} };
const call = (env, q, origin = "https://wandadj.github.io") =>
  worker.fetch(new Request(`https://w.example/pool?riotId=${encodeURIComponent(q)}`, { headers: { Origin: origin } }), env, ctx);

assert.deepEqual(parseRiotId("Hide on bush#KR1"), { name: "Hide on bush", tag: "KR1" });
assert.equal(parseRiotId("태그없음"), null);

// 1) KV 있음: 30판씩 이어 받아서 75판까지 누적
const env = { RIOT_API_KEY: "TEST-KEY", ALLOWED_ORIGIN: "https://wandadj.github.io", POOL_KV: new FakeKV() };
const loads = [];
for (let n = 0; n < 3; n++) {
  calls = 0;
  const res = await call(env, "동재#KR1");
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.ok(calls <= 45, `외부 호출 ${calls}회는 무료 플랜 한도(50)에 가까움`);
  assert.ok(!JSON.stringify(b).includes("TEST-KEY"));
  loads.push(b);
}
assert.deepEqual(loads.map((b) => b.pending), [40, 5, 0]);
assert.equal(loads[0].totalGames, 34);   // 35판 중 다시하기 1판 제외
assert.equal(loads[2].totalGames, 74);   // 75판 중 다시하기 1판 제외
const last = loads[2];
assert.equal(last.mainPosition, "SUP");
assert.equal(last.positions.SUP[0].name, "쓰레쉬");
assert.equal(last.positionGames.MID, 7);
assert.equal(last.mastery[1].name, "노틸러스");
assert.equal(last.stored, true);

// 2) KV 없음: 매번 최근 30판만
const envNoKV = { RIOT_API_KEY: "TEST-KEY", ALLOWED_ORIGIN: "https://wandadj.github.io" };
const b2 = await (await call(envNoKV, "동재#KR1")).json();
assert.equal(b2.totalGames, 34);
assert.equal(b2.pending, 40);
assert.equal(b2.stored, false);

// 3) 등록한 아이디만 허용 (Personal Key용)
const envLimited = { ...envNoKV, ALLOWED_RIOT_IDS: "다른사람#KR1, 동 재#kr1" };
assert.equal((await call(envLimited, "동재#KR1")).status, 200);   // 공백·대소문자 무시
calls = 0;
const denied = await call(envLimited, "모르는사람#KR1");
assert.equal(denied.status, 403);
assert.match((await denied.json()).error, /등록된 아이디만/);
assert.equal(calls, 0, "허용 안 된 아이디는 Riot API를 호출하지 않아야 함");

// 4) 오류와 CORS
let res = await call(envNoKV, "없는사람#KR1");
assert.equal(res.status, 404);
assert.match((await res.json()).error, /찾을 수 없어요/);
assert.equal((await call(envNoKV, "형식오류")).status, 400);
res = await call(envNoKV, "동재#KR1", "https://evil.example");
assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);

console.log("ok: 누적 35→70→75판, KV 없이 35판, 아이디 제한, 오류·CORS 확인");
