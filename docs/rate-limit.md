# Rate Limit 도입 기록

작성일: 2026-10-07. [실제 사용자 혼합 부하테스트](https://app.notion.com/p/3f160c1ed8eb80cba68bc72abd7a1922)의 330 RPS와 사용자가 선택한 90%를 기준으로 전체 제한을 297 RPS로 정했다. 이 수치는 운영 목표의 초기 설정이며 최대 처리 한계를 새로 측정한 결과는 아니다.

## 요청 흐름과 책임

```text
Nginx 전체 297 RPS / 로그인 IP 제한
→ Node 서버 공용 JWT 규칙으로 사용자 식별
→ 사용자 ID + 요청 종류 Token Bucket
→ Next Proxy의 기존 JWT guard
→ 기존 Controller / 회원 상태·입력·권한 검사 / SQL
```

JWT가 없거나 무효이면 사용자 버킷을 만들지 않고 기존 Proxy의 401·Refresh 쿠키 정리를 사용한다. 공개 헬스 GET/HEAD·카카오 로그인 시작·개발 테스트 로그인은 공용 Auth 정책에 따른 예외다. 카카오 로그인은 Nginx의 IP 제한으로 보호한다. WebSocket은 별도 upgrade 경로에서 Origin 확인 → Access JWT 서명·만료·app 목적 확인 → 연결 버킷 → 기존 DB 회원 상태 확인 → 업그레이드 순서다. 기존 연결의 ping/pong·1분 회원 재인증은 연결 시도에 포함하지 않는다.

| 모듈 | 단일 책임 |
|---|---|
| `deploy/nginx/rate-limit-zones.conf` | 전체/IP 키와 Leaky Bucket zone 정의 |
| `deploy/nginx/rate-limit-server.conf` | Nginx 제한 적용과 초과 HTTP 응답 |
| `Global/Auth/Backend/api-jwt-util.ts` | 공개/Access/Refresh/로그아웃 인증 규칙과 JWT 판별 공용화 |
| `Global/RateLimit/Backend/rate-limit-policy.ts` | 버킷 수치와 요청 종류 분류 |
| `Global/RateLimit/Backend/token-bucket.ts` | 충전·검사·원자적 차감·완전 충전된 항목 정리 |
| `Global/RateLimit/Backend/rate-limit-response.ts` | 429 JSON·Retry-After·캐시 금지 응답 구성 |
| `Global/RateLimit/Backend/native.ts` | 공개 Node 진입점, HTTP/upgrade 전달 제어와 정리 타이머 수명 관리 |
| `Global/Util/Frontend/rate-limit-util.ts` | Retry-After 파싱과 취소 가능한 대기 |
| `lib/api-client.ts` | 기존 요청·멱등 키 유지, GET 한 번 재시도와 오류 전달 |

`server.mjs`는 limiter를 한 번 만들어 HTTP와 WebSocket에 연결한다. Next.js의 로컬 `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`는 Proxy와 앱의 모듈/global 공유에 의존하지 말라고 명시한다. 따라서 버킷 상태를 Proxy나 개별 Route Handler에 두지 않는다. 새 모듈의 Backend import 경계도 기존 단일 책임·캡슐화 테스트에 포함했다.

## 설정과 계산

| 사용자별 종류 | 최대 토큰 | 초당 충전량 | 지속 허용량 |
|---|---:|---:|---:|
| 조회 GET·HEAD | 30 | 3 | 180회/분 |
| 쓰기 및 기타 인증 API 메서드 | 10 | 0.5 | 30회/분 |
| 영수증 POST 업로드 | 3 | 1/6 | 10회/분 |
| POST `/api/auth/access-token`, `/api/auth/refresh` | 5 | 1/3 | 20회/분 |
| WebSocket 연결 시도 | 3 | 1/6 | 10회/분 |

영수증 업로드는 쓰기 버킷도 함께 적용하고, Access 발급·갱신은 쓰기와 분리한다. URL·기기·세션·JWT 문자열 대신 검증된 `userId`와 종류를 키로 사용한다. 서버 재시작 후 첫 요청은 최대 토큰으로 생성하고 바로 1개 차감한다. 통과한 뒤 입력·권한 검사에서 실패해도 반환하지 않는다.

```text
충전 토큰 = min(capacity, tokens + elapsedMilliseconds × refillPerSecond / 1000)
대기 초 = ceil(max(0, 모든 적용 버킷의 (1 - 충전 토큰) / refillPerSecond))
대기 초 > 0이면 모든 버킷 차감 없이 429
그 외에는 각 버킷을 1개씩 차감
```

시간은 단조 증가하는 `performance.now()`를 사용한다. 생성·충전·전체 버킷 검사·차감 사이에 `await`가 없어서 같은 실행 환경의 동시 요청이 동일 토큰을 중복 사용하지 않는다. 완전히 충전될 시간이 지난 버킷만 60초 간격으로 삭제한다. 아직 제한 중인 항목을 삭제해 한도를 초기화하지 않는다.

## 429와 재시도

앱 응답은 `error: rate_limited`, 대기 초를 포함한 한국어 message, `details.retryAfterSeconds`, `Retry-After`, `Cache-Control: private, no-store`를 반환한다. HEAD는 같은 제한을 적용하고 본문은 반환하지 않는다. Nginx는 전체 한도에 burst 50, 로그인 IP 한도에 burst 5를 즉시 허용하고 초과는 JSON 429로 거절한다.

클라이언트의 저장 요청은 자동 재시도하지 않고 기존 입력·본문·Idempotency-Key를 유지한다. 응답이 유실된 저장을 재시도하다 429가 발생해도 최초 버전·키·본문을 유지한다. Refresh가 429여도 로그인 토큰을 지우거나 로그인 페이지로 보내지 않는다. GET은 Retry-After만큼 대기한 뒤 한 번만 재시도하고 AbortSignal로 대기를 취소할 수 있다. 공유 중인 GET은 대기 중에도 같은 Promise를 사용한다. 두 번째 요청도 실패하면 기존 오류·수동 새로고침 흐름을 사용한다. 성공한 mutation에서 직접 GET을 추가하지 않는다.

## 운영 반영과 한계

[OCI 배포 가이드의 설치 순서](oci-deploy.md#요청량-제한)대로 두 Nginx 파일을 설치하고 HTTPS server에 snippet을 include한 뒤 `nginx -t`와 reload가 필요하다. 앱의 기존 GitHub Actions는 Nginx 설정을 설치하지 않는다. 영수증과 WebSocket 전용 location도 server 제한을 상속한다. 앱 limiter는 기존 `npm run start`/`server.mjs`에서 실행하며 `next start`로 우회하면 적용되지 않는다.

DB 스키마·트랜잭션·SQL·패키지는 추가하지 않았다. 버킷은 프로세스 메모리이며 재시작 시 초기화된다. 다중 프로세스/서버 전환 시 공유 저장소의 원자적 충전·차감이 필요하다. 297 RPS는 요청별 DB/파일 비용 차이를 모두 보장하지 않으므로 운영 DB CPU·풀/락 대기·영수증 큐·429 비율을 보고 재조정한다.

## 검증

- `npm test`: **115/115 통과**. 사용자·종류 격리, 분수 충전, 동시 25개 쓰기 중 초기 10개 허용, 업로드 두 버킷의 원자적 차감, 완전 충전 후 정리, 공용 JWT 예외/Refresh 규칙, HEAD 429, 입력·키 유지, GET 단일 재시도·공유·대기 취소를 검증했다.
- `npm run test:integration`: **83/83 통과**. 작업 전용 `da_moa_rate_limit_20261007_test` DB와 `da-moa-rate-limit-20261007-test` 버킷을 사용했다. 실제 `server.mjs`/Next 요청 40개의 같은 사용자 버킷 공유, 기기/JWT 변경 후 한도 유지, 영수증 4번째 요청의 429·Retry-After 6초·**SQL 0회**, 기존 WebSocket·멱등 재시도·SQL 수·회원 탈퇴 흐름을 확인했다.
- `npm run build`: 격리 복사본의 운영 빌드·TypeScript 검사 통과. 기존 개발 서버의 `.next/dev/lock`과 생성 파일은 건드리지 않았다.
- `npm run test:nginx`: 공식 `nginx:stable-alpine` 이미지에서 `nginx -t` 및 실제 HTTP 검증 통과. API·영수증·WebSocket 경로를 섞은 600개 요청 중 **89개 허용 / 511개 429**, 로그인 IP 요청 20개 중 **6개 허용 / 14개 429**, Retry-After·JSON·캐시 금지·정적 경로 예외를 확인했다. Nginx의 burst 5는 기본 허용 요청에 추가되는 초과 여유여서 최초 로그인 6개가 통과한다. 테스트 실행 시 이미지 digest는 `sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94`였다.

첫 통합 실행에서 Rate Limit 대기 동안 주기적 WebSocket 회원 재검증 SQL이 요청 SQL 집계에 섞였다. 그 재검증의 정확한 SELECT 패턴만 제외하고 HTTP AUTH·비즈니스·워커 SQL 검증은 유지했다. 재실행에는 실패한 이전 시나리오가 남긴 미종료 회차가 영향을 주어, 이 작업에서 만든 테스트 DB만 다시 생성한 뒤 전체 검증을 통과했다. 테스트 시나리오의 빠른 연속 요청은 Retry-After에 따라 같은 키·본문으로 재시도하며 별도의 실제 제한 검사는 자동 재시도 없이 수행했다.

운영 Nginx 설치·reload와 새 운영 부하테스트는 실행하지 않았다. 앱 기능의 로컬 검증과 실제 운영 반영은 구분한다. 테스트 명령은 재현 가능하도록 기존 npm 스크립트 및 새 `test:nginx` 스크립트에 남겼다.
