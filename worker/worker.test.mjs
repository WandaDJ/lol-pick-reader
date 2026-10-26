// 가짜 Riot 응답으로 중계 서버 검증: node worker/worker.test.mjs
import assert from "node:assert/strict";
import worker, { parseRiotId } from "./worker.js";

const ME = "puuid-me";
const champs = { Thresh: ["412", "쓰레쉬"], Pyke: ["555", "파이크"], Nautilus: ["111", "노틸러스"] };
const matches = [
  ["UTILITY", "Thresh", true], ["UTILITY", "Thresh", false], ["UTILITY", "Pyke", true],
  ["MIDDLE", "Pyke", true], ["UTILITY", "Thresh", true], ["UTILITY", "Nautilus", false],
];
let riotCalls = 0;

globalThis.fetch = async (url, init) => {
  const u = String(url);
  const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
  if (u.includes("ddragon") && u.endsWith("versions.json")) return ok(["26.21.1"]);
  if (u.includes("ddragon")) return ok({ data: Object.fromEntries(Object.entries(champs).map(([id, [key, name]]) => [id, { id, key, name }])) });
  riotCalls++;
  assert.equal(init.headers["X-Riot-Token"], "TEST-KEY");
  if (u.includes("by-riot-id/%EB%8F%99%EC%9E%AC/KR1")) return ok({ puuid: ME, gameName: "동재", tagLine: "KR1" });
  if (u.includes("by-riot-id")) return new Response("{}", { status: 404 });
  if (u.includes("champion-masteries")) return ok([{ championId: 412, championPoints: 250000, championLevel: 30 }, { championId: 555, championPoints: 90000, championLevel: 12 }]);
  if (u.includes("/ids?")) return ok(matches.map((_, i) => `KR_${i}`));
  const i = Number(u.split("KR_")[1]);
  const [pos, champ, win] = matches[i];
  return ok({ info: { gameDuration: 1800, participants: [{ puuid: "other", teamPosition: "TOP", championName: "Garen", win: !win }, { puuid: ME, teamPosition: pos, championName: champ, win }] } });
};

const env = { RIOT_API_KEY: "TEST-KEY", ALLOWED_ORIGIN: "https://wandadj.github.io" };
const ctx = { waitUntil() {} };
const call = (q, origin = "https://wandadj.github.io") =>
  worker.fetch(new Request(`https://w.example/pool?riotId=${encodeURIComponent(q)}`, { headers: { Origin: origin } }), env, ctx);

assert.deepEqual(parseRiotId("Hide on bush#KR1"), { name: "Hide on bush", tag: "KR1" });
assert.equal(parseRiotId("태그없음"), null);

let res = await call("동재#KR1");
assert.equal(res.status, 200);
assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://wandadj.github.io");
let body = await res.json();
assert.equal(body.riotId, "동재#KR1");
assert.equal(body.mainPosition, "SUP");
assert.deepEqual(body.positions.SUP[0], { name: "쓰레쉬", games: 3, wins: 2 });
assert.deepEqual(body.positions.MID, [{ name: "파이크", games: 1, wins: 1 }]);
assert.equal(body.mastery[0].name, "쓰레쉬");
assert.ok(!JSON.stringify(body).includes("TEST-KEY"), "키가 응답에 들어가면 안 됨");

res = await call("없는사람#KR1");
assert.equal(res.status, 404);
assert.match((await res.json()).error, /찾을 수 없어요/);

res = await call("형식오류");
assert.equal(res.status, 400);

res = await call("동재#KR1", "https://evil.example");
assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);

console.log(`ok (Riot 요청 ${riotCalls}회)`);
