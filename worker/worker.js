/**
 * 픽창 판독기 챔프폭 중계 서버 (Cloudflare Worker)
 *
 * GET /pool?riotId=이름%23태그
 *   → {
 *       riotId, mainPosition,
 *       totalGames,        // 집계에 쓴 최근 랭크 경기 수 (최대 100)
 *       pending,           // 아직 못 받은 최근 경기 수 (다시 불러오면 이어서 받음)
 *       positions: { SUP: [{ name, games, wins }], ... },
 *       mastery: [{ name, points, level }]
 *     }
 *
 * 설정 (Cloudflare 대시보드 → Worker → Settings)
 *   RIOT_API_KEY    (Secret)      Riot API 키
 *   ALLOWED_ORIGIN  (Text)        https://wandadj.github.io   여러 개면 쉼표로 구분
 *   POOL_KV         (KV 바인딩)    선택. 연결하면 아이디별 경기를 최대 100판까지 쌓아둬요.
 *                                  없으면 매번 최근 30판만 봐요.
 *
 * Riot API 키는 이 서버 안에서만 쓰이고 페이지로는 절대 내려가지 않아요.
 */

const PLATFORM = "kr";
const REGION = "asia";
const RANKED_SOLO = 420;
const KEEP_MATCHES = 100;       // 아이디별로 보관하는 최근 경기 수
const NEW_PER_LOAD = 30;        // 한 번 불러올 때 새로 받는 경기 수 (무료 플랜 외부 호출 50회 한도 안)
const BATCH = 10;               // 동시에 받는 경기 수
const MASTERY_COUNT = 40;
const CACHE_SECONDS = 10 * 60;  // 같은 아이디 응답 캐시
const POS = { TOP: "TOP", JUNGLE: "JGL", MIDDLE: "MID", BOTTOM: "ADC", UTILITY: "SUP" };

export class HttpError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ok
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, OPTIONS", Vary: "Origin" }
    : { Vary: "Origin" };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

async function riot(env, host, path) {
  const res = await fetch(`https://${host}.api.riotgames.com${path}`, {
    headers: { "X-Riot-Token": env.RIOT_API_KEY },
  });
  if (res.status === 404) return null;
  if (res.status === 429) throw new HttpError(429, "요청이 많아요. 잠시 후 다시 시도하세요.", res.headers.get("Retry-After") || "10");
  if (res.status === 401 || res.status === 403) throw new HttpError(502, "서버의 Riot API 키가 만료됐거나 잘못됐어요.");
  if (!res.ok) throw new HttpError(502, `Riot API 오류 (${res.status})`);
  return res.json();
}

let champCache = null;
async function championNames(env) {
  if (champCache) return champCache;
  if (env.POOL_KV) {
    const saved = await env.POOL_KV.get("champ-names", "json");
    if (saved && Date.now() - saved.at < 24 * 3600 * 1000) return (champCache = saved);
  }
  const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
  const data = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/ko_KR/champion.json`)).json()).data;
  const byKey = {}, byId = {};
  for (const c of Object.values(data)) {
    byKey[c.key] = c.name;
    byId[c.id.toLowerCase()] = c.name;
  }
  champCache = { byKey, byId, at: Date.now() };
  if (env.POOL_KV) await env.POOL_KV.put("champ-names", JSON.stringify(champCache));
  return champCache;
}

export function parseRiotId(raw) {
  const s = String(raw || "").trim();
  const i = s.lastIndexOf("#");
  if (i <= 0 || i === s.length - 1) return null;
  const name = s.slice(0, i).trim(), tag = s.slice(i + 1).trim();
  if (name.length > 32 || tag.length > 8 || !name || !tag) return null;
  return { name, tag };
}

/** 경기 하나에서 내 기록만 뽑음. 랭크가 아니거나 15분 미만이면 skip 표시. */
function myRecord(match, puuid, names) {
  const info = match && match.info;
  const me = info && info.participants.find((p) => p.puuid === puuid);
  if (!me || !POS[me.teamPosition] || info.gameDuration < 15 * 60) return { skip: true, t: info?.gameCreation || 0 };
  return {
    lane: POS[me.teamPosition],
    champ: names.byId[String(me.championName).toLowerCase()] || me.championName,
    win: !!me.win,
    t: info.gameCreation || 0,
  };
}

export async function buildPool(env, riotId) {
  const id = parseRiotId(riotId);
  if (!id) throw new HttpError(400, "아이디는 '이름#태그' 형식으로 입력하세요. 예: Hide on bush#KR1");

  const account = await riot(env, REGION,
    `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(id.name)}/${encodeURIComponent(id.tag)}`);
  if (!account) throw new HttpError(404, "그 아이디를 찾을 수 없어요. 이름과 태그를 다시 확인하세요.");
  const puuid = account.puuid;
  const names = await championNames(env);

  const [mastery, recentIds] = await Promise.all([
    riot(env, PLATFORM, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=${MASTERY_COUNT}`),
    riot(env, REGION, `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=${RANKED_SOLO}&start=0&count=${KEEP_MATCHES}`),
  ]);
  const ids = recentIds || [];

  // 저장된 기록 불러오기
  const kvKey = `pool:${puuid}`;
  const stored = (env.POOL_KV && (await env.POOL_KV.get(kvKey, "json"))) || { matches: {} };
  const known = stored.matches;

  // 새 경기만, 최신 순으로 최대 NEW_PER_LOAD개
  const todo = ids.filter((m) => !(m in known)).slice(0, NEW_PER_LOAD);
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const got = await Promise.all(chunk.map((m) => riot(env, REGION, `/lol/match/v5/matches/${m}`)));
    chunk.forEach((m, j) => { if (got[j]) known[m] = myRecord(got[j], puuid, names); });
  }

  // 최근 100판 범위만 남김 (목록에 없는 오래된 경기는 정리)
  const keep = new Set(ids);
  for (const m of Object.keys(known)) if (!keep.has(m)) delete known[m];
  if (env.POOL_KV) await env.POOL_KV.put(kvKey, JSON.stringify({ matches: known, updated: Date.now() }));

  const positions = {};
  const posGames = {};
  let total = 0;
  for (const r of Object.values(known)) {
    if (r.skip) continue;
    total += 1;
    const list = (positions[r.lane] ||= []);
    let row = list.find((x) => x.name === r.champ);
    if (!row) list.push((row = { name: r.champ, games: 0, wins: 0 }));
    row.games += 1;
    row.wins += r.win ? 1 : 0;
    posGames[r.lane] = (posGames[r.lane] || 0) + 1;
  }
  for (const list of Object.values(positions)) list.sort((a, b) => b.games - a.games || b.wins - a.wins);
  const mainPosition = Object.entries(posGames).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    riotId: `${account.gameName}#${account.tagLine}`,
    mainPosition,
    totalGames: total,
    pending: ids.filter((m) => !(m in known)).length,
    stored: !!env.POOL_KV,
    positions,
    positionGames: posGames,
    mastery: (mastery || []).map((c) => ({
      name: names.byKey[String(c.championId)] || String(c.championId),
      points: c.championPoints,
      level: c.championLevel,
    })),
  };
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/pool") return json({ error: "GET /pool?riotId=이름%23태그" }, 404, cors);
    if (!env.RIOT_API_KEY) return json({ error: "서버에 RIOT_API_KEY가 설정되지 않았어요." }, 500, cors);

    const riotId = url.searchParams.get("riotId") || "";
    const cacheKey = new Request(`https://cache.local/pool/${encodeURIComponent(riotId.trim().toLowerCase())}`);
    const cache = typeof caches !== "undefined" ? caches.default : null;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return json(await hit.json(), 200, { ...cors, "X-Cache": "HIT" });
    }
    try {
      const body = await buildPool(env, riotId);
      // 아직 받을 경기가 남았으면 다음 요청에서 이어 받도록 캐시하지 않음
      if (cache && body.pending === 0) {
        const stored = new Response(JSON.stringify(body), { headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` } });
        ctx.waitUntil(cache.put(cacheKey, stored));
      }
      return json(body, 200, cors);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const extra = e.retryAfter ? { "Retry-After": e.retryAfter } : {};
      return json({ error: e instanceof HttpError ? e.message : "서버 오류가 났어요." }, status, { ...cors, ...extra });
    }
  },
};
