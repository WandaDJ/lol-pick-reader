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

// 3-1) 받는 도중 한도(429)에 걸려도 받은 만큼 저장하고 이어 받기
{
  const envRL = { ...envNoKV, POOL_KV: new FakeKV() };
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/matches/KR_") && ++n === 10) return new Response("{}", { status: 429, headers: { "Retry-After": "5" } });
    return realFetch(url, init);
  };
  const b1 = await (await call(envRL, "동재#KR1")).json();
  assert.equal(b1.rateLimited, true);
  assert.ok(b1.storedGames >= 8 && b1.storedGames < 35, `한도 전까지 받은 ${b1.storedGames}판 저장`);
  globalThis.fetch = realFetch;
  const b2 = await (await call(envRL, "동재#KR1")).json();
  assert.equal(b2.rateLimited, false);
  assert.ok(b2.storedGames > b1.storedGames, "다음 요청에서 이어 받음");
}

// 4) 도우미가 보낸 클라이언트 기록 합치기
const envIn = { ...envLimited, ALLOWED_RIOT_IDS: "동재#KR1", POOL_KV: new FakeKV() };
const post = (env, body, origin = "http://127.0.0.1:27150") => worker.fetch(new Request("https://w.example/ingest",
  { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
const cg = [
  { id: "KR_1000", q: 420, d: 1800, t: 1, lane: "SUP", c: "쓰레쉬", w: true },      // 서버가 나중에 받을 경기와 같은 ID
  { id: "KR_5", q: 490, d: 1600, t: 2, lane: null, c: "샤코", w: true },             // 포지션 없음 → 페이지가 추정
  { id: "KR_6", q: 1700, d: 1200, t: 3, lane: null, c: "파이크", w: false },        // 아레나 → 제외
  { id: "bad id", q: 420, d: 1800, lane: "SUP", c: "x", w: true },                 // 형식 오류 → 무시
];
calls = 0;
let r = await post(envIn, { riotId: "동재#KR1", games: cg });
assert.equal(r.status, 200);
assert.deepEqual(await r.json(), { added: 3, stored: 3 });
assert.ok(calls <= 1, "기록 저장에는 Riot API를 쓰지 않음 (계정 조회 1번만)");
assert.equal((await (await post(envIn, { riotId: "동재#KR1", games: cg })).json()).added, 0);   // 중복은 안 늘어남
assert.equal((await post(envIn, { riotId: "모르는사람#KR1", games: cg })).status, 403);
assert.equal((await post({ ...envIn, ALLOWED_RIOT_IDS: "" }, { riotId: "동재#KR1", games: cg })).status, 403);  // 목록 없으면 저장 안 받음
const merged = await (await call(envIn, "동재#KR1")).json();
assert.deepEqual(merged.unknownLane, [{ name: "샤코", win: true }]);
assert.equal(merged.totalGames, 36);   // 클라이언트 KR_1000 + 서버 새 35판(다시하기 1판 제외 34) + 포지션 없는 1판
assert.equal(r.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:27150");

// 5) 오류와 CORS
let res = await call(envNoKV, "없는사람#KR1");
assert.equal(res.status, 404);
assert.match((await res.json()).error, /찾을 수 없어요/);
assert.equal((await call(envNoKV, "형식오류")).status, 400);
res = await call(envNoKV, "동재#KR1", "https://evil.example");
assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);

console.log("ok: 누적 35→70→75판, KV 없이 35판, 아이디 제한, 클라이언트 기록 합치기, 오류·CORS 확인");
