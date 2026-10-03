# 단일 책임·쿼리 개선 계획

작성 기준: 2026-10-02, 커밋 `8f973f5`의 전수조사 결과.

## 목표와 기준

- `Domain/Health`, `Domain/Group`, `Domain/Settle`, `Domain/User`와 `Global/Auth`, `Global/Util`, `Global/Websocket`을 기준으로 구현 경계를 분리한다.
- 생성·수정 등 서로 다른 명령의 진입 메서드를 구분하고, 공통 검증과 계산은 재사용한다.
- 동일 지출의 동시 수정이 기존 저장 내용을 자동으로 덮어쓰는 경로를 막는다.
- 확인된 중복 조회·행별 SQL 왕복·중복 화면 재조회를 줄인다.
- 권한, 금액 계산, 멱등성, 과거 기록 보존, 원자적 저장과 조회 스냅샷을 유지한다.

**같은 도메인의 CRUD는 한 파일에 함께 둘 수 있다.** 예를 들어 정산 생성·조회·수정·삭제는 하나의 정산 Service 파일과 하나의 정산 Repository 파일에서 각각 담당할 수 있다. 생성·수정·삭제·조회는 이름 있는 메서드로 구분하며, CRUD별 파일 분리는 필수 조건이 아니다. Controller·Service·Repository처럼 서로 다른 계층의 책임은 구분한다.

**트랜잭션 원자성을 위해 다른 테이블을 함께 조회·변경하는 것은 허용한다.** 회차 기록 시 회차·영수증 관계를 함께 저장하거나, 정산 시 부담금·잔액·송금을 함께 저장하거나, 탈퇴 시 회원·멤버십을 함께 변경하는 것은 각각 하나의 작업이다. 테이블 수를 책임 수로 판단하지 않고 같은 트랜잭션을 유지한다. 해당 작업과 관계없는 사용자 정보·계좌 등을 함께 변경하는 경우에 책임 혼재로 판단한다.

새 패키지·범용 Repository·서비스 인터페이스·DI 프레임워크는 필요하지 않다. 기존 함수, `pg`, React 훅과 공유 컴포넌트를 사용한다.

## 도메인 기반 아키텍처

파일 분리는 다음 디렉터리 구조를 따른다. `Settle`은 정산과 회차 관련 기능을 포함하는 하나의 도메인이다. 지출·부담자·영수증을 별도 최상위 도메인으로 분리하지 않는다.

```text
src/
├── Domain/
│   ├── Health/                 # 앱·DB·MinIO 등 헬스체크
│   │   ├── Controller/
│   │   ├── Service/
│   │   ├── Repository/
│   │   ├── DTO/
│   │   ├── DAO/
│   │   └── Exception/
│   ├── Group/                  # 모임·멤버십·초대
│   │   ├── Controller/
│   │   ├── Service/
│   │   ├── Repository/
│   │   ├── DTO/
│   │   ├── DAO/
│   │   └── Exception/
│   ├── Settle/                 # 회차·지출·부담자·영수증·정산
│   │   ├── Controller/
│   │   ├── Service/
│   │   ├── Repository/
│   │   ├── DTO/
│   │   ├── DAO/
│   │   └── Exception/
│   └── User/                   # 사용자 정보·가입·탈퇴·대표 계좌
│       ├── Controller/
│       ├── Service/
│       ├── Repository/
│       ├── DTO/
│       ├── DAO/
│       └── Exception/
└── Global/
    ├── Auth/                   # 카카오 인증·JWT 토큰·인증 검사
    ├── Util/                   # 공통 DB·트랜잭션·입력·페이지네이션 등
    │   └── MinIOUtil.ts         # MinIO 객체 저장·조회·삭제
    └── Websocket/              # 연결·재연결·이벤트·무효화 알림
```

계층별 책임:

| 계층 | 책임 |
|---|---|
| Controller | 요청·응답, DTO 입력 처리, Service 호출, HTTP 오류 변환 |
| Service | 도메인 규칙·권한·상태 전이·계산, 트랜잭션 범위 결정, 필요한 Repository·다른 도메인 협력 호출 |
| Repository | SQL과 영속 데이터 접근. Service에서 받은 동일한 DB Client 사용 |
| DTO | API 요청·응답 및 프론트가 사용하는 공개 데이터 계약 |
| DAO | DB 조회·저장 레코드의 타입과 컬럼 구조. SQL 실행은 Repository가 담당 |
| Exception | 해당 도메인의 오류 코드·오류 생성 및 변환 기준 |

DAO와 Repository를 동일한 SQL 접근 계층으로 중복 구현하지 않는다. 실제 역할이 있는 파일만 추가하며 빈 클래스·한 구현만 있는 인터페이스를 만들지 않는다. 공통 오류·DB·멱등 처리 같은 기반 기능은 `Global`에서 공유하고 도메인 전용 검증·계산은 해당 `Domain`에 둔다.

Next.js의 `src/app/**/page.tsx`, `layout.tsx`, `route.ts`는 프레임워크 진입점으로 유지한다. Route Handler는 해당 도메인의 Controller 또는 `Global/Auth`에 위임하며, 기존 공통 Route Handler는 요청 경로를 분배하는 역할로 축소한다.

### 현재 구현 기능의 수용 범위

현재 구현된 기능은 위 네 Domain과 세 Global 영역으로 모두 수용할 수 있다. 별도의 최상위 Account·Expense·Receipt 도메인은 필요하지 않다.

| 영역 | 현재 기능과 소유 책임 |
|---|---|
| Domain/Health | 앱 생존 확인, PostgreSQL·MinIO 상태 확인, 의존 서비스 종합 상태 응답 |
| Domain/Group | 모임 생성·목록·상세, 멤버십·정원·이탈, 초대 링크 생성·조회·폐기·수락 |
| Domain/Settle | 회차 생성·조회·취소·참여자 제외, 통화·금액·분배 계산, 지출 CRUD·부담자, 영수증 업로드·조회·삭제와 접근 권한, 확정·재오픈·전송·나머지 추첨, 개인별 보낼/받을 금액·송금 안내·수취 확인·일반/강제 종료, 과거 회차·정산 기록 |
| Domain/User | 내 정보, 가입 완료·재가입·탈퇴, 은행 목록·계좌 입력 검증·표시 형식, 대표 계좌 등록·변경, 허용된 수취인 계좌정보 제공 |
| Global/Auth | 카카오 인증, JWT 토큰·쿠키 발급·갱신·삭제, 로그아웃, 인증 검사·안전한 복귀 경로, 개발용 테스트 로그인 |
| Global/Util | DB 연결·트랜잭션·요청 중복 처리, 공통 HTTP·오류·입력·페이지네이션, 서버 전용 파일 변환·MinIO 객체 접근, 공통 UI·요청 훅, SQL 로그·HTTP/DB 지표 |
| Global/Websocket | 인증된 연결·연결 유지·재연결, 구독, 커밋 후 허용된 사용자에게 재조회 키 전달 |

정산 규칙·금액 계산은 Settle, 은행 규칙은 User가 소유한다. 양쪽 실행 환경에서 필요한 순수 함수는 해당 도메인의 Shared에 둘 수 있지만, Shared/DTO에 구현을 섞지 않는다. 영수증의 권한·메타데이터·저장 순서는 Settle이 결정하고, FileCompressor와 MinIOUtil은 전달받은 파일 변환·객체 작업만 수행한다. User의 가입·탈퇴가 멤버십을 함께 바꿀 때도 Auth·Group의 공개 기능을 같은 트랜잭션에서 호출한다.

홈·전체·랜딩과 페이지 이동은 `src/app`의 화면 구성으로 유지한다. 여러 도메인을 보여주는 화면은 공개 UI·DTO를 조합하고 도메인 내부 구현을 가져오지 않는다. API 문서도 각 도메인의 공개 계약을 조합한다. 마이그레이션·시드·배포·브라우저 검증은 기존 scripts·운영 설정에 유지하며 업무 도메인으로 만들지 않는다. 금융결제원 연동은 현재 중단된 과거 설계이므로 구현된 기능 목록에 포함하지 않는다.

### 프론트·백엔드와 도메인 캡슐화

위 트리는 도메인과 계층의 구성을 나타낸다. 실제 파일 경로는 각 Domain 안에서도 프론트·백엔드·공유 계약을 다음과 같이 분리한다. 한 파일에 프론트와 백엔드 코드를 섞지 않는다.

```text
Domain/<Health|Group|Settle|User>/
├── Frontend/
│   ├── UI/
│   └── Hooks/
├── Backend/
│   ├── Controller/
│   ├── Service/
│   ├── Repository/
│   ├── DAO/
│   └── Exception/
└── Shared/
    └── DTO/

Global/<Auth|Util|Websocket>/
├── Frontend/                    # 브라우저에서 사용하는 구현
├── Backend/                     # 서버에서 사용하는 구현
└── Shared/                      # 실행 환경과 무관한 계약·순수 기능

Global/Util/Backend/MinIOUtil.ts  # 서버 전용 파일 저장 유틸
```

- Frontend는 UI·브라우저 이벤트·HTTP 요청을 담당한다. Backend의 Controller·Service·Repository·DAO·Exception, DB 연결, 파일 변환기, MinIO SDK, 인증 비밀값을 직접 또는 간접 import하지 않는다.
- Backend는 프론트 컴포넌트·훅·DOM·브라우저 저장소를 import하지 않는다. 서버 전용 모듈에는 Next.js의 서버 전용 경계 검사를 적용한다.
- Shared/DTO에는 직렬화 가능한 요청·응답 계약과 공개 타입만 둔다. DB 컬럼 타입·비밀값·서버 구현·브라우저 부수 효과를 넣지 않는다. DAO는 Backend 내부에서만 사용한다.
- 다른 도메인의 Controller·Service·Repository·DAO·Exception 내부 파일을 직접 import하지 않는다. 다른 도메인의 기능이 필요하면 해당 도메인의 명시적인 공개 진입점과 공개 DTO만 사용한다. 공개 진입점은 Frontend·Backend·Shared별로 구분하고 하나의 barrel 파일에서 함께 export하지 않는다.
- 공개 진입점도 필요한 메서드와 DTO만 노출한다. Repository·DAO·내부 검증·내부 상태를 통째로 export하지 않는다. 공개 함수에 변경 가능한 내부 객체나 SQL 행을 그대로 반환하지 않는다.
- 각 Repository는 소유 도메인의 테이블만 처리한다. 다른 도메인의 조회·변경은 그 도메인의 공개 기능으로 요청하며, 다른 도메인의 SQL·권한·상태 규칙을 복사하지 않는다. 같은 트랜잭션이 필요한 협력은 동일한 Global 트랜잭션 컨텍스트를 전달한다.
- 테이블 소유권은 Group이 `groups`·`group_members`·`group_invites`, Settle이 회차·회차 참여자·지출·부담금·영수증 메타데이터·정산 잔액·송금, User가 `users`, Global/Auth가 JWT 검증·발급, Global/Util이 멱등 기록을 담당한다.
- 다른 도메인의 여러 사용자 정보를 읽어야 한다면 공개 일괄 조회를 사용하여 N+1을 만들지 않는다. DAO와 전체 계좌정보를 공개 계약으로 우회 노출하지 않는다.
- Group 화면이 Settle의 회차 생성 UI를 사용하는 경우도 Settle Frontend의 공개 진입점을 사용한다. 도메인 내부 컴포넌트를 직접 가져오지 않는다. 공통 셸·표시 UI는 Global/Util/Frontend, 공통 요청 훅은 Global/Util/Frontend, 도메인 계산은 소유 Domain 안에 둔다.
- 수정한 기능의 전체 import 경로를 검사하고 금지된 경계 import가 실패하는 자동 검사를 남긴다. 파일 이동·빌드 성공만으로 캡슐화 완료를 판단하지 않는다.

### DB 락 적용 정책

애플리케이션에서 명시적으로 추가하는 DB 락은 **회차 기록과 회차 기록 수정에만 적용한다.** 모든 쓰기에 `pg_advisory_xact_lock`을 붙이는 현재 전역 락은 제거 대상이다. 인메모리 mutex나 전역 애플리케이션 락으로 대체하지 않는다.

- 허용한 기록·수정 작업에서는 해당 회차 행의 DB 락을 획득하고 현재 상태·버전·회차 합계 한도를 같은 트랜잭션에서 확인한다. 관련 없는 회차를 함께 잠그지 않는다.
- 조회·헬스체크·모임·계좌·인증·탈퇴·정산 확정·전송·추첨·확인·종료 등 나머지 작업에는 별도의 `SELECT ... FOR UPDATE`나 advisory lock을 추가하지 않는다.
- DB 트랜잭션과 명시적 락은 구분한다. 락 대상이 아닌 작업도 여러 저장을 함께 성공·롤백해야 하면 트랜잭션을 사용한다. 일반 INSERT·UPDATE·DELETE·제약 검사에서 PostgreSQL이 내부적으로 획득하는 잠금까지 제거할 수 있다는 의미는 아니다.
- 지출 추가·수정(`saveExpense`의 생성·수정 경로)에 회차 행 락을 적용한다. 새 회차 생성은 아래 UUID v7 티켓 PK로 중복 생성을 거절하며 별도 명시적 락을 추가하지 않는다.
- 명시적 락을 쓰지 않는 작업도 상태·버전 조건부 UPDATE, 영향받은 행 수 확인, UNIQUE·FK·CHECK, 동일 트랜잭션의 저장·검증으로 기존 정합성을 유지한다. 일반 SELECT로 검사한 뒤 무조건 UPDATE하는 방식으로 바꾸지 않는다.
- 특히 한 번만 실행하는 추첨, 상태 전이 경합, 모임 정원, 탈퇴와 새 참여의 경합은 전역 락 제거 시 보호가 사라지는 부분이다. 각 기능의 조건부 갱신·제약·재검증 방식을 해당 기능 계획에 구체적으로 적고 경합 테스트로 검증한다. 필요성이 발견됐다고 락 허용 범위를 임의로 넓히지 않는다.
- 기존 README·정산 명세의 전역 락 설명과 관련 테스트는 해당 기능 구현 단계에서 새 정책에 맞춰 갱신한다. 문서에 적힌 계획을 이미 구현된 동작으로 표시하지 않는다.

### 새 회차 생성 티켓

새 회차 생성 요청은 UUID v7 티켓을 받고 이를 `rounds`의 PK로 사용한다. 프론트는 하나의 생성 의도에 하나의 티켓을 만들고 같은 요청을 다시 보낼 때 같은 티켓을 유지한다. 서버는 UUID v7 형식과 모임 참여 권한을 검증하고, 최종 중복 방지는 DB PK 제약으로 처리한다. 사전 SELECT만으로 중복을 방지하지 않는다.

같은 티켓으로 이미 성공한 요청은 성공 응답을 재반환하는 대신 중복 요청으로 거절한다. 기존 공통 멱등 처리의 성공 재반환 규칙과 다른 회차 생성 전용 정책이다. 중복 실패 시 참여자 등 부속 INSERT도 롤백한다. 회차 취소 후에도 사용한 티켓이 재사용되지 않도록 기존 요청 기록의 보존 방식을 함께 확인한다. 응답 유실 시 새 티켓으로 자동 생성하지 않으며, 기존 티켓에 해당하는 회차를 권한 있는 조회로 확인한다. 기존 회차 ID·외래키·과거 기록은 보존하고 DTO·OpenAPI·명세·중복 요청 검증을 이 기능 수정 단계에서 함께 갱신한다.

### 기능별 요청 흐름 설명과 사용자 쿼리 확인

**계획과 구현을 모두 문단 단위로 진행한다.** 단계 표는 전체 작업의 지도이며 한 번에 실행할 일괄 작업 목록이 아니다. 각 작업 전에 해당 기능의 실행 문단에 ID·대상·완료 조건을 붙이고, 문서 순서대로 한 문단씩 처리한다. 경계를 분리해야 하는 변경도 한 기능의 프론트 요청부터 백엔드 응답까지 이어지는 범위로 진행한다.

작업 절차:

1. 현재 기능의 계획 문단과 변경할 파일만 제시한다. 다음 기능의 코드를 미리 수정하지 않는다.
2. 현재 흐름과 수정할 흐름을 `프론트 요청 → API 경로 → Global/Auth → XXController(XXDTO) → XXService(XXDTO) → 번호를 붙인 DB·파일 처리 단계 → 응답 DTO → 프론트 반영` 형식으로 설명한다.
3. 한 문단의 코드를 수정하고 그 문단의 검증을 수행한다. 완료·진행 중·사용자 쿼리 확인 대기 상태를 구분한다.
4. 한 기능이 완료되면 실제 반영된 클래스·함수·DTO·테이블 이름으로 요청 흐름을 다시 설명하고, 재현 방법·예상 SQL 순서·트랜잭션·명시적 락 위치·변경 전후 쿼리 수를 제시한다.
5. 사용자가 실제 쿼리를 확인할 수 있도록 필요한 로컬 실행과 SQL 로그 확인 방법을 제공하고 **다음 기능으로 넘어가지 않고 기다린다.** 사용자가 계속 진행하라고 명시적으로 말한 뒤 다음 기능을 진행한다. 대기 시간이 지났다는 이유로 진행하지 않는다.
6. 사용자가 수정 사항을 주면 현재 기능에 먼저 반영하고 같은 흐름과 SQL 검증을 반복한다. 묶어서 승인받거나 전체 도메인을 한 번에 이동하지 않는다.

각 기능의 설명에는 읽는·쓰는 테이블, 트랜잭션 시작·커밋·롤백, 실제로 사용하는 명시적 락, 버전·멱등 검사 순서, 외부 파일 작업 위치, 실패 시 남는 상태와 재시도 방식이 포함돼야 한다. 개인정보 바인딩 값은 로그에 노출하지 않는다. 조회 API는 SELECT와 트랜잭션 필요성을 같은 형식으로 설명한다.

설명 예시의 이름은 구현 예정 이름이며 실제 수정 시 최종 코드의 이름으로 갱신한다. 현재 제품의 회차 생성·지출 저장·영수증 업로드는 별도 요청이므로 이를 하나의 요청으로 합친 것처럼 설명하지 않는다.

**새 회차 생성:** 프론트 회차 생성 폼에서 UUID v7 티켓 생성·유지 → `POST /api/groups/{groupId}/rounds` → 인증·출처·티켓 형식 검사 → `SettleController.createRound(CreateRoundRequestDTO)` → `SettleService.createRound(CreateRoundRequestDTO)` → ① DB 트랜잭션 시작 ② JWT 목적·회원 상태·사용한 티켓 확인 ③ Group의 공개 기능으로 현재 모임 참여 권한·후보 확인 ④ 티켓을 PK로 회차 INSERT, 참여자 스냅샷 INSERT ⑤ 성공 요청 기록 저장 ⑥ COMMIT → `CreateRoundResponseDTO` → 프론트 회차 화면 이동. 명시적 락은 추가하지 않으며 같은 티켓은 PK 제약으로 중복 거절·ROLLBACK한다. 기존 성공 요청도 재반환하지 않는다.

**지출 기록·수정:** 프론트 지출 폼 → 생성 POST 또는 수정 PATCH → 인증·출처 검사 → `SettleController.createExpense/updateExpense(ExpenseRequestDTO)` → `SettleService.createExpense/updateExpense(ExpenseRequestDTO)` → ① DB 트랜잭션 시작 ② JWT 목적·회원 상태·멱등 요청 검사 ③ 해당 회차의 DB 락 획득 ④ 상태·권한·expectedVersion·기존 지출·부담자·합계 한도 검사 ⑤ 지출 INSERT/UPDATE와 부담금 저장 ⑥ 회차 버전 조건부 갱신·성공 요청 기록 저장 ⑦ COMMIT → `ExpenseResponseDTO` → 프론트 최신 조회. 실패는 ROLLBACK하며 수정 충돌은 입력을 유지한다.

**영수증 업로드:** 지출 저장 완료 후 프론트 파일 업로드 → `POST /api/rounds/{roundId}/expenses/{expenseId}/receipts` → 인증·출처·파일 DTO 검사 → `SettleController.addReceipt(ReceiptRequestDTO)` → `SettleService.addReceipt(ReceiptRequestDTO)` → ① 현재 권한·상태·버전·기존 성공 요청 확인 ② 서버 전용 FileCompressor로 실제 포맷 확인·AVIF 변환 ③ Global의 `MinIOUtil.save()`로 객체 저장 및 Object Key 확보 ④ DB 쓰기 트랜잭션 시작 ⑤ 현재 권한·상태·버전·멱등 요청 재검사와 조건부 갱신 ⑥ `expense_receipts`에 Object Key·MIME·크기·해시 저장 ⑦ 성공 요청 기록·회차 버전 저장 ⑧ COMMIT → `ReceiptResponseDTO` → 프론트 영수증 목록 재조회. 이미지 변환과 MinIO 업로드를 긴 DB 트랜잭션 안에서 수행하지 않는다. DB 저장 실패 시 객체가 남을 수 있는 기존 정리 한계를 설명하고, 성공한 DB 기록이 없는데 업로드 완료로 응답하지 않는다.

영수증 단계에서는 별도 명시적 DB 락을 추가하지 않는다. 파일 처리와 DB 트랜잭션은 하나의 원자적 자원이 아니므로 Object Key 저장·실패·재시도 흐름을 구분해서 설명한다.

## 실행 순서

### Health-01: 헬스체크 도메인 분리

사용자 지정에 따라 헬스체크를 첫 기능으로 진행한다. 대상은 기존 `src/lib/health.ts`, 헬스체크 Route Handler·테스트, 테스트 실행 설정이다. 완료 조건은 기존 다섯 API의 응답·상태코드·캐시·검사 범위를 유지하면서 `Domain/Health/Backend`의 Controller·Service·Repository와 `Shared/DTO`로 분리하고 서버·도메인 import 경계를 검증하는 것이다. 후속 사용자 요청에 따라 DB 검사는 `SELECT 1` 한 번으로 판단한다. 기존 `lib/db-client.mjs`의 공용 연결 풀과 SQL 로그·모니터링 계측을 재사용하며 다른 도메인·공통 DB 전체를 함께 이동하지 않는다.

요청 흐름은 브라우저 또는 운영 상태 검사 GET → Node Proxy → JWT Guard(공개 GET/HEAD 허용, JWT 검사 생략) → `src/app/api/health/[[...check]]/route.ts` → Health Backend 공개 진입점의 `getHealthResponse()` → HealthController의 경로 검증·`HealthRequestDTO` 생성 → HealthService의 `checkHealth()` → ① live는 외부 검사 없이 성공 ② DB 대상이면 HealthRepository의 `checkDatabase()`가 공용 풀의 `query('SELECT 1')`을 한 번 실행하고 풀에 연결 반환 ③ MinIO 대상이면 HealthRepository의 `checkMinio()`로 읽기·쓰기 정족수 URL 병렬 호출 ④ 검사 결과를 `HealthResponseDTO`로 취합 → Controller의 HTTP 200/503·no-store 응답이다. 미등록 경로는 JWT가 없으면 Guard에서 401, 유효한 JWT가 있으면 Controller에서 의존 서비스 검사 없이 404다. 등록된 GET/HEAD는 Guard의 공개 허용을 통해 JWT·멱등·버전 검사를 생략하는 읽기 API이며 테이블·파일을 저장하지 않는다.

DB SQL은 기존 읽기 트랜잭션의 5회에서 `SELECT 1` 1회로 줄인다. 별도 `BEGIN`·`COMMIT`·`ROLLBACK`·`SET LOCAL statement_timeout`·`SET LOCAL lock_timeout`과 명시적 락을 사용하지 않는다. 공용 풀의 기존 연결 설정은 재사용하며 쿼리 실패는 상세정보 없이 `down`·503으로 응답한다. 저장 레코드가 없어 DAO 파일을 만들지 않고, 외부 예외 상세를 노출하지 않는 기존 상태 응답에 별도 Exception 클래스를 추가하지 않는다. Next.js의 `server-only` 경계 표식을 사용하고 Node 테스트에서만 `scripts/test-server-only.mjs`로 Next.js에 포함된 빈 서버 표식을 연결한다. 이 기능의 검증 후 사용자 SQL 확인 대기 상태로 멈춘다.

**Health-01 상태: SELECT 1 단독 실행 수정·검증 완료, 사용자 쿼리 확인 대기.** live·minio는 DB SQL 0회, database·dependencies·overall은 각 1회이며 MinIO 검사는 요청당 상태 URL 2회를 병렬 호출한다. 모니터링 메트릭 이름·라벨·헬스체크 HTTP 집계 제외 규칙은 유지하며 `da_moa_db_queries_total`은 DB 헬스체크당 5회 대신 1회 증가한다. 실제 SQL 로그와 모니터링 계측 이벤트가 각각 1회임을 통합 검증했다. `npm test` 73개·`npm run build`가 통과했다. 기존 개발 서버와의 잠금 충돌을 피하기 위해 동일한 수정 코드를 임시 작업 복사본에 담고, 격리된 `da_moa_health_test_20261002` DB·`da-moa-health-test-20261002` 버킷을 지정하여 `npm run test:integration` 37개도 모두 통과했다.

사용자 재현: 앱을 `DB_QUERY_LOG=true npm run dev`로 실행하고 `curl -i http://localhost:3000/api/health/database`를 호출해 `SELECT 1` 한 번과 HTTP 응답을 확인한다. `/api/health/live`, `/api/health/minio`, `/api/health/dependencies`, `/api/health`도 각각 호출해 검사 범위·응답을 확인한다. 별도 SQL 로그가 섞이면 DB 모니터링 또는 다른 요청의 로그인지 구분한다. 쿼리 확인 또는 수정 요청 전에는 다음 기능을 진행하지 않는다.

### Group-01: 구현된 모임·초대·참여 도메인 분리

대상은 `group-store.ts`, 공통 API의 모임·초대 분기, 모임 목록·상세·초대 수락 UI, 공개 타입과 직접 호출 테스트다. 모임 수정은 구현 범위에 없으므로 추가하지 않는다. 완료 조건은 기존 생성·목록·상세·생성자 닫기·일반 이탈·초대 발급/재발급·폐기·조회·수락을 Group Frontend/Backend/Shared로 분리하고 Controller·Service·Repository·DAO·Exception의 책임과 공개 import 경계를 검증하는 것이다. 회차 UI와 사용자/미종료 회차 조회는 필요한 공개 협력 함수만 추출하며 다른 도메인의 전체 이전은 진행하지 않는다.

현재 프론트 요청 → 공통 Route Handler → `group-store`의 인증·규칙·SQL → 응답 흐름을 프론트 공개 UI → 기존 API 경로 → Node Proxy → JWT Guard(Access JWT 검사) → GroupController → GroupService → ① 공통 트랜잭션 ② 현재 계정·멱등 검사 ③ GroupRepository와 User/Settle 공개 조회에 동일 Client 전달 ④ 기존 변경과 성공 기록 저장 ⑤ COMMIT → 공개 DTO → 프론트 반영으로 옮긴다. 모임 목록은 후속 개선으로 트랜잭션을 제거하며 나머지 조회는 기존 REPEATABLE READ 스냅샷을 유지한다. User 조회는 일괄화하여 회원 수에 따른 N+1을 만들지 않는다. 다른 도메인 테이블 JOIN 분리에 따라 추가되는 SQL 수는 검증 후 기록한다.

이번 작업은 구조 분리이며 기존 공통 advisory transaction lock·정원/탈퇴 경합 보호를 유지한다. 신규 명시적 락은 추가하지 않고 전역 락 제거는 7단계의 별도 정합성 변경으로 남긴다. 초대 토큰은 해시만 저장하고 재생 응답에서 링크를 제거하며, DELETE 전에 확보한 수신자에게 커밋 후 기존 재조회 키를 발행한다. 실패는 같은 트랜잭션 전체를 롤백하고 같은 키·본문 재시도를 유지한다. 기능 검증 후 실제 SQL 순서·호출 수·재현 방법을 기록하고 사용자 쿼리 확인 대기에서 멈춘다.

**Group-01 상태: 코드 분리·단위/통합/빌드·모바일 브라우저 검증 완료, 사용자 쿼리 확인 대기.**

반영된 공개 경계는 `Domain/Group/{Frontend,Backend,Shared}/index.ts`다. 기존 `group-store.ts`, `app/home/group-client.tsx`, `app/invites/invite-client.tsx`를 제거했다. 프론트의 `GroupsList`·`GroupClient`·`InviteClient`는 Group Frontend에 있으며, Group 화면의 `CreateRoundForm`·`RoundList`는 Settle Frontend 공개 컴포넌트를 사용한다. Group Backend는 GroupController의 `getGroupResponse()`·`isGroupPath()`, GroupService, GroupRepository, GroupDAO, GroupException으로 나눴다. `GroupSummary`·`GroupListItem`·`GroupDetail`·`InvitePreview`·`GroupMutationResult`와 입력 DTO는 Group Shared에 있다. 일반 이탈은 Service의 `leaveMembership()`, 생성자 닫기는 `closeGroup()`로 구분하며 기존 `leaveGroup()` DELETE 진입점이 역할을 선택한다.

User의 공개 `getActiveUserProfiles()`는 필요한 ID를 한 번에 조회하여 활성 회원의 ID·이름·프로필 이미지만 반환한다. 모임 상세는 요청된 단일 조회를 위해 Group Repository에서 `users`의 활성 상태·이름을 JOIN한다. 회원 변경은 수행하지 않으며 목록·초대의 프로필 조회는 User 공개 기능을 사용한다. Settle의 `hasUnfinishedGroupRounds()`·`hasUnfinishedGroupParticipation()`는 같은 Client로 미종료 여부만 반환하며 Group Repository에는 회차 SQL이 없다. `requireGroupMembership()`는 회차 생성 호출자가 필요한 모임 권한을 검사하고 공개 GroupSummary만 반환한다. Repository·DAO·내부 오류는 공개 진입점에서 내보내지 않는다. 공통 입력·페이지네이션·`domainMutation()`을 Global Util의 `input-validation-util.ts`·`pagenation-util.ts`·`idempotency-util.ts`로 나눴고, 초대 재생 응답의 링크 제거는 Group Service가 맡는다. Auth/Websocket Backend와 Util Frontend의 공개 진입점은 기존 lib·공통 UI 구현에 위임한다. 다른 도메인의 전체 이전은 이번 범위에 포함하지 않는다.

요청한 후속 세분화에서 기존 공개 진입점과 함수 본문을 유지하고 `domain.ts`를 제거했다. `nowSeconds`는 같은 계산을 하는 기존 `currentTimestamp()`의 공개 별칭을 재사용한다. 작업한 Health/Group API 목록·로직 흐름·바인딩 자리표시자를 유지한 SQL 원문은 [API 흐름·SQL 문서](refactored-api-flows-and-sql.md)에 별도로 기록한다. 후속 유틸 세분화 후에도 `npm test` 81개·`npm run build`·격리된 DB/MinIO의 `npm run test:integration` 38개가 통과했고 SQL 호출 수는 유지된다.

인증 순서 후속 변경: Node.js src/proxy.ts에서 Global Auth의 jwtGuard()를 모든 /api 요청에 먼저 적용한다. 기본은 Bearer Access JWT 검사이고 실패는 입력 검증·DB 접근 전에 401이다. 다섯 Health GET/HEAD와 로그인 시작은 공개하며 토큰 전달·갱신은 Refresh JWT, 로그아웃은 Refresh 또는 Access JWT를 요구한다. Access는 localStorage에 저장하는 10분 JWT이며 Refresh는 HttpOnly 쿠키다. 로그인·가입·갱신·로그아웃에서 DB 세션을 생성하거나 조회하지 않는다. AUTH는 users만 읽어 JWT 목적·가입·탈퇴 상태를 확인한다. 모임·회차 권한 검사는 유지한다. JWT 검증 자체에는 SQL이 없다. 상세 흐름은 [API 흐름과 SQL](refactored-api-flows-and-sql.md)에 기록한다.

실제 요청 흐름:

모든 Group HTTP 요청은 Node Proxy → JWT Guard(Access JWT 검증, SQL 0회) → Route Handler/Controller 순서로 들어온다. 표의 회원 상태 SELECT는 이후 Service의 AUTH(users 조회, SQL 1회)다. Public Health도 Guard에서 공개 경로·메서드를 확인한 후 Controller로 전달한다.

| 작업 | 프론트 → API → Node Proxy → JWT Guard(Access JWT 검사) → Controller/Service → 번호를 붙인 DB 처리 → DTO/프론트 |
|---|---|
| 모임 생성 | `GroupsList.create()` → POST `/api/groups` → Node Proxy → JWT Guard(Access JWT 검사) → `getGroupResponse()` → `createGroup(CreateGroupRequestDTO)` → ① 공용 풀 연결 확보 ② `requireAccount()`로 JWT 목적/회원 상태 확인 ③ UUIDv7 요청 키를 PK로 groups INSERT·생성자 group_members INSERT를 한 SQL로 저장 ④ 자동 커밋·연결 반환; 같은 PK는 409 → GroupMutationResult → 상세 이동. 명시적 트랜잭션·락 없음 |
| 모임 목록·검색 | `GroupsList`의 `useResource()` → GET `/api/groups` → Node Proxy → JWT Guard(Access JWT 검사) → Controller → `listGroups()` → ① 공용 풀 연결 확보 ② AUTH 회원 상태 SELECT ③ `findGroups()`에서 요청자 활성 멤버십 JOIN·ID 내림차순 커서·limit+1 선택·멤버 ID 집계를 한 SQL로 조회; 검색은 제목 ILIKE 조건 추가 ④ 실제 페이지의 멤버 ID를 Set으로 중복 제거 → User 공개 프로필 일괄 SELECT ⑤ 연결 반환 → `Page<GroupListItem>` → 목록/다음 커서 반영. 트랜잭션 없이 3회, 빈 결과는 ④ 생략해 2회 |
| 모임 상세 | `GroupClient`의 `useResource()` → GET `/api/groups/{id}` → Node Proxy → JWT Guard(Access JWT 검사) → Controller → `getGroup()` → ① 공용 풀 연결 확보 ② JWT 사용자 ID로 회원 상태 SELECT ③ `findGroupWithMembers()`에서 모임·활성 멤버십·users 이름을 JOIN한 뒤 반환 멤버 ID로 본인의 참여 여부 비교 ④ 생성자일 때만 유효 초대 SELECT ⑤ 연결 반환 → GroupDetail: 모임 정보·members·isCreator·invites → 멤버 요약·회차 후보 표시. 트랜잭션 없이 일반 멤버 2회·생성자 3회 |
| 초대 발급/재발급 | `GroupClient.inviteMembers()` → POST `/api/groups/{id}/invites` → Node Proxy → JWT Guard(Access JWT 검사) → Controller → `createInvite(CreateInviteRequestDTO)` → ① 쓰기 시작·설정·기존 락 ② JWT 목적/회원 상태 ③ 멱등 검사 ④ 생성자 권한 SELECT ⑤ 재발급이면 기존 초대 조건부 폐기 UPDATE·영향 행 확인 ⑥ token_hash만 group_invites INSERT ⑦ 링크 없는 성공 메타데이터 INSERT ⑧ COMMIT → 새 성공에서만 sharePath가 있는 GroupMutationResult → 링크 표시·모임 재조회. 성공 재생은 linkUnavailable=true |
| 초대 폐기 | `GroupClient.revoke()` → DELETE `/api/groups/{id}/invites/{inviteId}` → Node Proxy → JWT Guard(Access JWT 검사) → Controller → `revokeInvite()` → ① 쓰기 시작·설정·기존 락 ② JWT 목적/회원 상태 ③ 멱등 검사 ④ 생성자 권한 ⑤ 모임/초대 ID 조건 UPDATE·영향 행 확인 ⑥ 성공 기록 ⑦ COMMIT → GroupMutationResult → 초대 목록 재조회. 기존 참여자는 유지 |
| 초대 조회 | `InviteClient`의 `useResource()` → GET `/api/invites/{token}` → Node Proxy → JWT Guard(Access JWT 검사) → Controller → `getInvite()` → ① 읽기 스냅샷 시작·설정 ② JWT 목적/회원 상태 ③ 토큰 형식 검사 후 해시로 유효 초대·활성 생성자 멤버십·조회자의 참여 여부 SELECT ④ User 공개 조회로 생성자의 활성 회원 상태 확인 ⑤ COMMIT → InvitePreview → 직접 수락 버튼 또는 이미 참여한 모임 링크. 조회만으로 멤버십을 저장하지 않음 |
| 참여 수락 | `InviteClient.accept()` → POST `/api/invites/{token}/accept` → Node Proxy → JWT Guard(Access JWT 검사) → Controller → `acceptInvite()` → ① 쓰기 시작·설정·기존 락 ② JWT 목적/회원 상태 ③ tokenHash를 본문으로 멱등 검사 ④ 초대/생성자 검사(초대 SELECT·User SELECT) ⑤ 비멤버이면 활성 정원 COUNT ⑥ `joinGroup()` 멤버십 UPSERT ⑦ 성공 기록 ⑧ COMMIT → GroupMutationResult → 모임 상세 이동. 기존 멤버는 정원 COUNT 생략하며 재참여는 기존 이탈 행을 갱신; 기존 회차 구성은 바꾸지 않음 |
| 이탈/생성자 닫기 | `GroupClient.leave()` → DELETE `/api/groups/{id}` → Node Proxy → JWT Guard(Access JWT 검사) → Controller가 필요 시 변경 전 수신자 확보 → `leaveGroup()` → ① 쓰기 시작·설정·기존 락 ② JWT 목적/회원 상태 ③ 멱등 검사 ④ 활성 멤버십/역할 SELECT ⑤ Settle 공개 미종료 SELECT ⑥ 일반 이탈은 본인 left_at UPDATE; 생성자 닫기는 모든 초대 폐기·멤버십 이탈 UPDATE ⑦ 성공 기록 ⑧ COMMIT → GroupMutationResult → 목록 이동. groups·완료 rounds·과거 참여 기록은 삭제하지 않음 |

변경 요청의 동일 출처 검사는 Controller가 수행하고 JSON 입력은 기존 공통 제한을 사용한다. Group 작업에는 expectedVersion 검사가 없다. 모임 생성은 UUIDv7 요청 키의 PK 중복을 거절하고 다른 변경은 기존 Idempotency-Key·본문 일치 검사를 유지한다. 쓰기 성공 뒤 `after()`로 `publishGroupInvalidation()`을 호출한다. 삭제 전 수신자 캡처는 기존 별도 읽기 스냅샷이고 발행도 기존 공통 구현을 사용한다. 수신자·재조회 키만 전송하고 토큰·계좌·금액은 보내지 않는다. Group 작업 자체에는 외부 파일 I/O가 없다.

모임 생성은 사용자 요청에 따라 명시적 트랜잭션·SET LOCAL·전역 락 없이 실행한다. UUIDv7 Idempotency-Key를 모임 PK로 사용하고 AUTH 회원 조회 1회 + 모임·생성자 멤버십 CTE INSERT 1회, 총 2회다. 세션·멱등 기록을 조회하거나 저장하지 않는다. 같은 PK는 409 group_already_exists이며 성공 결과를 재생하지 않는다. PostgreSQL 단일 문장 원자성으로 생성 실패 시 모임·멤버십 모두 저장되지 않는다. 기존 PK 타입·과거 모임은 유지한다.

모임 생성 통합 검사는 SQL 2회, 명시적 트랜잭션·락·세션·멱등 SQL 미실행, 같은 키 동시 요청의 단일 생성·중복 거절 및 부분 저장 방지를 확인한다.

다른 쓰기 트랜잭션 부가 SQL은 BEGIN·SET LOCAL 2회·공통 advisory lock·COMMIT의 5회다. 모임 목록·상세를 제외한 읽기는 BEGIN REPEATABLE READ READ ONLY·SET LOCAL 2회·COMMIT의 4회다. 실패 시 COMMIT 대신 ROLLBACK하고 DB 변경과 성공 기록을 모두 되돌린다. 재발급 실패는 기존 초대 변경도 롤백한다. 네트워크/저장 응답 유실 시 같은 키·본문으로 재시도하며 초대 재생은 원문 링크를 반환하지 않으므로 기존 재발급 안내를 사용한다. 기존 초대 수락·탈퇴 경로의 쓰기 락은 유지하며 나머지 전역 락 제거와 조건부 정합성 전환은 별도 7단계다.

쿼리 수는 같은 정상 작업의 공통 트랜잭션 SQL을 포함하고, 실시간 알림·다음 화면 재조회는 제외한다. 이전 수는 변경 전 함수의 SQL 호출 순서 기준이며 변경 후 수는 `scripts/group.integration.test.ts`에서 실제 PostgreSQL SQL 로그를 수집해 검증했다. 모임 목록·검색은 별도 멤버십 SELECT와 읽기 트랜잭션을 제거해 3회/빈 결과 2회로 줄였다. 상세는 모임·활성 멤버십·회원 이름을 한 SQL로 JOIN하고 Service에서 참여 여부를 비교하여, 멤버 목록을 포함하면서 일반 멤버 2회·생성자 3회로 줄였다. 별도 멤버 API는 제거했다. 초대 조회·참여 수락은 도메인별 공개 조회로 분리하며 각 1회 늘었고, 조회 수는 회원 수와 무관하게 일정하다. 성능 개선 수치는 주장하지 않는다.

| 정상 작업 | 이전 → 현재 SQL 호출 수 |
|---|---|
| 모임 생성 / 같은 PK 중복(409) | 10 → 2 / 7(이전 재생) → 2 |
| 모임 목록·검색(비어 있지 않음) / 빈 목록 | 7 → 8 → 3 / 6 → 2 |
| 모임 상세(생성자 / 일반 멤버) | 8 → 9 → 3 / 7 → 8 → 2 |
| 초대 발급 / 재발급 / 폐기 | 10 → 10 / 11 → 11 / 10 → 10 |
| 초대 조회 | 6 → 7 |
| 초대 수락(비멤버 / 이미 멤버) | 11 → 12 / 10 → 11 |
| 일반 이탈 / 생성자 닫기 | 11 → 11 / 12 → 12 |

재현 방법: `DB_QUERY_LOG=true npm run dev`로 로컬 앱을 실행한다. 테스트 계정으로 모임 생성 → 목록/상세 조회 → 초대 발급 → 다른 계정으로 초대 조회/수락 → 초대 재발급/폐기 → 일반 멤버 이탈 → 생성자 닫기를 수행한다. 미종료 회차가 있는 모임의 이탈/닫기도 시도해 ROLLBACK과 기존 오류 코드를 확인한다. 브라우저 Network의 단일 API 요청 시각과 stdout의 SQL: 블록을 대조하고 화면 후속 GET·실시간 수신자 SELECT·모니터링 SQL은 별도 집계한다. 바인딩 값·토큰·계좌·연결 문자열은 로그에 출력하지 않는다.

검증 기록: `npm test` 81개·`npm run build`·격리된 `da_moa_group_test_20261002_1` DB와 `da-moa-group-test-20261002-1` 버킷의 `npm run test:integration` 38개가 통과했다. 경계 검사는 프론트/Shared의 Backend 접근·다른 도메인 내부 import·Group Repository의 다른 도메인 테이블 접근을 막는다. 브라우저 검사에서 변경 전부터 없는 과거 정산 기록 안내 문구를 찾던 검증을 현재 제목/검색/필터 순서 검사로, 계좌 화면의 접힌 입력 대기를 현재 계좌 수정 버튼 검사로 맞췄다. 모임 일반 이탈/생성자 닫기 UI 검사를 추가했다. 전체 `scripts/browser-check.mjs`가 모임 생성·초대 수락·회차 생성·지출·영수증·정산·기록 검색·재가입·이탈·닫기까지 통과했다. 브라우저 증빙은 `/tmp/da-moa-group-browser-artifacts/settlement.png`에 저장했다. 기존 3000번 개발 서버와 충돌하지 않도록 임시 코드 복사본·3087번 테스트 서버·별도 Chrome 프로필을 사용한다. 사용자 쿼리 확인 전에는 다음 기능을 수정하지 않는다.

각 단계 안에서 기능 하나의 실행 문단씩 처리하고 사용자 쿼리 확인을 받는다. 확인이 끝난 기능은 따로 검토할 수 있는 커밋 또는 PR로 나눈다. 책임을 옮기는 변경과 SQL·화면 동작을 바꾸는 변경을 같은 큰 diff에 섞지 않는다.

| 순서 | 변경 | 완료 기준 |
|---|---|---|
| 0 | 기준 동작·쿼리 수 확인 | 대표 작업의 SQL 호출과 정합성 검증 기준 확보 |
| 1 | 지출 수정 충돌 처리 | 먼저 저장된 동일 지출 변경을 자동으로 덮어쓰지 않음 |
| 2 | 중복 SQL 제거·일괄 저장 | 계좌 변경 1개 트랜잭션, 전송 재검증 중복 제거, 정산 저장 일괄화 |
| 3 | 백엔드 책임 분리 | Domain/Global 구조 적용, Controller·Service·Repository·DTO·DAO·Exception 책임 구분 |
| 4 | 프론트 책임 분리 | 도메인별 UI·Hooks 배치, 공통 UI에서 계좌·실시간 구현 분리 |
| 5 | 중복 GET·단일 조회 트랜잭션 개선 | 같은 이벤트의 중복 GET 제거, 단일 SQL에 불필요한 트랜잭션 제거 |
| 6 | 추가 지출 조회 경량화 | 더 보기에서 전체 회차 재계산 생략, 버전 일치 검사 유지 |
| 7 | 나머지 구조 개선·락 정책 전환 | 낮은 우선순위 책임 혼재 정리, 기록·수정만 명시적 DB 락 적용, 전역 락 제거 후 정합성 검증 |

## 0. 검증 기준 확보

대표 시나리오는 계좌 변경, 지출 생성·수정, 정산 확정, 나머지 없는 전송, 추첨, 회차 조회, 지출 더 보기, WebSocket 연결·재연결이다.

- SQL 호출 수에는 `BEGIN`, `SET LOCAL`, 잠금, `COMMIT`도 포함한다. 업무 SQL 수와 트랜잭션 부가 호출 수를 구분한다.
- 기존 가짜 연결 검사의 계좌 변경 정상 경로는 총 16회이며, 앞선 조회용 쓰기 트랜잭션이 7회다. 실제 테스트 DB에서도 변경 전·후를 같은 조건으로 비교한다.
- 정산은 지출 수 E, 최종 부담금 행 수 S, 회차 참여자 수 M, 송금 행 수 T를 기록한다. 현재 최종 결과 저장은 S+M+T회의 행별 SQL과 최종화 UPDATE를 실행한다.
- `DB_QUERY_LOG=true`는 테스트 환경에서만 조사 기간에 활성화한다. 로그에는 바인딩 값·계좌·인증정보를 추가하지 않는다.
- 실제 PostgreSQL 실행계획과 지연은 아직 측정하지 않았다. 상관 서브쿼리를 조회 N+1 또는 운영 병목으로 단정하지 않는다.

## 1. 동일 지출의 수정 충돌 방지

대상: `src/app/home/round-client.tsx`, `spec/정산기능-spec.md`, 관련 브라우저 검증.

현재는 `stale_round`가 발생하면 최신 회차의 버전만 가져와 캡처한 입력 전체를 다시 제출한다. A가 금액을 수정하고 B가 이전 금액을 가진 폼에서 설명만 바꾸면 B의 자동 재시도가 A의 금액 변경까지 덮어쓸 수 있다.

수정 정책:

- 새 지출 생성은 현재처럼 최신 회차 조회 후 1회 자동 재시도를 허용한다. 서버의 상태·참여자·합계 한도 검증을 다시 통과해야 한다.
- 기존 지출 수정은 버전 충돌 시 자동 저장을 멈춘다. 입력을 유지하고 최신 내역 확인과 명시적 재제출로 이어지게 한다.
- 최신 조회에 실패하거나 회차가 잠기거나 지출이 삭제됐다면 재제출 가능한 상태로 오인하지 않는다.
- 네트워크 오류로 성공 여부가 불명확한 재시도는 원래 멱등 키와 본문을 유지한다. 확정된 409 이후의 새 제출과 구분한다.

이 정책은 현재 명세의 ‘생성·수정 모두 자동 재시도’와 다르므로 해당 명세와 인수 기준을 함께 수정한다. 자동 병합이나 지출별 신규 버전 컬럼은 이 해결에 필요하지 않다.

검증:

- 두 편집자가 같은 지출을 열고 A가 금액을 저장한 후 B가 설명을 제출해도 A의 금액은 유지된다.
- 충돌 뒤 B의 입력이 남아 있고, 최신 내용을 확인한 후에만 다시 제출된다.
- 다른 지출 추가로 발생한 새 지출 생성의 충돌은 1회 재시도로 처리된다.
- 5xx·응답 유실의 같은 키 재시도는 중복 지출을 만들지 않는다.

## 2. 확실한 중복 SQL 제거와 일괄 저장

대상: `src/lib/auth-store.ts`, `src/lib/round-store.ts`.

### 계좌 변경

`updateBankAccount()`의 두 쓰기 트랜잭션을 하나로 합친다. 같은 트랜잭션에서 계정 확인 → 기존 성공 결과 조회 → 버전 검사 → 계좌 UPDATE → 성공 기록 저장 순서를 유지한다. HMAC 지문과 개인정보 보존 정책은 그대로 사용한다.

현재 전역 락을 유지한 단순 통합만 계산하면 16회에서 9회이며, 최종 정책에서는 계좌 변경의 명시적 락 호출도 제거하므로 같은 조건의 목표는 8회다. 각 기능을 실제로 수정한 시점의 트랜잭션 설정과 쿼리 수를 다시 확인한다. 기존 성공 요청 재조회, 다른 본문의 같은 키, 동시 계좌 변경, 탈퇴와의 경합도 검증한다.

### 정산 전송과 결과 저장

- 나머지 없는 전송에서 이미 얻은 검증 결과를 최종 계산에 넘겨 참여자·지출 재조회를 없앤다. 서로 다른 요청 사이의 캐시는 만들지 않는다.
- 최종 부담금 UPDATE, 개인 잔액 INSERT, 송금 INSERT를 각각 일괄 SQL로 바꾼다. 기존 `storeShares()`의 배열·`unnest` 방식부터 검토한다.
- 확정 시 지출별 기본 몫·나머지 UPDATE와 회차 생성 시 참여자 INSERT도 일괄화한다.
- 금액은 문자열·BigInt를 유지하며 배열 길이·행 대응을 정확히 맞춘다. 송금 0건 같은 빈 결과도 처리한다.
- 최종 부담금·잔액·송금·회차 상태·버전·멱등 기록은 계속 같은 트랜잭션에서 커밋한다.

완료 기준은 결과 행별 SQL 왕복이 사라지고, 저장 개수가 늘어도 해당 일괄 SQL의 호출 수가 일정한 것이다. 매우 큰 입력으로 분할이 필요하면 측정한 상한에 맞춰 나누되 원자적 저장은 유지한다.

### 작은 낭비 제거

- 조회한 지출이 없으면 부담자·영수증 SELECT를 생략한다.
- 페이지 존재 확인용 `limit + 1`번째 지출은 하위 데이터 조회 대상에서 제외한다.
- 지출 생성 시 기존 부담자 DELETE를 생략한다.
- 수정 전·후 부담자와 지정 부담금이 같으면 부담자 DELETE·INSERT를 생략한다. 분배 모드가 바뀌거나 부담 관계가 달라졌다면 기존 갱신을 수행한다.
- `settlementExpensesFor()`의 참여자 ID는 함께 읽은 부담금 행에서 만들고 동일 테이블을 읽는 상관 서브쿼리 하나를 줄인다.

## 3. 백엔드 책임 분리

파일 분리 작업은 위 `Domain`·`Global` 구조로 배치하는 것부터 시작한다. 함수 본문과 트랜잭션 경계를 먼저 그대로 옮긴 뒤 Controller·Service·Repository 책임을 구분한다. 새 분리 지점의 직접 호출만 바꾸고 SQL 최적화와 섞지 않는다.

| 현재 파일 | 배치와 책임 |
|---|---|
| `health.ts`, 헬스체크 Route Handler | `Domain/Health`에 검사 규칙·결과 DTO·오류 처리 배치. DB 검사 SQL은 Health Repository, MinIO 검사는 Global Util 사용 |
| `group-store.ts` | 모임·멤버십·초대의 규칙은 Group Service, SQL은 Group Repository, 입출력·DB 레코드·오류는 Group DTO·DAO·Exception에 배치 |
| `round-store.ts`, `split.ts` | 회차·지출·부담자·영수증·정산 규칙은 Settle Service, SQL은 Settle Repository, 입출력·DB 레코드·오류는 Settle DTO·DAO·Exception에 배치. 같은 도메인 CRUD는 같은 계층의 한 파일에 유지 가능 |
| `auth-store.ts`, `authorization.ts` | 가입·탈퇴·프로필·대표 계좌는 Domain/User, 로그인·JWT 발급·갱신·인증 검사는 Global/Auth에 배치. 사용자 정보의 DB 접근은 User 경계를 사용 |
| `auth.ts` | 카카오 인증·자체 JWT·쿠키·복귀 경로 처리는 Global/Auth에 배치. 필요에 따라 같은 디렉터리 안에서 파일 분리 |
| `receipt-storage.ts` | 객체 I/O는 Global/Util/Backend/MinIOUtil.ts로 이동. 영수증 권한·변환·DB 메타데이터·정리 순서는 Settle Backend의 Service·Repository가 담당 |
| `realtime.ts`, `realtime-server.ts`, `server.mjs`의 실시간 구현 | Global/Websocket에 배치. 도메인의 커밋 후 알림과 브라우저 재조회 연결 유지 |
| `db.ts`, `db-client.mjs`, `mutations.ts`와 공통 입력·페이지네이션 | Global/Util에 배치. DB 연결·트랜잭션·멱등 처리·공통 검증 재사용 |
| `domain-types.ts`, 도메인별 Route Handler 로직 | 공개 계약은 해당 Domain/DTO, HTTP 처리 로직은 Domain/Controller로 이동. src/app의 경로 진입점 유지 |

구체적인 메서드 정리:

- Settle Service의 `saveExpense()`는 `createExpense()`와 `updateExpense()` 진입 메서드를 둔다. 입력·부담금 검증은 공유하며 CRUD별 파일 생성은 요구하지 않는다.
- Settle Controller는 명령을 선택하고 Service의 확정·재오픈·전송·추첨·종료·취소 메서드를 호출한다. Service가 하나의 트랜잭션을 열고 여러 Repository 메서드에 같은 Client를 전달한다.
- Group Service의 일반 이탈과 생성자 닫기는 각각 메서드로 분리한다. 현재 DELETE API의 역할별 선택은 유지한다.
- 각 도메인 안에서 여러 메서드가 공유하는 접근·상태·버전 검사는 해당 Service에서 재사용한다. 도메인 전용 기능을 공통 Util에 넣지 않는다.
- User의 탈퇴와 가입 작업은 Group과 Global/Auth의 공개 기능에 같은 트랜잭션 컨텍스트를 전달하여 원자성을 유지한다. User 내부에 Group 테이블 SQL이나 Auth JWT 구현을 넣지 않는다.
- 같은 도메인·같은 계층의 파일 추가는 독립된 변경 이유가 있을 때 결정한다. 기존 계획의 `expense-store.ts`·`receipt-store.ts` 같은 기능별 파일 분리를 필수로 삼지 않는다.

완료 기준:

- Health·Group·Settle·User의 구현이 Domain 아래에 있고 인증·공통 유틸·실시간 처리가 Global 아래에 있다.
- 각 Domain·Global 내부에서 Frontend·Backend·Shared가 분리되고, 다른 도메인의 내부 구현 import 및 테이블 직접 접근이 없다.
- Controller에 SQL·도메인 계산이 없고, Repository에 HTTP 처리·업무 트랜잭션 시작이 없다.
- Settle이 입력·페이지네이션·트랜잭션 공통 기능을 얻기 위해 Group 구현을 import하지 않는다.
- 모임·지출 작업과 관계없는 사용자 프로필·계좌 등 다른 도메인의 데이터를 함께 변경하는 경로가 생기지 않는다.
- 관련 테이블을 함께 변경하는 도메인 작업은 같은 Client를 공유한다. 내부 함수의 중첩 트랜잭션은 없다.
- API 요청·응답, 권한, 오류 코드, 멱등 재생 결과와 SQL 결과가 이동 전과 같다.

## 4. 프론트 책임 분리

먼저 기존 JSX·상태·이벤트를 그대로 옮긴다. 컴포넌트 추출과 UI 재설계를 함께 하지 않는다.

| 현재 파일 | 책임 배치 |
|---|---|
| `home/ui.tsx` | 공통 표시 컴포넌트·AppShell·조회 훅은 Global/Util/Frontend, WebSocket Provider는 Global/Websocket/Frontend, 계좌 입력·설정과 계정 Context는 Domain/User/Frontend에 배치 |
| `home/home-client.tsx` | 홈·전체 메뉴는 여러 도메인의 공개 UI를 조합하는 화면으로 구성. 모임 목록·생성은 Domain/Group/Frontend, 정산 기록·공유 RoundList는 Domain/Settle/Frontend에 배치 |
| `home/round-client.tsx`, `settlements/settlement-client.tsx` | 회차·지출 폼·영수증·참여자 제외·정산 안내를 Domain/Settle/Frontend의 UI·Hooks에 배치. 관련 CRUD는 같은 파일에 유지 가능 |
| `home/group-client.tsx`, `invites/invite-client.tsx` | 모임·초대 관리 UI는 Domain/Group/Frontend에 배치. 회차 생성·회차 목록은 Domain/Settle/Frontend의 공개 컴포넌트를 조합 |
| `onboarding/onboarding-client.tsx` | 가입·계좌 입력은 Domain/User/Frontend에 배치. 브라우저 인증 요청 흐름은 Global/Auth/Frontend 사용 |

파일 이름과 props는 실제 공유 범위에 맞춘다. 한 번만 쓰는 짧은 표시 함수까지 별도 파일로 옮기지 않는다. 기존 평문 CSS·네이티브 폼·대화상자·포커스·한국어 용어를 유지한다.

완료 기준은 공통 UI 파일에 계좌 저장·탈퇴·WebSocket 연결 구현이 없어지고, 모임 상세가 공유 목록을 가져오기 위해 전체 홈 화면 모듈에 의존하지 않는 것이다.

## 5. 중복 GET과 단일 조회 트랜잭션 개선

### 실시간·화면 조회

- 한 묶음의 무효화 키에서 호출할 listener를 Set으로 모아 같은 조회 콜백을 한 번만 실행한다.
- 최초 연결 전 이미 확인된 계정을 다시 조회하는 경로를 줄인다. WebSocket 서버의 인증·주기적 재검증은 유지한다.
- 재연결 시 변경을 놓쳤을 수 있으므로 현재 화면은 다시 조회한다. 최초 연결과 재연결의 동작을 구분한다.
- 저장 직후 직접 조회와 해당 저장의 무효화 이벤트가 겹치는 경로를 확인한다. 진행 중인 조회에 무조건 이벤트를 버리지 않는다. 조회 스냅샷 이후 새 변경이 생기면 후속 조회가 필요하다.
- 검색어 입력의 실제 조회 값에 짧은 지연을 적용하고 이전 검색 조회를 취소한다. 상태 버튼·사용자의 새로고침은 즉시 반영한다.
- 정산 화면의 focus·pageshow·visibilitychange가 겹치는 재조회도 함께 확인한다.

검증은 최초 연결, 재연결, 같은 정산을 가리키는 두 키, 본인 저장, 다른 사용자 저장, 빠른 검색 입력을 포함한다. 중복 감소와 함께 최종 화면이 최신 서버 데이터를 반영하는지 확인한다.

### 단일 SELECT

대상은 `/api/me`, DB 상태 확인, 실시간 알림의 모임·계좌·탈퇴 대상 조회, 단일 조회인 `getAccount()`다.

- 공용 풀에서 단일 문장을 실행하는 최소 경로를 Global/Util의 기존 DB 코드에 마련한다. 각 Domain Repository는 해당 경로를 재사용한다.
- 문장·연결 제한 시간을 유지할 수 있도록 풀 설정과 기존 트랜잭션 설정을 함께 확인한다. 풀에 반환한 연결의 세션 설정이 다음 작업에 누출되지 않아야 한다.
- 회차 상세·정산·권한 확인 후 여러 데이터를 읽는 작업은 읽기 전용 `REPEATABLE READ`를 유지한다.
- 영수증 업로드 전 검사와 최종 쓰기 단계의 재검증도 유지한다. 그 사이 이미지 변환·외부 저장이 있으므로 계좌 변경의 중복 트랜잭션과 같은 이유로 제거할 수 없다.

완료 기준은 단일 SELECT에 스냅샷 목적의 BEGIN·COMMIT이 사라지고, 제한 시간·연결 반환·오류 처리가 유지되는 것이다.

## 6. 추가 지출 조회 경량화

대상: 회차 조회 저장소, `src/app/api/[...path]/route.ts`, `RoundClient.loadMore()`, `openapi.ts`.

- 지출 더 보기에는 지출 페이지·다음 커서·회차 버전만 반환하는 조회 경로를 추가한다. 기존 POST가 있는 `/api/rounds/{roundId}/expenses` 경로에 GET을 추가한다.
- 같은 읽기 스냅샷에서 회원 상태·회차 참여 권한·버전·지출 페이지를 확인한다.
- 전체 참여자 목록·총액·잔액·전체 예상 정산은 이 경로에서 재조회·재계산하지 않는다.
- 화면이 가진 회차 버전과 페이지 버전이 다르면 페이지를 합치지 않고 기존 최신 조회 흐름으로 처리한다.
- 기존 회차 상세 API와 과거 참여자의 조회 권한은 유지한다. 새 계약을 OpenAPI와 Route Handler 테스트에 반영한다.

완료 기준은 더 보기 요청이 전체 회차의 예상 정산을 실행하지 않으면서도, 변경된 회차의 서로 다른 버전 지출을 화면에 섞지 않는 것이다.

## 7. 나머지 구조 개선과 DB 락 정책 전환

낮은 우선순위의 구조 정리는 독립적인 변경으로 처리한다.

- 랜딩 페이지의 긴 애니메이션 제어는 전용 훅으로 이동하고 기존 단계 계산 함수를 재사용한다.
- `server.mjs`의 WebSocket·내부 발행 구현을 Global/Websocket으로 추출한다. 시작 설정과 실제 서버 연결은 진입 파일에 남긴다.
- `api-client.ts`의 특정 계좌 경로 폐기 함수는 Domain/User의 요청 모듈로 옮기고 Global의 공통 `discardPendingRequest()`를 재사용한다. 성공·로그아웃·페이지 이탈 때 민감한 재시도 본문을 지우는 동작을 유지한다.
- 공통 Route Handler는 도메인 Controller로 위임하는 경로 분배만 담당한다. 공통 스타일 파일과 API 문서는 각각 스타일·계약이라는 책임으로 유지한다.

전역 쓰기 락은 제거하고, 사용자가 허용한 회차 기록·수정에만 해당 회차의 명시적 DB 락을 적용한다. 각 기능을 옮길 때 새 정책에 필요한 조건부 갱신·제약·경합 검증을 먼저 구체화한다. 전체 도메인의 락을 공통 헬퍼에서 한 번에 없앤 뒤 결과를 추정하지 않는다.

해당 기능의 작업 문단은 기존 락 위치 → 허용되는 새 락 위치 또는 명시적 락 없음 → 대체 정합성 처리 → 예상 SQL → 경합 테스트 순서로 설명한다. 사용자 쿼리 확인이 끝난 뒤 다음 기능으로 진행한다. 잠금 대기·풀 대기·요청 지연 측정은 검증 근거로 남기되, 측정 결과만으로 다른 기능에 명시적 락을 추가하지 않는다.

## 검증과 완료 조건

각 애플리케이션 변경은 `npm test`, `npm run build`를 통과해야 한다. DB·트랜잭션·Route Handler 변경은 README의 격리 조건을 충족하는 명시적 로컬 `TEST_DATABASE_URL`로 `npm run test:integration`을 실행한다. 영수증 검증에는 분리된 MinIO 버킷을 사용한다. UI는 같은 테스트 DB·인증 비밀값을 사용하는 `scripts/browser-check.mjs`로 확인한다.

필수 회귀 검증:

- 같은 회차의 지출 추가·수정 ↔ 확정, 재오픈 ↔ 전송, 취소 ↔ 확정 경합.
- 같은 지출의 두 편집자 수정과 새 지출 생성의 1회 재시도.
- 회차 생성·초대 수락·로그인 ↔ 탈퇴 경합.
- 한도 직전 동시 추가·수정, 수정 시 기존 금액을 제외한 합계 검사.
- 같은 멱등 키의 동시 요청·커밋 응답 유실·다른 본문 충돌.
- 추첨 1회, 일괄 저장 중 실패의 전체 롤백, 부담금 합계·개인 잔액·송금 보존식.
- 수취 확인 ↔ 일반·강제 종료, 완료 기록의 읽기 전용 상태.
- 회차 상세·더 보기의 스냅샷과 버전 일치, 제외·이탈 후 과거 조회 권한.
- KRW 실제 수취인 최신 계좌만 공개, 다른 통화 계좌 비공개, 미확인 계좌 문구 유지.
- WebSocket 재연결 후 최신 조회, 두 키의 동일 listener 1회 실행, 검색·계좌 폼의 입력 유지와 포커스.
- 프론트→백엔드 또는 백엔드→프론트 구현 import 차단, 다른 도메인 내부 구현·DAO·Repository 접근 차단.
- 명시적 DB 락 호출이 허용한 회차 기록·수정 API에만 존재하는지 확인하고 나머지 기능의 전역 락 제거 후 정합성 검증.
- 각 기능의 실행 문단·실제 요청 흐름·SQL 확인 결과·사용자 확인 여부 기록. 사용자 확인 대기 중 다음 기능 수정 금지.

최종 리뷰에서는 파일 이동량보다 독립된 변경 이유가 분리됐는지 확인한다. SQL 호출 수는 같은 시나리오의 전·후 결과로 제시하고, 성능 개선 수치는 실제 측정한 경우에만 보고한다.

### 2026-10-02 DELETE 모임 조회 최적화

앞선 Group-01 이탈 경로의 별도 Settle 조회와 실시간 수신자 읽기 트랜잭션을 대체했다. GroupRepository.findGroupDeparture()가 권한·역할별 미종료 여부·멱등 성공 기록·변경 전 수신자를 한 SQL로 JOIN하고 leaveGroup()이 멤버십·초대·성공 기록을 한 CTE로 저장한다. 회차 데이터는 읽기만 하며 상태 변경은 Settle 구현에 남는다. AUTH를 락 전에 수행하고 기존 쓰기 트랜잭션과 락은 유지한다. 업무 SQL은 거절 2회·성공 3회, 풀 startup parameter로 제한을 적용하여 제어 SQL 포함 총 5회·6회다. 상세 SQL과 현재 흐름은 [G4](refactored-api-flows-and-sql.md#g4-delete-apigroupsgroupid--일반-이탈생성자-닫기)에 기록한다.

### 2026-10-02 풀 기본 타임아웃

공용 pg.Pool에 statement_timeout=15000·lock_timeout=10000을 지정했다. PostgreSQL 연결 시작 단계에서 적용하므로 앞선 트랜잭션당 SET LOCAL 두 문장은 제거하며 마이그레이션용 독립 연결은 기존 별도 제한을 유지한다. 쓰기 부가 SQL은 BEGIN·락·COMMIT의 3회, 읽기는 BEGIN·COMMIT의 2회다. 앱 서버 재시작 후 기존 풀도 새 기본값을 사용한다.


## User-01: 구현된 회원·계좌 도메인 분리

2026-10-03 후속 요청에 따라 기존 User API 4개와 회원 화면·은행 규칙을 분리했다. `auth-store.ts`를 제거하고 내 정보·가입/재가입·계좌 변경·탈퇴는 UserController/UserService/UserRepository/UserDAO/UserException과 공개 Shared DTO로 옮겼다. 로그인·JWT 발급은 Global/Auth의 AuthService에 두며, requireAccount()의 회원 SQL은 User 공개 조회에 위임한다.

계좌 입력·설정·온보딩·AccountProvider/useAccount는 User Frontend의 공개 진입점에서 제공한다. AppShell은 기존 내 정보 조회/이동 검사와 실시간 연결을 유지하며 User Provider를 조합한다. 탈퇴는 같은 Client로 Settle 공개 미종료 참여 조회·Group 공개 멤버십 종료·User 소프트 삭제를 수행한다. 기존 계좌 버전, 성공 멱등 재생, 가입 목적, 재가입 동의, 과거 기록, 쿠키와 커밋 후 알림을 유지한다. SQL 최적화·전역 락 정책 변경·Settle 전체 이전은 이번 범위가 아니다.

API 목록과 요청별 SQL 순서는 [분리한 API 흐름과 SQL](refactored-api-flows-and-sql.md#user)에 기록했다. User의 서버/클라이언트·공개 import 경계와 Controller/Service의 SQL 미보유를 자동 검사한다.

검증 결과(2026-10-03): `npm test` 91개, `npm run build`, 격리된 로컬 테스트 DB/MinIO의 DB 통합 38개와 실시간 통합 1개가 통과했다. 기존 개발 서버의 Next 실행 락 때문에 실시간 검사는 동일 소스의 임시 복사본에서 별도로 실행했다. 전체 모바일 브라우저 검사와 `--forms-only`도 통과하여 내 정보 단일 조회·수동 가입·계좌 저장/충돌 복구·탈퇴·재가입·로그아웃 및 320/390/1024px 폼을 확인했다. 기존 브라우저 검사의 후반 초대 수락도 현재 UI의 `모임으로 가기` 링크 선택 흐름에 맞췄다. 실제 카카오 외부 인증은 이번 검사 범위에 포함하지 않는다.


### User-02: GET /api/me 단일 AUTH 조회

후속 요청에 따라 getMe()의 withReadTransaction()을 기존 withDatabaseConnection()으로 교체했다. 공용 풀의 제한 시간·회원 상태/온보딩 목적 검사·Account DTO·private, no-store 응답을 유지하며 BEGIN·COMMIT·ROLLBACK·명시적 락·SET 없이 AUTH 내 정보 읽기 1회만 수행한다. 기존 정상 SQL 3회에서 1회로 감소하고, 연결은 성공·실패 모두 반환한다. User 쓰기와 다른 기존 조회의 트랜잭션은 유지한다.

검증: scripts/user.integration.test.ts가 app·가입 전·탈퇴 후 온보딩·완료 후 무효가 된 온보딩 JWT·탈퇴 회원 app JWT·존재하지 않는 회원의 GET /api/me를 실제 SQL 로그로 확인한다. 회원 조회 경로는 AUTH SELECT 1회이며 BEGIN·COMMIT·ROLLBACK·SET·명시적 락이 없고 연결을 모두 반환한다. JWT 누락은 SQL 0회다. 후속 단위 91개·격리 DB/MinIO 전체 통합 40개·프로덕션 빌드 통과.
