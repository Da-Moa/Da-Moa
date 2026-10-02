# 분리한 API 목록·로직 흐름·SQL

작성 기준: 2026-10-02의 현재 구현. Health 5개와 Group 8개 API를 기록한다. 모임 수정 API는 추가하지 않았다. 회차 생성·목록 UI는 Settle 공개 컴포넌트를 사용하지만, 해당 API의 백엔드 전체 분리는 아직 진행하지 않았으므로 아래 분리 완료 목록에 포함하지 않는다.

SQL은 해당 함수의 실제 query() 문자열을 가져와 PostgreSQL 형식으로 정리했다. $1 등의 바인딩 위치를 유지하며 실제 토큰·회원 정보·계좌·연결 문자열은 넣지 않는다. SQL 번호는 문서의 식별자이며 요청 순서는 API별 흐름에서 지정한다.

## 1. 구현 파일과 공통 유틸

| 책임 | 현재 파일/진입점 |
|---|---|
| Health HTTP·검사·SQL | [Health Backend](../src/Domain/Health/Backend/index.ts), Controller/HealthController.ts, Service/HealthService.ts, Repository/HealthRepository.ts |
| Group HTTP | [GroupController](../src/Domain/Group/Backend/Controller/GroupController.ts)의 getGroupResponse()·isGroupPath() |
| Group 업무 규칙 | [GroupService](../src/Domain/Group/Backend/Service/GroupService.ts) |
| Group SQL | [GroupRepository](../src/Domain/Group/Backend/Repository/GroupRepository.ts) |
| Group 공개 계약 | [Group Shared](../src/Domain/Group/Shared/index.ts)의 GroupSummary·GroupListItem·GroupDetail·InvitePreview·GroupMutationResult·입력 DTO |
| 입력 검증 | [input-validation-util.ts](../src/Global/Util/Backend/input-validation-util.ts)의 textInput()·onlyKeys()·idsInput() |
| 페이지네이션 | [pagenation-util.ts](../src/Global/Util/Backend/pagenation-util.ts)의 pagination()·pageOf() |
| 멱등 실행 | [idempotency-util.ts](../src/Global/Util/Backend/idempotency-util.ts)의 domainMutation()·Identity. 기존 lib/mutations.ts의 replayMutation()·saveMutation() 재사용 |
| 공개 공통 진입점 | [Global Util Backend](../src/Global/Util/Backend/index.ts). 기존 호출자의 import 경로와 함수 이름 유지 |
| 현재 시각 | nowSeconds는 기존 currentTimestamp()의 공개 별칭. 같은 초 단위 계산을 중복 구현하지 않음 |
| 인증 | [Node Proxy](../src/proxy.ts) → [JwtGuard](../src/Global/Auth/Backend/Guard/JwtGuard.ts). Controller 진입 전 JWT 검증. Service의 requireAccount()는 회원 상태 조회에 사용 |
| 협력 조회 | [User Backend](../src/Domain/User/Backend/index.ts)의 getActiveUserProfiles(), [Settle Backend](../src/Domain/Settle/Backend/index.ts)의 미종료 여부 조회. Service가 같은 DB Client 전달 |
| 실시간 | [Global Websocket Backend](../src/Global/Websocket/Backend/index.ts). 기존 captureGroupAudience()·publishGroupInvalidation() 구현에 위임 |

입력 검증은 문자열 trim·필수/최대 길이, 허용 필드, 중복 없는 참여자 ID를 검사한다. 모임 이름은 최대 100자, 재발급 초대 ID는 최대 128자다. idsInput()은 현재 회차 코드에서도 사용하는 공통 함수다. 페이지네이션은 기본 limit=20, 허용 범위 1~100이고 커서의 길이·시각·ID를 검증한다. pageOf()는 limit+1 조회 중 실제 페이지와 다음 위치 커서를 만든다. 모임 생성은 명시적 트랜잭션 없이 UUIDv7 PK의 모임·생성자 멤버십을 단일 SQL로 저장한다. 다른 쓰기는 domainMutation()에서 인증 → 키/본문 검사·성공 재생 → 업무 실행 → 성공 기록 저장을 같은 쓰기 트랜잭션에서 수행한다.

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
| GET /api/groups/{groupId} | getGroup() | 경로 모임 ID | GroupDetail | 현재 활성 모임 멤버 |
| DELETE /api/groups/{groupId} | leaveGroup() | 경로 모임 ID | GroupMutationResult: 모임 id | 일반 멤버 이탈 / 생성자 닫기 |
| POST /api/groups/{groupId}/invites | createInvite() | {} 또는 { replaceInviteId } | GroupMutationResult: 초대 id·inviteId·최초 sharePath | 활성 모임 생성자 |
| DELETE /api/groups/{groupId}/invites/{inviteId} | revokeInvite() | 경로 모임·초대 ID | GroupMutationResult: 초대 id | 활성 모임 생성자 |
| GET /api/invites/{token} | getInvite() | 경로 원문 토큰 | InvitePreview | 가입 완료 회원, 유효 초대 |
| POST /api/invites/{token}/accept | acceptInvite() | 경로 원문 토큰 | GroupMutationResult: 모임 id | 가입 완료 회원, 유효 초대, 정원 조건 |

GroupSummary는 모임 ID·이름·생성자 ID·생성 시각이다. 목록은 활성 회원 수와 최대 5명의 미리보기를 붙인다. 상세는 현재 멤버·생성자 여부·생성자에게만 유효 초대를 반환한다. InvitePreview는 모임 ID·이름·현재 참여 여부·만료 시각이다. Group API는 계좌나 내부 DB 행을 응답에 담지 않는다.

## 3. 공통 실행 순서와 SQL 식별자

### Node JWT Guard

모든 `/api/:path*` 요청은 Node.js에서 실행되는 `src/proxy.ts`를 거쳐 Global Auth의 `jwtGuard()`에 도달한다. 기본 정책은 Authorization: Bearer Access JWT의 서명·알고리즘·만료·issuer·audience·토큰 종류 검증이며 누락·실패는 본문/페이지네이션 검사나 DB 접근 전에 `401 unauthorized`, `private, no-store`로 끝난다. JWT 검증은 기존 함수를 재사용하며 SQL이 추가되지 않는다. Controller와 트랜잭션의 기존 검증도 유지한다.

공개 경로는 다섯 Health GET/HEAD, `GET /api/auth/kakao`, `POST /api/auth/test-login`이다. 로그인 시작은 첫 JWT 발급을 위한 예외이고 개발용 로그인은 기존 로컬·개발 환경 제한을 유지한다. `/auth/v1/kakao` 콜백은 API matcher 밖에서 기존 state·nonce·PKCE·OIDC 검증을 수행한다. `POST /api/auth/access-token`·`POST /api/auth/refresh`는 Access JWT 대신 Refresh JWT를 요구하고, 실패 시 기존처럼 두 인증 쿠키를 지운다. `POST /api/auth/logout`은 Refresh 또는 Access JWT를 요구한다. 문서·OpenAPI·미등록 API도 기본 인증 대상이다. 페이지·정적 파일은 API Guard 범위 밖이며 데이터는 인증된 API로만 조회한다.

**모든 API의 공통 진입 순서는 HTTP 요청 → Node Proxy → JWT Guard → Route Handler → Controller → Service다.** Public API도 Guard를 먼저 거치며 공개 경로·메서드 조건에 맞으면 JWT 검사만 생략한다. 따라서 G1뿐 아니라 G2~G8과 Health에도 Guard 단계가 적용된다.

JWT Guard는 JWT의 유효성을 검사하며 SQL은 0회다. 아래 SQL 순서의 AUTH는 Guard 이후 Service에서 실행하는 users 회원 상태 SELECT 1회로, JWT 검사나 세션 조회를 뜻하지 않는다.

SQL 기록과 아래 호출 수는 유효한 JWT가 Guard를 통과한 요청 기준이다. Service/Route Handler를 직접 호출하는 테스트는 Proxy를 거치지 않으므로 입력 검증 결과가 HTTP 요청의 인증 우선 결과와 다를 수 있다.

Access JWT는 localStorage에 저장하며 만료는 10분이다. 로그인 완료 시 Refresh JWT를 POST /api/auth/access-token으로 검증해 Access JWT를 받아 저장한다. Refresh는 HttpOnly 쿠키에 저장하고 서명·만료·종류·목적을 확인한다. 로그인·가입·갱신·로그아웃은 refresh_sessions를 읽거나 쓰지 않는다. sid는 JWT 발급 식별자일 뿐 DB 세션이 아니다. 갱신은 목적을 보존하며 onboarding의 원래 만료를 연장하지 않는다. 로그아웃은 클라이언트 Access 토큰과 Refresh 쿠키를 삭제하며 이전 JWT는 자체 만료까지 유효하다. 회원의 가입·탈퇴 상태와 리소스 권한 검사는 유지한다.

브라우저 공통 조회 흐름은 다음과 같다. `AppShell` 진입과 pathname 변경마다 `/api/me`를 한 번 조회하고 결과를 `AccountContext`로 공유한다. 200이면 그대로 사용한다. `/api/me`의 401·404는 `/api/auth/refresh`를 한 번 호출하고, 성공하면 갱신된 Bearer JWT로 원래 요청을 한 번만 재시도한다. 갱신 401은 토큰을 지우고 로그인으로 이동하며 503은 재시도 오류로 표시한다. 일반 모임·회차 API의 404는 갱신하지 않는다.

`apiRequest()`는 같은 URL·응답 종류·Access 토큰의 진행 중인 GET Promise만 공유한다. 완료·실패 후에는 지우므로 페이지 재방문, 검색, 다음 커서, 수동 갱신과 실시간 무효화는 최신 데이터를 조회한다. AbortSignal이 있는 요청과 변경 요청은 공유하지 않는다. 개발 모드 effect 재실행도 이 경로를 사용하므로 정상 모임 목록 진입의 브라우저 요청은 `/api/me` 1회 → `/api/groups` 1회다. 유지되는 layout에서 페이지를 이동하면 내 정보와 해당 페이지 자료를 각각 조회한다.

WebSocket 최초 연결은 이미 확인한 AccountContext와 저장된 JWT를 사용하며 연결 전후에 브라우저 `/api/me`나 화면 자료를 다시 조회하지 않는다. 재연결 시에는 내 정보를 갱신한 뒤 연결하고 화면의 구독 자료를 다시 읽는다. 서버의 WebSocket JWT·회원 상태 인증 및 주기적 검증용 내부 `/api/me` 요청은 유지하며 위 브라우저 요청 횟수에 포함하지 않는다. 계좌 화면도 처음에는 Context를 사용하고 저장·충돌 복구 시에만 명시적으로 재조회한다.

실제 Node 서버 통합 검사는 미인증 잘못된 JSON의 401 우선 차단, 변조·만료·토큰 종류 혼동, 공개 Health, Refresh-only 갱신·로그아웃 및 Bearer WebSocket 인증을 검증한다.

### 읽기 R — 모임 목록 제외

1. HTTP 요청 → Node Proxy → JWT Guard에서 Access JWT 검증 → Route Handler/Controller → Service 입력 검증.
2. 공용 pg 풀에서 연결 확보.
3. R-START: REPEATABLE READ READ ONLY 시작 → 문장/잠금 제한 설정.
4. AUTH: JWT 목적과 가입 완료 회원 상태 확인.
5. 해당 API의 권한·데이터 SQL 실행. 같은 스냅샷과 Client 사용.
6. TX-COMMIT → 연결 반환. 실패는 TX-ROLLBACK → 연결 반환; 롤백 실패 연결은 폐기.

읽기 트랜잭션 자체는 R-START의 3문장과 COMMIT 1문장으로 총 4회다. 도메인용 명시적 락은 없다.

### 쓰기 W — 모임 생성 제외

1. Node Proxy → JWT Guard가 Route Handler/Controller 진입 전에 Access JWT를 검증한다. 통과한 요청은 Controller에서 JWT를 다시 확인하고 동일 출처 검사. JSON을 읽는 API는 기존 1MiB 제한·객체 본문 검사.
2. 필요한 Service 입력 검증. 모임/초대 생성 입력은 트랜잭션 전에 검사.
3. 공용 pg 풀에서 연결 확보 → W-START: BEGIN → 제한 설정 → 기존 공통 advisory transaction lock.
4. AUTH: JWT 목적·가입 완료 회원 상태 확인.
5. replayMutation(): UUID 형식 Idempotency-Key 검사 → 정렬한 payload의 SHA-256 → IDEM-READ.
6. 동일 키·동일 payload의 기존 성공이면 업무 SQL 없이 저장된 결과 재생 → COMMIT. 다른 payload이면 idempotency_conflict·ROLLBACK.
7. 해당 API의 권한·상태 검사와 업무 SQL. 성공한 경우에만 IDEM-SAVE.
8. TX-COMMIT → 연결 반환 → Controller 응답. 실패는 전체 ROLLBACK.
9. 실시간 기능이 켜져 있으면 성공 응답 후 after()에서 모임 무효화 알림. 재생 성공도 현재 Controller에서 알림을 예약한다.

쓰기 트랜잭션 부가 SQL은 W-START 4문장과 COMMIT 1문장으로 총 5회다. 모임 생성은 이 경로를 사용하지 않는다. 다른 쓰기의 기존 전역 advisory lock을 회차 기록/수정에만 적용하도록 바꾸는 정책 전환은 별도 작업이다.

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

정상 목록·검색 SQL: **AUTH → G-LIST → U-PROFILES = 3회**. 빈 결과는 AUTH → G-LIST = 2회다. 별도 G-MEMBERS·BEGIN·COMMIT·ROLLBACK·SET LOCAL·명시적 락은 실행하지 않는다. 세 조회는 같은 연결에서 각기 실행하며 읽기 트랜잭션 스냅샷을 사용하지 않는다.

### G3. GET /api/groups/{groupId} — 상세

GroupClient.useResource() → GET /api/groups/{groupId} → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Group 분배 → GroupController → getGroup() → R 스냅샷 → GroupDetail → 현재 멤버·초대·회차 후보 표시.

1. R-START → AUTH → G-ACCESS: 현재 활성 멤버십 확인. 없으면 not_found·ROLLBACK.
2. G-MEMBERS(모임 ID 하나) → U-PROFILES → 멤버 DTO에 excludedAt=null 부여.
3. 조회자가 creator_id와 같으면 G-INVITES로 유효 초대 조회; 일반 멤버는 이 SQL을 생략하고 invites=[] 반환.
4. 모임 DTO·isCreator·멤버·초대 만료 시각을 구성 → TX-COMMIT.

생성자 SQL: R-START(3) → AUTH → G-ACCESS → G-MEMBERS → U-PROFILES → G-INVITES → TX-COMMIT = 9회. 일반 멤버는 8회. excludedAt은 회차 제외 상태를 읽은 값이 아니라 Group 멤버 DTO의 null이다.

### G4. DELETE /api/groups/{groupId} — 일반 이탈/생성자 닫기

GroupClient.leave()의 역할별 확인 창 → DELETE → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Group 분배 → GroupController가 실시간 활성화 시 변경 전 수신자 확보 → leaveGroup() → 역할별 규칙/SQL → GroupMutationResult → 모임 목록 이동.

1. 실시간 기능이 켜져 있으면 별도 읽기 트랜잭션으로 R-START → AUTH → RT-CAPTURE → COMMIT. 성공 변경 전 활성 멤버를 확보한다.
2. 업무 쓰기는 W-START → AUTH → IDEM-READ(operation=group.leave) → G-ACCESS.
3. 일반 멤버: leaveMembership() → S-UNFINISHED-MEMBER. 제외되지 않은 현재 참여 회차가 미종료이면 unfinished_rounds·ROLLBACK. 없으면 G-LEAVE로 본인 left_at 갱신.
4. 생성자: closeGroup() → S-UNFINISHED-GROUP. 모임의 미종료 회차가 있으면 unfinished_group_rounds·ROLLBACK. 없으면 G-CLOSE-1로 모든 초대 폐기, G-CLOSE-2로 모든 멤버십 이탈 처리.
5. IDEM-SAVE({ id: groupId }) → COMMIT → 변경 전 수신자까지 합쳐 RT-PUBLISH 알림.

일반 이탈의 업무 SQL: W-START(4) → AUTH → IDEM-READ → G-ACCESS → S-UNFINISHED-MEMBER → G-LEAVE → IDEM-SAVE → COMMIT = 11회. 생성자 닫기는 미종료 조회 뒤 UPDATE 2회로 12회. groups 행·완료 회차·과거 round_members는 삭제하지 않는다. 실시간의 선행 6회와 후행 5회는 위 업무 횟수에서 제외한다.

### G5. POST /api/groups/{groupId}/invites — 초대 발급/재발급

GroupClient.inviteMembers() → POST → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Group 분배 → GroupController의 JSON 입력 → createInvite(CreateInviteRequestDTO) → 업무 SQL → 새 링크 표시 또는 재발급 안내 → 모임 상세 재조회.

1. onlyKeys(['replaceInviteId']), 제공된 ID는 textInput(...,128)로 검사.
2. W-START → AUTH → IDEM-READ(operation=invite.create) → G-ACCESS. 현재 활성 생성자만 허용; 일반 멤버는 forbidden·ROLLBACK.
3. 새 초대 UUID·32바이트 랜덤 토큰·현재 시각 생성. 만료는 7일 뒤.
4. replaceInviteId가 있으면 G-REVOKE. 해당 모임/초대 ID로 영향 행이 없으면 not_found·ROLLBACK.
5. G-INSERT-INVITE에 원문 대신 SHA-256 토큰 해시 저장.
6. IDEM-SAVE에 { id, inviteId, linkUnavailable: true }만 저장 → COMMIT.
7. 실제 신규 실행이 성공한 요청에만 메모리의 토큰으로 sharePath=/invites/{token}을 응답. 성공 재생은 링크 없는 저장 결과를 그대로 반환.

신규 발급 SQL: W-START(4) → AUTH → IDEM-READ → G-ACCESS → G-INSERT-INVITE → IDEM-SAVE → COMMIT = 10회. 재발급은 G-REVOKE가 추가되어 11회. 새 초대/성공 기록 저장 실패 시 기존 초대 폐기도 롤백한다.

### G6. DELETE /api/groups/{groupId}/invites/{inviteId} — 초대 폐기

GroupClient.revoke() 확인 창 → DELETE → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Group 분배 → GroupController → revokeInvite() → GroupMutationResult → 초대 목록 재조회.

W-START → AUTH → IDEM-READ(operation=invite.revoke) → G-ACCESS의 생성자 검사 → G-REVOKE의 모임/초대 ID UPDATE·영향 행 확인 → IDEM-SAVE({ id: inviteId }) → COMMIT. 정상은 10회. 이미 폐기된 같은 초대는 COALESCE로 기존 폐기 시각을 유지한다. 초대가 없으면 not_found·ROLLBACK이며 이미 참여한 멤버십은 건드리지 않는다.

### G7. GET /api/invites/{token} — 초대 조회

InviteClient.useResource() → GET → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Group 분배 → GroupController → getInvite() → R 스냅샷 → InvitePreview → 직접 수락 버튼 또는 이미 참여한 모임 링크.

1. R-START → AUTH.
2. validInvite()가 원문 토큰의 43자 URL-safe 형식 검사. 잘못되면 not_found·ROLLBACK.
3. G-VALID-INVITE: 토큰 해시·미폐기·유효 기간·생성자의 활성 멤버십·조회자의 현재 참여 여부 조회.
4. 초대가 있으면 U-PROFILES(생성자 ID 하나)로 생성자의 미탈퇴·가입 완료 확인. 없으면 not_found·ROLLBACK.
5. groupId·groupName·isMember·expiresAt만 구성 → COMMIT.

정상 SQL: R-START(3) → AUTH → G-VALID-INVITE → U-PROFILES → COMMIT = 7회. GET은 group_members를 쓰지 않으며 기존 회차 참여를 만들지 않는다.

### G8. POST /api/invites/{token}/accept — 참여 수락

InviteClient.accept() → POST → Node Proxy → JWT Guard(Access JWT 검사) → API Route의 Group 분배 → GroupController → acceptInvite() → GroupMutationResult → 모임 상세 이동.

1. W-START → AUTH → IDEM-READ(operation=invite.accept, payload={ tokenHash }).
2. validInvite(): 토큰 형식 → G-VALID-INVITE → U-PROFILES로 현재 유효 초대/활성 생성자 검사.
3. 현재 멤버가 아니면 G-COUNT로 활성 정원 확인. 생성자 포함 10명 이상이면 group_member_limit_exceeded·ROLLBACK. 이미 멤버인 경우 COUNT 생략.
4. G-JOIN UPSERT: 신규 멤버십 생성; 이탈 행이 있으면 joined_at 갱신·left_at=NULL; 이미 활성인 경우 기존 joined_at 유지.
5. IDEM-SAVE({ id: groupId }) → COMMIT → 모임 알림 → 프론트 상세 이동.

신규/재참여 SQL: W-START(4) → AUTH → IDEM-READ → G-VALID-INVITE → U-PROFILES → G-COUNT → G-JOIN → IDEM-SAVE → COMMIT = 12회. 이미 멤버는 11회. round_members를 INSERT/UPDATE하지 않는다. 정원 직전 동시 수락·탈퇴와의 경합은 현재 기존 공통 쓰기 락을 사용한다.

### 성공 재생·실패·실시간의 별도 순서

모임 생성 중복은 AUTH → G-CREATE로 2회이며 PK 오류를 409로 반환한다. 다른 모임 쓰기 성공 재생은 W-START(4) → AUTH → IDEM-READ → COMMIT으로 7회다. 업무 SQL·IDEM-SAVE는 반복하지 않는다. 초대 발급 재생에서는 원문 링크를 반환하지 않는다. 본문/키 오류·권한/정원/상태 오류·DB 오류는 성공 기록을 남기지 않는다. 모임 생성 실패는 단일 SQL의 원자성, 다른 쓰기 실패는 기존 트랜잭션 ROLLBACK으로 부분 저장을 막는다. 응답 유실은 같은 키·같은 payload로 재시도한다. 외부 파일 작업은 Group API에 없다.

실시간이 켜져 있을 때 DELETE의 선행 수신자 캡처는 R-START(3) → AUTH → RT-CAPTURE → COMMIT으로 6회다. 정상 쓰기/성공 재생 응답 후 발행은 별도 읽기 트랜잭션 R-START(3) → RT-PUBLISH → COMMIT으로 5회다. 변경 전·현재 수신자를 합쳐 groups와 group:{id} 키만 내부 HTTP로 전달한다. 이 후행 발행은 저장 트랜잭션에 속하지 않으며 발행 실패가 커밋된 결과를 롤백하지 않는다. 실시간 환경 변수가 꺼져 있으면 두 경로는 SQL 없이 생략된다.

## 5. 실제 SQL 카탈로그

한 식별자 블록에 여러 문장이 있으면 표기한 순서대로 각각 query()로 호출한다. 바인딩 의미는 문서 설명이며 로그에 실제 값을 출력하라는 뜻이 아니다. 아래 공통 인증 쿼리는 기존 구현대로 계좌 컬럼도 읽지만, Group은 account.id만 사용하고 계좌를 응답 DTO나 실시간 메시지에 넣지 않는다.

### R-START — 읽기 트랜잭션 시작/설정

출처: [src/lib/db.ts](../src/lib/db.ts).

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

SET
  LOCAL statement_timeout = '15s';

SET
  LOCAL lock_timeout = '10s';
```

같은 조회의 인증·권한·하위 데이터에 같은 읽기 스냅샷을 사용한다.

### W-START — 쓰기 트랜잭션 시작/설정/현재 공통 락

출처: [src/lib/db.ts](../src/lib/db.ts).

```sql
BEGIN;

SET
  LOCAL statement_timeout = '15s';

SET
  LOCAL lock_timeout = '10s';

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

출처: [src/lib/authorization.ts](../src/lib/authorization.ts).

```sql
SELECT
  u.id, u.display_name, u.email, u.profile_image_url,
  u.bank_name, u.account_number, u.account_number_formatted,
  u.account_holder, u.bank_code, u.bank_verified_at, u.bank_version,
  u.deleted_at, u.onboarding_completed_at
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

### G-MEMBERS — 모임들의 활성 멤버십

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
SELECT
  m.group_id,
  m.user_id
FROM
  group_members m
  JOIN groups g ON g.id = m.group_id
WHERE
  m.group_id = ANY ($1::TEXT[])
  AND m.left_at IS NULL
ORDER BY
  m.group_id,
  CASE
    WHEN m.user_id = g.creator_id THEN 0
    ELSE 1
  END,
  m.user_id;
```

$1=상세 조회의 모임 ID 배열. 생성자를 먼저 정렬한다. 목록은 G-LIST 안에서 멤버 ID를 가져오므로 이 SQL을 호출하지 않는다.

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

### G-CLOSE-1 — 생성자 닫기 1

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
UPDATE group_invites
SET
  revoked_at = COALESCE(revoked_at, $2)
WHERE
  group_id = $1;
```

$1=groupId, $2=현재 초 시각. 두 SQL은 같은 트랜잭션에서 수행한다.

### G-CLOSE-2 — 생성자 닫기 2

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
UPDATE group_members
SET
  left_at = COALESCE(left_at, $2)
WHERE
  group_id = $1;
```

$1=groupId, $2=현재 초 시각. 두 SQL은 같은 트랜잭션에서 수행한다.

### G-LEAVE — 일반 멤버 이탈

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
UPDATE group_members
SET
  left_at = $3
WHERE
  group_id = $1
  AND user_id = $2
  AND left_at IS NULL;
```

$1=groupId, $2=본인 ID, $3=현재 초 시각.

### G-REVOKE — 초대 폐기/재발급 시 이전 초대 폐기

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
UPDATE group_invites
SET
  revoked_at = COALESCE(revoked_at, $3)
WHERE
  id = $1
  AND group_id = $2;
```

$1=inviteId, $2=groupId, $3=현재 초 시각. rowCount가 없으면 Service가 not_found를 반환한다.

### G-INSERT-INVITE — 초대 발급

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
INSERT INTO
  group_invites (
    id,
    group_id,
    created_by,
    token_hash,
    created_at,
    expires_at
  )
VALUES
  ($1, $2, $3, $4, $5, $6);
```

$1=새 초대 ID, $2=groupId, $3=생성자 ID, $4=원문 토큰의 SHA-256, $5=발급 초 시각, $6=발급+7일 초 시각.

### G-VALID-INVITE — 유효 초대/현재 참여 여부

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
SELECT
  i.id,
  i.group_id,
  i.expires_at,
  g.name,
  g.creator_id,
  EXISTS (
    SELECT
      1
    FROM
      group_members x
    WHERE
      x.group_id = g.id
      AND x.user_id = $3
      AND x.left_at IS NULL
  ) AS is_member
FROM
  group_invites i
  JOIN groups g ON g.id = i.group_id
  JOIN group_members m ON m.group_id = g.id
  AND m.user_id = g.creator_id
  AND m.left_at IS NULL
WHERE
  i.token_hash = $1
  AND i.revoked_at IS NULL
  AND i.expires_at > $2;
```

$1=토큰 SHA-256, $2=현재 초 시각, $3=조회자/수락자 ID. User 공개 조회를 뒤에 실행해 생성자의 회원 상태도 확인한다.

### G-COUNT — 활성 모임 정원

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
SELECT
  COUNT(*)::int AS count
FROM
  group_members
WHERE
  group_id = $1
  AND left_at IS NULL;
```

$1=groupId. 비멤버의 참여 수락에서만 실행한다.

### G-JOIN — 신규/기존 멤버십 참여

출처: [src/Domain/Group/Backend/Repository/GroupRepository.ts](../src/Domain/Group/Backend/Repository/GroupRepository.ts).

```sql
INSERT INTO
  group_members (group_id, user_id, joined_at)
VALUES
  ($1, $2, $3)
ON CONFLICT (group_id, user_id) DO UPDATE
SET
  joined_at = CASE
    WHEN group_members.left_at IS NOT NULL THEN EXCLUDED.joined_at
    ELSE group_members.joined_at
  END,
  left_at = NULL;
```

$1=groupId, $2=참여자 ID, $3=현재 초 시각. 과거 회차 참여 행은 변경하지 않는다.

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

### RT-CAPTURE — DELETE 전 활성 수신자 확보

출처: [src/lib/realtime-server.ts](../src/lib/realtime-server.ts).

```sql
SELECT
  member.user_id
FROM
  group_members viewer
  JOIN group_members member ON member.group_id = viewer.group_id
  AND member.left_at IS NULL
WHERE
  viewer.group_id = $1
  AND viewer.user_id = $2
  AND viewer.left_at IS NULL;
```

$1=groupId, $2=요청자 ID. 읽기 트랜잭션에서 AUTH 이후 호출한다.

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

트랜잭션 시작·설정·락·종료를 포함한다. 실시간 선행/후행 쿼리와 프론트 후속 GET은 별도로 센다. 아래 이전 수는 변경 전 코드의 호출 순서, 현재 수는 scripts/group.integration.test.ts의 실제 DB SQL 로그 검증 기준이다. 사용자 JOIN을 일괄 공개 조회로 분리해 일부 경로가 1회 증가했으며 성능 개선 수치를 뜻하지 않는다.

| Group 정상 작업 | 이전 | 현재 |
|---|---:|---:|
| 생성 | 10 | 2 |
| 목록·검색(비빈/빈) | 7 / 6 | 3 / 2 |
| 상세(생성자/일반 멤버) | 8 / 7 | 9 / 8 |
| 일반 이탈/생성자 닫기 | 11 / 12 | 11 / 12 |
| 초대 발급/재발급/폐기 | 10 / 11 / 10 | 10 / 11 / 10 |
| 초대 조회 | 6 | 7 |
| 참여 수락(비멤버/이미 멤버) | 11 / 10 | 12 / 11 |
| 생성 중복(409) / 다른 쓰기 성공 재생 | 7(이전 재생) / 7 | 2 / 7 |

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
