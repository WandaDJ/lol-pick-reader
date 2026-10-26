# 픽창 판독기

리그 오브 레전드 픽창에서 양 팀 10명을 넣으면 아래 내용을 보여주는 웹 페이지예요.

- 0~10분, 10~20분, 20~30분, 30분 이후 구간별 우세
- 5:5 한타 구도 (이니시, 앞라인, 보호, 물리/마법 피해 비율)
- 아군 운영 난이도와 이번 판 게임 플랜
- 내 포지션을 고르면 지금 픽창 상황에 맞는 추천 챔피언 (내 챔프폭 표시·필터 가능)

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

## 테스트
```bash
python -m unittest discover tests
```

## 알려진 한계
- 골드 차이는 "그 시간대에 라인에서 이기는가"를 보여주지만, 팀 단위 영향력(로밍, 한타 기여)은 다 담지 못해요.
- 한타 점수와 이니시·앞라인 태그는 아직 추정값이에요.
- 픽창 정보는 직접 입력해야 해요.

---

픽창 판독기는 Riot Games의 승인이나 보증을 받지 않았으며, Riot Games 또는 리그 오브 레전드 제작·관리에 공식적으로 관여한 사람의 견해를 대변하지 않습니다. League of Legends 및 Riot Games는 Riot Games, Inc.의 상표 또는 등록 상표입니다.
