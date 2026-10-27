// 맞라인 상대별 문장 만들기 (페이지와 테스트가 같이 씀)
// 직접 쓴 문장(data/pairs)이 있으면 먼저 보여주고, 나머지는 특성표(data/traits.json)로 비교해서 만들어요.
(function (root) {
  function jo(w, a, b) { const ch = String(w).trim().slice(-1).charCodeAt(0) - 0xAC00; return w + ((ch >= 0 && ch < 11172 && ch % 28) ? a : b); }
  const RANGE = ['', '근접', '짧은 원거리', '긴 원거리'];

  // 직접 쓴 문장에서 라인전 판정 읽기 (+1 유리, -1 불리, 0 모름)
  function handVerdict(t) {
    const s = t.replace(/[^.]*(약해서|약해요)[^.]*이겨요/g, ' 이겨요 ');
    const plus = (s.match(/이겨요|유리해요|압도적|쉽게 잡혀요|잡기 쉬워요/g) || []).length;
    const minus = (s.match(/불리해요|불리|져요|위험해요|바로 죽어요/g) || []).length;
    return plus > minus ? 1 : minus > plus ? -1 : 0;
  }

  // a: 내 챔피언, b: 상대, ctx: {D, T, pair, note, stat}
  function gen(a, b, ctx) {
    const D = ctx.D, T = ctx.T;
    const da = D[a], db = D[b], ta = T[a], tb = T[b];
    if (!da || !db || !ta || !tb || a === b && !ctx.pair) return null;
    const [ra, aa, pa, sa, ma, ca] = ta, [rb, ab, pb, sb, mb, cb] = tb;
    const A = a, B = b, lines = [];
    const hand = ctx.pair || '';

    // 라인전 점수
    const parts = { '초반 힘': (da[0] - db[0]) * 1.0, '올인 힘': (aa - ab) * 0.45, '견제': (pa - pb) * 0.35, '사거리': ctx.role === 'JGL' ? 0 : (ra - rb) * 0.3 };
    let score = Object.values(parts).reduce((s, v) => s + v, 0);
    let verdict = score >= 0.8 ? 1 : score <= -0.8 ? -1 : 0, src = 'trait';
    const st = ctx.stat;
    if (st && st.games >= 10) { verdict = st.wr >= 0.53 ? 1 : st.wr <= 0.47 ? -1 : 0; src = 'stat'; }
    else if (hand) { const hv = handVerdict(hand); if (hv) { verdict = hv; src = 'hand'; } }

    if (hand) lines.push(hand);
    if (src === 'stat') lines.push(`최근 통계로는 ${jo(A, '이', '가')} ${B} 상대로 승률 ${Math.round(st.wr * 100)}%예요 (${st.games}판).`);

    // 사거리 (정글은 라인이 없어서 건너뜀)
    const role = ctx.role || '', sup = role === 'SUP', jgl = role === 'JGL';
    const dr = ra - rb;
    let engageSaid = false;
    if (hand && src !== 'stat') { }
    else if (jgl) {
      const dm = da[1] - db[1];
      if (dm >= 1) lines.push(`10~20분 용·전령 싸움은 ${A} 쪽이 더 강해요. 오브젝트 1분 전에 강가 시야를 잡고 먼저 싸움을 거세요.`);
      else if (dm <= -1) lines.push(`10~20분 용·전령 싸움은 ${jo(B, '이', '가')} 더 강해요. 오브젝트가 나오기 전에 반대편 라인을 압박하거나 상대 정글 캠프를 가져가서 교환하세요.`);
      else lines.push(`10~20분 용·전령 싸움은 비슷해서 라이너가 먼저 합류하는 쪽이 가져가요. 라인 주도권이 있는 쪽 오브젝트를 고르세요.`);
    }
    else if (dr >= 2 && cb >= 3 && ab >= 3 && (engageSaid = true)) lines.push(`${jo(B, '은', '는')} 근접이지만 끌기·돌진 CC로 한 번에 붙어요. 미니언 뒤에 서서 ${B} 진입 스킬을 먼저 빼고, 그 스킬이 빠진 동안 견제하세요.`);
    else if (dr >= 2) lines.push(`${jo(B, '은', '는')} 근접이라 붙어야 딜을 넣어요. 미니언 뒤에서 견제하고, ${mb >= 2 ? `${B} 돌진기가 빠진 걸 보고` : `${jo(B, '이', '가')} 걸어서 다가올 때`} 바로 거리를 벌리세요.`);
    else if (dr === 1) lines.push(sup ? `사거리는 ${A} 쪽이 조금 더 길어요(${RANGE[ra]} 대 ${RANGE[rb]}). ${B}가 막타를 치러 다가올 때 평타 거리 끝에서 견제하세요.`.replace(`${B}가`, jo(B, '이', '가')) : `사거리는 ${A} 쪽이 조금 더 길어요(${RANGE[ra]} 대 ${RANGE[rb]}). 평타 거리 끝에서 막타와 견제를 같이 하세요.`);
    else if (dr === -1) lines.push(sup ? `${B} 사거리가 조금 더 길어요(${RANGE[rb]} 대 ${RANGE[ra]}). 원딜 옆에 붙어 있다가 원딜이 막타를 칠 때만 같이 앞으로 나가세요.` : `${B} 사거리가 조금 더 길어요(${RANGE[rb]} 대 ${RANGE[ra]}). 막타 칠 때만 앞으로 나가고 바로 미니언 뒤로 돌아오세요.`);
    else if (dr <= -2) lines.push(`${jo(B, '은', '는')} 멀리서 견제해요. 체력이 깎이지 않게 미니언 뒤에 서고, ${ma >= 2 ? '돌진기로 한 번에 붙을 수 있을 때만' : '정글 갱이나 아군 CC가 맞았을 때만'} 들어가세요.`);
    else if (!hand) lines.push(`둘 다 ${jo(RANGE[ra], '이라', '라')} 핵심 스킬을 먼저 맞추는 쪽이 딜교환을 이겨요.`);

    // 라인전 판정 (직접 쓴 문장이 있으면 그 판단을 따름)
    if (!hand || src === 'stat') {
      const why = Object.entries(parts).filter(x => !jgl || x[0] !== '사거리').sort((x, y) => verdict >= 0 ? y[1] - x[1] : x[1] - y[1])[0][0];
      if (jgl) {
        if (verdict > 0) lines.push(`초반 1:1과 정글 싸움은 ${jo(A, '이', '가')} 유리해요(${why} 우위). 3레벨 이후 ${B} 정글 캠프 쪽으로 카정을 가고, 스커틀(바위게) 싸움을 먼저 거세요.`);
        else if (verdict < 0) lines.push(`초반 1:1과 정글 싸움은 ${jo(B, '이', '가')} 유리해요(${why} 열세). ${B} 반대편에서 정글을 돌고, 강가 싸움엔 라이너가 먼저 도착할 때만 가세요.`);
        else lines.push(`초반 정글 싸움은 비슷해요. 라인 주도권이 있는 쪽 강가에서 싸우는 정글이 이겨요.`);
      }
      else if (verdict > 0) lines.push(`라인전은 ${jo(A, '이', '가')} 유리해요(${why} 우위). 레벨 2·3이나 상대가 스킬을 쓴 직후처럼 내 스킬이 다 있을 때 먼저 딜교환하세요.`);
      else if (verdict < 0) lines.push(`라인전은 ${jo(B, '이', '가')} 유리해요(${why} 열세). 먼저 딜교환하지 말고, ${B} 핵심 스킬이 빠졌을 때만 반격하세요. ${sup ? '원딜이 포탑 근처에서 CS를 받게 하세요.' : role === 'TOP' || role === 'MID' ? '' : '웨이브는 포탑 쪽으로 당겨 받으세요.'}`);
      else lines.push(`라인전은 비슷해요. 정글 위치와 스킬 쿨타임을 보고, 상대가 스킬을 먼저 쓰게 만든 쪽이 딜교환을 이겨요.`);
    }

    // 라인별 운영 (탑: 웨이브·텔포, 미드: 로밍·웨이브 정리)
    if (role === 'TOP') {
      if (dr >= 2) lines.push(`웨이브를 ${B} 포탑 쪽으로 밀어두면 ${jo(B, '이', '가')} 포탑 아래에서 막타를 놓치고 체력도 못 채워요. 상대 정글이 안 보일 땐 밀지 말고 웨이브 중간에서 견제만 하세요.`);
      else if (dr <= -2) lines.push(`웨이브를 내 포탑 앞으로 당겨 두면 ${jo(B, '이', '가')} 견제하러 앞으로 나와야 해서 정글 갱 각이 나와요. 첫 귀환 전까지는 웨이브를 밀지 마세요.`);
      else if (verdict > 0) lines.push(`이기는 라인이에요. 웨이브를 2~3개 쌓아 ${B} 포탑에 밀어넣은 뒤 귀환하면 ${jo(B, '이', '가')} 포탑 아래에서 CS를 잃어요. 순간이동은 ${B} 귀환 타이밍에 맞춰 바텀이나 용 싸움에 쓰세요.`);
      else if (verdict < 0) lines.push(`밀리는 라인이에요. 웨이브를 포탑 앞에서 받아 CS만 챙기고, 전령 싸움은 정글에게 미리 어렵다고 알려주세요. 순간이동은 라인 복귀보다 아군 싸움 합류에 아껴두세요.`);
      else lines.push(`라인이 비슷해요. 웨이브가 내 쪽으로 올 때 딜교환하면 미니언 수가 많아 유리해요. 순간이동 쿨을 서로 확인하고, ${B} 순간이동이 빠지면 바텀에 핑을 찍어주세요.`);
    } else if (role === 'JGL' && !hand) {
      if (ca >= 2 && da[0] >= 4) lines.push(`${A}는 CC가 있어서 3레벨 갱 성공률이 높아요. ${B}보다 먼저 3레벨을 찍고 라인 주도권이 있는 쪽으로 갱을 가서 ${B} 정글 동선을 끊으세요.`.replace(`${A}는`, jo(A, '은', '는')));
      else if (ca <= 1) lines.push(`${A}는 CC가 적어서 갱보다 정글링 속도와 카정으로 이득을 보는 게 좋아요. ${B} 위치가 보이면 반대편 정글 캠프를 가져가세요.`.replace(`${A}는`, jo(A, '은', '는')));
      else if (cb >= 3) lines.push(`${B} CC가 강해서 ${B} 갱이 위험해요. ${B}가 보이지 않으면 라이너에게 와드를 박으라고 핑을 찍고, ${B} 반대편 라인으로 역갱을 가세요.`.replace(`${B}가`, jo(B, '이', '가')));
    } else if (role === 'MID') {
      const roamA = ma >= 2 || aa >= 3, roamB = mb >= 2 || ab >= 3;
      if (roamA && !roamB) lines.push(`${A} 쪽이 로밍이 빨라요. 웨이브를 밀고 강가 와드를 피해 탑·바텀에 내려가고, ${jo(B, '이', '가')} 따라오지 못하면 포탑 골드라도 챙기게 해요.`);
      else if (roamB && !roamA) lines.push(`${jo(B, '이', '가')} 로밍이 빨라요. ${jo(B, '이', '가')} 웨이브를 밀고 사라지면 바로 미아 핑을 찍고, 따라가기 어려우면 웨이브를 밀어 포탑 골드로 교환하세요.`);
      else if (pa >= 3 && pb <= 1) lines.push(`웨이브 정리는 ${A} 쪽이 빨라요. 웨이브를 먼저 밀어 ${jo(B, '이', '가')} 포탑 아래서 CS를 받게 만들고, 그 시간에 정글과 강가 시야를 잡으세요.`);
      else if (pb >= 3 && pa <= 1) lines.push(`웨이브 정리는 ${B} 쪽이 빨라요. 웨이브를 내 포탑 앞에서 받고, ${jo(B, '이', '가')} 웨이브를 밀고 움직이면 정글에게 위치를 알려주세요.`);
      else lines.push(`로밍 속도가 비슷해요. 웨이브를 먼저 미는 쪽이 로밍 주도권을 가지니, 상대 미드가 귀환할 때 웨이브를 밀고 정글과 같이 움직이세요.`);
    }

    // 회복과 견제
    if (sb >= 2 && pa >= 2) lines.push(`${jo(B, '은', '는')} 회복이 있어서 견제만으로는 체력 차이가 오래 가지 않아요. 견제로 깎은 직후에 올인 각을 같이 보고, 치유 감소 아이템을 첫 귀환 때 사세요.`);
    else if (sb >= 3) lines.push(`${B} 회복이 강해요. 치유 감소 아이템을 첫 귀환 때 사고, 짧은 딜교환보다 한 번에 끝내는 싸움을 노리세요.`);
    else if (sa >= 2 && pb >= 2) lines.push(`${B} 견제는 ${A} 회복으로 버틸 수 있어요. 체력이 절반 밑으로 떨어지기 전엔 귀환하지 말고 버티세요.`);
    else if (pb >= 3 && sa === 0 && pa <= 1) lines.push(`${B} 견제를 회복할 방법이 없어요. 체력 물약을 넉넉히 사고, 부쉬를 이용해 ${B} 스킬 사거리 밖에서 기다리세요.`);

    // 기동성과 CC
    if (hand) { }
    else if (mb >= 2 && ca >= 2) lines.push(`${jo(B, '이', '가')} 돌진기를 먼저 쓰게 만든 뒤 CC를 맞추세요. CC를 먼저 쓰면 돌진기로 피하고 들어와요.`);
    else if (ma <= 1 && cb >= 3 && !engageSaid) lines.push(`${B} CC 한 번에 묶이면 빠져나갈 수단이 없어요. ${B} CC가 빠진 걸 확인한 뒤에만 앞으로 나가세요.`);
    else if (ma >= 2 && cb >= 2) lines.push(`돌진기는 ${B} CC를 피하는 데 아껴두고, 딜교환할 때 먼저 쓰지 마세요.`);
    else if (aa >= 3 && mb <= 1) lines.push(`${jo(B, '은', '는')} 도망칠 수단이 적어요. 올인이 시작되면 끝까지 따라가세요.`);

    // 성장
    const dl = da[2] - db[2];
    if (dl >= 1.5) lines.push(`후반은 ${A} 쪽이 더 강해요. ${ctx.role === 'JGL' ? '초반 카정만' : '라인전에서 손해만'} 안 보면 시간이 내 편이에요.`);
    else if (dl <= -1.5) lines.push(`${jo(B, '이', '가')} 후반에 더 강해요. ${ctx.role === 'JGL' ? '초반 정글 이득' : '라인전 이득'}으로 포탑과 오브젝트를 일찍 가져가서 빨리 끝내세요.`);

    // 상대 핵심 (챔피언 문장)
    const ag = ctx.note ? ctx.note(B, 'against') : '';
    if (ag && !hand.includes(ag.slice(0, 15))) lines.push(`${B} 상대 요령: ${ag}`);
    return { verdict, src, score: Math.round(score * 10) / 10, lines: lines.map(s => s.trim()) };
  }

  const api = { gen, handVerdict, jo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MATCHUP = api;
})(this);
