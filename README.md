## XRPL어비스픽
이 프로젝트는 기존 어비스 시그널에 대한 변조방지시스템을 XRPL로 구현한 프로젝트입니다.

### 디렉토리 구조

- `routes/poeRoutes.js`: Express 라우터. PoE 검증/발급, XRPL 에스크로 관련 HTTP API 제공
- `services/xrplPoe.js`: XRPL 연동 서비스 함수 집합 (메모 결제, 에스크로 생성/완료)
- `controllers/stockController.js`: 주식 시그널 저장 시 PoE 메타데이터 생성 및 (옵션) 앵커링
- `server/poe-watcher.js`: MongoDB 변경 스트림/폴링으로 문서 기준 해시 생성 및 변경 감지, 온체인 체크
- `script/mock_signal_poe_test.js`: 샘플 시그널을 저장하고 검증 API를 호출하는 테스트 스크립트

의존 유틸/DB 모듈(경로 예: `../utils/poe`, `../db/mongodb`)은 상위 경로에 존재합니다.

*util의 경우 보안상 이 레포에 존재하지 않습니다

---

## 환경 변수

- `XRPL_POE_ENABLED` (default: "false"): XRPL 앵커링 활성화 여부
- `XRPL_NETWORK` (default: "testnet"): `mainnet` | `testnet`
- `XRPL_ACCOUNT`: 송신 계정 주소
- `XRPL_SEED`: 송신 계정 시드(비밀)
- `XRPL_DEST_ACCOUNT`: 수신 계정 주소(미지정 시 자기지갑)
- `BASE_API`: 외부에서 접근할 API 베이스 URL (예: `http://localhost`)
- `SIGNAL_TOKEN`: 테스트 스크립트 인증 토큰
- `COIN_DB_URI` / `COIN_DB_BETA_URI`: 테스트 스크립트에서 시그널 저장에 사용하는 API 엔드포인트
- `POE_POLL_INTERVAL_MS` (기본 15000): 폴링 간격(ms)
- `POE_POLL_LOOKBACK_MS` (기본 24h): 폴링 대상 조회 기간(ms)
- `POE_POLL_LIMIT` (기본 500): 폴링 시 조회 제한 개수
---

## API 개요 (`routes/poeRoutes.js`)

### 1) 시그널 검증: GET `/api/poe/signals/verify`
- 쿼리 파라미터
  - `type`: `coin`(default) | `stock`
  - `ticker`: 종목 식별자 (필수)
  - `dateAdded`: ISO 문자열. 타임존 미포함 시 KST(UTC+9)로 간주 후 내부 UTC 보정하여 분 단위 윈도우 매칭
  - `close`: 종가(선택). 허용 오차: `max(1e-4, |close|*0.0005)`
  - `compare`: `live` 지정 시 현재 문서로 재직렬화/재해시하여 저장 해시와 비교
- 응답 요약
  - `ok`: 판정이 `ok_*` 계열이면 true
  - `code`: `ok_on_chain | ok_but_unchecked_memo | ok_local_only | pending | failed | tx_not_found | tampered | memo_mismatch`
  - `localMatch`, `onLedger`, `memoMatch`, `txHash`, `explorerUrl`

검증 로직 핵심:
- 문서의 `poe.hash`(저장 당시 캐논 문자열의 SHA-256)와 재해시 비교
- 온체인 상태(`poe.status === on-ledger`)인 경우, XRPL 트랜잭션의 MemoData가 저장된 해시와 일치하는지 확인

### 2) 자격증명 앵커링(발급): POST `/api/poe/credentials/issue`
- 본문: `{ credential, anchor }`
  - `credential`: 임의 JSON. 내부 캐논 정렬→해시 생성
  - `anchor`: true 시 XRPL 메모 결제 전송(환경변수 설정 필요)
- 응답: `hash`, `canon`, `onchain { validated, txHash, ledgerIndex, explorerUrl }`
  - 메모 타입은 `CRED`를 사용

### 3) 자격증명 검증: POST `/api/poe/credentials/verify`
- 본문: `{ credential?, hashHex?, account?, ledgerIndex?, txHash? }`
- 동작: 주어진 `hashHex` 또는 `credential`을 캐논→해시 후 XRPL에서 트랜잭션을 조회하여 MemoData와 일치하는지 확인
- 응답: `{ ok, txHash, memoMatch, explorerUrl }`

### 4) 에스크로 생성: POST `/api/poe/escrow/create`
- 본문: `{ destination, amountDrops="1000000", cancelAfterSec?, finishAfterSec?, conditionHex?, memoHex? }`
- 결과: `{ validated, txHash, ledgerIndex, offerSequence, explorerUrl }`
  - Memo 타입: `ESCROW`

### 5) 에스크로 완료: POST `/api/poe/escrow/finish`
- 본문: `{ owner=XRPL_ACCOUNT, offerSequence, fulfillmentHex?, memoHex? }`
- 결과: `{ validated, txHash, ledgerIndex, explorerUrl }`
  - Memo 타입: `ESCROW_FINISH`

---

## XRPL 서비스 (`services/xrplPoe.js`)

- `submitHashToXRPL({ network, seed, account, hashHex, destinationAccount })`
  - 1 drop self-payment로 해시를 MemoData에 실어 전송. MemoType=`POE`
- `submitMemoPayment({ network, seed, account, memoType, memoHex, destinationAccount, drops })`
  - 임의의 `memoType`/`memoHex`로 결제 트랜잭션 제출
- `createEscrow({ ... })` / `finishEscrow({ ... })`
  - XRPL 에스크로 생성/완료 트랜잭션 빌드 및 제출

모든 함수는 제출 결과의 `validated`, `txHash`, `ledgerIndex` 등을 반환합니다.

---

## 컨트롤러 (`controllers/stockController.js`)

`setStrategyStock`:
- 입력 배열을 bulkWrite로 저장
- 각 레코드에 대해 캐논 타깃을 만들고 `poe.hash`, `poe.canon` 등을 저장
- `XRPL_POE_ENABLED`가 true이고 키가 있으면 `submitHashToXRPL`로 앵커링 시도 후 상태 업데이트

저장되는 `poe` 주요 필드: `status`, `hash`, `canon`, `network`, `account`, `txHash`, `ledgerIndex`, `memoHex`, `explorerUrl`, `validatedAt`, `tampered`, `history[]` 등

---

## 워커 (`server/poe-watcher.js`)

- MongoDB Change Stream으로 `coin_strategy`, `stock_strategy` 변경 감시
- 기준 해시 미보유 문서는 캐논 생성→해시→`poe` 필드 세팅(옵션으로 XRPL 앵커링)
- 기준 해시 보유 문서는 현재 캐논/해시 재계산하여 변경 시 `tampered` 처리 및 (옵션) 재앵커링
- 레플리카셋 미지원 시 폴백 폴링 동작(`POLL_*` 환경변수)

온체인 검증:
- `poe.status === on-ledger`일 때 `tx` 조회 후 MemoData와 저장된 해시 일치 여부 확인

---

## 테스트 스크립트 (`script/mock_signal_poe_test.js`)

1) 샘플 시그널을 외부 API(`COIN_DB_URI`)로 POST
2) 잠시 대기 후, 본 서버의 검증 엔드포인트(`/api/poe/signals/verify`)로 GET 검증

실행 예:
```bash
node src/script/mock_signal_poe_test.js
```

---

## 라우터 마운트 예시

애플리케이션에서 다음과 같이 라우터를 마운트합니다.
```js
// app.js 또는 서버 초기화 파일
const express = require("express");
const app = express();
app.use(express.json());
app.use("/api/poe", require("./routes/poeRoutes"));
```

## XRPL앵커링관련 스샷
<img width="2314" height="770" alt="스크린샷 2025-09-21 오후 1 21 28" src="https://github.com/user-attachments/assets/c340927b-fc04-4160-b23e-350000eba6c6" />

<img width="2294" height="776" alt="스크린샷 2025-09-21 오후 1 21 36" src="https://github.com/user-attachments/assets/481ffa46-a38f-4ac3-a6d9-9e4dfeb03264" />


## 주의사항 
어비스픽 프로덕션 코드와 연결되어있는 부분들이 있어 해당 부분을 제외한 XRPL 부분만을 추출한 코드입니다. 참고부탁드립니다.

## 어비스픽 공식홈페이지
https://aviss.kr/main/main.php

