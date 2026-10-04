# 지출별 복수 통화 정산 변경

변경일: 2026-10-05. 회차 단일 통화 선택을 지출별 통화 선택으로 변경한다. 지원 목록 41종과 기존 통화 선택창을 유지하며 한 회차의 지출에는 최대 5개 통화가 존재할 수 있다.

## 동작과 API

- 기록 시작 `POST /api/groups/{groupId}/rounds`는 `{ name, participantIds }`만 받는다. currency를 보내면 허용하지 않은 필드로 400을 반환한다.
- 지출 생성 `POST /api/rounds/{roundId}/expenses`는 currency가 필수다. `CURRENCIES`의 지원 코드와 자릿수를 AUTH 이후 검사한다. 누락·비지원 코드는 `unsupported_currency`, 과도한 소수·잘못된 금액은 `invalid_amount`다.
- 지출 수정 `PATCH /api/rounds/{roundId}/expenses/{expenseId}`는 currency 생략 시 기존 값을 유지한다. 통화를 바꾸면 amount를 다시 입력하고 CUSTOM을 유지할 때는 customShares도 다시 입력한다. CUSTOM에서 ALL/SELECTED로 바꾸는 경우 지정 부담금은 제거한다. 자동 환전·반올림은 하지 않는다.
- 작성자 또는 회차 생성자만 RECORDING 지출을 변경할 수 있다. 결제자·모임 생성자만이라는 이유로 수정 권한을 주지 않는다. 전송 이후 원본은 잠기며 기존 버전·멱등성·추첨 1회 규칙을 유지한다.
- 회차의 통화별 지출 합계는 각각 주 단위 1,000,000,000 이하, 지출 한 건은 주 단위 100,000,000 이하다. 수정 시 이전 금액을 이전 통화에서 제외하고 새 통화 합계와 종류 수를 검사한다. 6번째 통화는 `round_currency_limit_exceeded`로 거부하며 변경·버전을 저장하지 않는다. 마지막 해당 통화 지출을 변경·삭제하면 슬롯을 다시 사용할 수 있다.
- 회차 목록·상세의 기존 단일 currency/totalMinor/balanceMinor 대신 `totals: [{ currency, totalMinor, balanceMinor }]`를 반환한다. 지출이 없으면 빈 배열이고 최종 잔액이 없으면 balanceMinor는 null이다. 상세의 나머지는 `pendingRemainders: [{ currency, amountMinor }]`이며 최종화 후 빈 배열이다.
- 개인 정산은 `balances: [{ currency, balanceMinor }]`를 반환한다. 최종 저장 전에는 빈 배열이다. outgoing/incoming/transfers와 제외 차단 지출에도 currency를 포함한다. 금액은 문자열·BigInt 최소 단위를 유지하고 통화별로 분배·상계·추첨·송금 계산한다. 다른 통화를 하나의 금액으로 합치지 않는다.
- 개인 KRW outgoing에만 실제 수취인의 최신 계좌를 포함한다. 외화 송금·수취 내역에는 계좌를 포함하지 않는다.

## 수취 확인

개별 수취 확인 요청은 `{ expectedVersion, checked, senderId, currency }`다. 같은 송금자에게서 받는 원화·엔화·달러를 각각 확인하고 해제한다. 송금자를 지정하면서 통화를 생략하면 `unsupported_currency`로 거부한다. 둘 다 생략하는 기존 전체 확인은 본인의 모든 수취 건에 적용한다.

UPDATE는 round_id·receiver_id=본인·sender_id·currency로 행을 선택한다. 한 통화 확인은 다른 통화의 received_at을 바꾸지 않는다. 원본 잔액은 고정하고 같은 통화의 미확인 송금만 보내거나 받을 남은 금액에 표시한다. 수취인별 완료 집계와 일반 종료는 모든 통화의 수취 확인이 완료돼야 성공한다. 완료 회차의 확인 상태는 변경할 수 없다.

## DB 이행

`016-expense-currencies.sql`을 `scripts/migrations.mjs`의 마지막에 추가했다. 이미 적용한 마이그레이션은 수정하지 않는다.

1. expenses, settlement_balances, settlement_transfers에 currency를 추가하고 원래 rounds.currency를 백필한다.
2. 기존 최소 단위 금액·분담금·추첨 결과·received_at은 그대로 유지한다. 지연 FK 검사를 끝낸 뒤 제약을 변경하여 하나의 마이그레이션 트랜잭션 안에서도 기존 데이터 이행이 가능하다.
3. 지원 통화 CHECK와 NOT NULL을 적용한다. 잔액 PK는 `(round_id,user_id,currency)`, 송금 PK는 `(round_id,sender_id,receiver_id,currency)`로 바꾼다.
4. 지출 `(round_id,currency)` 인덱스를 추가하고 rounds.currency를 제거한다.

배포 시 새 코드 실행 전에 `npm run db:migrate`를 적용한다. API 계약도 함께 바뀌므로 기존 클라이언트와 서버 버전을 함께 갱신한다. 개발·운영 DB에는 이 작업에서 직접 마이그레이션을 실행하지 않았다.

## SQL과 동시성

| 요청 | 정상 성공 SQL | 보호 방식 |
|---|---:|---|
| 기록 시작 | 4 | 기존 공용 세션 advisory lock, UUIDv7 ticket PK |
| 회차 목록·상세 | 2 | AUTH + 통화별 JSON 집계 통합 조회, 명시적 트랜잭션·락 없음 |
| 지출 생성 | 6 | AUTH → 요청 검증 → BEGIN → 공용 transaction advisory lock → 조건부 INSERT → 부담금/버전/멱등 저장 → COMMIT |
| 지출 수정 | 5 | AUTH → 통합 조회 → 공용 세션 lock → 조건부 수정/버전/멱등 저장 → unlock |
| 개인 정산 조회 | 2 | AUTH + 통화별 잔액·송금·확인 통합 조회 |
| 수취 확인·해제 | 3 | AUTH → 본인의 수취 목록 → 통화 조건부 UPDATE, 명시적 트랜잭션·락·멱등 저장 없음 |

지출 생성의 통화·자릿수 오류는 AUTH 1회로 종료한다. 생성의 통화 종류/누적 한도 거절은 ROLLBACK까지 5회, 수정의 사전 한도 거절은 2회다. 저장 SQL에서도 통화별 합계·최대 5종·상태·버전을 다시 검사한다. 기존 공용 락과 expectedVersion을 유지하여 5번째/6번째 통화 추가·수정이 경합해도 한 버전 요청만 저장된다. 수취 확인의 변경할 상태가 이미 같으면 404이며 알림을 발행하지 않는다.

나머지 없는 전송의 최종 잔액 INSERT 수는 참여자 수 × 통화 수다. 추첨이 필요한 경우 기존 단일 CTE에 모든 통화의 최종 분담금·잔액·송금을 함께 저장하며 저장된 결과를 다시 추첨하지 않는다. 상세의 전체 합계와 예상 송금은 지출 페이지 크기에 영향을 받지 않는다.

## 화면과 검증

기존 SheetSelect의 검색·국기·Korean 통화 이름·네이티브 dialog·포커스를 지출 폼에서 재사용한다. 통화 변경 시 금액 입력을 비워 새 통화 금액을 받는다. 회차 상세·홈·정산 기록 카드에 최대 5개의 금액을 통화별로 표시하고 ‘나의 송금 관계’는 같은 통화의 관계 뒤에 통화 이름과 구분선을 표시한다. 기존 카드·폰트·버튼·금액 애니메이션 스타일을 재사용하며 수취 확인 행은 송금자+통화로 구분한다.

- `npm test`: 99개 통과.
- 별도 로컬 PostgreSQL 테스트 DB와 MinIO 버킷의 `npm run test:integration`: 81개 통과. 기존 SQL 로그·권한·버전·멱등성·추첨·완료·영수증·과거 기록 회귀를 포함한다.
- `scripts/multicurrency.integration.test.ts`: 5종 제한/슬롯 반환/동시 추가·수정/개별 부담금 통화 변경/분배 방식 전환/같은 송금자의 통화별 수취 확인·해제/종료 조건을 검증하는 7개 테스트를 실행한다.
- `scripts/auth.integration.test.ts`: 기존 KRW·USD 지출·잔액·송금 통화를 이행하고 금액·확인 시각·기존 회차 필드가 보존됨을 검증한다.
- `npm run build`: 통과. 별도 소스·의존성 복사본에서도 최종 빌드를 검증한다.
- `scripts/browser-check.mjs --currencies-only`: 실제 Chrome 320/390/1024px에서 통화 없는 회차 생성, 41종 검색, Escape/포커스 복원, 5개 총액/송금 구분선, 6번째 통화 거절, 통화 수정, 통화별 확인·해제·전체 확인, 가로 넘침 없음을 확인했다.
- `scripts/browser-check.mjs --expenses-only`: 지출 POST/PATCH/DELETE·확정·재오픈·추첨·개별/전체 수취 확인·해제 모두 **mutation GET 0 → WebSocket GET 1**을 확인했다. 성공 후 직접 reload는 추가하지 않았다.

브라우저는 테스트 DB를 사용하는 별도 소스 복사본과 3097 포트에서 검증했다. 화면 증거는 `/tmp/da-moa-multicurrency-browser-artifacts/`, 실행 로그는 `/tmp/da-moa-multicurrency-*.log`에 저장했다.
