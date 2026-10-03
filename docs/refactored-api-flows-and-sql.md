# 분리한 API 목록·로직 흐름·SQL

작성 기준: 2026-10-03의 현재 구현. Health 5개, Group 8개, User 4개, Settle 21개 API를 기록한다. 모임 수정 API는 추가하지 않았다. Settle의 API별 호출 흐름·SQL 횟수·검증은 [8절](#8-settle-요청-흐름sql)에 기록한다.

SQL은 해당 함수의 실제 query() 문자열을 가져와 PostgreSQL 형식으로 정리했다. $1 등의 바인딩 위치를 유지하며 실제 토큰·회원 정보·계좌·연결 문자열은 넣지 않는다. SQL 번호는 문서의 식별자이며 요청 순서는 API별 흐름에서 지정한다.

## 1. 구현 파일과 공통 유틸

| 책임 | 현재 파일/진입점 |
|---|---|
| Health HTTP·검사·SQL | [Health Backend](../src/Domain/Health/Backend/index.ts), Controller/HealthController.ts, Service/HealthService.ts, Repository/HealthRepository.ts |
| Group HTTP | [GroupController](../src/Domain/Group/Backend/Controller/GroupController.ts)의 getGroupResponse()·isGroupPath() |
| Group 업무 규칙 | [GroupService](../src/Domain/Group/Backend/Service/GroupService.ts) |
| Group SQL | [GroupRepository](../src/Domain/Group/Backend/Repository/GroupRepository.ts) |
| Group 공개 계약 | [Group Shared](../src/Domain/Group/Shared/index.ts)의 GroupSummary·GroupListItem·GroupDetail·InvitePreview·GroupMutationResult·입력 DTO |
| User HTTP | [UserController](../src/Domain/User/Backend/Controller/UserController.ts)의 내 정보·가입·계좌 변경·탈퇴 응답 |
| User 업무 규칙·SQL | [UserService](../src/Domain/User/Backend/Service/UserService.ts), [UserRepository](../src/Domain/User/Backend/Repository/UserRepository.ts), 내부 UserDAO·UserException |
| User UI·공개 계약 | [User Frontend](../src/Domain/User/Frontend/index.ts)의 AccountPanel·OnboardingClient·계좌 폼·AccountProvider, [User Shared](../src/Domain/User/Shared/index.ts)의 DTO·순수 은행 규칙 |
| 로그인·JWT 발급 | [AuthService](../src/Global/Auth/Backend/Service/AuthService.ts). 회원 SQL은 User 공개 기능으로 위임하고 JWT 구현은 Global/Auth에 유지 |
| 입력 검증 | [input-validation-util.ts](../src/Global/Util/Backend/input-validation-util.ts)의 textInput()·onlyKeys()·idsInput() |
| 페이지네이션 | [pagenation-util.ts](../src/Global/Util/Backend/pagenation-util.ts)의 pagination()·pageOf() |
| 멱등 실행 | [idempotency-util.ts](../src/Global/Util/Backend/idempotency-util.ts)의 domainMutation()·Identity. 기존 lib/mutations.ts의 replayMutation()·saveMutation() 재사용 |
| 공개 공통 진입점 | [Global Util Backend](../src/Global/Util/Backend/index.ts). 기존 호출자의 import 경로와 함수 이름 유지 |
| 현재 시각 | nowSeconds는 기존 currentTimestamp()의 공개 별칭. 같은 초 단위 계산을 중복 구현하지 않음 |
| 인증 | [Node Proxy](../src/proxy.ts) → [JwtGuard](../src/Global/Auth/Backend/Guard/JwtGuard.ts). Controller 진입 전 JWT 검증. Service의 requireAccount()는 회원 상태 조회에 사용 |
| 협력 조회 | [User Backend](../src/Domain/User/Backend/index.ts)의 getActiveUserProfiles(), [Settle Backend](../src/Domain/Settle/Backend/index.ts)의 미종료 여부 조회. Service가 같은 DB Client 전달 |
| 실시간 | [Global Websocket Backend](../src/Global/Websocket/Backend/index.ts). publishGroupInvalidation() 구현에 위임; DELETE 수신자와 초대 발급/폐기 수신자는 업무 조회에서 확보 |

입력 검증은 문자열 trim·필수/최대 길이, 허용 필드, 중복 없는 참여자 ID를 검사한다. 모임 이름은 최대 100자, 재발급 초대 ID는 최대 128자다. idsInput()은 현재 회차 코드에서도 사용하는 공통 함수다. 페이지네이션은 기본 limit=20, 허용 범위 1~100이고 커서의 길이·시각·ID를 검증한다. pageOf()는 limit+1 조회 중 실제 페이지와 다음 위치 커서를 만든다. 모임 생성은 명시적 트랜잭션 없이 UUIDv7 PK의 모임·생성자 멤버십을 단일 SQL로 저장한다. 초대 발급·폐기는 권한과 멱등 성공 기록을 함께 조회하고 단일 SQL로 초대 생성 또는 폐기와 성공 기록을 저장한다. 재발급 시 이전 초대도 같은 SQL에서 폐기한다. 나머지 쓰기는 domainMutation() 또는 leaveGroup()에서 인증 → 키/본문 검사·성공 재생 → 업무 실행 → 성공 기록 저장을 같은 쓰기 트랜잭션에서 수행한다.

## 2. API 목록

### Health

모두 공개 GET/HEAD이며 HealthRequestDTO/HealthResponseDTO를 사용한다. 검사 정상은 HTTP 200, 의존 서비스 실패는 503이며 Cache-Control: no-store다. Guard의 공개 허용은 아래 다섯 경로에 한정한다. 미등록 경로는 JWT가 없으면 Guard에서 401, 유효한 JWT가 있으면 Controller에서 검사 없이 404다.

| 메서드·경로 | 역할 | 정상 검사 시 DB SQL | 외부 검사 |
|---|---|---:|---|
| GET /api/health/live | 앱 응답 확인 | 0 | 없음 |
| GET /api/health/database | PostgreSQL 응답 확인 | 1 | DB |
| GET /api/health/minio | MinIO 읽기/쓰기 정족수 확인 | 0 | MinIO GET 2회 |
| GET /api/health/dependencies | DB·MinIO 확인 | 1 | DB와 MinIO 병렬 |
| GET /api/health | 앱·DB·MinIO 종합 | 1 | DB와 MinIO 병렬 |

### Group

모두 Access JWT와 회원의 가입·탈퇴 상태를 확인한다. 정상은 HTTP 200과 { data: 응답 DTO }, Cache-Control: private, no-store다. 쓰기에는 같은 출처의 Origin과 Idempotency-Key가 필요하다. Group 작업에는 expectedVersion이 없다.

| 메서드·경로 | Service | 입력 | 응답 DTO | 권한/역할 |
|---|---|---|---|---|
| POST /api/groups | createGroup() | { name } | GroupMutationResult: 모임 id | 가입 완료 회원 |
| GET /api/groups | listGroups() | q·limit·cursor | Page<GroupListItem> | 본인의 활성 모임 |
| GET /api/groups/{groupId} | getGroup() | 경로 모임 ID | GroupDetail: 모임 정보·멤버·isCreator·생성자의 유효 초대 | 현재 활성 모임 멤버 |
| DELETE /api/groups/{groupId} | leaveGroup() | 경로 모임 ID | GroupMutationResult: 모임 id | 일반 멤버 이탈 / 생성자 닫기 |
| POST /api/groups/{groupId}/invites | createInvite() | {} 또는 { replaceInviteId } | GroupMutationResult: 초대 id·inviteId·최초 sharePath | 활성 모임 생성자 |
| DELETE /api/groups/{groupId}/invites/{inviteId} | revokeInvite() | 경로 모임·초대 ID | GroupMutationResult: 초대 id | 활성 모임 생성자 |
| GET /api/invites/{token} | getInvite() | 경로 원문 토큰 | InvitePreview | 가입 완료 회원, 유효 초대 |
| POST /api/invites/{token}/accept | acceptInvite() | 경로 원문 토큰 | GroupMutationResult: 모임 id | 가입 완료 회원, 유효 초대, 정원 조건 |

GroupSummary는 모임 ID·이름·생성자 ID·생성 시각이다. 목록은 활성 회원 수와 최대 5명의 미리보기를 붙인다. 상세는 현재 멤버·생성자 여부·생성자에게만 유효 초대를 반환한다. InvitePreview는 모임 ID·이름·현재 참여 여부·만료 시각이다. Group API는 계좌나 내부 DB 행을 응답에 담지 않는다.

### User

기존 경로·메서드를 유지한 **4개 분리 API**다. Node Proxy → JWT Guard → 기존 Route Handler → UserController → UserService 순서로 처리한다. 네 API 모두 Bearer Access JWT와 `Cache-Control: private, no-store`를 사용하며, 변경 요청은 동일 출처를 검사한다. 온보딩 목적 JWT도 내 정보 조회·가입 완료에 사용할 수 있다.

| 메서드·경로 | Controller → Service | 입력 | 성공 응답 | 주요 조건 |
|---|---|---|---|---|
| GET /api/me | getMeResponse() → getMe() | 없음 | `{ data: Account }`: 프로필·가입/탈퇴 상태·본인 계좌·bankVersion | 본인 정보만 조회, 가입 전 JWT 허용 |
| POST /api/me/onboarding | getOnboardingResponse() → completeOnboarding() | OnboardingRequestDTO: bankCode·accountNumber·accountHolder·expectedBankVersion·선택 confirmRejoin | `{ data: { id, returnTo, accessToken } }` + Refresh 쿠키 | 온보딩 목적·최신 계좌 버전·탈퇴 회원의 명시적 재가입 동의 |
| PUT /api/me/bank-account | getBankAccountResponse() → updateBankAccount() | BankAccountRequestDTO + Idempotency-Key | `{ data: { id, bankVersion } }` | 가입 완료 회원, 계좌 버전 조건부 갱신·실패 시 409 |
| POST /api/auth/withdraw | getWithdrawalResponse() → withdrawAccount() | 없음 | `{ ok: true }` + 인증·복귀·OIDC 쿠키 삭제 | 제외된 참여 이력까지 모든 미종료 회차가 없어야 함 |

은행 입력은 기존 수동 등록만 지원한다. 계좌 원본 숫자·표시 형식을 분리하며, 신규 가입/재가입은 확인 이력을 초기화한다. 계좌 변경은 같은 정규화 은행·번호·예금주일 때만 기존 확인 이력을 보존한다. 진행 중 정산이 있어도 대표 계좌 변경은 가능하다. 가입 완료·탈퇴에는 멱등 기록을 새로 추가하지 않았다.

카카오 콜백 `/auth/v1/kakao`와 테스트 로그인 `/api/auth/test-login`은 Global/Auth가 처리한다. 회원 upsert·테스트 회원 조회/생성만 User의 공개 기능으로 옮겼으므로 User API 목록에 포함하지 않는다. JWT 갱신·로그아웃도 Global/Auth 소유다.

### Settle

기존 **21개 메서드/경로**를 SettleController.getSettleResponse()로 분배한다. Access JWT·가입 완료·미탈퇴 확인, 동일 출처의 변경 요청, private/no-store 응답을 유지한다. 변경 요청은 Idempotency-Key, 회차 생성 외 변경은 expectedVersion을 사용한다.

| 메서드·경로 | Service | 공개 입력/응답 | 흐름 |
|---|---|---|---|
| POST /api/groups/{groupId}/rounds | createRound() | CreateRoundRequestDTO → MutationResult | S1 |
| GET /api/groups/{groupId}/rounds | listRounds(groupId) | q·status·limit·cursor → Page<RoundSummary> | S2 |
| GET /api/rounds | listRounds() | q·status·limit·cursor → Page<RoundSummary> | S3 |
| GET /api/rounds/{roundId} | getRound() | limit·cursor → RoundDetail | S4 |
| DELETE /api/rounds/{roundId} | roundCommand('cancel') | VersionRequestDTO → MutationResult | S5 |
| POST /api/rounds/{roundId}/expenses | saveExpense() | ExpenseRequestDTO → MutationResult | S6 |
| PATCH /api/rounds/{roundId}/expenses/{expenseId} | saveExpense(expenseId) | ExpenseRequestDTO → MutationResult | S7 |
| DELETE /api/rounds/{roundId}/expenses/{expenseId} | deleteExpense() | VersionRequestDTO → MutationResult | S8 |
| GET /api/rounds/{roundId}/members/{userId}/exclusion-check | checkExclusion() | ExclusionCheck | S9 |
| POST /api/rounds/{roundId}/members/{userId}/exclude | excludeMember() | VersionRequestDTO → MutationResult | S10 |
| POST /api/rounds/{roundId}/confirm | roundCommand('confirm') | VersionRequestDTO → MutationResult | S11 |
| POST /api/rounds/{roundId}/reopen | roundCommand('reopen') | VersionRequestDTO → MutationResult | S12 |
| POST /api/rounds/{roundId}/send | roundCommand('send') | VersionRequestDTO → MutationResult | S13 |
| POST /api/rounds/{roundId}/draw | roundCommand('draw') | VersionRequestDTO → MutationResult | S14 |
| GET /api/rounds/{roundId}/settlement | getSettlement() | SettlementDTO | S15 |
| POST /api/rounds/{roundId}/settlement-check | setSettlementCheck() | SettlementCheckRequestDTO → MutationResult | S16 |
| POST /api/rounds/{roundId}/complete | roundCommand('complete') | VersionRequestDTO → MutationResult | S17 |
| POST /api/rounds/{roundId}/force-complete | roundCommand('force-complete') | VersionRequestDTO → MutationResult | S18 |
| POST /api/rounds/{roundId}/expenses/{expenseId}/receipts | addReceipt() | multipart(file,expectedVersion) → MutationResult | S19 |
| GET /api/receipts/{receiptId} | getReceipt() | 인증된 바이너리 이미지 | S20 |
| DELETE /api/rounds/{roundId}/expenses/{expenseId}/receipts/{receiptId} | removeReceipt() | VersionRequestDTO → MutationResult | S21 |

## 3. 공통 실행 순서와 SQL 식별자

### Node JWT Guard

모든 `/api/:path*` 요청은 Node.js에서 실행되는 `src/proxy.ts`를 거쳐 Global Auth의 `jwtGuard()`에 도달한다. 기본 정책은 Authorization: Bearer Access JWT의 서명·알고리즘·만료·issuer·audience·토큰 종류 검증이며 누락·실패는 본문/페이지네이션 검사나 DB 접근 전에 `401 unauthorized`, `private, no-store`로 끝난다. JWT 검증은 기존 함수를 재사용하며 SQL이 추가되지 않는다. Controller와 트랜잭션의 기존 검증도 유지한다.

공개 경로는 다섯 Health GET/HEAD, `GET /api/auth/kakao`, `POST /api/auth/test-login`이다. 로그인 시작은 첫 JWT 발급을 위한 예외이고 개발용 로그인은 기존 로컬·개발 환경 제한을 유지한다. `/auth/v1/kakao` 콜백은 API matcher 밖에서 기존 state·nonce·PKCE·OIDC 검증을 수행한다. `POST /api/auth/access-token`·`POST /api/auth/refresh`는 Access JWT 대신 Refresh JWT를 요구하고, 실패 시 기존처럼 두 인증 쿠키를 지운다. `POST /api/auth/logout`은 Refresh 또는 Access JWT를 요구한다. 문서·OpenAPI·미등록 API도 기본 인증 대상이다. 페이지·정적 파일은 API Guard 범위 밖이며 데이터는 인증된 API로만 조회한다.

**모든 API의 공통 진입 순서는 HTTP 요청 → Node Proxy → JWT Guard → Route Handler → Controller → Service다.** Public API도 Guard를 먼저 거치며 공개 경로·메서드 조건에 맞으면 JWT 검사만 생략한다. 따라서 G1뿐 아니라 G2~G8과 Health에도 Guard 단계가 적용된다.

JWT Guard는 JWT의 유효성을 검사하며 SQL은 0회다. 아래 SQL 순서의 AUTH는 Guard 이후 Service에서 실행하는 users 회원 상태 SELECT 1회로, JWT 검사나 세션 조회를 뜻하지 않는다.

SQL 기록과 아래 호출 수는 유효한 JWT가 Guard를 통과한 요청 기준이다. Service/Route Handler를 직접 호출하는 테스트는 Proxy를 거치지 않으므로 입력 검증 결과가 HTTP 요청의 인증 우선 결과와 다를 수 있다.

Access JWT는 localStorage에 저장하며 만료는 10분이다. 로그인 완료 시 Refresh JWT를 POST /api/auth/access-token으로 검증해 Access JWT를 받아 저장한다. Refresh는 HttpOnly 쿠키에 저장하고 서명·만료·종류·목적을 확인한다. 로그인·가입·갱신·로그아웃은 refresh_sessions를 읽거나 쓰지 않는다. sid는 JWT 발급 식별자일 뿐 DB 세션이 아니다. 갱신은 목적을 보존하며 onboarding의 원래 만료를 연장하지 않는다. 로그아웃은 클라이언트 Access 토큰과 Refresh 쿠키를 삭제하며 이전 JWT는 자체 만료까지 유효하다. 회원의 가입·탈퇴 상태와 리소스 권한 검사는 유지한다.

브라우저 공통 조회 흐름은 다음과 같다. `AppShell` 진입과 pathname 변경마다 `/api/me`를 한 번 조회하고 결과를 `AccountContext`로 공유한다. 200이면 그대로 사용한다. `/api/me`의 401·404는 `/api/auth/refresh`를 한 번 호출하고, 성공하면 갱신된 Bearer JWT로 원래 요청을 한 번만 재시도한다. 갱신 401은 토큰을 지우고 로그인으로 이동하며 503은 재시도 오류로 표시한다. 일반 모임·회차 API의 404는 갱신하지 않는다.

`apiRequest()`는 같은 URL·응답 종류·Access 토큰의 진행 중인 GET Promise만 공유한다. 완료·실패 후에는 지우므로 페이지 재방문, 검색, 다음 커서, 수동 갱신과 실시간 무효화는 최신 데이터를 조회한다. AbortSignal이 있는 요청과 변경 요청은 공유하지 않는다. 수동 재조회·실시간 무효화는 fresh 요청으로 이전 읽기를 공유하지 않아 변경 전 응답이 최신 결과를 덮지 않게 한다. 동일 이벤트의 여러 키에 등록된 listener는 Set으로 한 번만 실행한다. 개발 모드 effect 재실행도 이 경로를 사용하므로 정상 모임 목록 진입의 브라우저 요청은 `/api/me` 1회 → `/api/groups` 1회다. 유지되는 layout에서 페이지를 이동하면 내 정보 응답을 확인한 뒤 새 페이지 자료를 조회한다. 확인 중에는 화면 자료 대신 로딩·재시도를 표시하며 WebSocket 연결은 유지한다.

WebSocket 최초 연결은 이미 확인한 AccountContext와 저장된 JWT를 사용하며 연결 전후에 브라우저 `/api/me`나 화면 자료를 다시 조회하지 않는다. 재연결 시에는 내 정보를 갱신한 뒤 연결하고 화면의 구독 자료를 다시 읽는다. 서버는 기존 `readAccessToken()`으로 WebSocket JWT를 직접 검증하고 공용 풀에서 id·탈퇴·가입 완료 상태만 SELECT한다. 최초 연결·주기적 검증 모두 내부 HTTP `/api/me`를 호출하지 않는다. Node.js 22.18 이상의 기본 TypeScript 타입 제거로 기존 순수 JWT 모듈을 재사용한다. 계좌 화면도 처음에는 Context를 사용하고 저장·충돌 복구 시에만 명시적으로 재조회한다.

공통 조회 변경 검증: `npm test` 89개, 격리 PostgreSQL·MinIO의 `npm run test:integration` 38개, `npm run build` 통과. 실제 개발 서버와 Chrome에서 모임 직접 진입 및 홈·모임·정산 기록·전체·계좌의 클라이언트 이동마다 `/api/me`가 먼저 1회, 각 화면 자료가 1회 조회됨을 검증했다. 계좌 저장·실시간 갱신·정산·로그아웃 회귀 검사도 통과했다.

실제 Node 서버 통합 검사는 미인증 잘못된 JSON의 401 우선 차단, 변조·만료·토큰 종류 혼동, 공개 Health, Refresh-only 갱신·로그아웃 및 Bearer WebSocket 인증을 검증한다.

### 읽기 R — 모임 목록·상세 제외

1. HTTP 요청 → Node Proxy → JWT Guard에서 Access JWT 검증 → Route Handler/Controller → Service 입력 검증.
2. 공용 pg 풀에서 연결 확보.
3. R-START: REPEATABLE READ READ ONLY 시작. 문장 15초·잠금 10초 제한은 풀의 PostgreSQL startup parameter로 적용한다.
4. AUTH: JWT 목적과 가입 완료 회원 상태 확인.
5. 해당 API의 권한·데이터 SQL 실행. 같은 스냅샷과 Client 사용.
6. TX-COMMIT → 연결 반환. 실패는 TX-ROLLBACK → 연결 반환; 롤백 실패 연결은 폐기.

읽기 트랜잭션 자체는 R-START의 BEGIN 1문장과 COMMIT 1문장으로 총 2회다. 도메인용 명시적 락은 없다.

### 쓰기 W — 모임 생성·초대 발급/폐기 제외

1. Node Proxy → JWT Guard가 Route Handler/Controller 진입 전에 Access JWT를 검증한다. 통과한 요청은 Controller에서 JWT를 다시 확인하고 동일 출처 검사. JSON을 읽는 API는 기존 1MiB 제한·객체 본문 검사.
2. 필요한 Service 입력 검증. 모임/초대 생성 입력은 트랜잭션 전에 검사.
3. 공용 pg 풀에서 연결 확보 → W-START: BEGIN → 기존 공통 advisory transaction lock. 제한은 풀 연결의 기본값을 사용한다.
4. AUTH: JWT 목적·가입 완료 회원 상태 확인.
5. replayMutation(): UUID 형식 Idempotency-Key 검사 → 정렬한 payload의 SHA-256 → IDEM-READ.
6. 동일 키·동일 payload의 기존 성공이면 업무 SQL 없이 저장된 결과 재생 → COMMIT. 다른 payload이면 idempotency_conflict·ROLLBACK.
7. 해당 API의 권한·상태 검사와 업무 SQL. 성공한 경우에만 IDEM-SAVE.
8. TX-COMMIT → 연결 반환 → Controller 응답. 실패는 전체 ROLLBACK.
9. 실시간 기능이 켜져 있으면 성공 응답 후 after()에서 모임 무효화 알림. 재생 성공도 현재 Controller에서 알림을 예약한다.

쓰기 트랜잭션 부가 SQL은 W-START의 BEGIN·락 2문장과 COMMIT 1문장으로 총 3회다. 모임 생성과 초대 발급/폐기/수락은 이 경로를 사용하지 않는다. 다른 쓰기의 기존 전역 advisory lock을 회차 기록/수정에만 적용하도록 바꾸는 정책 전환은 별도 작업이다.

| operation | 멱등 payload |
|---|---|
| group.leave | { groupId } |
| invite.create | { groupId, ...원 요청 body } |
| invite.revoke | { groupId, inviteId } |
| invite.accept | { tokenHash: SHA-256(token) } |

본문 fingerprint는 원 요청 payload 기준이다. 같은 키로 본문을 바꾸면 충돌한다. 초대 원문 토큰은 group_invites·mutation_requests에 저장하지 않는다.

## 4. API별 로직 흐름과 SQL 순서

### H1. GET /api/health/live

브라우저/운영 검사 → Node Proxy → JWT Guard(공개 GET/HEAD 허용, JWT 검사 생략) → Health Route Handler → 공개 getHealthResponse() → Controller가 scope=live DTO 작성 → checkHealth() → 외부 검사 없이 application=ok → HealthResponseDTO → 200. SQL·트랜잭션·JWT 검사·멱등·파일 작업 없음.

### H2. GET /api/health/database

운영 검사 → Node Proxy → JWT Guard(공개 GET/HEAD 허용, JWT 검사 생략) → Health Route Handler → Health Controller의 scope=database → checkHealth() → Repository.checkDatabase() → 공용 풀에서 H-DB의 SELECT 1 한 번 → 풀 연결 반환 → database=ok/down → 200/503. 별도 BEGIN·SET LOCAL·명시적 락 없음. 연결 설정/쿼리 실패는 내부 내용을 숨기고 down으로 반환.

### H3. GET /api/health/minio

운영 검사 → Node Proxy → JWT Guard(공개 GET/HEAD 허용, JWT 검사 생략) → Health Route Handler → Health Controller의 scope=minio → checkHealth() → checkMinio() → MINIO_ENDPOINT 기준 /minio/health/cluster/read 및 /minio/health/cluster GET 병렬 실행 → 둘 다 200이면 ok, 하나라도 실패하면 down → 200/503. 각 HTTP 요청 제한은 5초, no-store다. DB SQL 0회이며 객체·버킷 권한·영수증 I/O를 검사하는 요청은 아니다.

### H4. GET /api/health/dependencies

운영 검사 → Node Proxy → JWT Guard(공개 GET/HEAD 허용, JWT 검사 생략) → Health Route Handler → Health Controller의 scope=dependencies → DB의 H2와 MinIO의 H3를 병렬 실행 → database·minio 결과를 취합 → 하나라도 down이면 503, 모두 ok이면 200. 정상 DB 검사 시 SQL은 H-DB 한 번이다.

### H5. GET /api/health

운영 검사 → Node Proxy → JWT Guard(공개 GET/HEAD 허용, JWT 검사 생략) → Health Route Handler → Health Controller의 scope=overall → H4의 의존 서비스 검사와 application=ok 취합 → HealthResponseDTO → 200/503. 정상 DB 검사 시 SQL은 H-DB 한 번이다. 외부 검사 실패가 저장 레코드나 파일을 남기지 않는다.

### G1. POST /api/groups — 모임 생성

GroupsList.create() → POST /api/groups → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Group 분배 → GroupController.getGroupResponse()의 JSON 입력 → GroupService.createGroup(CreateGroupRequestDTO) → 아래 DB 처리 → GroupMutationResult → 상세 화면 이동.

1. onlyKeys(['name'])·textInput(name): trim 후 1~100자. Idempotency-Key는 UUIDv7 형식으로 검사하고 소문자로 정규화한다.
2. withDatabaseConnection()으로 공용 풀의 연결만 확보 → AUTH: JWT userId로 users를 한 번 읽어 가입·탈퇴 상태와 JWT 목적을 확인한다. 세션·멱등 기록을 조회하지 않는다.
3. UUIDv7 요청 키를 모임 PK로 사용 → G-CREATE 단일 SQL: 모임 INSERT CTE → 반환된 모임 ID·생성자·시각으로 생성자 멤버십 INSERT.
4. 문장 자동 커밋 후 연결을 반환하고 { id }를 응답한다. 같은 PK이면 groups_pkey 제약으로 409 group_already_exists를 반환한다. 저장된 성공 응답을 재생하지 않는다.
5. 활성화 시 해당 모임 ID로 알림 → 프론트 상세 조회.

SQL 순서: AUTH → G-CREATE = **2회**. 같은 PK 중복도 2회다. BEGIN·COMMIT·ROLLBACK·SET LOCAL·명시적 락·mutation_requests 조회/저장을 실행하지 않는다. PostgreSQL 단일 문장 원자성으로 INSERT 실패 시 모임·멤버십 모두 저장되지 않는다. 본문/키 오류는 저장 SQL 전에 400이며 JWT 오류는 Guard에서 401이다. 기존 모임 PK의 TEXT 타입과 과거 ID는 유지한다.

scripts/group.integration.test.ts는 정상·중복 SQL 2회, 세션·멱등 SQL 및 명시적 트랜잭션 미실행, 같은 키 동시 요청의 성공 1개·중복 409, 생성 실패 시 부분 저장 없음을 검증한다.

### G2. GET /api/groups — 목록/검색/페이지

GroupsList.useResource()·loadMore() → GET /api/groups(query) → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Group 분배 → GroupController → listGroups() → 공용 풀 연결에서 일반 SELECT → Page<GroupListItem> → 목록·다음 커서 반영.

1. pagination()으로 limit/cursor 검사, q가 있으면 textInput(q,100). 기존 공통 커서의 { id, createdAt } 형식은 유지하며 이 조회의 정렬·조건에는 id만 사용한다.
2. withDatabaseConnection()으로 공용 풀 연결만 확보 → AUTH: JWT 목적과 가입·탈퇴 상태 확인.
3. G-LIST: group_members의 JOIN ON 조건으로 요청자의 활성 멤버십 제한 → g.id DESC, g.id < cursor.id로 모임 limit+1개를 먼저 조회 → 같은 SQL에서 선택한 모임의 활성 멤버 ID를 array_agg로 집계한다. 모임을 고른 뒤 멤버를 JOIN하므로 멤버 수가 페이지 크기에 영향을 주지 않는다.
4. 검색은 같은 G-LIST에 제목 ILIKE 조건을 적용한다. 검색어의 %, _, 역슬래시는 이스케이프해 문자 그대로 부분 검색하며 대소문자는 구분하지 않는다.
5. pageOf()로 실제 페이지 선택. 비어 있으면 연결을 반환한다. 나머지는 실제 페이지의 member_ids를 앱의 Set으로 중복 제거 → U-PROFILES로 활성 회원 프로필 한 번 조회. 다음 페이지 유무 확인용 모임의 프로필은 조회하지 않는다.
6. 생성자 우선 순서로 회원 수·최대 5명 미리보기 구성 → 연결 반환. member_ids는 내부 DAO 데이터이며 공개 DTO에 포함하지 않는다.

정상 목록·검색 SQL: **AUTH → G-LIST → U-PROFILES = 3회**. 빈 결과는 AUTH → G-LIST = 2회다. 별도 멤버십 SELECT·BEGIN·COMMIT·ROLLBACK·SET LOCAL·명시적 락은 실행하지 않는다. 세 조회는 같은 연결에서 각기 실행하며 읽기 트랜잭션 스냅샷을 사용하지 않는다.

### G3. GET /api/groups/{groupId} — 상세

GroupClient.useResource() → GET /api/groups/{groupId} → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Group 분배 → GroupController → getGroup() → GroupDetail → 모임 정보·멤버·생성자 여부·유효 초대 표시.

1. 공용 풀 연결 확보 → AUTH: JWT의 사용자 ID로 현재 회원 상태 조회 1회.
2. G-DETAIL: groupId로 groups·활성 group_members·미탈퇴/가입 완료 users를 JOIN하여 모임 정보와 멤버 ID·이름을 함께 조회 1회. Service에서 조회된 멤버 ID와 본인 ID를 비교하며 참여자가 아니거나 모임이 없으면 not_found. 초대는 조회하지 않고 멤버 정보도 응답하지 않는다.
3. 조회자가 creator_id와 같으면 G-INVITES로 유효 초대 조회 1회; 일반 멤버는 이 SQL을 생략하고 invites=[] 반환.
4. 생성자를 먼저 정렬한 멤버 목록(excludedAt=null)·모임 정보·isCreator·초대 만료 시각 구성 → 연결 반환. 화면의 멤버 요약·전체 목록·회차 생성 후보가 같은 응답을 사용하며 group 무효화 키로 함께 재조회한다.

명시적 트랜잭션·SET LOCAL 없이 일반 멤버는 2회, 생성자는 3회다. 별도 멤버 API·회원 프로필 조회는 없으며 회차는 기존 별도 API로 조회한다. 초대 원문 링크는 기존대로 최초 발급 응답에서만 제공한다.

### G4. DELETE /api/groups/{groupId} — 일반 이탈/생성자 닫기

GroupClient.leave()의 확인 창 → DELETE → Node Proxy/JWT Guard → GroupController → leaveGroup() → 역할별 검사/변경 → GroupMutationResult → 모임 목록 이동.

1. BEGIN으로 쓰기 트랜잭션을 시작한다. 풀의 문장 15초·잠금 10초 제한을 사용하며 SET LOCAL은 실행하지 않는다.
2. AUTH로 본인의 가입·탈퇴 상태를 확인한 뒤 기존 공통 advisory transaction lock을 획득한다. 인증 실패는 락을 획득하지 않고 ROLLBACK한다.
3. G-DEPARTURE 한 조회에서 활성 멤버십·생성자 여부·역할별 미종료 회차·기존 멱등 성공 기록·변경 전 실시간 수신자를 가져온다. 동일 키 재시도는 성공 응답을 재생하며 다른 모임에 키를 재사용하면 idempotency_conflict로 거부한다.
4. 일반 멤버는 본인이 제외되지 않은 미종료 참여 회차가 있으면 unfinished_rounds, 생성자는 본인 참여 여부와 무관하게 모임 전체 미종료 회차가 있으면 unfinished_group_rounds로 거부한다. 실패는 ROLLBACK으로 락을 해제한다.
5. 없으면 G-DEPARTURE-WRITE 한 CTE에서 본인 멤버십 종료 또는 생성자의 전체 활성 멤버십 종료·초대 폐기와 멱등 성공 기록을 함께 저장한다. COMMIT이 락을 자동 해제하며 별도 unlock SQL은 없다.
6. Controller가 커밋 후 확보한 수신자로 groups·group:{id} 무효화를 발행한다. 선행·후행 실시간 DB 조회는 없다.

업무 SQL은 AUTH·G-DEPARTURE로 거절 2회, 여기에 G-DEPARTURE-WRITE를 더해 성공 3회다. 락 획득과 COMMIT/ROLLBACK 포함 4회·5회이며 BEGIN까지 포함한 실제 총 SQL은 거절 5회·성공 6회다. 성공 재생은 5회다. groups·rounds·과거 round_members는 삭제하지 않는다.

### G5. POST /api/groups/{groupId}/invites — 초대 발급/재발급

GroupClient.inviteMembers() → POST → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Group 분배 → GroupController의 JSON 입력 → createInvite(CreateInviteRequestDTO) → 업무 SQL → 새 링크 표시 또는 재발급 안내 → 모임 상세 재조회.

1. onlyKeys(['replaceInviteId']), 제공된 ID는 textInput(...,128)로 검사한다. 공용 풀 연결을 빌리며 BEGIN·COMMIT·ROLLBACK·명시적 락은 실행하지 않는다.
2. AUTH로 본인 회원 상태를 조회한다. mutationDigest()로 키·본문을 검사한다.
3. G-INVITE-MUTATION에서 모임 생성자·활성 멤버십·기존 멱등 성공 기록을 함께 조회한다. 같은 키·본문은 링크 없는 성공 응답을 재생하고, 다른 본문은 idempotency_conflict로 거부한다. 신규 요청의 일반 멤버는 forbidden, 비멤버는 not_found로 거부한다.
4. 새 초대 UUID·32바이트 랜덤 토큰·현재 시각을 만들고 G-INSERT-INVITE 한 SQL에서 SHA-256 토큰 해시·7일 만료 초대·성공 메타데이터를 저장한다. replaceInviteId가 있으면 해당 모임의 이전 초대를 같은 SQL에서 폐기한다. 저장 시 활성 생성자 자격도 다시 확인하며, 대상 초대가 없으면 쓰기 없이 not_found를 반환한다.
5. 성공 기록에는 { id, inviteId, linkUnavailable: true }만 저장하고 최초 성공 응답에만 메모리 토큰의 sharePath를 반환한다. 같은 키 동시 요청은 mutation_requests PK가 중복 저장을 막으며, 충돌한 문장 전체가 취소된 뒤 추가 G-INVITE-MUTATION 조회로 성공을 재생하거나 본문 충돌을 거부한다.
6. Controller가 응답 후 after()에서 생성자에게 groups·group:{id} 무효화를 보낸다. 생성자 ID를 확보했으므로 후행 DB 조회·트랜잭션이 없다. POST 성공 핸들러는 공유 링크만 표시하며 직접 재조회하지 않는다. 기존 useResource 구독이 group:{id} 신호를 받으면 모임 상세와 초대 목록을 한 번 다시 읽는다. 최초 화면 진입·수동 오류 재시도·웹소켓 재연결 시 조회는 유지한다.

신규 발급·재발급은 AUTH → G-INVITE-MUTATION → G-INSERT-INVITE로 3회다. 일반 성공 재생·권한 거절은 2회다. 같은 키 동시 저장 충돌 시 복구 조회를 포함해 4회다. PostgreSQL 문장 원자성으로 새 초대·성공 기록 저장 실패 시 기존 초대 폐기도 함께 취소된다.

### G6. DELETE /api/groups/{groupId}/invites/{inviteId} — 초대 폐기

GroupClient.revoke() 확인 창 → DELETE → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Group 분배 → GroupController → revokeInvite() → GroupMutationResult → 초대 목록 재조회.

명시적 트랜잭션·advisory lock·행 조회 락 없이 공용 풀 연결에서 AUTH → G-INVITE-MUTATION(operation=invite.revoke)의 활성 멤버십·생성자 검사 및 성공 재생 → G-REVOKE의 모임/초대 ID UPDATE·성공 기록 INSERT를 한 SQL로 실행한다. 정상은 3회, 성공 재생·권한 거절은 2회다. 같은 키 동시 저장 충돌 시 복구 조회를 포함해 4회다. 이미 폐기된 초대는 COALESCE로 기존 폐기 시각을 유지한다. 초대가 없으면 not_found이며 성공 기록을 저장하지 않는다. 저장 실패 시 문장 전체가 취소된다. 이미 참여한 멤버십은 유지하며, 폐기와 동시에 진행 중인 수락은 성공할 수 있다. 생성자만 초대 목록을 보므로 인증한 생성자를 무효화 수신자로 전달하여 추가 조회를 생략한다.

### G7. GET /api/invites/{token} — 초대 조회

InviteClient.useResource() → GET → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Group 분배 → GroupController → getInvite() → 공용 풀 연결 → InvitePreview → 직접 수락 버튼 또는 이미 참여한 모임 링크.

1. AUTH로 조회자의 가입·탈퇴 상태 확인.
2. validInvite()가 원문 토큰의 43자 URL-safe 형식 검사. 잘못되면 not_found.
3. G-VALID-INVITE: 토큰 해시 WHERE 조건으로 유효 초대를 조회하며 모임·생성자의 활성 멤버십·미탈퇴/가입 완료 users를 JOIN. 조회자의 활성 멤버십은 LEFT JOIN하여 isMember 확인.
4. 행이 있으면 groupId·groupName·isMember·expiresAt만 반환, 없으면 not_found. 연결은 성공·실패 모두 반환.

정상 SQL: AUTH → G-VALID-INVITE = 2회. 명시적 트랜잭션·락·별도 생성자 조회는 없다. 형식 오류는 AUTH 1회 후 거절한다. GET은 group_members를 쓰지 않으며 기존 회차 참여를 만들지 않는다.

### G8. POST /api/invites/{token}/accept — 참여 수락

InviteClient.accept() → POST → Node Proxy → JWT Guard → GroupController → acceptInvite() → 참여 완료 상태·모임으로 가기 링크 표시. POST 성공에서 GET이나 자동 이동을 실행하지 않으며 모임 자료는 WebSocket invalidation으로 재조회한다.

1. AUTH로 회원 상태 확인 → 43자 URL-safe 토큰 형식 검사 → Idempotency-Key와 tokenHash digest 검사.
2. G-ACCEPT-READ로 유효 초대·활성 생성자·본인 멤버십·이전 성공 기록을 함께 조회. 같은 키 성공은 재생하며 다른 본문은 idempotency_conflict. 초대가 없으면 not_found, 새 키의 활성 멤버는 group_already_member.
3. 같은 풀 연결에서 SELECT pg_advisory_lock(1684106607)로 세션 락 획득. 기존 쓰기의 pg_advisory_xact_lock과 같은 키를 사용해 수락·탈퇴·모임 닫기를 직렬화한다.
4. G-JOIN 한 SQL에서 회원 활성 상태·초대/생성자·현재 멤버십·정원·알림 수신자를 다시 확인하고 조건부 INSERT·이탈자 재참여 UPDATE·성공 기록 INSERT를 함께 자동 커밋. 실패하면 문장 전체가 취소된다. 락을 기다리는 동안 달라진 회원·초대 상태를 신뢰하지 않는다.
5. finally에서 SELECT pg_advisory_unlock(1684106607) AS unlocked로 락 해제. 획득·해제 실패 또는 해제 결과가 false면 연결을 폐기해 세션 락이 풀에 남지 않게 한다.
6. 저장 SQL에서 확보한 기존 멤버와 수락자에게 groups·group:{id} invalidation만 발행. 수신자 후속 SELECT는 없다. 성공 재생은 알림을 반복하지 않는다.

정상 SQL: AUTH → G-ACCEPT-READ → 세션 락 획득 → G-JOIN → 락 해제 = 5회. 성공 재생·조회 시 활성 멤버 거절은 2회, 형식 오류는 1회다. 명시적 BEGIN/COMMIT·트랜잭션 advisory lock·FOR UPDATE/SHARE는 없다. 기존 회차는 변경하지 않으며 스키마 변경도 없다. [PostgreSQL 세션 락](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS)은 명시적 해제 또는 연결 종료까지 유지되므로 모든 SQL을 같은 연결에서 실행한다.

### 성공 재생·실패·실시간의 별도 순서

모임 생성 중복은 AUTH → G-CREATE로 2회이며 PK 오류를 409로 반환한다. 초대 발급 성공 재생은 AUTH → G-INVITE-MUTATION으로 2회다. 초대 수락 성공 재생은 AUTH → G-ACCEPT-READ로 2회다. 나머지 모임 쓰기 성공 재생은 W-START(2) → AUTH → IDEM-READ → COMMIT으로 5회다. 업무 SQL·IDEM-SAVE는 반복하지 않는다. 초대 발급 재생에서는 원문 링크를 반환하지 않는다. 본문/키 오류·권한/정원/상태 오류·DB 오류는 성공 기록을 남기지 않는다. 모임 생성·초대 발급·폐기·수락 실패는 단일 SQL의 원자성, 다른 쓰기 실패는 기존 트랜잭션 ROLLBACK으로 부분 저장을 막는다. 응답 유실은 같은 키·같은 payload로 재시도한다. 외부 파일 작업은 Group API에 없다.

DELETE는 G-DEPARTURE에서 확보한 변경 전 수신자에게, 초대 발급·폐기는 AUTH에서 확보한 생성자에게, 초대 수락은 G-JOIN의 기존 멤버와 수락자에게 추가 SQL 없이 groups·group:{id} 키만 내부 HTTP로 전달한다. 다른 모임 변경의 발행은 기존 별도 읽기 트랜잭션 R-START(1) → RT-PUBLISH → COMMIT으로 3회다. 이 후행 발행은 저장 트랜잭션에 속하지 않으며 발행 실패가 커밋된 결과를 롤백하지 않는다. 실시간 환경 변수가 꺼져 있으면 두 경로는 SQL 없이 생략된다.

## 5. 실제 SQL 카탈로그

한 식별자 블록에 여러 문장이 있으면 표기한 순서대로 각각 query()로 호출한다. 바인딩 의미는 문서 설명이며 로그에 실제 값을 출력하라는 뜻이 아니다. 아래 공통 인증 쿼리는 기존 구현대로 계좌 컬럼도 읽지만, Group은 account.id만 사용하고 계좌를 응답 DTO나 실시간 메시지에 넣지 않는다.

### R-START — 읽기 트랜잭션 시작

출처: [src/lib/db.ts](../src/lib/db.ts).

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
```

같은 조회의 인증·권한·하위 데이터에 같은 읽기 스냅샷을 사용한다.

### W-START — 쓰기 트랜잭션 시작/현재 공통 락

출처: [src/lib/db.ts](../src/lib/db.ts).

```sql
BEGIN;

SELECT
  pg_advisory_xact_lock(1684106607);
```

모임 생성을 제외한 기존 쓰기에 적용되는 락이다.

### TX-COMMIT — 성공 종료

출처: [src/lib/db.ts](../src/lib/db.ts).

```sql
COMMIT;
```

### TX-ROLLBACK — 실패 종료

출처: [src/lib/db.ts](../src/lib/db.ts).

```sql
ROLLBACK;
```

실패는 COMMIT 대신 ROLLBACK한다.

### H-DB — Health DB 검사

출처: [src/Domain/Health/Backend/Repository/HealthRepository.ts](../src/Domain/Health/Backend/Repository/HealthRepository.ts).

```sql
SELECT
  1;
```

트랜잭션 없이 공용 풀의 query()로 한 번 호출한다.

### AUTH — 회원 상태 확인

출처: [UserRepository.findUser()](../src/Domain/User/Backend/Repository/UserRepository.ts). Global/Auth의 requireAccount()가 User 공개 조회로 회원 상태를 확인한다.

```sql
SELECT
  u.id, u.display_name, u.email, u.profile_image_url,
  u.bank_name, u.account_number, u.account_number_formatted,
  u.account_holder, u.bank_code, u.bank_verified_at, u.bank_version,
  u.deleted_at, u.onboarding_completed_at, u.updated_at
FROM users u
WHERE u.id = $1;
```

$1=검증된 JWT의 userId. 세션 테이블은 읽지 않는다. JWT의 purpose와 회원의 deleted_at·onboarding_completed_at을 코드에서 검사한다.

### IDEM-READ — 멱등 성공 결과 확인

출처: [src/lib/mutations.ts](../src/lib/mutations.ts).

```sql
SELECT
  request_digest,
  response_metadata
FROM
  mutation_requests
WHERE
  actor_id = $1
  AND operation = $2
  AND request_key = $3;
```

바인딩: $1=actorId, $2=operation, $3=requestKey. 저장된 request_digest와 현재 payload digest를 비교한다.

### IDEM-SAVE — 멱등 성공 기록 저장

출처: [src/lib/mutations.ts](../src/lib/mutations.ts).

```sql
INSERT INTO
  mutation_requests (
    actor_id,
    operation,
    request_key,
    request_digest,
    resource_id,
    response_metadata,
    created_at
  )
VALUES
  ($1, $2, $3, $4, $5, $6, $7);
```

바인딩: $1=actorId, $2=operation, $3=requestKey, $4=payload digest, $5=resourceId, $6=JSON 직렬화 응답 메타데이터, $7=현재 초 시각. 초대 발급은 링크가 없는 메타데이터를 전달한다.

### G-LIST — 내 활성 모임 목록과 멤버 ID

출처: [GroupRepository.findGroups()](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
SELECT
  g.id, g.creator_id, g.name, g.created_at,
  array_agg(
    member.user_id ORDER BY
      CASE WHEN member.user_id = g.creator_id THEN 0 ELSE 1 END,
      member.user_id
  ) AS member_ids
FROM (
  SELECT g.*
  FROM groups g
  JOIN group_members viewer ON viewer.group_id = g.id
    AND viewer.user_id = $1 AND viewer.left_at IS NULL
  WHERE ($2::text IS NULL OR g.name ILIKE $2)
    AND ($3::text IS NULL OR g.id < $3)
  ORDER BY g.id DESC
  LIMIT $4
) g
JOIN group_members member ON member.group_id = g.id
  AND member.left_at IS NULL
GROUP BY g.id, g.creator_id, g.name, g.created_at
ORDER BY g.id DESC;
```

$1=조회자 ID, $2=이스케이프한 검색어를 %로 감싼 패턴 또는 null, $3=커서 ID 또는 null, $4=limit+1. 모임 ID의 기존 PK 인덱스를 유지하며 스키마 변경은 없다. 반환된 실제 페이지의 member_ids를 Set으로 중복 제거하여 U-PROFILES의 $1에 전달한다.

### G-ACCESS — 활성 모임 권한

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
SELECT
  g.*
FROM
  groups g
  JOIN group_members m ON m.group_id = g.id
  AND m.user_id = $2
  AND m.left_at IS NULL
WHERE
  g.id = $1;
```

$1=groupId, $2=조회자 ID. 생성자 전용 기능은 반환된 creator_id와 요청자 ID를 Service에서 비교한다.

### G-DETAIL — 모임과 활성 멤버 이름

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts)의 findGroupWithMembers().

```sql
SELECT
  g.id,
  g.creator_id,
  g.name,
  g.created_at,
  m.user_id,
  COALESCE(u.display_name, '카카오 사용자') AS display_name
FROM
  groups g
  JOIN group_members m ON m.group_id = g.id
  AND m.left_at IS NULL
  JOIN users u ON u.id = m.user_id
  AND u.deleted_at IS NULL
  AND u.onboarding_completed_at IS NOT NULL
WHERE
  g.id = $1
ORDER BY
  CASE
    WHEN m.user_id = g.creator_id THEN 0
    ELSE 1
  END,
  m.user_id;
```

$1=groupId. Service에서 모든 반환 행의 user_id를 JWT로 확인한 본인 ID와 비교한다. 없으면 not_found이며 초대 조회와 응답 구성을 수행하지 않는다. 계좌·이메일·인증 정보는 SELECT하지 않는다. G-ACCESS는 기존 변경 요청·기존 모임 변경 권한 검사에 유지한다. 회차 생성은 S1 단일 SQL에 권한 검사를 포함한다.

### G-INVITES — 생성자에게 보여줄 유효 초대

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
SELECT
  id,
  expires_at
FROM
  group_invites
WHERE
  group_id = $1
  AND revoked_at IS NULL
  AND expires_at > $2
ORDER BY
  created_at DESC;
```

$1=groupId, $2=현재 초 시각. 원문 토큰이나 token_hash를 반환하지 않는다.

### G-CREATE — 모임 생성 단일 SQL

출처: [GroupRepository.insertGroup()](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
WITH created_group AS (
  INSERT INTO groups (id, creator_id, name, created_at)
  VALUES ($1, $2, $3, $4)
  RETURNING id, creator_id, created_at
)
INSERT INTO group_members (group_id, user_id, joined_at)
SELECT id, creator_id, created_at FROM created_group;
```

$1=UUIDv7 요청 키, $2=생성자 ID, $3=trim된 이름, $4=현재 초 시각. PK 중복은 409로 변환한다. PostgreSQL의 문장 원자성으로 둘 중 하나라도 실패하면 모임·멤버십 저장 전체가 취소된다.

### G-DEPARTURE — 권한·역할별 미종료·멱등·수신자 통합 조회

출처: [GroupRepository.findGroupDeparture()](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
SELECT g.creator_id,viewer.user_id,
    EXISTS(SELECT 1 FROM rounds r WHERE r.group_id=$1 AND r.status<>'COMPLETED'
      AND (g.creator_id=$2 OR EXISTS(SELECT 1 FROM round_members m
        WHERE m.round_id=r.id AND m.user_id=$2 AND m.excluded_at IS NULL))) AS has_unfinished,
    ARRAY(SELECT user_id FROM group_members WHERE group_id=$1 AND left_at IS NULL) AS member_ids,
    previous.request_digest,previous.response_metadata
    FROM (SELECT $1::text AS id) requested
    LEFT JOIN groups g ON g.id=requested.id
    LEFT JOIN group_members viewer ON viewer.group_id=g.id AND viewer.user_id=$2 AND viewer.left_at IS NULL
    LEFT JOIN mutation_requests previous ON previous.actor_id=$2 AND previous.operation='group.leave' AND previous.request_key=$3;
```

$1=groupId, $2=인증한 사용자 ID, $3=멱등 키. 생성자는 모임 전체 회차를 검사하고 일반 참여자는 제외되지 않은 본인 참여 회차만 검사한다. 종료된 멤버십에도 기존 성공 응답을 재생할 수 있도록 LEFT JOIN한다. Service가 활성 멤버십과 요청 digest를 검사한다.

### G-DEPARTURE-WRITE — 멤버십·초대·성공 기록 원자적 저장

출처: [GroupRepository.leaveGroup()](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
WITH departed AS (
    UPDATE group_members SET left_at=$3
    WHERE group_id=$1 AND left_at IS NULL AND ($4::boolean OR user_id=$2)
    RETURNING user_id
  ), revoked AS (
    UPDATE group_invites SET revoked_at=$3
    WHERE group_id=$1 AND revoked_at IS NULL AND $4::boolean AND EXISTS(SELECT 1 FROM departed)
    RETURNING id
  ) INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $2,'group.leave',$5,$6,$1,jsonb_build_object('id',$1::text),$3
    WHERE EXISTS(SELECT 1 FROM departed);
```

$1=groupId, $2=사용자 ID, $3=현재 초 시각, $4=생성자 여부, $5=멱등 키, $6=요청 digest. 생성자만 전체 활성 멤버십과 초대를 종료한다. 단일 CTE와 쓰기 트랜잭션으로 변경·성공 기록을 함께 커밋한다.

### G-REVOKE — 초대 폐기

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
WITH revoked AS (
    UPDATE group_invites SET revoked_at=COALESCE(revoked_at,$3)
    WHERE id=$1 AND group_id=$2
    RETURNING id
  ) INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $4,'invite.revoke',$5,$6,id,jsonb_build_object('id',id),$3 FROM revoked;
```

$1=inviteId, $2=groupId, $3=현재 초 시각, $4=인증한 생성자 ID, $5=요청 키, $6=요청 digest. rowCount가 없으면 Service가 not_found를 반환한다. 폐기와 성공 기록은 한 SQL로 원자적으로 저장된다.

### G-INVITE-MUTATION — 생성자 권한과 초대 발급/폐기 재시도 조회

출처: [GroupRepository.findInviteMutation()](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
SELECT g.creator_id,m.user_id,previous.request_digest,previous.response_metadata
    FROM (SELECT $1::text AS id) requested
    LEFT JOIN groups g ON g.id=requested.id
    LEFT JOIN group_members m ON m.group_id=g.id AND m.user_id=$2 AND m.left_at IS NULL
    LEFT JOIN mutation_requests previous ON previous.actor_id=$2 AND previous.operation=$4 AND previous.request_key=$3;
```

$1=groupId, $2=본인 ID, $3=요청 키, $4=invite.create 또는 invite.revoke. 존재하지 않는 모임도 기존 멱등 성공 기록을 조회할 수 있도록 requested에서 LEFT JOIN한다.

### G-INSERT-INVITE — 초대·이전 초대 폐기·성공 기록 단일 SQL

출처: [GroupRepository.insertInvite()](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
WITH created AS (
    INSERT INTO group_invites(id,group_id,created_by,token_hash,created_at,expires_at)
    SELECT $1,$2,$3,$4,$5,$6 FROM groups g
    JOIN group_members m ON m.group_id=g.id AND m.user_id=$3 AND m.left_at IS NULL
    JOIN users u ON u.id=m.user_id AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL
    WHERE g.id=$2 AND g.creator_id=$3
      AND ($9::text IS NULL OR EXISTS(SELECT 1 FROM group_invites WHERE id=$9 AND group_id=$2))
    RETURNING id
  ), revoked AS (
    UPDATE group_invites SET revoked_at=COALESCE(revoked_at,$5)
    WHERE id=$9 AND group_id=$2 AND EXISTS(SELECT 1 FROM created)
    RETURNING id
  ) INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $3,'invite.create',$7,$8,id,jsonb_build_object('id',id,'inviteId',id,'linkUnavailable',true),$5
    FROM created;
```

$1=새 초대 ID, $2=groupId, $3=생성자 ID, $4=원문 토큰의 SHA-256, $5=발급 초 시각, $6=발급+7일 초 시각, $7=요청 키, $8=요청 digest, $9=재발급 대상 초대 ID 또는 null. 이전 초대 폐기는 새 초대가 생성됐을 때만 실행한다. 문장 전체가 성공해야 모든 변경이 저장된다.

### G-VALID-INVITE — 유효 초대/현재 참여 여부

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
SELECT
  i.id,
  i.group_id,
  i.expires_at,
  g.name,
  g.creator_id,
  viewer.user_id IS NOT NULL AS is_member
FROM
  group_invites i
  JOIN groups g ON g.id = i.group_id
  JOIN group_members m ON m.group_id = g.id
  AND m.user_id = g.creator_id
  AND m.left_at IS NULL
  JOIN users u ON u.id = m.user_id
  AND u.deleted_at IS NULL
  AND u.onboarding_completed_at IS NOT NULL
  LEFT JOIN group_members viewer ON viewer.group_id = g.id
  AND viewer.user_id = $3
  AND viewer.left_at IS NULL
WHERE
  i.token_hash = $1
  AND i.revoked_at IS NULL
  AND i.expires_at > $2;
```

$1=토큰 SHA-256, $2=현재 초 시각, $3=조회자/수락자 ID. 생성자의 활성 회원 상태와 조회자 참여 여부를 같은 SQL에서 확인한다.

### G-ACCEPT-READ — 초대·멱등 결과 조회

출처: [GroupRepository](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
SELECT CASE WHEN u.id IS NOT NULL THEN g.id END AS group_id,
    viewer.user_id IS NOT NULL AS is_member,
    previous.request_digest,previous.response_metadata
    FROM (SELECT $1::text AS token_hash) requested
    LEFT JOIN group_invites i ON i.token_hash=requested.token_hash AND i.revoked_at IS NULL AND i.expires_at>$3
    LEFT JOIN groups g ON g.id=i.group_id
    LEFT JOIN group_members creator ON creator.group_id=g.id AND creator.user_id=g.creator_id AND creator.left_at IS NULL
    LEFT JOIN users u ON u.id=creator.user_id AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL
    LEFT JOIN group_members viewer ON viewer.group_id=g.id AND viewer.user_id=$2 AND viewer.left_at IS NULL
    LEFT JOIN mutation_requests previous ON previous.actor_id=$2 AND previous.operation='invite.accept' AND previous.request_key=$4;
```

### G-JOIN — 락 내부 재검증·조건부 참여·성공 기록 저장

출처: [GroupRepository](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
WITH eligible AS (
    SELECT g.id,
      EXISTS(SELECT 1 FROM group_members WHERE group_id=g.id AND user_id=$2 AND left_at IS NULL) AS is_member,
      (SELECT COUNT(*)::int FROM group_members WHERE group_id=g.id AND left_at IS NULL) AS member_count,
      ARRAY(SELECT user_id FROM group_members WHERE group_id=g.id AND left_at IS NULL) AS member_ids
    FROM group_invites i
    JOIN groups g ON g.id=i.group_id
    JOIN group_members creator ON creator.group_id=g.id AND creator.user_id=g.creator_id AND creator.left_at IS NULL
    JOIN users u ON u.id=creator.user_id AND u.deleted_at IS NULL AND u.onboarding_completed_at IS NOT NULL
    WHERE i.token_hash=$1 AND i.revoked_at IS NULL AND i.expires_at>$3
  ), actor AS (
    SELECT id FROM users WHERE id=$2 AND deleted_at IS NULL AND onboarding_completed_at IS NOT NULL
  ), joined AS (
    INSERT INTO group_members(group_id,user_id,joined_at)
    SELECT eligible.id,actor.id,$3 FROM eligible CROSS JOIN actor
    WHERE NOT eligible.is_member AND eligible.member_count<$6
    ON CONFLICT(group_id,user_id) DO UPDATE SET joined_at=EXCLUDED.joined_at,left_at=NULL
      WHERE group_members.left_at IS NOT NULL
    RETURNING group_id
  ), saved AS (
    INSERT INTO mutation_requests(actor_id,operation,request_key,request_digest,resource_id,response_metadata,created_at)
    SELECT $2,'invite.accept',$4,$5,group_id,jsonb_build_object('id',group_id),$3 FROM joined
    RETURNING resource_id
  ) SELECT EXISTS(SELECT 1 FROM actor) AS actor_active,
    (SELECT id FROM eligible) AS group_id,
    COALESCE((SELECT is_member FROM eligible),false) AS is_member,
    COALESCE((SELECT member_count FROM eligible),0) AS member_count,
    COALESCE((SELECT member_ids FROM eligible),'{}'::text[]) AS member_ids,
    EXISTS(SELECT 1 FROM saved) AS joined;
```

G-ACCEPT-READ: $1=토큰 해시, $2=회원 ID, $3=현재 초 시각, $4=요청 키. G-JOIN은 같은 순서에 $5=digest, $6=MAX_GROUP_MEMBERS(10)를 추가한다. 세션 락을 확보한 뒤 현재 활성 멤버 수를 검사해 정원을 보장한다. 이미 활성인 멤버의 새 키는 409 group_already_member, 정원 초과는 409 group_member_limit_exceeded. 저장 실패 시 멤버십·성공 기록이 함께 취소되고 락은 finally에서 해제한다.

### U-PROFILES — User 공개 일괄 활성 프로필 조회

출처: [src/Domain/User/Backend/Repository/UserProfileRepository.ts](../src/Domain/User/Backend/Repository/UserProfileRepository.ts).

```sql
SELECT
  id AS "userId",
  COALESCE(display_name, '카카오 사용자') AS "displayName",
  profile_image_url AS "profileImageUrl"
FROM
  users
WHERE
  id = ANY ($1::TEXT[])
  AND deleted_at IS NULL
  AND onboarding_completed_at IS NOT NULL
ORDER BY
  id;
```

$1=중복을 제거한 회원 ID 배열. 가입 완료·미탈퇴 회원만 반환하고 Group이 멤버십 순서와 합친다.

### S-UNFINISHED-GROUP — Settle 공개 모임 미종료 회차 조회

출처: [src/Domain/Settle/Backend/Repository/ParticipationRepository.ts](../src/Domain/Settle/Backend/Repository/ParticipationRepository.ts).

```sql
SELECT
  1
FROM
  rounds
WHERE
  group_id = $1
  AND status <> 'COMPLETED'
LIMIT
  1;
```

$1=groupId. 존재 여부 boolean만 공개한다.

### S-UNFINISHED-MEMBER — Settle 공개 멤버 미종료 참여 조회

출처: [src/Domain/Settle/Backend/Repository/ParticipationRepository.ts](../src/Domain/Settle/Backend/Repository/ParticipationRepository.ts).

```sql
SELECT
  1
FROM
  rounds r
  JOIN round_members m ON m.round_id = r.id
WHERE
  r.group_id = $1
  AND m.user_id = $2
  AND m.excluded_at IS NULL
  AND r.status <> 'COMPLETED'
LIMIT
  1;
```

$1=groupId, $2=이탈 요청자 ID. 제외된 회차 참여는 이 이탈 제한 조회의 대상에서 빠진다.

### RT-PUBLISH — 커밋 후 현재 활성 수신자 조회

출처: [src/lib/realtime-server.ts](../src/lib/realtime-server.ts).

```sql
SELECT
  m.user_id
FROM
  group_members m
  JOIN users u ON u.id = m.user_id
WHERE
  m.group_id = $1
  AND m.left_at IS NULL
  AND u.deleted_at IS NULL;
```

$1=groupId. 별도 읽기 트랜잭션에 AUTH는 없고, 이미 허가된 커밋 결과의 모임 ID로 수신자를 조회한다. 선행 수신자와 중복 제거 후 알림을 보낸다.

## 6. SQL 호출 수와 재현

트랜잭션 시작·락·종료를 포함한다. 풀 연결 생성 시 적용되는 타임아웃 startup parameter는 SQL 호출이 아니다. 실시간 선행/후행 쿼리와 프론트 후속 GET은 별도로 센다. 아래 이전 수는 변경 전 코드의 호출 순서, 현재 수는 scripts/group.integration.test.ts의 실제 DB SQL 로그 검증 기준이다. 사용자 JOIN을 일괄 공개 조회로 분리해 일부 경로가 1회 증가했으며 성능 개선 수치를 뜻하지 않는다.

| Group 정상 작업 | 이전 | 현재 |
|---|---:|---:|
| 생성 | 10 | 2 |
| 목록·검색(비빈/빈) | 7 / 6 | 3 / 2 |
| 상세(생성자/일반 멤버) | 8 / 7 | 3 / 2 |
| 일반 이탈/생성자 닫기 | 11 / 12 | 6 / 6 |
| 초대 발급/재발급/폐기 | 10 / 11 / 10 | 3 / 3 / 3 |
| 초대 조회 | 6 | 2 |
| 참여 수락(신규·재참여/조회 시 활성 멤버 거절) | 11 / 10 | 5 / 2 |
| 생성 중복(409) / 초대 발급·폐기 성공 재생 / 나머지 쓰기 성공 재생 | 7(이전 재생) / 7 / 7 | 2 / 2 / 5 |

로컬 앱 SQL 확인:

```bash
DB_QUERY_LOG=true npm run dev
# 다른 터미널: 인증 없이 DB 헬스체크 한 문장 확인
curl -i http://localhost:3000/api/health/database
```

테스트 계정으로 모임 생성 → 목록/상세 → 초대 발급 → 다른 계정으로 조회/수락 → 재발급/폐기 → 일반 이탈 → 생성자 닫기를 수행한다. Network의 단일 API 요청과 stdout SQL: 블록을 대조한다. 미종료 회차가 있으면 이탈/닫기 요청의 ROLLBACK·오류 코드를 확인한다. 같은 Idempotency-Key·본문 재시도의 업무 SQL 생략도 확인한다. 위 설정은 SQL 문장만 출력하고 바인딩 값·결과 행을 출력하지 않는다.

자동 검증은 README의 격리 조건을 충족하는 로컬 TEST_DATABASE_URL과 별도 MinIO 버킷으로 실행한다. 테스트 DB의 이름에는 test가 포함되어야 하며 개발/운영 DB를 지정하지 않는다. 테스트 명령은 .env.local을 자동으로 읽지 않는다.

```bash
npm test
npm run build
# TEST_DATABASE_URL과 격리된 MINIO_*를 먼저 설정
npm run test:integration
# 모임 SQL 호출 수·재생·롤백만 확인하려면
node --import ./scripts/test-server-only.mjs --import tsx --test scripts/group.integration.test.ts
```

공통 유틸 세분화 후 `npm test` 81개, `npm run build`, 격리된 로컬 테스트 DB/MinIO 버킷의 `npm run test:integration` 38개가 모두 통과했다. 기존 입력·페이지네이션·멱등 동작과 Group SQL 호출 수를 유지한다. 이번 후속 변경은 UI를 수정하지 않았다.

이 문서는 현재 코드의 요청/SQL 흐름 기록이며 실제 사용자 쿼리 확인 결과를 대신하지 않는다. Group 분리 실행 기록은 [Group-01](srp-query-refactor-plan.md#group-01-구현된-모임초대참여-도메인-분리), 이후 User·Settle의 현재 구현은 7·8절을 참고한다.

JWT 인증 전환 검증 결과(2026-10-02): 단위 85개, 격리된 로컬 DB·MinIO 통합 38개, 프로덕션 빌드 및 전체 모바일 브라우저 회귀 검사 통과. 실제 로그인 완료 페이지의 localStorage/Bearer 전환과 로그아웃 토큰 삭제도 확인했다. 실제 카카오 외부 인증은 이번 자동 검사에 포함하지 않는다.

모임 목록 후속 변경: scripts/group.integration.test.ts에서 목록·검색 3회/빈 결과 2회, 트랜잭션 SQL 미실행, 생성 시각과 반대로 배치한 ID 커서, 멤버가 여러 명인 모임의 페이지 크기, 여러 모임이 공유하는 멤버의 프로필 일괄 조회, LIKE 특수문자의 문자 검색을 확인한다.

모임 목록 후속 검증 결과(2026-10-02): 단위 85개·격리 DB/MinIO 통합 38개·프로덕션 빌드 통과. 일반 목록·검색 3회, 빈 결과 2회와 ID 커서를 실제 SQL 로그로 검증했다.

## 7. User 요청 흐름·SQL

최초 User 분리는 기존 SQL·트랜잭션을 유지했다. 후속 개선으로 GET /api/me는 공용 풀 연결에서 AUTH 한 문장만 실행하고, POST /api/me/onboarding과 PUT /api/me/bank-account는 AUTH와 조건부 UPDATE만 실행한다. 세 API는 트랜잭션·명시적 락을 사용하지 않는다. 탈퇴의 기존 트랜잭션은 유지한다. 아래 수는 `BEGIN`·기존 advisory lock·`COMMIT`까지 포함하며, 응답 후 실시간 알림의 별도 조회는 제외한다.

### U1. GET /api/me — 내 정보 조회

AppShell.useResource()/OnboardingClient.useResource() → GET → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 User 위임 → UserController.getMeResponse() → getMe() → 공용 풀 연결 → Account → AccountProvider 또는 온보딩 폼 반영.

1. 공용 풀에서 연결 확보. BEGIN·COMMIT·ROLLBACK·명시적 락·SET은 실행하지 않는다.
2. AUTH: requireAccount()가 User 공개 getUserAccountState()를 호출하여 JWT의 userId로 본인 users 한 행 조회. JWT 목적과 회원의 가입·탈퇴 상태를 검사하며 온보딩 목적도 허용한다. 회원이 없거나 목적과 현재 회원 상태가 맞지 않으면 unauthorized.
3. 프로필·purpose·가입/탈퇴 시각·bankVersion을 Account DTO로 변환. 은행명·계좌번호·예금주가 모두 있으면 본인 bankAccount를 구성하고, 아니면 null 반환. DB 행이나 다른 회원 계좌는 반환하지 않는다.
4. `{ data: Account }` 응답. 연결은 성공·실패 모두 finally에서 풀에 반환한다.

정상 SQL: **AUTH 내 정보 읽기 (+1) = 1회**. 회원 상태 거절도 AUTH 1회 후 종료하며 JWT Guard 거절은 SQL 0회다. 기존 R-START·TX-COMMIT의 2회를 제거해 정상 호출은 3회에서 1회로 줄었다. 멱등 기록·회원 변경은 없다.

단일 조회 검증: [scripts/user.integration.test.ts](../scripts/user.integration.test.ts)에서 정상 회원·온보딩·회원 상태 거절의 실제 SQL 1회, 트랜잭션/락/SET 미실행, 성공·거절 후 풀 연결 반환을 확인했다. 후속 단위 91개·격리 DB/MinIO 통합 40개·빌드 통과.

### U2. POST /api/me/onboarding — 가입 완료·재가입

OnboardingForm.register() → POST → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 User 위임 → UserController.getOnboardingResponse() → completeOnboarding() → 공용 풀 연결 → OnboardingResponseDTO·Refresh 쿠키 → Access 토큰 저장·폼 입력 정리·returnTo로 이동.

1. Controller가 sameOrigin() 검사 → 최대 16,384바이트 JSON 읽기 → 안전한 returnTo 쿠키 해석. Service가 objectBody()·normalizeBankAccountInput()으로 허용 필드·은행·번호·예금주·expectedBankVersion·confirmRejoin 검증 및 정규화. 입력 오류는 DB 접근 전에 거절한다.
2. 공용 풀에서 연결 확보. BEGIN·COMMIT·ROLLBACK·명시적 락·SET은 실행하지 않는다.
3. AUTH로 본인 회원 상태 조회. assertOnboarding()이 온보딩 목적·탈퇴 회원의 명시적 confirmRejoin·최신 계좌 버전을 검사한다. 목적이 app이면 already_onboarded, 재가입 동의가 없으면 rejoin_confirmation_required, 버전이 다르면 bank_account_conflict.
4. Global/Auth의 issueTokens()로 app 목적 Access/Refresh JWT를 먼저 생성한다. JWT 발급에는 SQL이 없으며 발급 오류 시 회원을 변경하지 않는다.
5. U-ONBOARDING: UserRepository.saveOnboarding()이 `id`·AUTH에서 읽은 `updated_at`·expectedBankVersion과 일치하고 아직 온보딩 상태(`deleted_at IS NOT NULL OR onboarding_completed_at IS NULL`)인 행만 UPDATE한다. 계좌 원본·표시 형식·예금주·은행 코드·가입/계좌 갱신 시각·deleted_at=NULL·bank_version 증가·확인 이력 초기화를 한 문장으로 저장한다. 갱신 행이 0개면 bank_account_conflict로 거절한다. 초 단위 updated_at이 같아도 계좌 버전과 상태 조건으로 동시 요청 중 하나만 성공한다. 기존 모임 멤버십은 복구하지 않는다.
6. UPDATE 성공 후 Controller가 `{ data: { id, returnTo, accessToken } }`과 Refresh 쿠키를 반환하고 기존 Access 쿠키·복귀 쿠키를 삭제. after()로 publishBankInvalidation() 예약. 연결은 성공·실패 모두 finally에서 풀에 반환한다.

정상 SQL: **AUTH 내 정보 읽기 (+1) → U-ONBOARDING 조건부 UPDATE (+1) = 2회**. 기존 5회에서 BEGIN·락·COMMIT의 3회를 제거했다. 출처·JSON·계좌 입력 오류는 0회, 회원 상태·목적·동의·버전 거절은 AUTH 1회, 조회 후 경합 거절은 AUTH + UPDATE 2회다. 멱등 기록·외부 계좌 확인은 없다. 단일 UPDATE가 계좌와 가입 상태를 원자적으로 저장하며 응답 유실은 카카오 재로그인으로 복구한다.

[scripts/user.integration.test.ts](../scripts/user.integration.test.ts)에서 실제 SQL 2회와 트랜잭션·명시적 락 미실행, 동시 가입·재가입의 단일 성공, 변경된 AUTH 시각 거절, 같은 시각의 중복 UPDATE 거절, JWT 발급 오류 시 미수정과 연결 반환을 검증한다.

### U3. PUT /api/me/bank-account — 대표 계좌 변경

AccountPanel.save() → PUT → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 User 위임 → UserController.getBankAccountResponse() → updateBankAccount() → 공용 풀 연결 → BankAccountResponseDTO → 입력 정리·폼 닫기 → WebSocket me invalidation 수신 후 /api/me 재조회.

1. Controller가 sameOrigin() 검사 → 최대 16,384바이트 JSON·Idempotency-Key 읽기. 공용 풀 연결을 확보하며 BEGIN·COMMIT·ROLLBACK·명시적 락·SET은 실행하지 않는다.
2. AUTH: requireAccount()가 본인 회원을 조회하고 가입 완료·미탈퇴·app 목적을 확인한다.
3. objectBody()·normalizeBankAccountInput()으로 허용 필드·은행 코드·계좌번호·예금주·expectedBankVersion 검증 및 정규화. 은행명은 지원 은행 코드의 이름을 사용한다. 기존 mutationDigest()로 UUID 요청 키 형식만 검사하며 성공 기록을 조회·저장하지 않는다.
4. U-BANK-UPDATE: UserRepository.saveBankAccount()가 `id`·expectedBankVersion과 일치하고 현재도 활성 가입 상태(`deleted_at IS NULL AND onboarding_completed_at IS NOT NULL`)인 행만 UPDATE한다. 계좌 원본·표시 형식·은행·예금주·갱신 시각·bank_version 증가를 한 문장으로 저장한다. 기존 은행 코드·계좌번호·예금주가 정규화 입력과 같을 때만 확인 이력을 유지하며, 다르면 초기화한다. 갱신 행이 0개면 409 bank_account_conflict로 거절한다.
5. 성공하면 `{ data: { id, bankVersion: expectedBankVersion + 1 } }` 반환·after()로 publishBankInvalidation() 예약. 연결은 성공·실패 모두 finally에서 풀에 반환한다. 프론트는 성공 응답의 bankVersion으로 저장을 확인하고 폼을 닫으며, PUT 성공 직후에는 GET을 실행하지 않는다. 최신 계좌는 WebSocket의 me invalidation에서만 자동 재조회하고 저장된 버전이 반영된 뒤 편집을 다시 허용한다. 기존 ErrorNotice로 실패를 표시하고 버전 충돌 시 최신 정보 다시 불러오기를 제공한다.

정상 SQL: **AUTH 내 정보 읽기 (+1) → 입력 검증 → U-BANK-UPDATE 조건부 UPDATE (+1) = 2회**. 기존 12회에서 트랜잭션·락·중복 AUTH·멱등 기록 SQL을 제거했다. 출처·JSON·JWT 거절은 0회, 회원 상태·계좌 입력·요청 키 오류는 AUTH 1회, 버전 충돌과 AUTH 후 상태 변경 거절은 AUTH + UPDATE 2회다. 같은 버전의 동시 요청은 하나만 성공하며, 같은 요청 키·본문의 재전송도 이미 저장된 버전이면 409다. 응답이 유실되면 최신 내 정보를 조회해 저장 결과를 확인한다. 진행 중 정산 조회·외부 계좌 확인은 없다.

[scripts/user.integration.test.ts](../scripts/user.integration.test.ts)에서 실제 SQL 2회·트랜잭션/락/멱등 기록 미실행, AUTH 우선 검증, 동시 수정의 단일 성공, 409 응답과 안내, 동일 계좌 확인 보존·변경 시 초기화, AUTH 후 탈퇴/가입 상태 변경 거절 및 연결 반환을 검증한다. `scripts/browser-check.mjs --account-only`는 실제 me invalidation 전달을 잠시 보류하여 PUT 직후 GET 0회, 전달 후 /api/me GET 1회와 편집 폼의 최신 계좌 반영을 검증한다.

### U4. POST /api/auth/withdraw — 회원탈퇴

AccountPanel.withdraw()의 확인 대화상자 → POST → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 User 위임 → UserController.getWithdrawalResponse() → withdrawAccount() → 공용 풀 연결·쓰기 트랜잭션 락 → `{ ok: true }`·쿠키 삭제 → 클라이언트 Access 토큰·미완료 계좌 입력 정리·홈 이동.

1. Controller가 sameOrigin() 검사. withWriteTransaction()이 BEGIN 후 회차 생성·모임 탈퇴와 동일한 키 1684106607의 pg_advisory_xact_lock을 획득한다.
2. 락을 획득한 뒤 AUTH로 본인의 가입 완료·미탈퇴 상태 확인.
3. S-UNFINISHED-USER: 같은 Client로 Settle 공개 getUnfinishedUserRounds() 호출. round_members → rounds → groups JOIN으로 본인의 모든 미종료 참여 이력과 모임 이름 조회. excluded_at 조건을 두지 않아 회차에서 제외된 참여 이력도 포함한다. 행이 있으면 unfinished_rounds와 해당 회차 목록을 반환하고 ROLLBACK한다.
4. U-WITHDRAW: UserRepository.softDeleteUser()의 단일 SQL에 Settle 공개 unfinishedUserRoundsSql·Group 공개 endUserMembershipsSql을 조합한다. 미종료 참여가 없고 회원이 가입 완료·미탈퇴일 때만 users의 deleted_at·updated_at을 갱신한다. withdrawn CTE가 성공한 경우에만 활성 멤버십의 left_at을 같은 시각으로 갱신하며 RETURNING으로 알림 대상 모임 ID를 얻는다. 계좌·회원 행·과거 회차/정산 기록은 삭제하지 않는다.
5. 성공은 COMMIT·실패는 ROLLBACK으로 트랜잭션 락을 자동 해제한다. 롤백 실패 연결은 폐기한다. 커밋 후 Controller가 `{ ok: true }` 반환. Access/Refresh·복귀·OIDC 쿠키 삭제 및 after()의 publishDepartureInvalidation(groupIds) 예약. 공통 API 클라이언트와 AccountPanel이 클라이언트 토큰·미완료 계좌 입력을 정리한다.

정상 SQL: BEGIN → 트랜잭션 락 획득 → AUTH → S-UNFINISHED-USER → U-WITHDRAW → COMMIT = 6회. 미종료 회차 거절은 BEGIN → 트랜잭션 락 획득 → AUTH → S-UNFINISHED-USER → ROLLBACK = 5회다. 회원 상태·미종료 참여 확인부터 탈퇴 처리까지 같은 락 안에서 실행한다. 별도 pg_advisory_unlock 호출·멱등 기록·DB 세션 삭제·외부 계좌 해제는 없다.

`scripts/user.integration.test.ts`는 정상 6회·미종료 거절 5회 SQL 순서, COMMIT/ROLLBACK 후 다른 연결의 동일 락 획득, 제외된 미종료 참여 거절, 저장 실패 취소와 동시 탈퇴의 단일 성공을 검사한다. `scripts/concurrency.integration.test.ts`는 회차 생성·이탈·닫기·탈퇴의 동시 요청 직렬화와 락 대기 후 최신 회원 상태 검사를 확인하며, 실제 Node/WebSocket 검사는 POST 응답·쿠키 삭제·기존 JWT 차단·남은 모임 멤버 알림을 확인한다.

트랜잭션 락 전환 검증(2026-10-03): `npm test` 91개, 격리된 로컬 DB·MinIO의 `npm run test:integration` 44개와 `npm run build` 통과. 통합·빌드는 기존 개발 서버와 분리한 소스/의존성 복사본에서 실행했다.

User SQL의 실제 원문과 바인딩 순서는 [UserRepository](../src/Domain/User/Backend/Repository/UserRepository.ts)에 있다. `findUser()`는 회원 ID 한 개로 프로필·계좌·가입/탈퇴 상태를 조회하고 UserService가 숫자 시각/버전과 공개 DTO로 변환한다. `saveOnboarding()`은 기존 계좌 저장과 확인 초기화, `saveBankAccount()`는 동일 계좌 확인 보존과 버전 증가, `softDeleteUser()`는 조건부 소프트 삭제와 멤버십 종료를 단일 SQL로 저장한다. 과거 정산과 계좌는 삭제하지 않는다.

UserService·Controller에는 SQL이 없다. 미종료 회차 SQL은 [Settle ParticipationRepository](../src/Domain/Settle/Backend/Repository/ParticipationRepository.ts), 멤버십 변경 SQL은 [GroupRepository](../src/Domain/Group/Backend/Repository/GroupRepository.ts)가 소유한다. UserRepository는 공개 SQL을 고정 CTE로 조합하며 기존 미종료 회차의 모임 이름 JOIN을 유지한다.

가입/계좌 저장 성공 후 `publishBankInvalidation()`은 본인의 `me`와 해당 회원에게 지급할 송금자의 `settlements` 키를 발행한다. 탈퇴 성공 후 `publishDepartureInvalidation()`은 남은 모임 멤버의 목록·상세 키를 발행한다. 쿠키 처리·알림 예약은 Controller, 계좌 버전·멱등·재가입·탈퇴 판단은 Service, DB 행 타입은 내부 DAO, 오류 생성은 내부 Exception에 있다. 실시간 메시지에는 계좌·금액·토큰을 넣지 않는다.

User Frontend는 기존 화면·CSS·복사/클립보드·키보드 동작을 그대로 옮겼다. 계좌 폼 종료 시 User Requests가 공통 `discardPendingRequest()`로 민감한 재시도 본문을 지운다. 인증 실패로 로그인/가입 화면으로 이동할 때 공통 API 클라이언트는 모든 도메인의 미완료 본문과 이전 복구 콜백을 폐기한다.

User 분리 당시 Group·Settle/realtime의 기존 회원·수취 계좌 JOIN은 그대로 유지했다. Settle 후속 분리는 아래 8절에 기록한다. 이번 User 분리는 기존 User API·은행 규칙·화면·회원 저장의 소유권을 옮긴 작업이며, Settle 백엔드 전체 이전이나 락 정책 변경은 포함하지 않는다.

검증 결과(2026-10-03): `npm test` 91개, `npm run build`, 격리된 로컬 테스트 DB/MinIO의 DB 통합 38개와 실시간 통합 1개가 통과했다. 기존 개발 서버의 Next 실행 락 때문에 실시간 검사는 동일 소스의 임시 복사본에서 별도로 실행했다. 전체 모바일 브라우저 검사와 `--forms-only`도 통과하여 내 정보 단일 조회·수동 가입·계좌 저장/충돌 복구·탈퇴·재가입·로그아웃 및 320/390/1024px 폼을 확인했다. 기존 브라우저 검사의 후반 초대 수락도 현재 UI의 `모임으로 가기` 링크 선택 흐름에 맞췄다. 실제 카카오 외부 인증은 이번 검사 범위에 포함하지 않는다.

## 8. Settle 요청 흐름·SQL

회차·지출·부담자·영수증·개인 정산을 **21개 메서드/경로**로 분리했다. API 주소·응답·화면 동작은 유지한다. 회차 목록은 트랜잭션 없이 AUTH → 입력 검증 → 단일 조회의 SQL 2회로 처리한다. 회차 생성은 UUIDv7 ticket을 PK로 사용하며 공용 세션 락·AUTH·단일 저장·락 해제 4회 흐름으로 처리한다. 명시적 트랜잭션·멱등 성공 기록은 없으며 나머지 변경의 기존 정책은 유지한다.

공개 진입점은 [Settle Backend](../src/Domain/Settle/Backend/index.ts)·[Frontend](../src/Domain/Settle/Frontend/index.ts)·[Shared](../src/Domain/Settle/Shared/index.ts)다. [SettleController](../src/Domain/Settle/Backend/Controller/SettleController.ts)가 JSON/multipart·응답·after() 알림을, [SettleService](../src/Domain/Settle/Backend/Service/SettleService.ts)가 입력·권한·상태·버전·계산·저장 순서를, [SettleRepository](../src/Domain/Settle/Backend/Repository/SettleRepository.ts)가 SQL을 소유한다. SQL 행 타입은 내부 SettleDAO, not_found 오류는 SettleException에 있다. Controller·Service는 query()를 호출하지 않는다.

RoundClient·SettlementClient·CreateRoundForm·RoundList는 Settle Frontend에 있다. 공개 DTO와 순수 money/split 계산은 Shared로 옮겼으며 기존 lib/money.ts·split.ts·domain-types.ts는 호환 재수출만 한다. 영수증 변환은 Global Util의 [FileCompressor](../src/Global/Util/Backend/FileCompressor.ts), 객체 저장은 [MinIOUtil](../src/Global/Util/Backend/MinIOUtil.ts)을 사용한다. 회차 생성은 Group의 roundCreationCandidatesSql 공개 SQL을 단일 생성문에 조합하여 활성 회원·멤버십·선택 참여자를 같은 스냅샷에서 검사한다. 기존 모임 이름·회원 프로필·허용 수취 계좌 JOIN은 유지하되 Settle에서 Group/User 테이블을 변경하지 않는다.

### SQL 계산 기준

아래 수는 Service 호출의 실제 query() 횟수다. **BEGIN·락·AUTH·멱등 조회/저장·COMMIT을 포함**하고, Controller의 취소 전 알림 대상 조회·응답 후 실시간 발행·프론트 후속 GET·MinIO 작업은 별도로 센다. 풀 타임아웃은 startup parameter이며 요청별 SET LOCAL은 없다. JWT Guard 거절은 SQL 0회다. SQL에는 바인딩 자리만 기록하며 회원·계좌·토큰·파일 바이트는 로그에 출력하지 않는다.

- `R`: BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY → AUTH → 업무 조회 → COMMIT. 제어 SQL 2회, AUTH 1회다. 읽기에는 명시적 락이 없다.
- `W`: BEGIN → pg_advisory_xact_lock(1684106607) → AUTH → IDEM-READ → 업무 처리 → IDEM-SAVE → COMMIT. 업무 외 **6회**다. 성공 기록은 같은 트랜잭션에서 저장한다.
- `A`: 지출 편집자가 회차 생성자이면 0, 그 외 활성 참여 확인 SELECT이면 1.
- `C`: PATCH에서 SELECTED의 participantIds 또는 CUSTOM의 customShares를 생략해 기존 부담금을 조회하면 1, 그 외 0.
- `E`: 확정 시 기본 몫을 저장하는 균등 분배 지출 수(CUSTOM 제외). `S`: 최종 분담금 행 수. `M`: 제외 이력까지 포함한 회차 참여자 수. `T`: 최종 송금 행 수. `F = S + M + T`.
- 일반 쓰기 성공 재생: BEGIN → 락 → AUTH → IDEM-READ → COMMIT = **5회**. 업무 SQL·버전 증가·IDEM-SAVE를 반복하지 않는다. 같은 키의 다른 payload는 409 idempotency_conflict·ROLLBACK이다.

### S1. POST /api/groups/{groupId}/rounds — 회차 생성

CreateRoundForm.start() → POST → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Settle 분배 → SettleController.getSettleResponse()의 JSON 입력 → SettleService.createRound(CreateRoundRequestDTO) → 아래 DB 처리 → MutationResult → 회차 상세 화면 이동.

1. 공용 풀 연결에서 pg_advisory_lock(1684106607)을 획득한다(+1). 모임 이탈·닫기·회원 탈퇴의 transaction lock 및 초대 수락의 session lock과 같은 키다.
2. 락 획득 후 AUTH 내 정보 조회(+1). 없는/탈퇴한 회원은 401 unauthorized, 가입 전 회원은 403 onboarding_required다. 락 대기 중 변경된 상태도 조회한다.
3. onlyKeys(['name','currency','participantIds'])·textInput(name,100)·idsInput()·requireCurrency(). 요청자를 포함한 최소 2명의 활성 모임 멤버를 요구한다. Idempotency-Key의 UUIDv7 형식을 검증하고 소문자로 정규화한 ticket을 회차 ID로 사용한다.
4. 단일 SQL(+1)의 actor·candidates CTE가 활성 회원·모임 멤버십·선택 참여자를 확인하고 created·members CTE가 회차와 참여자 이름 스냅샷을 원자적으로 저장한다. actor 부재는 401, 비멤버·없는 모임은 404, 후보 누락은 400 invalid_participants다. rounds_pkey 중복은 409 round_already_exists로 반환하며 저장 실패는 같은 SQL 전체를 취소한다.
5. 성공·실패 모두 finally에서 같은 연결로 pg_advisory_unlock(1684106607)을 실행한다(+1). 획득/해제 결과가 불확실하면 연결을 풀에 반환하지 않고 폐기한다. 연결 반환 후 응답하며 검증한 참여자 ID를 realtime 수신자로 전달해 추가 수신자 SQL을 실행하지 않는다.

SQL 순서: **락 획득 → AUTH → 조건부 회차·참여자 INSERT → 락 해제 = 4회**. 입력/회원 거절은 보통 3회, JWT Guard 거절은 0회다. BEGIN·COMMIT·ROLLBACK·mutation_requests는 없다. 회차 생성과 모임 이탈·닫기·회원 탈퇴가 같은 락 안에서 검사·저장을 수행하므로 양쪽이 동시에 성공하지 않는다. 같은 ticket의 재전송은 PK 중복으로 거절하고 다른 ticket은 새 회차를 생성한다. 응답 유실 시 같은 ticket을 유지해 재시도하며 중복 응답이면 회차 목록에서 저장 결과를 확인한다.

### S2. GET /api/groups/{groupId}/rounds — 모임별 회차 목록

GroupClient의 RoundList.useResource()·loadMore() → GET → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController → SettleService.listRounds(access,query,groupId) → 공용 풀 연결 → Page<RoundSummary> → 목록·다음 커서 반영.

1. 공용 풀 연결에서 AUTH 내 정보 조회(+1). 회원의 가입·탈퇴 상태를 검사한 뒤 pagination()으로 limit 기본 20·1~100과 cursor를 검사한다. q는 trim 후 1~100자이며 status는 active 또는 네 회차 상태만 허용한다.
2. S-ROUND-LIST(+1): round_members의 본인 참여 이력과 groupId를 조건으로 회차·모임 이름·최종 잔액·전체 지출·활성 회차 참여자 수를 조회한다. 모임에서 이탈하거나 회차에서 제외되어도 기존 참여 이력은 조회 조건에 남는다.
3. 회차/모임 이름의 대소문자 무시 부분 검색, 상태 필터, (created_at,id) 내림차순 cursor·limit+1을 같은 SQL에 적용한다. pageOf()로 실제 페이지와 다음 cursor를 만든다.
4. 성공·실패 모두 finally에서 연결 반환. GET은 상태·멱등 기록을 변경하거나 알림을 발행하지 않는다.

SQL 순서: **AUTH(+1) → 입력 검증 → S-ROUND-LIST(+1) = 2회**. 빈 결과도 2회, 회원 상태·입력 거절은 AUTH 1회다. BEGIN·COMMIT·ROLLBACK·명시적 락은 없다. 현재 모임 멤버 전체에게 회차를 공개하지 않고, 조회자 자신의 회차 참여 이력으로 제한한다.

### S3. GET /api/rounds — 내 회차·정산 기록 목록

HomeClient/정산 기록의 RoundList → GET → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController → SettleService.listRounds(access,query) → 공용 풀 연결 → Page<RoundSummary> → 홈/기록 카드 반영.

1. S2와 같은 AUTH → limit·cursor·q·status 검사. status=active는 COMPLETED 제외, COMPLETED는 종료 기록만 조회한다.
2. S-ROUND-LIST. groupId는 NULL이며 본인이 참여한 모든 모임의 회차를 같은 조회로 검색한다.
3. 회차마다 자신의 통화·잔액·지출 합계를 반환한다. 서로 다른 회차/통화를 하나의 금액으로 합산하지 않는다.
4. pageOf() → 연결 반환. 과거 참여 이력의 조회 권한을 유지한다.

SQL 순서: **AUTH(+1) → 입력 검증 → S-ROUND-LIST(+1) = 2회**, 빈 결과도 2회다. 공통 listRounds()에서 트랜잭션 없이 처리하며 회원 상태·입력 거절은 AUTH 1회다.

### S4. GET /api/rounds/{roundId} — 회차 상세·지출 페이지·송금 예상

RoundClient.useResource()·refresh()·loadMore() → GET → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController → SettleService.getRound() → 공용 DB 연결 → RoundDetail → 참여자·지출·자신의 송금 관계 반영.

1. AUTH 1회로 회원 상태를 확인한 뒤 limit·cursor를 검사한다.
2. SettleRepository.findRoundDetail() 1회에서 rounds·groups·조회자의 round_members·settlement_balances를 JOIN한다. 본인의 round_members 이력이 없으면 404 not_found이며, 이탈·회차 제외 후에도 조회 가능하다.
3. LATERAL 집계로 참여자와 사용자 이미지, 지출 페이지(limit+1)·부담금·영수증 메타데이터, 전체 지출 합계를 같은 문장의 스냅샷에서 읽는다. 부담금·영수증을 각각 집계하여 JOIN에 따른 중복을 막고 금액은 text로 반환한다. 탈퇴한 참여자의 이름 스냅샷은 보존하고 이미지는 숨긴다.
4. 최종 저장 전에는 같은 SQL의 전체 지출·부담금으로 previewSettlement()를 계산한다. 페이지·빈 페이지에 관계없이 전체 예상과 미배분 나머지를 유지한다. 최종 저장 후에는 같은 SQL에서 본인의 저장된 송금만 조회한다. 계좌·영수증 본문은 반환하지 않는다.
5. pageOf()로 다음 커서를 만들고 연결을 반환한다. 더보기는 화면의 기존 버전과 다르면 최신 재조회를 안내한다.

SQL 순서: AUTH → 회차 상세 통합 JOIN = **2회**. 빈 지출·추가 페이지·최종 저장 후에도 2회이며 BEGIN·COMMIT·ROLLBACK·명시적 락은 없다. 입력 오류는 AUTH 1회 뒤 중단한다. 기존 findRound()·findMembers()·findSettlementExpenses()·findTotal()·findBalance()는 다른 정산 API에서 유지한다.

### S5. DELETE /api/rounds/{roundId} — 빈 회차 취소

RoundClient.cancel()의 영구 삭제 확인 → DELETE → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.roundCommand('cancel',VersionRequestDTO) → MutationResult → 모임 상세 이동.

1. withWriteTransaction()이 BEGIN(+1) → AUTH 내 정보 조회(+1) → 기존 공용 pg_advisory_xact_lock(1684106607) 획득(+1)을 같은 연결에서 실행한다. AUTH 거절은 락 획득 전에 ROLLBACK한다.
2. 허용 필드 expectedVersion·요청 키를 검증한 뒤 findRoundCancellation() 한 SQL(+1)에서 회차 참여 이력·생성자·상태·버전·지출 EXISTS·멱등 성공 기록·삭제 전 알림 대상 ID를 함께 읽는다. 성공 기록은 회차가 없어도 조회하며, 같은 키·같은 본문은 성공 재생, 다른 본문은 409 idempotency_conflict다.
3. 성공 재생이 아니면 회차 존재·생성자·expectedVersion·RECORDING 상태를 검사한다. 지출이 하나라도 있으면 409 round_has_expenses로 거절하고 ROLLBACK(+1)하여 락을 자동 해제한다. 지출·증빙은 유지하며 지출을 먼저 삭제해야 취소할 수 있다.
4. 빈 회차는 deleteRound()의 DELETE CTE → mutation_requests INSERT 단일 SQL(+1)로 삭제와 성공 기록을 함께 저장한다. FK CASCADE로 회차 참여 이력을 삭제한다. 저장 실패는 전체 ROLLBACK이며 롤백 실패 연결은 폐기한다.
5. COMMIT(+1)에서 락을 자동 해제한 뒤 응답·after() invalidation을 처리한다. 알림 대상은 2번에서 확보하여 실시간 활성화 여부와 무관하게 추가 DB 조회가 없다. 성공 재생 시 재발행하지 않는다.

SQL 순서: BEGIN → AUTH → 락 → 통합 조회 → 삭제·성공 기록 → COMMIT = **6회**. 지출 존재·권한·상태·버전 거절과 성공 재생은 **5회**이며 거절 시 마지막 SQL은 ROLLBACK, 재생은 COMMIT이다. 별도 pg_advisory_unlock 호출은 없다. 입력/요청 키 오류는 BEGIN → AUTH → 락 → ROLLBACK의 4회다.

### S6. POST /api/rounds/{roundId}/expenses — 지출 기록

RoundClient.ExpenseForm.save() → POST → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.saveExpense()의 createExpense() → MutationResult → 지출 폼 종료 → WebSocket invalidation 시 상세 GET 1회.

1. 공용 풀의 한 연결에서 AUTH 회원 조회(+1). 가입 완료·미탈퇴 회원을 확인한 뒤 Service에서 요청 키·허용 필드·description·양의 금액 형식/1건 한도·결제자 ID·분배 방식·expectedVersion 형식을 검증한다. SELECTED는 중복 없는 부담자 ID, CUSTOM은 양의 개별 금액·중복 없는 ID·정확한 합계를 확인한다. ALL 부담자는 서버가 결정한다. 이 단계의 입력 오류는 BEGIN·락 없이 AUTH 1회로 종료한다.
2. 같은 연결에서 BEGIN(+1) → SELECT pg_advisory_xact_lock(1684106607)(+1). 기존 회차 변경·모임 이탈·회원 탈퇴와 같은 락을 사용한다.
3. Repository.insertExpenseCreation()의 조건부 INSERT(+1). CTE로 본인의 회차 참여·현재 회원 상태·RECORDING·expectedVersion·제외 여부·활성 결제자/부담자·회차 통화·전체 지출 한도·같은 키 성공 기록을 함께 조회한다. 허용된 새 요청만 expenses에 삽입하며 현재 회차 정보·전체 참여자 알림 대상도 반환한다. Service는 반환한 현재 정보로 권한/버전/통화별 오류를 판별한다. 통화별 소수점 허용 여부는 DB 정보가 필요하므로 이 단계에서 검사하며 별도 SELECT를 추가하지 않는다. 금액은 BigInt와 PostgreSQL numeric으로 정확히 변환하고 정수 최소 단위로 저장한다.
4. Repository.finishExpenseCreation()의 CTE SQL(+1). expense_shares를 unnest로 일괄 삽입하고 rounds.version 증가·mutation_requests 성공 응답 저장을 묶는다. 기록 중 전체 합계는 expenses의 SUM, 예상 송금은 expenses·expense_shares의 previewSettlement로 계산한다. 별도 합계/예상 송금 캐시를 만들지 않으며 최종 settlement_balances/transfers 저장은 기존 전송/추첨 단계에서 수행한다.
5. COMMIT(+1)이 transaction advisory lock을 자동 해제한다. 실패는 ROLLBACK(+1)으로 지출·부담금·버전·성공 기록을 전부 취소하고 락도 해제한다. 롤백 실패 연결은 폐기한다.
6. 성공 응답 뒤 after()는 INSERT에서 확보한 알림 대상에 invalidation 키만 발행하여 대상 조회 SQL을 실행하지 않는다. 같은 키·본문 성공 재생은 INSERT/부담금/버전 증가를 반복하지 않고 저장 응답을 반환하며 알림도 다시 발행하지 않는다. 다른 본문은 409 idempotency_conflict. stale_round 복구는 기존처럼 최신 상세를 조회하고 버전을 바꿔 한 번 재저장한다.

SQL 순서: **AUTH → 요청 검증(SQL 0회) → BEGIN → transaction lock → 조건부 지출 INSERT → 부담금·버전·성공 기록 저장 → COMMIT/락 자동 해제 = 6회**. 생성자·일반 참여자·ALL/SELECTED/CUSTOM 모두 동일하며 WebSocket 발행까지 포함한다. 성공 직후 프론트에서 직접 GET을 보내지 않고 WebSocket invalidation을 받은 useResource만 상세를 조회한다. 버전 충돌 복구·수동 새로고침 GET은 유지하며 후속 GET의 SQL은 별도로 센다. 성공 재생·권한/상태/버전/통화/전체 한도 거절은 마지막 저장 SQL 없이 **5회**다. 실제 SQL은 [SettleRepository.ts](../src/Domain/Settle/Backend/Repository/SettleRepository.ts)의 insertExpenseCreation()/finishExpenseCreation()에 있다.

### S7. PATCH /api/rounds/{roundId}/expenses/{expenseId} — 지출 수정

ExpenseForm.save() → PATCH → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.saveExpense(ExpenseRequestDTO,expenseId) → MutationResult → WebSocket invalidation 시 상세 GET 1회.

1. withDatabaseConnection에서 AUTH 내 정보 조회(+1). JWT·활성 회원·가입 완료를 확인하고 요청 키·본문 digest를 검증한다. BEGIN/COMMIT/ROLLBACK·FOR UPDATE/SHARE·SET을 사용하지 않는다.
2. Repository.findExpenseUpdate() 한 SQL(+1)에서 본인의 회차 참여 이력·생성자·상태·버전·통화·대상 지출·활성 부담자·기존 부담금·회차 합계·멱등 성공 기록·알림 대상 ID를 함께 읽는다. 같은 키/본문 성공은 재생하고 다른 본문은 409 idempotency_conflict다. 성공 재생은 지출이 나중에 삭제되어도 가능하다.
3. RECORDING 상태에서 지출 작성자(제외되지 않은 참여자) 또는 회차 생성자만 허용한다. 결제자/모임 생성자라는 이유만으로 수정할 수 없다. expectedVersion·통화별 금액·결제자·부담자·CUSTOM 합계·기존 금액을 대체한 회차 한도를 검사한다. 생략 필드는 기존 값·SELECTED 부담자·CUSTOM 부담금으로 유지한다. 권한/입력 거절은 추가 SQL 없이 끝난다.
4. withWriteLock()으로 지출 생성·확정과 같은 pg_advisory_lock(1684106607)을 획득(+1)한 뒤 Repository.updateExpense() 단일 CTE SQL(+1)을 실행한다. 현재 권한·참여자·회차 한도를 재검사하고 rounds의 RECORDING·미종료·expectedVersion 조건부 UPDATE로 버전을 증가시킨 요청만 지출을 수정한다. 기존 기본 몫·나머지를 초기화하고, 빠진 부담자는 DELETE, 유지/추가된 부담자는 UPSERT하며 최종 부담금을 초기화한다. 성공 응답을 mutation_requests에 함께 저장한다. 어느 쓰기든 실패하면 SQL 전체가 취소되어 지출·부담금·버전·성공 기록이 부분 저장되지 않는다.
5. 같은 연결에서 pg_advisory_unlock(+1)을 finally로 실행한다. 실패해도 락을 해제하며 해제 실패 연결은 폐기한다. 성공 시 2번에서 확보한 대상에게 재조회 키만 발행한다. 수신자 조회 SQL·성공 직후 프론트의 직접 GET은 없다. 조건부 UPDATE가 경합으로 실패하면 통합 조회 1회를 추가해 같은 키 성공을 재생하거나 최신 상태/버전 오류를 반환한다. 버전 충돌 복구는 S6과 같다.

SQL 순서: **AUTH → 지출/권한/멱등 통합 조회 → 세션 lock → 조건부 UPDATE → unlock = 5회**. 생성자·작성자·ALL/SELECTED/CUSTOM·부분 수정 모두 같다. 조회 후 권한/입력/상태/버전 거절과 순차 성공 재생은 **2회**, 키 오류는 AUTH **1회**, JWT 거절은 **0회**다. UPDATE 경합으로 마지막 통합 조회가 필요하면 **6회**다. 명시적 트랜잭션은 없으며 UPDATE 자체의 PostgreSQL 행 잠금은 유지된다([동시 UPDATE의 WHERE 재검사](https://www.postgresql.org/docs/17/transaction-iso.html)).

PATCH와 경합하는 기존 트랜잭션 쓰기도 같은 회차 버전을 조건부로 증가시킨다. 확정·삭제는 단일 저장 SQL에서, 영수증 변경은 원본을 쓰기 전에 S-BUMP로 버전을 확보하고, 제외는 단일 저장 SQL에서 버전을 확보하며, 지출 생성은 마지막 저장 SQL의 버전 조건이 실패하면 전체 ROLLBACK한다. PATCH가 먼저 저장된 뒤 오래된 요청이 확정/삭제되거나 회차 합계를 넘기는 것을 막으며 기존 쓰기의 트랜잭션·advisory lock은 유지한다.

### S8. DELETE /api/rounds/{roundId}/expenses/{expenseId} — 지출 삭제

ExpenseCard.remove()의 확인 → DELETE → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.deleteExpense(VersionRequestDTO) → 아래 DB 처리 → MutationResult → WebSocket invalidation 시 상세 GET 1회.

1. BEGIN(+1) → AUTH 내 정보 조회(+1). AUTH 이후 expectedVersion 외 필드·요청 키를 검사한다.
2. findExpenseDeletion()의 통합 조회(+1)로 회차·본인 참여·지출 작성자·제외 상태·영수증 Object Key·알림 대상·같은 키 성공 기록을 얻는다. 성공 재생이 아니면 작성자 또는 회차 생성자·RECORDING·expectedVersion을 검사한다. 권한/상태/버전/없는 지출 거절은 락을 잡지 않고 ROLLBACK하여 **4회**다.
3. 허용된 요청만 pg_advisory_xact_lock(+1)을 획득한다. deleteExpense() 단일 CTE SQL(+1)에서 현재 회원 상태·권한·RECORDING·버전·성공 재시도를 재검사하고 rounds.version 증가 → 지출 삭제 → 멱등 성공 응답 저장을 함께 처리한다. 부담금·영수증 메타데이터는 FK CASCADE로 삭제한다. 총금액은 남은 expenses의 SUM, 예상 송금 관계는 남은 expenses·expense_shares에서 계산하므로 삭제 이후 조회에 바로 반영된다. 합계/예상 송금 캐시를 추가하지 않는다.
4. COMMIT(+1) 성공 후에만 반환된 Object Key의 MinIO 객체를 정리한다. DB 실패는 전체 ROLLBACK하며 객체 삭제를 실행하지 않는다. 객체 정리 실패는 로그로 남기고 이미 커밋된 삭제 성공을 반환한다.
5. 통합 조회의 허가된 참여자 ID로 알림을 예약하여 추가 수신자 SQL은 0회다. 같은 키 성공 재생은 버전/삭제/객체 정리/알림을 반복하지 않는다. 사전 조회 뒤 같은 키 성공이 먼저 커밋되어도 락 안의 단일 SQL에서 재생한다.

SQL 순서: **BEGIN → AUTH → 지출·권한 통합 조회 → transaction lock → 지출 삭제·버전·성공 기록 저장 → COMMIT/락 자동 해제 = 6회**. 작성자/생성자·영수증 유무 모두 동일하며 알림 발행까지 추가 SQL은 없다. 사전 조회에서 확인된 성공 재생은 기존 공용 트랜잭션의 락·COMMIT을 포함해 **5회**다. 후속 상세 GET 2회와 MinIO 작업은 별도로 센다.

### S9. GET /api/rounds/{roundId}/members/{userId}/exclusion-check — 제외 가능 여부

RoundClient.checkExclusion() → GET → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController → SettleService.checkExclusion() → 공용 풀 연결 → ExclusionCheck → 제외 안내 대화상자.

1. AUTH 회원 조회(+1) → S-ROUND 회차·본인 참여 이력 조회(+1) → 회차 생성자 권한 확인. 생성자가 아닌 참여자는 403으로 거절하며 대상/지출 조회를 실행하지 않는다. 회차가 없거나 조회자가 참여 이력이 없으면 404다.
2. S-EXCLUSION-EXPENSES(+1)가 대상 참여 이력·제외 여부·현재 참여 인원과 결제자 겸 부담자·SELECTED 부담자·CUSTOM 부담자인 관련 지출/작성자 스냅샷을 한 SQL로 조회한다. 대상 참여 이력이 없으면 404다. 금액은 문자열로 반환하고 관련 지출 전체를 생성 시각·ID 순서로 유지한다.
3. 생성자 제외 불가·이미 제외·RECORDING/CONFIRMED 외 상태·관련 지출·제외 후 최소 2명 조건을 allowed/reason/expenses로 반환한다.
4. 성공·거절·오류 모두 연결을 반환한다. 명시적 트랜잭션·락은 없으며 참여자나 부담금을 변경하지 않는다. CONFIRMED에서는 검토만 가능하고 실제 제외는 재오픈 후 실행한다. 실제 제외 요청은 S10의 통합 조회와 조건부 단일 저장 SQL에서 조건을 다시 검사한다.

SQL 순서: **AUTH → S-ROUND → 생성자 권한 확인 → S-EXCLUSION-EXPENSES = 3회**. 비생성자·조회 불가 회차는 **2회**, 회원 상태 거절은 **1회**, JWT Guard 거절은 **0회**. `scripts/settle-sql.integration.test.ts`에서 실제 SQL 순서·횟수·트랜잭션/락 부재와 기존 제외 조건을 검증한다.

### S10. POST /api/rounds/{roundId}/members/{userId}/exclude — 회차 참여자 제외

RoundClient.exclude()의 확인 → POST → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.excludeMember(VersionRequestDTO) → 공용 풀 연결 → MutationResult → 대화상자 종료. 상세 갱신은 WebSocket invalidation을 통해 수행한다.

1. AUTH(+1)로 내 회원 상태 확인 → expectedVersion 외 필드와 요청 키 형식 검사.
2. findMemberExclusion(+1)로 회차·본인 참여 이력·대상 참여/제외 상태·현재 참여 인원·제외를 막는 관련 지출·회차/모임 알림 대상을 한 SQL로 조회한다. 생성자 권한을 먼저 확인하고, 대상이 없거나 이미 제외됐으면 404 not_found다. RECORDING·expectedVersion·S9 제외 조건을 검사하며 최소 인원은 minimum_participants, 다른 차단은 member_exclusion_blocked와 관련 지출을 반환한다.
3. Repository.excludeMember(+1)의 단일 CTE에서 조건부 회차 버전 증가 → 대상 excluded_at 저장 → 해당 회차 ALL 지출의 대상 부담금 삭제를 원자적으로 처리한다. 현재 생성자·회원 상태·RECORDING·버전·대상 활성 참여·최소 인원·관련 지출 조건을 다시 확인하며 경합으로 저장하지 못하면 409 stale_round다. SQL 문장 하나의 자동 트랜잭션을 사용하고 BEGIN/COMMIT 및 명시적 락은 없다.
4. Idempotency-Key 형식 검사는 유지하며 성공 기록 조회/저장·재생은 사용하지 않는다. 성공 후 같은 키/새 키로 다시 요청하면 대상 참여 검사에서 404로 끝난다. 모임 멤버십·다른 회차·과거 조회 이력·비부담 결제자의 수취 관계는 유지한다.
5. 저장 성공 후 통합 조회에서 확보한 회차 참여자·활성 모임 참여자로 invalidation을 예약한다. 알림 대상의 추가 SQL은 0회이며 저장 실패·중복 요청에는 발행하지 않는다.

SQL 순서: **AUTH → 회차/대상/제외 조건 통합 조회 → 생성자·대상 참여 확인 → 제외 단일 저장 = 3회**. 권한·대상 없음/이미 제외·상태·버전·제외 조건 거절은 **2회**, 회원 상태/입력/키 거절은 **1회**, JWT Guard 거절은 **0회**. `scripts/settle-sql.integration.test.ts`에서 실제 SQL 순서·횟수·명시적 트랜잭션/락 부재·중복 404·제외 저장 실패 원자성·알림 대상과 ALL 재분배를 검증한다.

검증(2026-10-04): `npm test` **96개**, 전용 로컬 테스트 PostgreSQL·MinIO와 개발 서버에서 분리한 복사본의 `npm run test:integration` **52개**, `npm run build` 통과. Route Handler는 모임 생성자의 다른 회차 제외 403과 회차 생성자의 성공 200·같은 키/새 키 재요청 404를 확인했다.

### S11. POST /api/rounds/{roundId}/confirm — 정산 확정

RoundClient.command('confirm') → POST → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.roundCommand('confirm',VersionRequestDTO) → MutationResult → WebSocket invalidation 시 상세 GET 1회·화면 위로 이동.

1. AUTH 내 정보 조회(+1)로 활성·가입 완료 회원을 확인하고 expectedVersion 외 필드·요청 키·본문 digest를 검사한다.
2. BEGIN(+1) 후 findRoundConfirmation() 통합 조회(+1)에서 회차·본인 참여 이력·생성자·상태·버전·통화·전체 참여자/지출/부담금·멱등 성공 기록·알림 대상을 얻는다. 같은 키/본문 성공은 재생하고 다른 본문은 409 idempotency_conflict다.
3. 회차 생성자·expectedVersion·RECORDING·활성 참여자 최소 2명·지출 존재·결제자/부담자·CUSTOM 합계·1건/회차 금액 한도를 검사한다. 지출이 없으면 409 empty_expenses와 `지출 내역이 없습니다`로 거절한다.
4. 허용된 요청만 pg_advisory_xact_lock(1684106607)(+1)을 획득한다. 지출 추가의 transaction lock·지출 수정의 session lock과 같은 키다. 락 획득부터 COMMIT/ROLLBACK까지 추가·수정의 저장은 대기한다.
5. confirmRound() 단일 CTE SQL(+1)에서 현재 회원·생성자·RECORDING·버전·지출 존재·성공 재시도를 다시 검사한다. 조건부 rounds UPDATE로 CONFIRMED·confirmed_at·버전을 저장한 요청만 ALL/SELECTED 기본 몫·나머지를 일괄 저장하고 멱등 성공 응답을 함께 기록한다. CUSTOM 지정 부담금은 유지한다. 조회 이후 다른 변경이 먼저 커밋되면 최신 상태/버전 오류를 반환하며, 같은 키의 선행 성공은 재생한다.
6. COMMIT(+1)이 transaction lock을 자동 해제한다. 실패는 ROLLBACK으로 확정·기본 몫·버전·성공 기록을 모두 취소하고 락을 해제한다. 롤백 실패 연결은 폐기한다.
7. 커밋 후 통합 조회에서 확보한 참여자에게 invalidation 키만 발행한다. 알림 대상 조회 SQL과 성공 직후 직접 GET은 없으며 재생 시 알림을 반복하지 않는다. 최종 송금 저장·나머지 추첨은 기존 전송/추첨 단계에서 수행한다.

SQL 순서: **AUTH → BEGIN → 회차/지출/멱등 통합 조회 → 생성자·지출·상태·버전 검사(SQL 0회) → transaction lock → 확정 단일 저장 → COMMIT = 6회**. 지출 개수·ALL/SELECTED/CUSTOM과 관계없이 알림 발행까지 포함한다. 조회 단계 거절은 ROLLBACK까지 **4회**, 순차 성공 재생은 **5회**, 락 대기 이후 경합 거절·성공 재생은 **6회**, 회원/입력/키 거절은 **1회**, JWT Guard 거절은 **0회**다.

`scripts/settle-sql.integration.test.ts`에서 실제 SQL 순서·횟수·다건/혼합 분배·회차 생성자 권한·빈 지출·성공 재생·저장 실패 롤백을 검사한다. `scripts/concurrency.integration.test.ts`는 조회 이후 수정이 먼저 저장되는 경우의 버전 거절과, 확정 락을 가진 동안 지출 추가·수정·같은 키 확정이 실제 advisory lock 대기 상태에 있는지 검사한다.

### S12. POST /api/rounds/{roundId}/reopen — 기록 단계 재오픈

RoundClient.command('reopen') → POST → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.roundCommand('reopen',VersionRequestDTO) → MutationResult → WebSocket invalidation 시 상세 GET 1회·화면 위로 이동.

1. AUTH 내 정보 조회(+1)로 활성·가입 완료 회원을 확인하고 expectedVersion 외 필드·Idempotency-Key 형식을 검사한다.
2. findRoundReopening() 회차 조회(+1)에서 본인의 회차 참여 이력·회차 생성자·상태·버전·알림 대상을 얻는다. 회차 생성자만 허용하며 모임 생성자 권한으로 대신할 수 없다. CONFIRMED·미종료·expectedVersion을 검사하고 이미 RECORDING 또는 LOCKED/COMPLETED이면 409 invalid_round_state다.
3. reopenRound() 단일 CTE SQL(+1)에서 현재 회원·회차 생성자·CONFIRMED·미종료·버전을 재검사한다. 조건부 rounds UPDATE로 RECORDING·confirmed_at=NULL·버전 증가를 저장한 요청만 지출의 기본 몫·나머지 컬럼을 초기화한다. SQL 문장 하나의 자동 트랜잭션으로 처리하며 BEGIN/COMMIT·명시적 락은 없다. 지출 원본·CUSTOM 지정 부담금·참여자·통화는 유지하고 저장 실패는 전체 취소된다.
4. 성공 기록 조회/저장·재생은 사용하지 않는다. 성공 후 같은 키/새 키로 다시 요청하면 이미 기록 중인 상태를 확인해 409로 거절한다. 조회 이후 동시 재오픈/전송이 먼저 저장되면 조건부 UPDATE가 실패해 409 stale_round다. 전송의 lockRound()에도 CONFIRMED·미종료·버전 조건을 적용해 먼저 성공한 재오픈을 덮어쓰지 않는다.
5. 저장 성공 후 조회에서 확보한 참여자에게 invalidation 키만 발행한다. 알림 대상 추가 SQL과 성공 직후 직접 GET은 없으며 실패·중복 요청에는 알림을 발행하지 않는다.

SQL 순서: **AUTH → 회차 조회 → 생성자·상태·버전 검사(SQL 0회) → 재오픈 단일 저장 = 3회**. 권한·회차 없음·상태·버전 거절은 **2회**, 회원/입력/키 거절은 **1회**, JWT Guard 거절은 **0회**다. `scripts/settle-sql.integration.test.ts`에서 실제 SQL 순서·횟수·명시적 트랜잭션/락 부재·같은 키/새 키 재요청 409·저장 실패 원자성·CUSTOM 보존·알림 대상을 확인한다. `scripts/concurrency.integration.test.ts`는 조회 후 다른 재오픈/전송이 먼저 저장되는 양방향 경합을, `scripts/routes.integration.test.ts`는 회차 생성자 권한·성공·중복·종료 상태의 HTTP 응답을 검증한다.

검증(2026-10-04): `npm test` **96개**, 전용 로컬 테스트 PostgreSQL·MinIO와 격리 복사본의 `npm run test:integration` **56개**, `npm run build` 통과. `scripts/browser-check.mjs --expenses-only`에서 재오픈 POST의 직접 GET **0회**·WebSocket invalidation 후 상세 GET **1회**와 실제 서버 로그의 재오픈 SQL **3회**·명시적 트랜잭션/락 부재를 확인했다.

### S13. POST /api/rounds/{roundId}/send — 전송·기록 잠금

RoundClient.command('send')의 확인 → POST → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.roundCommand('send',VersionRequestDTO) → W → MutationResult → 개인 정산 화면 이동.

1. expectedVersion만 허용. W → S-ROUND → 생성자·버전·CONFIRMED 검사 → S-MEMBERS → S-SETTLEMENT-EXPENSES로 지출 재검증.
2. S-LOCK으로 LOCKED·locked_at 저장 → S-REMAINDER로 미배분 나머지 존재 여부 조회.
3. 나머지가 있으면 최종 저장을 추첨까지 미룬다. 나머지가 없으면 finalize(false)가 S-MEMBERS → S-SETTLEMENT-EXPENSES를 다시 조회하고 확정 계산한다.
4. 최종 저장은 S-FINAL-SHARE × S → S-BALANCE-INSERT × M → S-TRANSFER-INSERT × T → S-FINALIZE 1회다. 분담금·잔액·송금·최종 시각은 같은 트랜잭션에 저장한다.
5. S-BUMP → IDEM-SAVE → COMMIT → 정산 화면 이동·알림. 실제 송금/카카오 전송은 없으며 링크만 직접 공유한다.

나머지 있음: W 6회 + S-ROUND → S-MEMBERS → S-SETTLEMENT-EXPENSES → S-LOCK → S-REMAINDER → S-BUMP = **12회**. 나머지 없음: 여기에 최종 저장의 재검증 2회·F회·최종 시각 1회가 추가되어 **15 + F회**다. 2명·분담금 2행·송금 1행이면 F=5로 20회다.

### S14. POST /api/rounds/{roundId}/draw — 나머지 한 번 추첨

SettlementClient.command('draw') → POST → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.roundCommand('draw',VersionRequestDTO) → W → MutationResult → 정산 안내 재조회.

1. expectedVersion만 허용. W → S-ROUND → 생성자 확인. finalized_at이 이미 있으면 버전/상태 검사 전에 저장된 상태·버전을 반환하여 재추첨을 막는다.
2. 미저장 회차는 버전·LOCKED 확인 → S-MEMBERS → S-SETTLEMENT-EXPENSES로 지출·부담금 재검증.
3. finalizeSettlement()에 crypto.randomInt를 전달한다. 지출별 서로 다른 균등 부담자에게 최소 단위 1씩 나머지를 배분하고 CUSTOM 지정 부담금은 유지한다.
4. S-FINAL-SHARE × S → S-BALANCE-INSERT × M → S-TRANSFER-INSERT × T → S-FINALIZE → S-BUMP.
5. IDEM-SAVE → COMMIT. 중간 저장 실패는 전체 ROLLBACK이며 최종 결과가 저장된 회차를 다시 뽑지 않는다.

SQL: W 6회 + S-ROUND → S-MEMBERS → S-SETTLEMENT-EXPENSES → 최종 행 저장 F회 → S-FINALIZE → S-BUMP = **11 + F회**. 이미 저장된 결과를 새 키로 요청하면 W 6회 + S-ROUND = **7회**, 같은 키 성공 재생은 5회다.

### S15. GET /api/rounds/{roundId}/settlement — 내 정산·최신 수취 계좌

SettlementClient.useResource()·reload()·화면 복귀 갱신 → GET → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController → SettleService.getSettlement() → R → SettlementDTO → 내 보낼/받을 금액·수취 확인 현황.

1. BEGIN → AUTH → S-ROUND로 참여 이력 확인 → S-CHECKS로 실제 수취인별 bool_and(received_at IS NOT NULL)·마지막 확인 시각·프로필 조회.
2. finalized_at이 없으면 최종 대기 DTO만 반환한다. 미저장 금액이나 계좌를 최종 안내로 노출하지 않는다.
3. 최종 저장 후 S-BALANCE → S-OUTGOING → S-INCOMING. outgoing은 본인이 보내며 아직 확인되지 않은 송금, incoming은 본인이 받는 모든 송금과 received_at이다.
4. S-OUTGOING은 KRW일 때만 **조회자 자신의 실제 수취인** users에 계좌 컬럼을 JOIN한다. 생성자 권한으로 다른 계좌를 추가 공개하지 않는다. KRW 이외 통화는 SQL의 계좌 SELECT 컬럼과 응답의 account 속성을 모두 생략한다.
5. 부담액−결제액 부호·최신 계좌·확인 현황·sharePath를 DTO로 변환 → COMMIT. verifiedAt이 없으면 화면에서 정확히 `확인되지 않은 계좌입니다.`를 표시한다.

미저장 SQL: BEGIN → AUTH → S-ROUND → S-CHECKS → COMMIT = **5회**. 최종 저장 후에는 S-BALANCE → S-OUTGOING → S-INCOMING 3회를 더해 **8회**다. 금액·계좌를 실시간 메시지나 성공 재생 기록에 저장하지 않는다.

### S16. POST /api/rounds/{roundId}/settlement-check — 수취 수동 확인·해제

SettlementClient.setChecked(checked,senderId?) → POST → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.setSettlementCheck(SettlementCheckRequestDTO) → W → MutationResult → 정산 안내 재조회.

1. onlyKeys(['expectedVersion','checked','senderId']). checked는 boolean이며 선택 senderId는 공백 없는 1~128자 식별자 형식으로 검사한다.
2. W → S-ROUND → 버전·LOCKED·최종 저장 완료 검사.
3. S-RECEIVED 한 UPDATE는 receiver_id=본인과 선택 sender_id로 제한한다. checked=true는 기존 확인 시각을 COALESCE로 유지하고 false는 NULL로 해제한다. senderId 생략은 본인의 모든 incoming에 적용한다.
4. 영향 행이 없으면 403 forbidden이다. 다른 수취인 확인·종료 후 변경은 거절한다. 이 작업은 회차 버전을 증가시키지 않는다.
5. IDEM-SAVE → COMMIT → 정산 DTO 재조회·알림 예약. 은행 입금 자동 조회는 없다.

SQL: W 6회 + S-ROUND → S-RECEIVED = **8회**. 같은 키 성공 재생은 5회이며 동시 수취인 확인을 같은 잠금 아래 합성한다.

### S17. POST /api/rounds/{roundId}/complete — 일반 정산 종료

SettlementClient.command('complete')의 확인 → POST → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.roundCommand('complete',VersionRequestDTO) → W → MutationResult → 정산 기록 화면 이동.

1. expectedVersion만 허용. W → S-ROUND → 생성자·버전·LOCKED·최종 저장 완료 검사.
2. S-PENDING-COUNT가 received_at IS NULL인 송금 수를 조회한다. 남아 있으면 409 pending_settlement_checks와 pendingCount를 반환하고 ROLLBACK한다.
3. 모두 확인되었으면 S-COMPLETE로 COMPLETED·completed_at 저장 → S-BUMP → IDEM-SAVE → COMMIT.
4. 종료한 회차는 읽기 전용이다. 기존 분담금·잔액·송금·계좌 안내 조회는 보존하며 실제 은행 입금을 검증하지 않는다.
5. 성공 후 기록 화면 이동·알림 예약. 참여 이력의 미종료 회차 제한에서 이 회차가 빠진다.

SQL: W 6회 + S-ROUND → S-PENDING-COUNT → S-COMPLETE → S-BUMP = **10회**. 미확인 거절은 BEGIN → 락 → AUTH → IDEM-READ → S-ROUND → S-PENDING-COUNT → ROLLBACK = **7회**다.

### S18. POST /api/rounds/{roundId}/force-complete — 강제 정산 종료

SettlementClient.command('force-complete')의 미확인 인원·되돌릴 수 없음 경고 → POST → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.roundCommand('force-complete',VersionRequestDTO) → W → MutationResult → 정산 기록 화면 이동.

1. expectedVersion만 허용. W → S-ROUND → 생성자·버전·LOCKED·최종 저장 완료 검사.
2. S-PENDING-COUNT를 실행하지 않고 S-COMPLETE → S-BUMP로 종료를 저장한다. 미확인 송금의 received_at을 임의로 확인 처리하지 않는다.
3. IDEM-SAVE → COMMIT → 응답·알림 예약. 일반 종료와의 경합도 기존 쓰기 잠금·버전/상태 검사로 하나만 성공한다.
4. 경고와 종료 후 읽기 전용 흐름을 유지한다.

SQL: W 6회 + S-ROUND → S-COMPLETE → S-BUMP = **9회**.

### S19. POST /api/rounds/{roundId}/expenses/{expenseId}/receipts — 영수증 추가

ExpenseCard.upload() → POST multipart → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController의 file·expectedVersion → SettleService.addReceipt() → 사전 읽기·AVIF 변환·MinIO 저장·W 재검증 → MutationResult → 영수증 대화상자 종료·상세 재조회.

1. Controller는 동일 출처·file 한 개·허용 폼 키(file,expectedVersion)를 확인한다. 파일 원본 SHA-256·경로·버전·claimed type을 멱등 payload로 사용한다.
2. 사전 읽기: BEGIN → AUTH → IDEM-READ → S-ROUND → S-EXPENSE → [S-ACTIVE-MEMBER] → COMMIT. 편집 권한·RECORDING·expectedVersion을 확인한다. 기존 성공이면 즉시 재생하여 변환/업로드를 반복하지 않는다.
3. Global FileCompressor가 실제 JPEG/PNG/WebP 포맷과 claimed type을 비교하고 autoOrient().avif()로 변환한다. Global MinIOUtil이 비공개 버킷의 `receipts/{userId}/{key}.avif`에 저장한다. 이미지 작업은 DB 쓰기 락 밖에서 수행한다.
4. W → S-ROUND → S-EXPENSE → [S-ACTIVE-MEMBER]로 현재 상태·권한·버전을 다시 검사 → S-BUMP로 버전 확보 → S-RECEIPT-INSERT로 Object Key·MIME·크기·해시 저장 → IDEM-SAVE → COMMIT.
5. 변환 타입 오류는 415, 변환/저장 불가는 503, 사전 검증 이후 잠긴 회차는 DB 재검사에서 거절한다. 객체 저장 후 DB 실패로 남는 객체의 자동 정리는 현재 제공하지 않는다(기존 ponytail 한계 유지).

사전 SQL **6 + A회**, 저장 SQL **10 + A회**, 합계 **16 + 2A회**(생성자 16회, 일반 작성자 18회). 이미 성공한 업로드는 BEGIN → AUTH → IDEM-READ → COMMIT = **4회**다. MinIO PUT·AVIF 변환은 SQL 횟수에 포함하지 않는다. 앱 파일 크기 제한을 추가하지 않고 변환기의 픽셀 안전장치를 유지한다.

### S20. GET /api/receipts/{receiptId} — 인증된 영수증 이미지 조회

ReceiptImage.view() → GET(blob) → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController → SettleService.getReceipt() → R·MinIO 읽기 → 이미지 바이트 → 브라우저 Object URL·미리보기.

1. BEGIN → AUTH → S-RECEIPT. 영수증 → 지출 → round_members JOIN의 본인 참여 이력으로 조회 권한을 제한한다. 다른 회차 영수증은 404다.
2. Object Key가 있으면 MIME·키만 읽고 COMMIT 후 MinIO GET으로 바이트를 가져온다. DB 읽기 트랜잭션을 잡고 객체 네트워크 작업을 기다리지 않는다.
3. 과거 BYTEA 영수증이면 같은 스냅샷에서 S-LEGACY-CONTENT 1회를 추가하고 COMMIT한다. 기존 JPEG/PNG/WebP 등 저장 MIME을 유지한다.
4. Controller는 실제 MIME·X-Content-Type-Options:nosniff·Cache-Control:private,no-store로 바이너리 응답한다. JSON data envelope를 쓰지 않는다.
5. 브라우저가 미리보기를 접거나 컴포넌트를 해제할 때 Object URL을 폐기한다.

Object Key SQL: BEGIN → AUTH → S-RECEIPT → COMMIT = **4회**, BYTEA는 S-LEGACY-CONTENT 추가로 **5회**다. MinIO GET은 별도 외부 작업이다.

### S21. DELETE /api/rounds/{roundId}/expenses/{expenseId}/receipts/{receiptId} — 영수증 삭제

ExpenseCard.removeReceipt()의 확인 → DELETE → Node Proxy → JWT Guard → API Route Settle 분배 → SettleController JSON → SettleService.removeReceipt(VersionRequestDTO) → W → MutationResult → 상세 재조회.

1. expectedVersion만 허용. W → S-ROUND → S-EXPENSE → [S-ACTIVE-MEMBER] → 작성자/회차 생성자·RECORDING·버전 확인.
2. S-BUMP로 버전 확보 → S-RECEIPT-DELETE는 receiptId와 expenseId를 함께 제한하고 Object Key를 RETURNING한다. 삭제 행이 없으면 404 not_found·ROLLBACK이다.
3. IDEM-SAVE → COMMIT → Object Key가 있으면 MinIO 삭제 → 응답·알림 예약. 지출 원본은 유지한다.
4. 같은 키 성공 재생은 DB 삭제·객체 삭제를 반복하지 않으며 BYTEA 영수증은 외부 객체 삭제 없이 처리한다.

SQL: W 6회 + S-ROUND → S-EXPENSE → [S-ACTIVE-MEMBER] → S-BUMP → S-RECEIPT-DELETE = **10 + A회**.

### Settle 실시간·검증 경계

회차 생성·지출 생성·지출 수정·지출 삭제·참여자 제외·정산 확정 알림은 저장/통합 조회에서 확보한 참여자 ID를 전달받아 수신자 SQL 0회다. 나머지 일반 변경 후 알림 수신자 조회는 BEGIN → 회차 group_id → round_members → COMMIT = **별도 4회**다. 취소는 S5의 기록 확인 SQL에서 삭제 전 허가된 수신자를 함께 읽으므로 삭제 전후 추가 조회 **0회**이며 성공 재생 시 재발행하지 않는다. 실시간 비활성화 시 모두 SQL 0회다. after() 알림 실패는 이미 저장한 변경을 롤백하지 않는다. 메시지에는 rounds·group-rounds·round·settlement와 필요한 groups/group 키만 넣고 금액·계좌·영수증·초대 토큰은 넣지 않는다.

[scripts/settle-sql.integration.test.ts](../scripts/settle-sql.integration.test.ts)는 실제 PostgreSQL SQL 로그로 생성 4회·UUIDv7 PK·중복 409·동시 중복 단일 성공·세션 락 획득/해제·참여자 저장 실패 원자성·목록 4회·상세 10/11회·지출 생성 6회·생성 입력 오류 AUTH 1회·생성 성공 재생 5회·생성 실패 전체 롤백·같은 키 동시 생성 단일 저장·수정 5회/거절 및 재생 2회/경합 후 재조회 6회·삭제 12회·제외 검토 3회·제외 3회/거절 2회/중복 404·확정 6회/조회 거절 4회/성공 재생 5회·재오픈 10회·나머지 있는 전송 12회·없는 전송 20회·추첨 17회/재추첨 방지 7회·최종 전/후 안내 5/8회·수취 확인 8회·일반/강제 종료 10/9회·취소 9회·영수증 생성/조회/삭제 16/4/10회·일반 성공 재생 5회·영수증 재생 4회·종료 후 편집 거절 ROLLBACK을 검증한다. 숫자는 해당 테스트의 참여자·분담금·송금 행 수 기준이며 위 계산식이 일반 규칙이다.

기존 [settlement.integration.test.ts](../scripts/settlement.integration.test.ts)·[concurrency.integration.test.ts](../scripts/concurrency.integration.test.ts)·[receipt-migration.integration.test.ts](../scripts/receipt-migration.integration.test.ts)·[routes.integration.test.ts](../scripts/routes.integration.test.ts)는 Settle 공개 진입점을 통해 권한·과거 조회·정확한 통화/금액·CUSTOM 합계·멱등성·버전 충돌·추첨 중간 실패 취소·상태 전이 경합·사전 검사 후 업로드 경합·최신 수취 계좌 제한·기존 BYTEA 영수증을 검증한다. [domain-boundaries.test.ts](../src/lib/domain-boundaries.test.ts)는 Frontend/Shared→Backend 금지, 서버 전용 표시, 다른 도메인 내부 import 금지와 Controller/Service의 SQL 미포함을 검사한다. [settle.test.ts](../src/lib/settle.test.ts)는 경로 분배·출처·JSON/multipart 오류를 검사한다.

재현: README대로 개발/운영과 분리된 **로컬 test DB와 MinIO 버킷**을 지정한 뒤 다음을 실행한다. 실제 바인딩/계좌/토큰을 로그로 출력하지 않는다.

```bash
npm test
node --import ./scripts/test-server-only.mjs --import tsx --test scripts/settle-sql.integration.test.ts
npm run test:integration
npm run build
# 동일 테스트 DB·JWT secret의 앱과 Chrome debugging을 준비한 뒤
node --import ./scripts/test-server-only.mjs --import tsx scripts/browser-check.mjs
```

Settle 분리 검증 결과(2026-10-03): `npm test` **93개**, 격리된 로컬 PostgreSQL·MinIO의 `npm run test:integration` **45개**, `npm run build`가 통과했다. 전체 `scripts/browser-check.mjs`도 통과하여 실제 Chrome에서 회차 생성·지출/CUSTOM·버전 충돌 재저장·영수증·제외·확정/추첨·최신 수취 계좌·수취 확인·종료/읽기 전용·과거 조회·탈퇴/재가입·응답 유실 재시도를 확인했다. 기존 개발 서버와 분리한 소스/의존성 복사본을 사용했으며 실제 카카오 외부 인증은 이번 검증 대상이 아니다.


회차 생성 UUIDv7 ticket·세션 락 검증 결과(2026-10-03): `npm test` **94개**, 격리된 PostgreSQL·MinIO의 `npm run test:integration` **46개**, `npm run build`, 전체 Chrome `scripts/browser-check.mjs`가 통과했다. 실제 Node 서버에서 UUIDv7 ticket PK·같은 ticket 중복 409·WebSocket 발행을 포함한 **SQL 4회**와 명시적 트랜잭션/멱등 기록 미실행을 확인했다. 모임 이탈·닫기·회원 탈퇴와 동시 실행 시 단일 성공, 락 대기 후 활성 상태 검사, 성공·입력 오류·AUTH 오류·저장 실패의 락 해제, 참여자 저장 실패 시 원자성을 검증했다. 브라우저 요청은 회차 생성에 UUIDv7 ticket을 보내고 응답 유실 후 같은 ticket을 유지한다. 중복 응답이면 목록에서 저장 결과를 확인하도록 안내한다.


지출 PATCH 개선 검증(2026-10-03): `npm test` 96개·격리된 PostgreSQL/MinIO의 `npm run test:integration` 48개·`npm run build` 통과. 실제 Chrome `--expenses-only`에서 지출 생성/수정/삭제·확정/재오픈 직후 GET 0회, WebSocket invalidation 전달 뒤 상세 GET 1회를 확인했다. PATCH의 권한·부분 필드·ALL/SELECTED/CUSTOM·멱등 재생·동시 버전 충돌·단일 SQL 실패 원자성 및 이미 이전 버전을 읽은 확정/삭제/생성의 롤백을 검증했다.

지출 DELETE 개선 검증(2026-10-03): `npm test` 96개·격리된 PostgreSQL/MinIO의 `npm run test:integration` 50개·`npm run build` 통과. 실제 SQL 로그에서 BEGIN → AUTH → 통합 조회 → 락 → 단일 삭제 SQL → COMMIT의 6회, 권한/상태/버전 거절의 락 없는 4회, 성공 재생의 5회를 확인했다. 작성자/회차 생성자 권한·부담금/영수증 CASCADE·총금액/예상 송금 갱신·멱등 저장 실패 전체 롤백·락 전 조회 이후 PATCH/확정/동일 키 삭제 경합·커밋 후 MinIO 삭제·객체 삭제 실패 시 DB 성공 유지·알림 재발행 방지를 검증했다. 실제 Chrome `--expenses-only`에서 DELETE 직후 GET 0회, WebSocket invalidation 전달 뒤 상세 GET 1회를 확인했다. 기존 개발 서버의 Next 잠금 충돌은 임시 소스/의존성 복사본에서 전체 통합 테스트를 재실행하여 해소했다.

정산 확정 개선 검증(2026-10-04): `npm test` 96개·격리된 PostgreSQL/MinIO와 개발 서버 복사본의 `npm run test:integration` 54개·`npm run build` 통과. 확정은 AUTH → BEGIN → 회차/지출 통합 조회 → 공통 transaction lock → 확정 일괄 저장 → COMMIT의 6회이며, 지출 수정도 같은 advisory lock을 사용한다. 지출 다건·혼합 분배·권한·빈 지출·멱등 재생·실패 롤백·확정 중 추가/수정의 실제 잠금 대기를 검증했다.
