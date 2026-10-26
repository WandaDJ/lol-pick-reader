# 픽창 판독기

리그 오브 레전드 픽창에서 양 팀 10명을 넣으면 아래 내용을 보여주는 웹 페이지예요.

- 0~10분, 10~20분, 20~30분, 30분 이후 구간별 우세
- 5:5 한타 구도 (이니시, 앞라인, 보호, 물리/마법 피해 비율)
- 아군 운영 난이도와 이번 판 게임 플랜
- 내 포지션을 고르면 지금 픽창 상황에 맞는 추천 챔피언 (내 챔프폭 표시·필터 가능)
- `이름#태그`로 내 최근 랭크 기록을 불러와 포지션별 챔프폭 자동 채우기

**바로 쓰기:** https://wandadj.github.io/lol-pick-reader/

## 데이터는 어디서 오나요

| 항목 | 근거 |
|---|---|
| 0~10분 | 10분 시점 같은 포지션 상대와의 골드 차이 |
| 10~20분 | 10분→20분 사이 골드 차이 변화 |
| 20~30분 | 20분→30분 사이 골드 차이 변화 |
| 30분 이후 | 30분 넘게 진행된 경기의 승률 |
| 한타 성향, 이니시·앞라인 태그 | 직접 매긴 추정값 |

통계는 [Riot 공식 API](https://developer.riotgames.com/)(League-V4, Match-V5 + 타임라인)로 한국 서버 랭크 솔로 경기를 모아 `scripts/collect.py`가 계산하고 `data/stats.json`에 저장해요. 표본이 적은 경기 수는 평균 쪽으로 보정하고, 30판 미만인 챔피언·포지션은 추정 표로 대체해요. `data/stats.json`이 없으면 페이지 전체가 추정 표로 동작해요.

op.gg 같은 통계 사이트를 직접 긁어오지 않는 이유는 대부분 이용약관에서 자동 수집을 금지하기 때문이에요.

## 통계 갱신하기

### 1. Riot API 키 받기
[developer.riotgames.com](https://developer.riotgames.com/)에 로그인하면 **개발 키**가 바로 나오지만 24시간마다 만료돼요. 자동 갱신을 쓰려면 같은 사이트에서 이 프로젝트를 등록하고 **Personal API Key**를 신청하세요. 누구나 보는 공개 페이지라서 프로젝트 등록이 필요해요.

### 2-a. 내 PC에서 직접 실행
```bash
export RIOT_API_KEY=RGAPI-xxxx   # Windows PowerShell: $env:RIOT_API_KEY="RGAPI-xxxx"
python scripts/collect.py --max-matches 1500
git add data/stats.json && git commit -m "통계 갱신" && git push
```
외부 패키지는 필요 없어요(Python 3.9 이상). 경기당 요청이 2번이라 기본 한도(2분에 100회)에서 1,500경기는 약 1시간 걸려요. 받은 경기는 `data/cache`에 저장돼서 다시 실행하면 이어서 받아요.

주요 옵션:

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--tiers` | `EMERALD,DIAMOND` | 수집할 티어 (예: `PLATINUM,EMERALD`) |
| `--max-matches` | `1500` | 최대 경기 수 |
| `--days` | `14` | 최근 며칠 경기만 |
| `--patches` | 최신 2개 패치 | 집계할 패치 (예: `26.21`) |
| `--min-games` | `30` | 이보다 적으면 통계 대신 추정값 사용 |

### 2-b. GitHub Actions로 매주 자동 갱신
1. 저장소 **Settings → Secrets and variables → Actions → New repository secret**
2. 이름 `RIOT_API_KEY`, 값에 키 입력
3. **Actions → 통계 갱신 → Run workflow**로 바로 돌리거나, 매주 월요일 새벽에 자동 실행돼요.

## 아이디로 챔프폭 불러오기 (Cloudflare Worker)

페이지에 `이름#태그`를 넣으면 최근 랭크 경기(최대 100판)와 챔피언 숙련도를 보고 포지션별 챔프폭을 자동으로 채워요. Riot API 키를 페이지에 넣으면 누구나 볼 수 있어서, 키를 숨겨주는 작은 중계 서버(`worker/worker.js`)를 Cloudflare Workers 무료 플랜에 올려서 써요.

### 대시보드로 배포하기 (설치 없이)
1. [dash.cloudflare.com](https://dash.cloudflare.com/)에 가입하고 **Workers & Pages → Create → Create Worker**
2. 이름을 `lol-pick-reader`로 하고 **Deploy** → **Edit code**에서 기본 코드를 지우고 `worker/worker.js` 내용을 붙여넣은 뒤 **Deploy**
3. Worker의 **Settings → Variables and Secrets**에서 추가
   - `RIOT_API_KEY` : 종류 **Secret**, 값은 Riot API 키
   - `ALLOWED_ORIGIN` : 종류 **Text**, 값 `https://wandadj.github.io`
4. **KV 저장소 연결 (권장)**: 왼쪽 메뉴 **Storage & Databases → KV → Create**로 `lol-pick-reader-pool`을 만들고, Worker의 **Settings → Bindings → Add → KV namespace**에서 변수 이름 `POOL_KV`로 연결
5. Worker 주소(`https://lol-pick-reader.<계정>.workers.dev`)를 `data/config.json`의 `poolApi`에 넣고 커밋

```json
{ "poolApi": "https://lol-pick-reader.<계정>.workers.dev" }
```

### 명령줄로 배포하기 (Node.js가 있으면)
```bash
cd worker
npx wrangler deploy
npx wrangler secret put RIOT_API_KEY
```

### 챔프폭은 어떻게 고르나요
- 한 번 불러올 때 **새로 한 경기만 최대 30판** 받아요 (Cloudflare 무료 플랜의 요청당 외부 호출 50회 한도 안).
- KV를 연결하면 아이디별로 경기를 쌓아서 **최근 랭크 100판**까지 봐요. 처음엔 30판 → 다시 불러오면 60판 → 90판 → 100판처럼 늘어나고, 그다음부터는 새 경기만 받아서 빨라요. KV가 없으면 매번 최근 30판만 봐요.
- 포지션별 챔프폭 기준: 그 포지션에서 **2판 이상**, 또는 **1판 + 숙련도 3만 점 이상**. 주 포지션이거나 5판 이상 간 포지션이면 최근엔 안 했어도 **숙련도 5만 점 이상**인 챔피언을 포함해요.
- 추천 목록에 "내 기록 21판 12승 (57%)"처럼 표시하고, 5판 미만은 승률 대신 **표본 적음**으로 표시해요.

### 알아두기
- 처음 불러올 때 Riot API를 최대 33번 호출해요. 같은 아이디는 모든 경기를 받은 뒤 10분 동안 캐시돼요.
- Personal API Key 기본 한도(2분에 100회)로는 처음 불러오는 사람 기준 2분에 3명 정도예요. 사용자가 많아지면 Riot에 Production Key를 신청하세요.
- 키가 만료되면 페이지에 "서버의 Riot API 키가 만료됐거나 잘못됐어요"라고 떠요. Worker의 `RIOT_API_KEY`만 바꾸면 돼요.

## 테스트
```bash
python -m unittest discover tests   # 통계 집계
node worker/worker.test.mjs         # 챔프폭 중계 서버 (가짜 Riot 응답)
```

## 알려진 한계
- 골드 차이는 "그 시간대에 라인에서 이기는가"를 보여주지만, 팀 단위 영향력(로밍, 한타 기여)은 다 담지 못해요.
- 한타 점수와 이니시·앞라인 태그는 아직 추정값이에요.
- 픽창 정보는 직접 입력해야 해요.

---

픽창 판독기는 Riot Games의 승인이나 보증을 받지 않았으며, Riot Games 또는 리그 오브 레전드 제작·관리에 공식적으로 관여한 사람의 견해를 대변하지 않습니다. League of Legends 및 Riot Games는 Riot Games, Inc.의 상표 또는 등록 상표입니다.
