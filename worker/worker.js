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
 *   ALLOWED_RIOT_IDS (Text)       조회를 허용할 아이디 목록, 쉼표로 구분 (예: 동재#KR1, 친구#KR1)
 *                                  Personal API Key는 개인·지인용이라 이 값을 꼭 넣으세요.
 *                                  비우면 누구나 조회 가능 (Production Key를 받은 뒤에만)
 *   POOL_KV         (KV 바인딩)    아이디별 경기를 최근 300판까지 쌓아둬요.
 *                                  없으면 매번 최근 35판만 봐요.
 *   예약 실행(Cron)  선택. "5분마다"로 켜두면 ALLOWED_RIOT_IDS의 아이디들을 돌아가며
 *                                  5분마다 새 경기를 모아둬요. (KV 필요)
 *
 * Riot API 키는 이 서버 안에서만 쓰이고 페이지로는 절대 내려가지 않아요.
 */

const PLATFORM = "kr";
const REGION = "asia";
const RANKED_SOLO = 420;
const KEEP_MATCHES = 300;       // 아이디별로 보관하는 최근 경기 수
const NEW_PER_LOAD = 35;        // 한 번 불러올 때 새로 받는 경기 수 (무료 플랜 외부 호출 50회 한도 안)
const NEW_PER_CRON = 40;        // 예약 실행 한 번에 새로 받는 경기 수
// 포지션이 있는 큐만: 솔로·자유 랭크, 빠른 대전, 일반 드래프트, 신속 대전
const ID_QUERIES = ["type=ranked", "queue=490", "queue=400", "queue=480"];
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
  // 내 기록만 남김 (같이 한 다른 플레이어 정보는 저장하지 않음)
  return {
    lane: POS[me.teamPosition],
    champ: names.byId[String(me.championName).toLowerCase()] || me.championName,
    win: !!me.win,
    t: info.gameCreation || 0,
  };
}

const idKey = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

export function isAllowed(env, id) {
  const list = String(env.ALLOWED_RIOT_IDS || "").split(",").map(idKey).filter(Boolean);
  return !list.length || list.includes(idKey(`${id.name}#${id.tag}`));
}

const matchNum = (m) => Number(String(m).split("_")[1]) || 0;

async function getAccount(env, id) {
  const key = `acct:${idKey(`${id.name}#${id.tag}`)}`;
  const cached = env.POOL_KV && (await env.POOL_KV.get(key, "json"));
  if (cached) return cached;
  const account = await riot(env, REGION,
    `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(id.name)}/${encodeURIComponent(id.tag)}`);
  if (!account) throw new HttpError(404, "그 아이디를 찾을 수 없어요. 이름과 태그를 다시 확인하세요.");
  const slim = { puuid: account.puuid, gameName: account.gameName, tagLine: account.tagLine };
  if (env.POOL_KV) await env.POOL_KV.put(key, JSON.stringify(slim), { expirationTtl: 7 * 24 * 3600 });
  return slim;
}

/** 포지션이 있는 큐의 최근 경기 ID (최신순, 최대 KEEP_MATCHES) */
async function matchIdList(env, puuid, full) {
  const base = `/lol/match/v5/matches/by-puuid/${puuid}/ids?`;
  const lists = await Promise.all(ID_QUERIES.map((q) => riot(env, REGION, `${base}${q}&start=0&count=100`)));
  if (full && (lists[0] || []).length === 100) { // 처음 채울 때는 랭크를 더 과거까지
    for (const start of [100, 200]) {
      const more = (await riot(env, REGION, `${base}type=ranked&start=${start}&count=100`)) || [];
      lists.push(more);
      if (more.length < 100) break;
    }
  }
  return [...new Set(lists.flat().filter(Boolean))].sort((a, b) => matchNum(b) - matchNum(a)).slice(0, KEEP_MATCHES);
}

/** 새 경기만 최대 budget개 받아서 KV에 쌓음 */
export async function syncUser(env, puuid, budget, names) {
  const kvKey = `pool:${puuid}`;
  const stored = (env.POOL_KV && (await env.POOL_KV.get(kvKey, "json"))) || { matches: {} };
  const known = stored.matches;
  const ids = await matchIdList(env, puuid, Object.keys(known).length < KEEP_MATCHES - 50);
  const todo = ids.filter((m) => !(m in known)).slice(0, budget);
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const got = await Promise.all(chunk.map((m) => riot(env, REGION, `/lol/match/v5/matches/${m}`)));
    chunk.forEach((m, j) => { if (got[j]) known[m] = myRecord(got[j], puuid, names); });
  }
  // 최신 300판만 남김
  const keep = new Set([...new Set([...Object.keys(known), ...ids])].sort((a, b) => matchNum(b) - matchNum(a)).slice(0, KEEP_MATCHES));
  for (const m of Object.keys(known)) if (!keep.has(m)) delete known[m];
  const pending = ids.filter((m) => !(m in known)).length;
  if (env.POOL_KV && (todo.length || stored.pending !== pending)) {
    await env.POOL_KV.put(kvKey, JSON.stringify({ matches: known, pending, updated: Date.now() }));
  }
  return { known, pending };
}

/** 예약 실행: 등록된 아이디를 한 명씩 돌아가며 새 경기를 모음 */
export async function cronSync(env) {
  const list = String(env.ALLOWED_RIOT_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!list.length || !env.POOL_KV || !env.RIOT_API_KEY) return null;
  const n = Number(await env.POOL_KV.get("cron:next")) || 0;
  const raw = list[n % list.length];
  await env.POOL_KV.put("cron:next", String((n + 1) % list.length));
  const id = parseRiotId(raw);
  if (!id) return { riotId: raw, error: "형식 오류" };
  try { // 한 아이디에서 문제가 생겨도 다음 실행 때 다음 사람으로 넘어감
    const account = await getAccount(env, id);
    const names = await championNames(env);
    const { known, pending } = await syncUser(env, account.puuid, NEW_PER_CRON, names);
    return { riotId: raw, stored: Object.keys(known).length, pending };
  } catch (e) {
    return { riotId: raw, error: e.message };
  }
}

export async function buildPool(env, riotId) {
  const id = parseRiotId(riotId);
  if (!id) throw new HttpError(400, "아이디는 '이름#태그' 형식으로 입력하세요. 예: Hide on bush#KR1");
  if (!isAllowed(env, id)) throw new HttpError(403, "이 서버는 등록된 아이디만 조회할 수 있어요. 서버 관리자에게 아이디 등록을 요청하세요.");

  const account = await getAccount(env, id);
  const puuid = account.puuid;
  const names = await championNames(env);
  const [mastery, synced] = await Promise.all([
    riot(env, PLATFORM, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=${MASTERY_COUNT}`),
    syncUser(env, puuid, NEW_PER_LOAD, names),
  ]);
  const { known, pending } = synced;

  const positions = {};
  const posGames = {};
  let total = 0, skipped = 0;
  for (const r of Object.values(known)) {
    if (r.skip) { skipped += 1; continue; }
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
    skippedGames: skipped,
    pending,
    stored: !!env.POOL_KV,
    autoSync: !!(env.POOL_KV && String(env.ALLOWED_RIOT_IDS || "").trim()),
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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cronSync(env).catch(() => null));
  },

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
