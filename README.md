# 다모아

카카오로 로그인한 모임 참여자들이 지출을 기록하고 회차별로 비용을 나누는 앱입니다. 회차를 만들 때마다 [50개 주요 여행 목적지의 41종 통화](spec/통화지원-spec.md) 중 하나를 선택하며, 회차 안에서 여러 결제자의 지출을 합산해 각자 보낼 금액과 받을 금액을 계산합니다.

## 실행

Node.js **22.18 이상**과 Docker가 필요합니다. 로컬 개발은 Docker PostgreSQL을 사용합니다. 앱과 실시간 연결은 같은 Node 서버에서 실행합니다. 영수증 업로드에는 MinIO가 필요합니다.

```bash
npm install
cp .env.example .env.local
```

`.env.local`에 아래 서버 환경 변수를 설정합니다. 비밀 값은 브라우저용 `NEXT_PUBLIC_` 변수로 옮기지 않습니다.

| 변수 | 값 |
|---|---|
| `KAKAO_REST_API_KEY` | 카카오 앱 REST API 키. OpenID Connect 활성화 필요 |
| `KAKAO_REDIRECT_URI` | 로컬에서는 `http://localhost:3000/auth/v1/kakao`. 카카오 콘솔에 같은 URI 등록 |
| `KAKAO_CLIENT_SECRET` | 카카오 콘솔에서 Client Secret을 사용하는 경우만 설정 |
| `AUTH_JWT_SECRET` | 32바이트 이상의 임의 비밀 문자열 |
| `DATABASE_URL` | 로컬은 `postgresql://da_moa:da_moa_local@127.0.0.1:55432/da_moa_dev`, OCI 앱 컨테이너는 Compose의 `postgres:5432` 연결 문자열 |
| `DB_QUERY_LOG` | `true`이면 모든 DB 쿼리를 줄바꿈·들여쓰기하여 출력. 기본값은 비활성화 |
| `MINIO_ENDPOINT` | MinIO S3 API 주소. 운영 앱 컨테이너는 `http://minio:9000` |
| `MINIO_BUCKET` | 비공개 영수증 버킷 이름 |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | 해당 버킷에 읽기·쓰기·삭제 권한이 있는 전용 사용자 키 |
| `NEXT_DEV_ALLOWED_ORIGINS` | 개발 서버 접근 허용 호스트를 쉼표로 구분. 미설정 시 기존 `192.168.219.141`, 빈 값이면 추가 허용 없음. 변경 후 개발 서버 재시작 |

```bash
npm run db:local:up
npm run db:migrate
npm run db:seed:test-accounts
npm run dev
```

`npm run db:local:up`은 PostgreSQL과 MinIO를 함께 실행하고 비공개 `da-moa-receipts-dev` 버킷을 생성합니다. MinIO API는 `http://127.0.0.1:9000`, 콘솔은 `http://127.0.0.1:9001`이며, 로컬 전용 로그인은 `da_moa_local` / `da_moa_minio_local`입니다. 로컬 MinIO는 [Community 소스 빌드 이미지](https://github.com/coollabsio/minio)를 고정 버전으로 사용합니다.

`npm run db:local:down`은 컨테이너만 중지하고 DB·영수증 데이터는 각각 `postgres-dev-data`·`minio-dev-data` Docker volume에 유지합니다. `da_moa_dev_test`를 담던 기존 `postgres-data` 볼륨은 보존하고 개발 DB는 별도 `postgres-dev-data` 볼륨에 생성합니다. `.env.local`은 Git 배포에 포함되지 않습니다.

이전 버전의 로컬 DB에 영수증 `content` 컬럼이 남아 있어도 `npm run db:migrate`로 기존 데이터를 보존하며 업그레이드할 수 있습니다. 기존 영수증은 계속 조회할 수 있고, 새 영수증은 MinIO에 저장합니다.

[http://localhost:3000](http://localhost:3000)에서 시작합니다. API 문서는 `/api/docs`, OpenAPI JSON은 `/api/openapi.json`에서 확인할 수 있습니다. [정산기능-intent.md](intent/정산기능-intent.md)는 정책 결정 기록, [정산기능-spec.md](spec/정산기능-spec.md)는 요구사항·상태·권한·인수 기준입니다. 금액 부호는 최신 명세를 따라 **부담액 − 결제액**, 양수는 보낼 돈·음수는 받을 돈입니다.

상태 확인 API는 인증 없이 사용할 수 있습니다. `/api/health/live`는 앱 응답만, `/api/health/database`는 PostgreSQL `SELECT 1`만, `/api/health/minio`는 MinIO 저장소의 읽기·쓰기 정족수만 확인합니다. `/api/health/dependencies`는 DB와 MinIO를 함께, `/api/health`는 앱과 두 의존 서비스를 종합해 반환합니다. 검사 실패 시 해당 API는 `503`과 검사 결과를 반환하며 응답을 캐시하지 않습니다. MinIO 검사는 실제 객체 작업이나 영수증 버킷·키 권한까지 검증하지 않습니다.

헬스체크 구현은 `src/Domain/Health/Backend`의 Controller·Service·Repository와 `src/Domain/Health/Shared/DTO`로 분리합니다. Next.js Route Handler는 Backend의 공개 진입점만 호출합니다. DB 검사는 공용 연결 풀에서 `SELECT 1`을 한 번 실행하며 별도 트랜잭션·명시적 락·`SET LOCAL`을 사용하지 않습니다.

모임 구현은 `src/Domain/Group`의 Frontend(목록·상세·초대 수락), Backend(Controller·Service·Repository·DAO·Exception), Shared(공개 DTO)로 분리합니다. 기존 생성·조회·닫기/이탈·초대 발급/폐기/수락 API를 유지하고 모임 수정 기능은 추가하지 않습니다. 회차 생성·목록 UI는 Settle Frontend 공개 진입점으로 조합하며, 회원 프로필·미종료 회차 조회도 User/Settle 공개 기능에 동일 DB Client를 전달합니다. 공통 입력·페이지네이션·멱등 실행은 Global Util의 `input-validation-util.ts`·`pagenation-util.ts`·`idempotency-util.ts`로 나눴고, Auth/Websocket과 공통 프론트 UI의 공개 진입점은 기존 구현을 사용합니다. 기존 공통 쓰기 락은 이번 구조 분리에서 유지합니다. 실제 요청 흐름·SQL 호출 수·검증 방법은 [Group-01 실행 기록](docs/srp-query-refactor-plan.md#group-01-구현된-모임초대참여-도메인-분리)에 기록합니다. API 목록·요청별 로직·실제 SQL은 [분리한 API 흐름과 SQL](docs/refactored-api-flows-and-sql.md)에서 확인합니다.

## 사용자 흐름

1. 카카오 로그인 후 전체 계좌번호를 입력하고 제안된 은행을 선택한 다음 예금주를 입력해 가입합니다. 선택 은행의 알려진 계좌번호 형식을 찾지 못하면 하이픈 없이 숫자로 저장합니다. 계좌 자동 연동·실명조회는 제공하지 않으며, 송금 전 계좌번호와 예금주를 직접 확인해야 합니다.
2. 모임을 만들고 초대 링크를 공유합니다. 초대받은 사람은 로그인한 뒤 참여를 직접 수락하며, 한 모임은 생성자를 포함해 최대 10명입니다.
3. 생성자가 본인 포함 최소 2명과 회차 통화를 골라 기록을 시작합니다. 같은 모임에서 서로 다른 통화의 회차를 동시에 진행할 수 있습니다. 생성한 회차의 통화는 변경할 수 없으며 과거 회차의 통화와 금액은 유지됩니다.
4. 참여자가 결제자 한 명과 금액을 입력하고 전체 참여자 균등 분배, 특정 사용자 균등 분배, 개별 항목 분배 중 선택합니다. 개별 항목 분배는 부담자와 각 부담금을 지정하며, 저장할 때 부담금 합계가 총 금액과 정확히 일치해야 합니다. 기록 단계에서 작성자 또는 회차 생성자가 수정·삭제할 수 있습니다.
5. 생성자가 정산을 확정합니다. 전송 전에는 생성자가 기록 단계로 다시 열 수 있습니다. 전송을 확인하면 원본이 잠기며, 나머지가 있으면 생성자가 ‘랜덤 돌리기’를 한 번 실행합니다.
6. 최종 안내에서 본인 금액과 필요한 수취 계좌를 확인하고 **링크만 복사**합니다. ‘전송’ 버튼이 외부 메시지를 보내거나 은행 이체를 실행하는 것은 아닙니다.
7. 생성자가 정산 종료를 표시합니다. 이는 입금 검증이 아니며, 종료한 회차는 모두에게 읽기 전용입니다.

결제자도 부담자로 선택되어 있으면 자신의 몫을 그대로 부담합니다. 결제자가 부담자가 아니면 다른 부담자들이 결제액을 나눕니다. 균등 분배의 나머지는 각 지출의 서로 다른 부담자에게 최소 단위 1씩 배분하며 저장된 결과를 다시 추첨하지 않습니다. 개별 항목 분배의 지정 부담금에는 나머지 추첨을 적용하지 않으며 재오픈·재확정해도 입력한 금액을 유지합니다. KRW·JPY·VND는 정수, 나머지 지원 통화는 소수점 이하 최대 2자리입니다. 통화 코드는 ISO 4217을 따르며 선정 근거와 50개 목적지 대응표는 [통화 지원 명세](spec/통화지원-spec.md)에 기록합니다. 입력·계산·저장·응답에 정확한 문자열과 BigInt를 사용합니다.

통화의 주 단위를 기준으로 지출 한 건은 100,000,000 이하, 한 회차의 전체 지출은 1,000,000,000 이하로 제한합니다. 수정할 때는 기존 금액을 제외한 회차 합계를 다시 계산합니다.

영수증은 지출 저장 후 별도로 업로드하는 **증빙 이미지**입니다. JPEG·PNG·WebP를 받으며 AVIF로 변환해 비공개 MinIO 버킷에 저장합니다. PostgreSQL에는 객체 키·형식·크기·해시만 남기고 인증된 API를 통해 AVIF로 응답합니다. 앱 자체 파일 크기 제한은 없으며 이미지 변환기의 픽셀 수 안전장치는 유지합니다. OCR·자동 금액 입력, 환불 기록, 복수 결제자, 환전, 실제 송금·입금 추적, 카카오 메시지 발송은 제공하지 않습니다.

## 이탈·탈퇴와 개인정보

- 회차 생성자는 제외할 수 없습니다. 제외 대상자가 결제자 겸 부담자이거나 특정 사용자 균등 분배·개별 항목 분배의 부담자이면 관련 내역을 표시하며 제외를 막습니다. 수정 후 다시 시도합니다. 허용된 제외는 해당 회차의 전체 균등 분배만 다시 계산하며 현재 모임 멤버십과 다음 회차 후보는 유지합니다.
- 이탈·회차 제외 후에도 본인이 참여한 회차를 조회할 수 있습니다. 이미 만들어진 다른 회차의 구성은 바뀌지 않으며 모임에서 이탈한 경우에만 다음 회차 후보에서 빠집니다.
- 참여 이력이 있는 회차가 하나라도 미종료이면 회원탈퇴를 막습니다. 가능한 탈퇴는 `deletedAt`을 설정하고 세션·활성 멤버십을 폐기하며 과거 기록을 보존합니다. 대표 계좌 교체에는 정산 제한을 적용하지 않습니다.
- 같은 검증된 카카오 계정으로 명시적으로 재가입하면 같은 내부 회원과 과거 조회 권한을 사용합니다. 이전 모임과 관리 권한은 자동 복구하지 않습니다. 재가입 시 같은 계좌번호여도 과거 확인 이력을 초기화합니다. 생성자가 탈퇴한 모임의 관리 복구·권한 이전 기능은 없습니다.
- KRW 개인 안내에는 **본인이 지급할 수취인의 최신 계좌만** 보입니다. KRW 이외 통화에는 상대방과 금액만 보입니다. 계좌 변경은 완료 회차의 원본 금액을 바꾸지 않으며 링크 재접속·새로고침으로 최신값을 조회합니다. 계좌번호 안내에는 **‘확인되지 않은 계좌입니다.’**와 송금 전 계좌번호·예금주를 직접 확인하라는 주의를 표시합니다.

## 저장·재시도

개인별 물리 정산 테이블을 만들지 않습니다. 회차의 분담·개인 잔액과 공통 `보내는 사람 → 받는 사람` 송금 행을 하나의 DB 트랜잭션으로 저장합니다. 변경 요청은 `Idempotency-Key`를 사용하고 회차 변경은 `expectedVersion`도 요구합니다. 응답이 유실되면 같은 키·본문으로 재시도하며 이미 성공한 작업을 다시 적용하지 않습니다. 지출 저장의 버전 충돌은 최신 회차를 자동 조회한 뒤 같은 입력으로 한 번 재저장합니다.

DB 연결은 `pg` 드라이버의 공용 커넥션 풀을 사용합니다. 같은 연결 문자열의 풀은 프로세스 내에서 재사용하며 최대 10개 연결, 연결·풀 대기 제한 10초, 유휴 연결 정리 30초를 적용합니다. 트랜잭션이 끝나면 연결을 반환하고 롤백에 실패한 연결은 폐기합니다. DB 용량 모니터링은 풀 포화 시에도 상태를 확인할 수 있도록 별도 연결을 사용하며, 마이그레이션·시드 스크립트도 작업 후 종료하는 개별 연결을 사용합니다.

쿼리 전수 조사는 `DB_QUERY_LOG=true npm run dev` 또는 운영 환경의 `DB_QUERY_LOG=true` 설정 후 앱 컨테이너 재생성으로 활성화합니다. stdout에 쿼리마다 `SQL:` 아래 SQL을 줄바꿈하고 들여쓰기하여 출력합니다. Hibernate의 `format_sql: true`처럼 `SELECT` 컬럼, `FROM`, `JOIN`, `WHERE` 등을 여러 줄로 표시하며, SQL의 `$1` 등은 그대로 남깁니다. 바인딩 값·결과 행·오류 메시지·DB 연결 문자열은 기록하지 않습니다. `BEGIN`·`SET LOCAL`·`COMMIT`·`ROLLBACK`, 모니터링, 마이그레이션·시드의 쿼리도 모두 기록합니다. 포매터가 처리하지 못하는 SQL은 원문을 출력하며 DB에는 항상 원래 SQL을 전달합니다. 이 로그는 공통 DB 연결 코드를 통한 `query()` 호출 기준이며 DB 내부 실행이나 다른 도구의 쿼리는 포함하지 않습니다. 전수 로그 출력 자체가 부하에 영향을 주므로 조사 후 비활성화합니다. 로그 파일은 `DB_QUERY_LOG=true npm run dev > /tmp/da-moa-db-query.log 2>&1`, 운영 로그는 `docker compose -f compose.production.yaml logs -f app`으로 확인할 수 있습니다.

초기 쓰기는 공통 PostgreSQL advisory transaction lock으로 직렬화합니다. 읽기는 별도 스냅샷을 사용합니다. 영수증 객체는 MinIO에 저장하고 DB는 객체 키를 관리합니다. 업로드 후 DB 저장이 실패하거나 DB 커밋 뒤 객체 삭제가 실패하면 참조되지 않은 객체가 남을 수 있으므로 저장소를 점검해야 합니다.

모임·회차·지출·정산·계좌 변경은 DB 커밋 후 이 Node 서버의 인증된 사용자별 WebSocket 연결로 재조회 키만 발행합니다. 브라우저는 이벤트를 받으면 기존 인증 API를 다시 읽습니다. 금액·계좌·영수증·초대 토큰은 메시지에 넣지 않으며, 연결이 끊기면 재연결 시 현재 화면을 다시 조회합니다. 실시간 연결이 일시 실패해도 저장 결과는 유지되고 수동 새로고침을 사용할 수 있습니다.

## 검증

### 계좌 등록

전체 계좌번호를 먼저 입력해 은행 후보를 확인하고 은행·예금주를 선택 또는 입력해 가입하거나 대표 계좌를 변경합니다. 계좌번호 원본과 은행별 표시 형식을 따로 저장하며 정산 안내에는 저장된 표시 형식을 사용합니다. 입력값은 자동으로 실명조회하지 않습니다. 정산 안내에서 계좌번호와 예금주를 확인한 뒤 송금합니다. 기존 `009-openbanking.sql`은 적용 이력과 기존 계좌 데이터 호환을 위해 마이그레이션 목록에 유지합니다.

### 로컬 자동 검증

```bash
npm test
npm run build
```

`npm test`는 `node --import tsx --test`로 금액·분배·인증·권한·API 계약을 검증합니다. DB 트랜잭션·롤백·동시 요청과 Route Handler 검증에는 **로컬 호스트에서 이름에 `test`가 포함된 별도 DB**를 먼저 만들고 `TEST_DATABASE_URL`로 지정합니다. 영수증 통합 테스트에는 개발·운영과 분리된 MinIO 버킷과 `MINIO_*` 환경 변수도 필요합니다. 테스트가 마이그레이션과 검증용 회원·모임·지출·영수증을 실제로 저장하므로 개발·운영 저장소를 사용하지 않습니다. 테스트 명령은 `.env.local`을 자동으로 읽지 않습니다.

```bash
export TEST_DATABASE_URL='postgresql://사용자:비밀번호@127.0.0.1:5432/da_moa_test'
npm run test:integration
```

실제 화면 검증은 [scripts/browser-check.mjs](scripts/browser-check.mjs)를 사용합니다. 실행 전 로컬 테스트 DB에 마이그레이션을 적용하고, 그 DB를 사용하는 앱 서버와 원격 디버깅을 켠 Chrome을 실행합니다. 앱 서버와 검증 스크립트의 `AUTH_JWT_SECRET`은 같은 테스트 전용 값이어야 합니다.

```bash
# 앱 서버용 터미널: TEST_DATABASE_URL과 AUTH_JWT_SECRET을 먼저 설정
export DATABASE_URL="$TEST_DATABASE_URL"
npm run db:migrate
npm run dev -- --port 3087

# Chrome 실행 인수: 별도의 테스트 프로필 사용
# --remote-debugging-port=9223 --user-data-dir=/tmp/da-moa-browser-check

# 다른 터미널: 같은 TEST_DATABASE_URL과 AUTH_JWT_SECRET을 설정한 뒤 실행
node --import tsx scripts/browser-check.mjs
```

`BROWSER_APP_ORIGIN` 기본값은 `http://localhost:3087`, `CHROME_DEBUG_ORIGIN`은 `http://127.0.0.1:9223`입니다. 스크립트는 테스트 DB에 기존 가입 완료 회원을 만들고 모바일 크기의 Chrome에서 초대·지출·증빙·제외·확정·추첨·최신 수취 계좌 표시·링크 복사·종료와 응답 유실 재시도를 검사합니다. 가입·재가입 화면은 계좌 직접 입력 폼을 검사합니다. 카카오 실제 인증은 별도로 확인해야 합니다. 결과 이미지는 시스템 임시 디렉터리의 `da-moa-browser-artifacts/settlement.png`에 저장하며 `BROWSER_ARTIFACT_DIR`로 위치를 지정할 수 있습니다.

카카오 로그인 자체는 서로 다른 실제 계정으로 초대·정산 링크에서 진입해 로그인 후 원래 화면으로 복귀하는지 별도로 확인합니다.

### 개발 테스트 계정

화면·DB 확인용 가입 완료 회원 5명은 로컬 개발 DB에 반복해서 시드할 수 있습니다.

```bash
npm run db:seed:test-accounts
```

원격 개발 DB에는 `DATABASE_URL`과 `ALLOW_REMOTE_TEST_ACCOUNT_SEED=true`를 함께 명시한 경우에만 시드할 수 있습니다. 운영 DB에는 이 플래그를 사용하지 않습니다.

시드는 `테스트 민지`, `테스트 준호`, `테스트 서연`, `테스트 지우`, `테스트 현우`와 서로 다른 테스트 계좌를 생성하고 목록을 출력합니다. 이 회원들은 `provider='test'`와 고정 `provider_subject`를 사용하므로 실제 카카오 로그인과 연결되지 않습니다. 개발 서버를 로컬 주소로 실행하면 `/login`에 다섯 계정의 로그인 버튼이 표시되고, 선택한 계정의 테스트 세션을 발급합니다. 운영 빌드에서는 버튼이 사라지고 `/api/auth/test-login`도 404를 반환합니다.

`첫 가입 온보딩 보기` 버튼은 별도 시드 없이 매번 새 테스트 계정과 가입 전 세션을 만들어 `/onboarding`을 엽니다. 계좌를 저장하면 실제 가입 완료 흐름도 확인할 수 있습니다. 기존 테스트 계정과 정산 기록은 변경하지 않습니다.

## 배포

Ubuntu arm64 오라클 인스턴스의 IP HTTPS, Docker Compose 앱·PostgreSQL·MinIO 설정과 GitHub Actions 배포 절차는 [OCI 배포 가이드](docs/oci-deploy.md)를 따릅니다. PostgreSQL과 MinIO 데이터는 `/db` 블록 볼륨의 `/db/postgres`와 `/db/minio`에 각각 저장하고, 배포 시 기존 저장소 컨테이너와 볼륨을 유지하면서 앱만 교체합니다. `main`에 반영하면 테스트·빌드가 통과한 커밋으로 앱 이미지를 서버에서 빌드하고, 빈 운영 DB에 스키마를 만든 뒤 컨테이너를 전환합니다. 개발·운영 DB와 MinIO 버킷은 분리합니다. 운영 API의 변경 요청과 WebSocket 연결은 `KAKAO_REDIRECT_URI`의 공개 주소에서 온 요청만 허용합니다. 같은 IP를 유지하면 기존 세션을 유지할 수 있도록 `AUTH_JWT_SECRET`도 유지하고, 공개 주소가 바뀌면 카카오 콘솔의 Redirect URI와 `KAKAO_REDIRECT_URI`를 함께 변경합니다.

운영 Compose는 앱·PostgreSQL·MinIO만 실행합니다. Grafana·Prometheus·Blackbox Exporter와 대시보드·경보는 별도 [Monitoring 저장소](https://github.com/Da-Moa/Monitoring)에서 E2 Micro에 배포합니다. A1에는 모니터링 컨테이너를 두지 않고 CPU·메모리는 OCI Compute 지표를 사용합니다. 앱의 P95/P99·RPS·HTTP 상태 코드·공통 API 예외·DB 쿼리 호출량·PostgreSQL 연결 사용/잔여 지표는 `127.0.0.1:9464/metrics`에서 제공하고, E2 `10.0.0.195`가 A1 `10.0.0.20:9465`의 전용 Nginx 경로로 수집합니다. 네트워크·환경변수·이전 순서는 Monitoring README를 따릅니다.

TLS가 적용된 Nginx `server` 블록 안에서 앱과 WebSocket을 같은 포트로 프록시합니다. Compose 앱의 3000번 포트는 호스트의 `127.0.0.1:3000`에만 게시합니다. 아래 위치 설정은 [OCI 배포 가이드](docs/oci-deploy.md)의 IP 인증서 설정에 추가합니다.

```nginx
location = /internal/realtime { return 404; }
location = /api/health { return 404; }
location = /api/health/ { return 404; }
location = /api/health/database { return 404; }
location = /api/health/database/ { return 404; }
location = /api/health/minio { return 404; }
location = /api/health/minio/ { return 404; }
location = /api/health/dependencies { return 404; }
location = /api/health/dependencies/ { return 404; }
location = /realtime {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 75s;
}
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Oracle 방화벽에서는 인증서 발급·갱신용 HTTP 80과 HTTPS 443만 공개하고 앱 포트 3000, DB 포트 5432, MinIO 포트 9000·9001은 공개하지 않습니다. 실시간 알림은 현재 단일 서버 인스턴스 안에서 전달하므로 앱을 한 인스턴스로 실행합니다. 여러 인스턴스로 확장할 때는 인스턴스 간 발행 경로를 추가해야 합니다.

첫 배포에서는 빈 운영 DB에 `001~015` 스키마 파일을 순서대로 적용합니다. 영수증 테이블은 처음부터 MinIO 객체 키를 저장합니다. 큰 증빙 이미지 업로드·조회는 배포 프록시의 요청·응답 크기 상한을 확인해야 합니다.
