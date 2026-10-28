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

    // ---------------------------------------------------------------- 바텀 2:2 (원딜+서폿 vs 원딜+서폿)
  const ADC_TYPE = {};
  'allin:드레이븐,루시안,사미라,칼리스타,트리스타나,닐라,미스 포츈,아크샨/poke:이즈리얼,바루스,케이틀린,진,애쉬,시비르,세나,직스,세라핀,스웨인/hyper:징크스,코그모,베인,아펠리오스,트위치,제리,카이사,스몰더,유나라,자야'
    .split('/').forEach(g => { const [k, v] = g.split(':'); v.split(',').forEach(n => ADC_TYPE[n] = k); });
  const SUP_TYPE = {};
  'engage:레오나,노틸러스,알리스타,렐,라칸,쓰레쉬,블리츠크랭크,파이크,뽀삐,마오카이,니코,세트,갈리오,말파이트,판테온/enchanter:룰루,잔나,소라카,밀리오,나미,유미,레나타 글라스크,카르마,소나,바드,질리언/mage:제라스,럭스,브랜드,자이라,벨코즈,세나,하이머딩거,멜,스웨인,모르가나,샤코,세라핀/peel:브라움,탐 켄치,타릭,쉔'
    .split('/').forEach(g => { const [k, v] = g.split(':'); v.split(',').forEach(n => SUP_TYPE[n] = k); });
  const ADC_NAME = { allin: '올인형', poke: '견제형', hyper: '후반형' };
  const SUP_NAME = { engage: '진입형', enchanter: '보호형', mage: '견제형', peel: '수비형' };
  const SYN = { engage: { allin: 2, hyper: 1, poke: 0 }, enchanter: { allin: 1, hyper: 2, poke: 1 }, mage: { allin: 0, hyper: 0, poke: 2 }, peel: { allin: 1, hyper: 2, poke: 0 } };
  const DUO = new Set(['루시안|나미', '루시안|브라움', '자야|라칸', '카이사|노틸러스', '사미라|레오나', '사미라|노틸러스', '사미라|라칸', '코그모|룰루', '징크스|룰루', '징크스|자이라', '드레이븐|레오나', '드레이븐|노틸러스', '케이틀린|럭스', '케이틀린|모르가나', '이즈리얼|카르마', '이즈리얼|유미', '베인|룰루', '트위치|룰루', '트위치|유미', '아펠리오스|쓰레쉬', '칼리스타|쓰레쉬', '칼리스타|레나타 글라스크', '칼리스타|렐', '제리|룰루', '제리|유미', '진|제라스', '바루스|브랜드', '애쉬|브랜드', '시비르|카르마', '트리스타나|레오나', '닐라|나미']);
  // 서폿 성향 상성: 진입 > 보호, 보호 > 견제, 견제 > 진입, 수비는 진입에 강함
  const TRI = { engage: { enchanter: 1, mage: -1 }, enchanter: { mage: 1, engage: -1 }, mage: { engage: 1, enchanter: -1 }, peel: { engage: 0.5 } };
  const SYN_TEXT = {
    'engage|allin': '서폿이 CC를 맞춘 순간 원딜이 바로 따라 들어가는 조합이에요. 레벨 2·3과 첫 귀환 직후처럼 스킬이 다 있을 때 같이 올인하세요.',
    'engage|hyper': '서폿은 진입하지만 원딜 딜이 초반엔 약해요. 무리한 올인보다 서폿 CC로 한 명을 확실히 묶을 때만 싸우고, 원딜 2코어 이후 진입을 늘리세요.',
    'engage|poke': '원딜은 견제, 서폿은 진입이라 템포가 달라요. 원딜이 견제로 체력을 깎아둔 뒤에만 서폿이 들어가세요.',
    'enchanter|allin': '서폿 보호막·강화로 원딜의 짧은 딜교환이 강해져요. 원딜이 들어갈 때 서폿 강화 스킬을 같이 넣고, 상대 반격엔 보호막을 아껴두세요.',
    'enchanter|hyper': '원딜을 키우는 조합이에요. 라인전은 CS와 체력 지키기 위주로 하고, 원딜 2코어 이후 한타에서 서폿이 원딜만 지키면 이겨요.',
    'enchanter|poke': '견제와 회복으로 체력 차이를 벌리는 조합이에요. 상대 진입만 피하면 라인전이 편하니 미니언 뒤 거리를 지키세요.',
    'mage|poke': '둘 다 견제라 라인전 체력 싸움에 강해요. 진입형 상대에게 붙지 않게 넓게 서고, 체력이 깎인 상대가 귀환하면 포탑을 깎으세요.',
    'mage|allin': '서폿 견제로 체력을 깎고 원딜이 마무리하는 조합이에요. 서폿이 진입을 받아줄 수 없으니 원딜이 너무 앞에 서지 마세요.',
    'mage|hyper': '서폿 견제로 라인을 버티지만 원딜을 지켜줄 수단이 적어요. 원딜이 상대 진입 스킬 사거리 밖에서 CS를 받게 하세요.',
    'peel|allin': '서폿이 앞에서 맞아주고 원딜이 딜교환하는 조합이에요. 상대 진입을 서폿이 받아낸 직후가 원딜이 들어갈 타이밍이에요.',
    'peel|hyper': '원딜을 지키는 조합이에요. 상대 진입을 서폿이 받아내면 원딜이 오래 딜할 수 있어 후반 한타가 강해요.',
    'peel|poke': '서폿 견제가 약해서 원딜 견제에 기대야 해요. 서폿은 원딜 옆에서 상대 진입만 막아주세요.'
  };
  const FOE_TEXT = {
    engage: '상대 서폿이 진입형이라 레벨 2·3과 6레벨 올인이 위험해요. 상대가 먼저 레벨 2를 찍을 것 같으면 미니언 웨이브 뒤로 빠지고, 진입 스킬이 빠진 쿨 동안 반격하세요.',
    enchanter: '상대 서폿이 보호형이라 짧은 견제로는 체력 차이가 잘 안 나요. 보호막·회복 스킬이 빠진 직후에 딜교환을 몰아서 하세요.',
    mage: '상대 서폿이 견제형이라 라인전 체력이 계속 깎여요. 부쉬와 미니언 뒤를 이용하고, 상대가 견제 스킬을 쓴 직후 거리를 좁히세요.',
    peel: '상대 서폿이 수비형이라 원딜을 잡기 어려워요. 서폿 보호 스킬(방패·삼키기 등)을 먼저 빼게 만든 뒤 원딜을 노리세요.'
  };
  function synergy(adc, sup) {
    const at = ADC_TYPE[adc], st = SUP_TYPE[sup];
    if (!at || !st) return null;
    const duo = DUO.has(adc + '|' + sup);
    return { at, st, v: SYN[st][at] + (duo ? 1 : 0), duo };
  }
  // a: [우리 원딜, 우리 서폿], e: [상대 원딜, 상대 서폿], D: 챔피언 표
  function bot(a, e, D) {
    const [aa, as] = a, [ea, es] = e;
    const sA = aa && as ? synergy(aa, as) : null, sE = ea && es ? synergy(ea, es) : null;
    const lines = [];
    let score = 0, n = 0;
    if (sA) {
      const lv = sA.v >= 2 ? '좋아요' : sA.v === 1 ? '보통이에요' : '잘 안 맞아요';
      lines.push(`우리 바텀(${ADC_NAME[sA.at]} ${aa} + ${SUP_NAME[sA.st]} ${as}) 궁합은 ${lv}${sA.duo ? ' (자주 쓰이는 조합)' : ''}. ${SYN_TEXT[sA.st + '|' + sA.at]}`);
    }
    if (sE) lines.push(`상대 바텀(${ADC_NAME[sE.at]} ${ea} + ${SUP_NAME[sE.st]} ${es}): ${FOE_TEXT[sE.st]}`);
    if (sA && sE) { score += (sA.v - sE.v) * 0.5; n++; }
    const tri = as && es && SUP_TYPE[as] && SUP_TYPE[es] ? (TRI[SUP_TYPE[as]] || {})[SUP_TYPE[es]] || 0 : 0;
    if (as && es && tri) {
      score += tri * 0.8; n++;
      lines.push(tri > 0
        ? `서폿 상성은 ${SUP_NAME[SUP_TYPE[as]]} ${jo(as, '이', '가')} ${SUP_NAME[SUP_TYPE[es]]} ${es}에게 강해요. ${SUP_TYPE[as] === 'engage' ? `${es} 보호 스킬이 빠진 직후 진입하면 막을 수단이 없어요.` : SUP_TYPE[as] === 'enchanter' ? `${es} 견제를 회복·보호막으로 버티면 상대가 할 게 없어요.` : SUP_TYPE[as] === 'mage' ? `${es} 진입 스킬 사거리 밖에서 견제하면 상대가 다가오지 못해요.` : `${es} 진입을 ${as}가 받아내면 반격 각이 나와요.`.replace(`${as}가`, jo(as, '이', '가'))}`
        : `서폿 상성은 ${SUP_NAME[SUP_TYPE[es]]} ${jo(es, '이', '가')} ${SUP_NAME[SUP_TYPE[as]]} ${as}에게 강해요. ${SUP_TYPE[es] === 'engage' ? `${es} 진입 스킬을 먼저 빼게 만들고, 그 전엔 미니언 뒤에 서세요.` : SUP_TYPE[es] === 'enchanter' ? `${es} 회복·보호막이 빠진 순간에만 딜교환하세요.` : `${es} 견제를 맞지 않게 부쉬와 미니언 뒤를 쓰고, 상대 견제 스킬이 빠지면 거리를 좁히세요.`}`);
    }
    if (aa && as && ea && es && D[aa] && D[as] && D[ea] && D[es]) {
      const early = (D[aa][0] + D[as][0]) - (D[ea][0] + D[es][0]);
      score += early * 0.6; n++;
      if (early >= 1.5) lines.push('초반 2:2 힘은 우리가 강해요. 첫 웨이브 3번째 근접 미니언까지 먼저 잡아 레벨 2를 선점하고, 2레벨이 되는 순간 같이 들어가세요.');
      else if (early <= -1.5) lines.push('초반 2:2 힘은 상대가 강해요. 첫 웨이브는 포탑 쪽으로 당겨 받고, 상대가 레벨 2를 먼저 찍는 순간 뒤로 빠지세요. 정글이 바텀에 올 때까지 버티는 게 목표예요.');
      else lines.push('초반 2:2 힘은 비슷해요. 레벨 2를 먼저 찍는 쪽이 주도권을 가지니 첫 웨이브 막타를 놓치지 마세요.');
      const late = D[aa][2] - D[ea][2];
      if (late >= 1.5) lines.push(`후반은 ${aa} 쪽이 더 강해요. 라인전에서 크게 지지만 않으면 시간이 우리 편이에요.`);
      else if (late <= -1.5) lines.push(`후반은 ${jo(ea, '이', '가')} 더 강해요. 라인전 이득으로 바텀 1차 포탑과 첫 용을 일찍 가져가세요.`);
    }
    const verdict = n === 0 ? 0 : score >= 0.8 ? 1 : score <= -0.8 ? -1 : 0;
    return { score: Math.round(score * 10) / 10, verdict, lines, synA: sA, synE: sE, known: n > 0 };
  }

  // ---------------------------------------------------------------- 이번 판 아이템·위치 방향
  // me: 내 챔피언, lane: 'TOP'.., allies/enemies: 이름 배열, D: 챔피언 표, T: 특성표
  function adapt(me, lane, allies, enemies, D, T) {
    if (!me || !D[me]) return [];
    const tg = D[me][4] || '', tm = T[me] || [2, 1, 1, 1, 1, 1];
    const en = enemies.filter(c => c && D[c]);
    if (!en.length) return [];
    const nm = a => a.slice(0, 3).join('·');
    const tag = c => D[c][4] || '', tr = c => T[c] || [2, 1, 1, 1, 1, 1];
    const ap = en.filter(c => tag(c).includes('M') && !tag(c).includes('A'));
    const ad = en.filter(c => tag(c).includes('A') && !tag(c).includes('M'));
    const assassins = en.filter(c => !tag(c).includes('F') && tr(c)[1] >= 3 && tr(c)[4] >= 3);
    const tanks = en.filter(c => tag(c).includes('F'));
    const healers = en.filter(c => tr(c)[3] >= 3 || (tr(c)[3] >= 2 && tr(c)[1] >= 3));
    const cc = en.filter(c => tr(c)[5] >= 3);
    const poke = en.filter(c => tr(c)[2] >= 3);
    const isTank = tg.includes('F');
    const supType = lane === 'SUP' ? SUP_TYPE[me] : null;
    const isUtility = supType === 'enchanter';
    const squishy = !isTank && (lane === 'ADC' || lane === 'MID' || supType === 'enchanter' || supType === 'mage' || tm[0] >= 3);
    const dealer = !isTank && !isUtility;
    const out = [];
    // 방어 아이템 방향
    if (isTank || (!squishy && !isUtility)) {
      if (ap.length >= 3 && ad.length <= 2) out.push(`상대에 마법 피해 챔피언이 많아요(${nm(ap)}). 상대 물리 딜러가 크게 성장하지 않았다면 마법 저항 위주로 방어 아이템을 가세요.`);
      else if (ad.length >= 3 && ap.length <= 2) out.push(`상대에 물리 피해 챔피언이 많아요(${nm(ad)}). 상대 마법 딜러가 크게 성장하지 않았다면 방어력 위주로 방어 아이템을 가세요.`);
      else out.push('상대 피해가 물리·마법으로 섞여 있어요. 체력 위주로 가다가, 가장 크게 성장한 적의 피해 종류에 맞춰 방어 아이템을 고르세요.');
    }
    // 물몸: 암살자·돌진
    if (squishy && assassins.length >= 2) out.push(`상대에 암살자·돌진 챔피언이 많아요(${nm(assassins)}). 앞으로 나가면 순식간에 죽을 수 있으니 아군 앞라인 뒤에서 안전하게 위치를 잡고, 생존 아이템 하나를 일찍 고려하세요.`);
    else if (squishy && assassins.length === 1) out.push(`${jo(assassins[0], '이', '가')} 시야에서 사라지면 바로 아군 쪽으로 붙으세요. 혼자 사이드나 정글에 서 있으면 노려져요.`);
    // 회복
    if (dealer && healers.length) out.push(`상대에 회복이 큰 챔피언이 있어요(${nm(healers)}). 치유 감소 아이템을 하나 섞으세요.`);
    // 단단한 상대
    if (dealer && tanks.length >= 2) out.push(`상대 앞라인이 단단해요(${nm(tanks)}). 체력 비례 피해나 관통 아이템을 섞어야 딜이 들어가요.`);
    // CC
    if (squishy && cc.length >= 3) out.push(`상대 CC가 많아요(${nm(cc)}). 강인함 신발이나 CC 해제 수단을 고려하고, 한 번 묶이면 끝나니 핵심 CC가 빠진 걸 보고 앞으로 나가세요.`);
    // 견제
    if (poke.length >= 3) out.push(isUtility ? `상대 견제가 강해요(${nm(poke)}). 회복·보호막 아이템 효율이 좋아요. 한타 전엔 아군 체력을 먼저 채우세요.` : `상대 견제가 강해요(${nm(poke)}). 라인전엔 체력 물약을 넉넉히 사고, 한타 전엔 체력을 채운 뒤 들어가세요.`);
    // 보호형 서폿: 아군 캐리 기준
    if (isUtility) {
      const carry = allies.filter(c => c && c !== me && D[c] && D[c][2] >= 5);
      out.push(carry.length ? `가장 후반이 강한 아군(${nm(carry)}) 옆에 붙어서 보호막·회복을 그 아군에게 몰아주세요.` : '아군 중 가장 많이 성장한 딜러 옆에 붙어서 보호막·회복을 몰아주세요.');
    }
    if (isTank && assassins.length >= 2) out.push(`적 암살자(${nm(assassins)})가 아군 딜러를 노려요. 진입보다 아군 딜러 옆에서 받아치는 역할을 먼저 하세요.`);
    return out.slice(0, 4);
  }

  const api = { gen, handVerdict, jo, bot, synergy, adapt, ADC_TYPE, SUP_TYPE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MATCHUP = api;
})(this);
