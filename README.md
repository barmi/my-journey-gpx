# Journey Atlas

차량 이동, 관광지 체류, 도보·탐방을 구분해서 보는 개인 여행 지도.

공개 지도: https://barmi.github.io/my-journey-gpx/

## 로컬 실행

Python 3.10 이상이 필요합니다. 지도와 폰트에는 인터넷이 필요합니다. 추가 Python 패키지는 필요하지 않습니다.

```sh
python3 scripts/serve.py
```

http://localhost:8000 에서 엽니다. `src/`, `data/`, `config/`와 지정한 GPX 폴더의 변경을 감지해서 다시 빌드합니다. 열린 화면은 20초마다 새 기록을 확인합니다.

다른 GPX 폴더를 지정하려면:

```sh
python3 scripts/serve.py --source /absolute/path/to/gpx --port 8000
```

여러 폴더는 `--source`를 반복해서 지정합니다. 또는 Git에서 제외되는 `config.local.json`을 저장합니다.

```json
{"gpxSources": ["/absolute/path/to/gpx"]}
```

## 새 GPX 추가와 자동 배포

1. `data/gpx/`에 새 GPX를 복사합니다. 하위 폴더도 자동으로 읽습니다.
2. 로컬 서버는 변경을 감지해 화면을 갱신합니다.
3. `main`에 커밋·푸시하면 GitHub Actions가 **기록 시작 시각이 가장 최근인 GPX 20개**를 선택해 빌드·검증 후 Pages를 자동 배포합니다. 로컬 서버는 전체 GPX를 사용합니다.

```sh
git add data/gpx
git commit -m "Add new journey records"
git push origin main
```

파일명과 상관없이 GPX 내부 시각과 좌표로 날짜·지역을 분류합니다. 스페인·포르투갈의 새 기록은 기존 여행에 이어집니다. 화면의 `GPX 추가`는 현재 화면에 임시로 더하는 기능입니다. 공개 페이지에 계속 남기려면 저장소에 파일을 추가하세요.

최근 20개는 각 GPX의 첫 기록 시각(UTC)을 기준으로 선택합니다. 파일명·수정일·내보낸 시각은 사용하지 않으며, 기록 시각이 없는 파일은 최근 파일 선택에서 제외합니다. 같은 시작 시각은 경로명 순서로 정렬합니다. 새 기록이 들어오면 가장 오래된 파일이 배포 대상에서 빠집니다. 배포에서 빠진 GPX 원본은 저장소와 로컬에 계속 보관합니다.

GitHub Pages용 결과를 로컬에서 별도로 확인하려면:

```sh
python3 scripts/build.py --recent-limit 20 --output .cache/pages-preview
python3 -m http.server 8001 --bind 127.0.0.1 --directory .cache/pages-preview
```

이 미리보기는 `dist/`의 전체 로컬 데이터와 분리됩니다. 저장소에는 여전히 전체 원본이 있으므로 공개 저장소에서 GPX 원본에 접근 가능한 범위는 달라지지 않습니다.

## 프로젝트 구조

```text
src/                    직접 수정하는 화면·지도 소스
  app.js                화면, 지도, 시간표
  analysis.js           이동·체류 추정과 관광지 반경
  map-config.js         배경 지도 제공자
  styles.css            화면 스타일
  vendor/leaflet/       고정 버전 지도 라이브러리
data/gpx/               계속 추가하는 GPX 원본
data/itinerary.json     최신 일정과 방문지 좌표
config/overrides.json   파일별 지역·시간대·구간 보정
scripts/build.py        GPX 데이터와 정적 사이트 생성
scripts/serve.py        로컬 서버와 변경 감지
dist/                   빌드 결과 (Git 제외, Pages 배포 대상)
.github/workflows/      main push 시 Pages 자동 배포
```

빌드 및 검증:

```sh
python3 scripts/build.py
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

## 시간과 구역 분류

- 15초 단위 좌표 중앙값으로 GPS 흔들림을 줄입니다.
- 주변 약 2분의 속도 중앙값이 기본 12km/h 이상이면 차량 이동으로 추정합니다. 짧은 신호 대기는 인접 차량 구간에 포함합니다.
- 등록 관광지 반경에서 비차량 시간이 기본 8분 이상 이어지면 관광지 체류로 추정합니다. 반경은 `src/analysis.js`의 `POIS`에서 수정합니다.
- 관광지 밖의 지속적인 도보는 도보·탐방, 나머지는 기타 체류입니다. 기타 체류에는 식사, 휴식, 숙박, 버스 대기가 섞일 수 있습니다.
- 3분이 넘는 기록 간격과 350km/h를 넘는 GPS 점프는 기록 단절이며 이동·체류 합계에서 제외합니다.
- 좌표·시각의 98% 이상이 더 긴 파일에 포함되는 짧은 파일은 겹치는 파일로 표시하고 합계에서 제외합니다. 원본은 보관합니다.
- 기록 시간은 탑승·입장을 확인한 시간이 아닙니다. 속도로 열차·선박 등을 구별할 수 없으며 차량 표시는 빠른 이동 수단의 추정입니다.
- 예전 여행에는 관광지 반경을 등록하지 않아 관광지 체류 대신 도보·탐방이나 기타 체류가 표시될 수 있습니다.

화면의 `분류 기준`은 이 브라우저에 저장됩니다. 모든 방문자에게 보정을 적용하려면 `config/overrides.json`을 수정합니다.

```json
{
  "06-Nov-2026-2000.gpx": {
    "group": "spain",
    "timezone": "Europe/Lisbon",
    "intervals": [{
      "start": "2026-11-06T12:00:00+00:00",
      "end": "2026-11-06T13:30:00+00:00",
      "kind": "visit",
      "label": "직접 확인한 벨렝 관광"
    }]
  }
}
```

종류는 `drive`, `visit`, `walk`, `stay`, `unknown`입니다. 보정 시각에는 시간대를 포함합니다.

## 시간대와 공개 범위

스페인은 `Europe/Madrid`, 포르투갈 중심 기록은 `Europe/Lisbon`입니다. 국경 통과일에도 파일 전체에 하나의 시간대를 사용하며 화면에 기준 시간대를 표시합니다. `overrides.json`으로 직접 지정할 수 있습니다.

이번 여행과 예전 기록을 모두 기본 표시하도록 원본 GPX가 공개 저장소에 포함되어 있습니다. 화면에서 임시로 추가한 파일은 서버로 업로드하지 않습니다.

지도 제공자는 `src/map-config.js`에서 변경합니다. OSM 기본 타일을 대량 다운로드하거나 오프라인용으로 저장하는 기능은 제공하지 않습니다.
