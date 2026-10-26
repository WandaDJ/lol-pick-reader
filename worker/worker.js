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
 *
 * POST /ingest  { riotId, games: [{ id, q, d, t, lane, c, w }] }
 *   PC 도우미가 읽은 클라이언트 전적(내 기록만)을 받아서 쌓아요. Riot API는 쓰지 않아요.
 *   등록된 아이디만 받고, 같은 경기를 서버가 Riot API로 받은 기록이 있으면 그걸 우선해요.
 *
 * 수집은 누군가 페이지에서 불러오기를 누를 때만 해요. 한 번에 새 경기를 최대 35판 받고,
 * 페이지가 1분마다 이어서 요청해서 300판까지 채워요.
 *
 * Riot API 키는 이 서버 안에서만 쓰이고 페이지로는 절대 내려가지 않아요.
 */

const PLATFORM = "kr";
const REGION = "asia";
const RANKED_SOLO = 420;
const KEEP_MATCHES = 300;       // 아이디별로 보관하는 최근 경기 수
const NEW_PER_LOAD = 35;        // 한 번 불러올 때 새로 받는 경기 수 (무료 플랜 외부 호출 50회 한도 안)
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
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true", Vary: "Origin" }
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

const POOL_QUEUE_IDS = new Set([400, 420, 430, 440, 480, 490]);
const LANES_OK = new Set(Object.values(POS));

/** PC 도우미가 보낸 클라이언트 기록 합치기 */
export async function ingest(env, body) {
  const id = parseRiotId(body && body.riotId);
  if (!id) throw new HttpError(400, "아이디 형식이 잘못됐어요.");
  if (!String(env.ALLOWED_RIOT_IDS || "").trim() || !isAllowed(env, id)) {
    throw new HttpError(403, "등록된 아이디만 서버에 기록을 저장할 수 있어요.");
  }
  if (!env.POOL_KV) throw new HttpError(500, "서버에 저장소(POOL_KV)가 연결되지 않았어요.");
  const games = Array.isArray(body.games) ? body.games.slice(0, 100) : [];
  const account = await getAccount(env, id);
  const kvKey = `pool:${account.puuid}`;
  const stored = (await env.POOL_KV.get(kvKey, "json")) || { matches: {} };
  const known = stored.matches;
  let added = 0;
  for (const g of games) {
    if (!g || typeof g.id !== "string" || !/^[A-Z0-9]{2,5}_\d{1,15}$/.test(g.id) || g.id in known) continue;
    const champ = typeof g.c === "string" ? g.c.slice(0, 24) : "";
    if (!champ) continue;
    const t = Number(g.t) || 0, d = Number(g.d) || 0, q = Number(g.q);
    if (!POOL_QUEUE_IDS.has(q) || d < 15 * 60) known[g.id] = { skip: true, t, src: "client" };
    else known[g.id] = { lane: LANES_OK.has(g.lane) ? g.lane : null, champ, win: !!g.w, t, src: "client" };
    added += 1;
  }
  if (added) {
    const keep = new Set(Object.keys(known).sort((a, b) => matchNum(b) - matchNum(a)).slice(0, KEEP_MATCHES));
    for (const m of Object.keys(known)) if (!keep.has(m)) delete known[m];
    await env.POOL_KV.put(kvKey, JSON.stringify({ ...stored, matches: known, updated: Date.now() }));
  }
  return { added, stored: Object.keys(known).length };
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
  const unknownLane = [];
  for (const r of Object.values(known)) {
    if (r.skip) { skipped += 1; continue; }
    if (!r.lane) { unknownLane.push({ name: r.champ, win: !!r.win }); continue; }  // 포지션 없는 클라이언트 기록
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
    totalGames: total + unknownLane.length,
    skippedGames: skipped,
    unknownLane,
    pending,
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
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKeyFor = (rid) => new Request(`https://cache.local/pool/${encodeURIComponent(String(rid || "").trim().toLowerCase())}`);
    if (request.method === "POST" && url.pathname === "/ingest") {
      try {
        const text = await request.text();
        if (text.length > 64 * 1024) throw new HttpError(413, "한 번에 보내는 기록이 너무 많아요.");
        const body = JSON.parse(text || "{}");
        const out = await ingest(env, body);
        if (cache && out.added) ctx.waitUntil(cache.delete(cacheKeyFor(body.riotId)));
        return json(out, 200, cors);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 400;
        return json({ error: e instanceof HttpError ? e.message : "요청 형식이 잘못됐어요." }, status, cors);
      }
    }
    if (request.method !== "GET" || url.pathname !== "/pool") return json({ error: "GET /pool?riotId=이름%23태그" }, 404, cors);
    if (!env.RIOT_API_KEY) return json({ error: "서버에 RIOT_API_KEY가 설정되지 않았어요." }, 500, cors);

    const riotId = url.searchParams.get("riotId") || "";
    const cacheKey = cacheKeyFor(riotId);
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
