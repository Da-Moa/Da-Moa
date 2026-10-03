# 분리한 API 목록·로직 흐름·SQL

작성 기준: 2026-10-03의 현재 구현. Health 5개, Group 8개, User 4개 API를 기록한다. 모임 수정 API는 추가하지 않았다. 회차 생성·목록 UI는 Settle 공개 컴포넌트를 사용하지만, 해당 API의 백엔드 전체 분리는 아직 진행하지 않았으므로 아래 분리 완료 목록에 포함하지 않는다.

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
| PUT /api/me/bank-account | getBankAccountResponse() → updateBankAccount() | BankAccountRequestDTO + Idempotency-Key | `{ data: { id, bankVersion } }` | 가입 완료 회원, 성공 재생을 버전 검사보다 먼저 처리 |
| POST /api/auth/withdraw | getWithdrawalResponse() → withdrawAccount() | 없음 | `{ ok: true }` + 인증·복귀·OIDC 쿠키 삭제 | 제외된 참여 이력까지 모든 미종료 회차가 없어야 함 |

은행 입력은 기존 수동 등록만 지원한다. 계좌 원본 숫자·표시 형식을 분리하며, 신규 가입/재가입은 확인 이력을 초기화한다. 계좌 변경은 같은 정규화 은행·번호·예금주일 때만 기존 확인 이력을 보존한다. 진행 중 정산이 있어도 대표 계좌 변경은 가능하다. 가입 완료·탈퇴에는 멱등 기록을 새로 추가하지 않았다.

카카오 콜백 `/auth/v1/kakao`와 테스트 로그인 `/api/auth/test-login`은 Global/Auth가 처리한다. 회원 upsert·테스트 회원 조회/생성만 User의 공개 기능으로 옮겼으므로 User API 목록에 포함하지 않는다. JWT 갱신·로그아웃도 Global/Auth 소유다.

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

$1=groupId. Service에서 모든 반환 행의 user_id를 JWT로 확인한 본인 ID와 비교한다. 없으면 not_found이며 초대 조회와 응답 구성을 수행하지 않는다. 계좌·이메일·인증 정보는 SELECT하지 않는다. G-ACCESS는 기존 변경 요청·회차 생성 권한 검사에 유지한다.

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

이 문서는 현재 코드의 요청/SQL 흐름 기록이며 실제 사용자 쿼리 확인 결과를 대신하지 않는다. 다음 도메인 작업은 [Group-01](srp-query-refactor-plan.md#group-01-구현된-모임초대참여-도메인-분리)의 사용자 쿼리 확인 후 진행한다.

JWT 인증 전환 검증 결과(2026-10-02): 단위 85개, 격리된 로컬 DB·MinIO 통합 38개, 프로덕션 빌드 및 전체 모바일 브라우저 회귀 검사 통과. 실제 로그인 완료 페이지의 localStorage/Bearer 전환과 로그아웃 토큰 삭제도 확인했다. 실제 카카오 외부 인증은 이번 자동 검사에 포함하지 않는다.

모임 목록 후속 변경: scripts/group.integration.test.ts에서 목록·검색 3회/빈 결과 2회, 트랜잭션 SQL 미실행, 생성 시각과 반대로 배치한 ID 커서, 멤버가 여러 명인 모임의 페이지 크기, 여러 모임이 공유하는 멤버의 프로필 일괄 조회, LIKE 특수문자의 문자 검색을 확인한다.

모임 목록 후속 검증 결과(2026-10-02): 단위 85개·격리 DB/MinIO 통합 38개·프로덕션 빌드 통과. 일반 목록·검색 3회, 빈 결과 2회와 ID 커서를 실제 SQL 로그로 검증했다.

## 7. User 요청 흐름·SQL

최초 User 분리는 기존 SQL·트랜잭션을 유지했다. 후속 개선으로 GET /api/me는 공용 풀 연결에서 AUTH 한 문장만 실행하고, POST /api/me/onboarding은 AUTH와 조건부 UPDATE만 실행한다. 두 API는 트랜잭션·명시적 락을 사용하지 않는다. 대표 계좌 변경·탈퇴의 기존 트랜잭션은 유지한다. 아래 수는 `BEGIN`·기존 advisory lock·`COMMIT`까지 포함하며, 응답 후 실시간 알림의 별도 조회는 제외한다.

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

AccountPanel.save() → PUT → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 User 위임 → UserController.getBankAccountResponse() → updateBankAccount() → 공용 풀의 두 쓰기 트랜잭션 → BankAccountResponseDTO → 입력 정리·최신 /api/me 재조회·폼 닫기.

1. Controller가 sameOrigin() 검사 → 최대 16,384바이트 JSON·Idempotency-Key 읽기. Service가 objectBody()·normalizeBankAccountInput()으로 수동 계좌 입력과 expectedBankVersion 검증·정규화. 입력 오류는 DB 접근 전에 거절한다.
2. 첫 W-START(2) → AUTH로 가입 완료·미탈퇴 회원 확인. 서버 비밀키로 경로·회원 ID·정규화 은행/번호/예금주·계좌 버전 등의 HMAC fingerprint 생성. replayMutation()이 UUID 요청 키를 검사하고 operation='bank-account.update'의 IDEM-READ 실행.
3. 같은 키·같은 fingerprint의 성공 기록이 있으면 TX-COMMIT 후 기존 `{ id, bankVersion }` 반환. 같은 키의 입력이 다르면 idempotency_conflict·TX-ROLLBACK. 성공 기록이 없으면 첫 트랜잭션을 COMMIT하고 fingerprint 유지.
4. 두 번째 W-START(2) → AUTH → IDEM-READ로 현재 회원 상태와 성공 기록 재확인. 다른 동시 요청이 같은 작업을 이미 저장했다면 버전 검사 전에 성공 재생. 성공 기록이 없을 때만 assertBankVersion()으로 expectedBankVersion 확인.
5. U-BANK-UPDATE: UserRepository.saveBankAccount()가 계좌 원본·표시 형식·은행·예금주·갱신 시각을 UPDATE하고 bank_version 증가. 기존 은행 코드·계좌번호·예금주가 정규화 입력과 같을 때만 확인 이력을 유지하며, 다르면 초기화한다.
6. IDEM-SAVE로 `{ id, bankVersion: expectedBankVersion + 1 }` 성공 메타데이터 저장 → TX-COMMIT. 계좌와 성공 기록은 같은 트랜잭션에서 저장하며 실패는 함께 ROLLBACK.
7. Controller가 `{ data: { id, bankVersion } }` 반환·after()로 publishBankInvalidation() 예약. 프론트의 최신 내 정보 재조회가 실패하면 재제출을 잠그고 다시 불러오기 안내를 표시한다.

정상 SQL: 첫 W-START(2) → AUTH → IDEM-READ → TX-COMMIT = 5회, 두 번째 W-START(2) → AUTH → IDEM-READ → U-BANK-UPDATE → IDEM-SAVE → TX-COMMIT = 7회, 합계 12회. 첫 조회의 성공 재생은 5회, 두 번째 조회의 성공 재생·버전 충돌은 합계 10회다. 입력 오류는 0회이며 진행 중 정산 조회·외부 계좌 확인은 없다. 응답 유실은 같은 키·같은 입력으로 재시도하며 성공 재생은 버전 검사보다 먼저 처리한다.

### U4. POST /api/auth/withdraw — 회원탈퇴

AccountPanel.withdraw()의 확인 대화상자 → POST → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 User 위임 → UserController.getWithdrawalResponse() → withdrawAccount() → 공용 풀 연결·쓰기 트랜잭션 → `{ ok: true }`·쿠키 삭제 → 클라이언트 Access 토큰·미완료 계좌 입력 정리·홈 이동.

1. Controller가 sameOrigin() 검사. Service가 W-START(2)로 BEGIN·기존 전역 advisory transaction lock 획득.
2. AUTH로 본인의 가입 완료·미탈퇴 상태 확인.
3. S-UNFINISHED-USER: 같은 Client로 Settle 공개 getUnfinishedUserRounds() 호출. round_members → rounds → groups JOIN으로 본인의 모든 미종료 참여 이력과 모임 이름 조회. excluded_at 조건을 두지 않아 회차에서 제외된 참여 이력도 포함한다. 행이 있으면 unfinished_rounds와 해당 회차 목록 반환·TX-ROLLBACK.
4. Group 공개 endUserMemberships()를 같은 Client로 호출. G-USER-GROUPS가 본인의 활성 group_members에서 모임 ID 조회 → G-USER-LEAVE가 활성 멤버십의 left_at UPDATE. 별도 트랜잭션은 열지 않는다.
5. U-WITHDRAW: UserRepository.softDeleteUser()가 users의 deleted_at·updated_at UPDATE. 계좌·회원 행·과거 회차/정산 기록은 삭제하지 않는다.
6. TX-COMMIT 후 Controller가 `{ ok: true }` 반환. Access/Refresh·복귀·OIDC 쿠키 삭제 및 after()의 publishDepartureInvalidation(groupIds) 예약. 공통 API 클라이언트와 AccountPanel이 클라이언트 토큰·미완료 계좌 입력을 정리한다.

정상 SQL: W-START(2) → AUTH → S-UNFINISHED-USER → G-USER-GROUPS → G-USER-LEAVE → U-WITHDRAW → TX-COMMIT = 8회. 미종료 회차 거절은 W-START(2) → AUTH → S-UNFINISHED-USER → TX-ROLLBACK = 5회다. 동일 Client의 멤버십 종료·회원 소프트 삭제는 함께 성공·롤백하며, 성공·실패 모두 연결을 반환한다. 멱등 기록·DB 세션 삭제·외부 계좌 해제는 없다.

User SQL의 실제 원문과 바인딩 순서는 [UserRepository](../src/Domain/User/Backend/Repository/UserRepository.ts)에 있다. `findUser()`는 회원 ID 한 개로 프로필·계좌·가입/탈퇴 상태를 조회하고 UserService가 숫자 시각/버전과 공개 DTO로 변환한다. `saveOnboarding()`은 기존 계좌 저장과 확인 초기화, `saveBankAccount()`는 동일 계좌 확인 보존과 버전 증가, `softDeleteUser()`는 deleted_at·updated_at만 갱신한다. 과거 정산과 계좌는 삭제하지 않는다.

UserService·Controller에는 SQL이 없다. 탈퇴 협력 함수는 호출자가 연 **동일 DB Client**를 사용하고 별도 트랜잭션을 열지 않으므로 멤버십 종료와 회원 탈퇴는 함께 성공·롤백한다. 미종료 회차 조회는 [Settle ParticipationRepository](../src/Domain/Settle/Backend/Repository/ParticipationRepository.ts), 모임 ID 조회와 멤버십 변경은 [GroupRepository](../src/Domain/Group/Backend/Repository/GroupRepository.ts)에 있다. 기존 미종료 회차의 모임 이름 JOIN은 유지한다.

가입/계좌 저장 성공 후 `publishBankInvalidation()`은 본인의 `me`와 해당 회원에게 지급할 송금자의 `settlements` 키를 발행한다. 탈퇴 성공 후 `publishDepartureInvalidation()`은 남은 모임 멤버의 목록·상세 키를 발행한다. 쿠키 처리·알림 예약은 Controller, 계좌 버전·멱등·재가입·탈퇴 판단은 Service, DB 행 타입은 내부 DAO, 오류 생성은 내부 Exception에 있다. 실시간 메시지에는 계좌·금액·토큰을 넣지 않는다.

User Frontend는 기존 화면·CSS·복사/클립보드·키보드 동작을 그대로 옮겼다. 계좌 폼 종료 시 User Requests가 공통 `discardPendingRequest()`로 민감한 재시도 본문을 지운다. 인증 실패로 로그인/가입 화면으로 이동할 때 공통 API 클라이언트는 모든 도메인의 미완료 본문과 이전 복구 콜백을 폐기한다.

Group의 기존 users JOIN과 아직 분리하지 않은 Settle/realtime의 회원·수취 계좌 JOIN은 그대로 유지한다. 이번 User 분리는 기존 User API·은행 규칙·화면·회원 저장의 소유권을 옮긴 작업이며, Settle 백엔드 전체 이전이나 락 정책 변경은 포함하지 않는다.

검증 결과(2026-10-03): `npm test` 91개, `npm run build`, 격리된 로컬 테스트 DB/MinIO의 DB 통합 38개와 실시간 통합 1개가 통과했다. 기존 개발 서버의 Next 실행 락 때문에 실시간 검사는 동일 소스의 임시 복사본에서 별도로 실행했다. 전체 모바일 브라우저 검사와 `--forms-only`도 통과하여 내 정보 단일 조회·수동 가입·계좌 저장/충돌 복구·탈퇴·재가입·로그아웃 및 320/390/1024px 폼을 확인했다. 기존 브라우저 검사의 후반 초대 수락도 현재 UI의 `모임으로 가기` 링크 선택 흐름에 맞췄다. 실제 카카오 외부 인증은 이번 검사 범위에 포함하지 않는다.
