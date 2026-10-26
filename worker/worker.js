/**
 * 픽창 판독기 챔프폭 중계 서버 (Cloudflare Worker)
 *
 * GET /pool?riotId=이름%23태그
 *   → { riotId, mainPosition, positions: { SUP: [{name, games, wins}], ... }, mastery: [{name, points, level}] }
 *
 * 필요한 설정 (Cloudflare 대시보드 → Worker → Settings → Variables and Secrets)
 *   RIOT_API_KEY    (Secret)  Riot API 키
 *   ALLOWED_ORIGIN  (Text)    https://wandadj.github.io   여러 개면 쉼표로 구분
 *
 * Riot API 키는 이 서버 안에서만 쓰이고 페이지로는 절대 내려가지 않아요.
 */

const PLATFORM = "kr";
const REGION = "asia";
const RANKED_SOLO = 420;
const MATCH_COUNT = 15;          // 조회할 최근 랭크 경기 수 (경기당 요청 1회)
const MASTERY_COUNT = 25;
const CACHE_SECONDS = 60 * 60;   // 같은 아이디는 1시간 캐시
const POS = { TOP: "TOP", JUNGLE: "JGL", MIDDLE: "MID", BOTTOM: "ADC", UTILITY: "SUP" };

class HttpError extends Error {
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
async function championNames() {
  if (champCache) return champCache;
  const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
  const data = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/ko_KR/champion.json`)).json()).data;
  const byKey = {}, byId = {};
  for (const c of Object.values(data)) {
    byKey[c.key] = c.name;
    byId[c.id.toLowerCase()] = c.name;
  }
  champCache = { byKey, byId };
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

export async function buildPool(env, riotId) {
  const id = parseRiotId(riotId);
  if (!id) throw new HttpError(400, "아이디는 '이름#태그' 형식으로 입력하세요. 예: Hide on bush#KR1");

  const account = await riot(env, REGION,
    `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(id.name)}/${encodeURIComponent(id.tag)}`);
  if (!account) throw new HttpError(404, "그 아이디를 찾을 수 없어요. 이름과 태그를 다시 확인하세요.");
  const puuid = account.puuid;
  const names = await championNames();

  const [mastery, matchIds] = await Promise.all([
    riot(env, PLATFORM, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=${MASTERY_COUNT}`),
    riot(env, REGION, `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=${RANKED_SOLO}&start=0&count=${MATCH_COUNT}`),
  ]);

  const positions = {};
  const posGames = {};
  for (const mid of matchIds || []) {
    const m = await riot(env, REGION, `/lol/match/v5/matches/${mid}`);
    const me = m && m.info && m.info.participants.find((p) => p.puuid === puuid);
    if (!me || !POS[me.teamPosition] || m.info.gameDuration < 15 * 60) continue;
    const lane = POS[me.teamPosition];
    const name = names.byId[String(me.championName).toLowerCase()] || me.championName;
    const list = (positions[lane] ||= []);
    let row = list.find((r) => r.name === name);
    if (!row) list.push((row = { name, games: 0, wins: 0 }));
    row.games += 1;
    row.wins += me.win ? 1 : 0;
    posGames[lane] = (posGames[lane] || 0) + 1;
  }
  for (const list of Object.values(positions)) list.sort((a, b) => b.games - a.games || b.wins - a.wins);
  const mainPosition = Object.entries(posGames).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    riotId: `${account.gameName}#${account.tagLine}`,
    mainPosition,
    matchesChecked: (matchIds || []).length,
    positions,
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
      if (cache) {
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
