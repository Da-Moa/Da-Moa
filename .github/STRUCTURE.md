# 프로젝트 구조

`domain_instruct.txt`에 따라 Next 프론트와 Nest 백엔드를 분리했습니다. 파일명은 camelCase를 사용하고 역할 접미사는 `group.controller.ts`처럼 점으로 구분합니다.

```text
src/
├── app/                     # Next 페이지·레이아웃 라우트
├── assets/                  # 프론트 이미지·글꼴
├── backend/
│   ├── main.ts             # Nest CLI 진입점
│   ├── domain/
│   │   ├── group/           # controller/service/repository/dao/code/exception/dto/module
│   │   ├── health/
│   │   ├── settle/
│   │   ├── user/
│   │   ├── app.module.ts
│   │   └── main.ts          # Nest 초기화·워커 시작
│   ├── global/
│   │   ├── apiPayload/     # 응답 DTO·전역 예외 필터·HTTP 스트림/쿠키
│   │   ├── auth/           # JWT Guard·카카오·토큰·쿠키
│   │   ├── database/       # PrismaService·계측 pg 풀
│   │   ├── monitoring/
│   │   ├── runtime/         # Nest HTTP·Next·WebSocket 연결 및 종료
│   │   ├── rateLimit/
│   │   ├── util/           # MinIO·입력 검증·멱등성·페이지네이션
│   │   └── websocket/      # 인증·업그레이드·토픽 전송
│   └── test/{unit,domain,integration,scenario,transport}/
├── frontend/
│   ├── domain/{group,settle,user}/
│   ├── global/{auth,util,websocket}/
│   ├── page/               # 랜딩·로그인·앱 셸 등 페이지 구현
│   └── test/{unit,integration}/
├── shared/                 # 프론트/백 공용 순수 함수·타입·상수
├── proxy.ts

```

`npm run dev`는 `nest start --watch`로 `src/backend/main.ts`를 빌드하고 실행합니다. Nest가 HTTP 서버를 시작하며 `global/runtime/bootstrap.ts`에서 Next 페이지와 WebSocket을 같은 포트에 연결합니다. API 및 `/auth/v1/kakao`는 Nest가 처리하고, Next `app`에는 API Route Handler가 없습니다. `@nestjs/swagger`가 `/docs`와 `/api/docs`의 Swagger UI를 제공하며, 실제 OpenAPI 문서는 JWT가 필요한 `/api/openapi.json`에서 조회합니다. `/api/docs`의 HTML 요청도 JWT 검증을 유지합니다.

백엔드 변경은 Nest CLI가 다시 빌드하고 프로세스를 재시작하며, 프론트 변경은 Next HMR이 처리합니다. 종료 시 WebSocket·요청 제한 타이머·메트릭 서버·영수증 워커·DB 연결을 닫습니다. `nest-cli.json`과 `webpack.config.cjs`가 백엔드 전용 SWC 변환 및 ESM 번들을 설정합니다. 데코레이터 메타데이터와 Prisma의 `import.meta`를 유지하며 Next가 생성한 JavaScript는 다시 변환하지 않습니다. `npm run build`는 Prisma 생성 → Nest 빌드 → Next 빌드 순서입니다. `npm start`는 운영 환경에서 `nest start`로 백엔드를 다시 빌드한 뒤 실행하며, Docker는 이미지 빌드 때 생성한 `dist/main.js`를 직접 실행합니다. 백엔드만 빌드하려면 `npm run build:backend`를 사용합니다. 포트는 `PORT=3087 npm run dev`처럼 환경 변수로 지정합니다.

Controller는 API마다 `@Get`, `@Post`, `@Patch`, `@Put`, `@Delete` 메서드를 정의합니다. Controller는 HTTP·쿠키·변경 알림, Service는 검증·권한·정산 규칙, Repository는 Prisma 모델 조회·수정 및 SQL을 담당합니다. 각 클래스는 `@Injectable()`과 생성자 주입을 사용하며 도메인 Module이 Service·Repository를 등록합니다. 참고 스타일은 `/Users/user/umc11th/Backend`입니다. DTO의 `req`는 API별 요청 클래스, `res`는 데이터 응답 타입을 정의합니다. 컨트롤러는 `@Body() body: XxxRequestDTO`, `@Query() query: XxxQueryDTO`, `@RequiredIdempotencyKey()`로 값을 받습니다. DTO에 `@ApiProperty`, `@IsString`, `@IsInt`, `@Min`, `@Max`, `@ValidateNested` 등을 선언합니다. 조회 숫자는 `@Type(() => Number)`로 변환하며 JSON 숫자·불리언에는 암묵적 변환을 사용하지 않습니다. 백엔드 전용 `tsconfig.backend.json`의 SWC 실행기·`emitDecoratorMetadata` 설정으로 DTO 타입 메타데이터를 생성하므로 개별 DTO 생성자를 컨트롤러에 전달하지 않습니다. `JwtGuard` → `OriginGuard` → `RequestBodyInterceptor` → 전역 `ValidationPipe` 순으로 처리합니다. 인증·Origin 검사 이후에만 크기를 제한해 JSON을 디코딩합니다. User는 16KiB, Group·Settle은 1MiB 제한을 유지합니다. `ValidationPipe`는 `transform`, `whitelist`, `forbidNonWhitelisted`를 사용해 DTO 인스턴스로 변환하고 알 수 없는 필드를 거부합니다. 생성 지출 DTO는 필수 필드, 수정 지출 DTO는 선택 필드를 구분합니다. 금액 문자열과 계좌번호의 선행 0을 유지합니다. DTO는 입력 형태를 검증하고 서비스는 계좌 정규화, 권한, 버전 충돌, 통화별 금액·정산 규칙을 검증합니다. 입력 오류는 기존 AppError 응답 형식과 도메인 오류 코드로 반환합니다. `code`는 enum과 code/message/detail 정의, Exception은 해당 정의로 AppError를 만듭니다.

시작 시 Swagger가 DTO에서 생성한 요청·조회 스키마를 OpenAPI 문서에 반영합니다. 인증·SQL 순서·응답 계약 설명은 기존 문서에 유지합니다.

JWT 인증은 `APP_GUARD`로 등록한 전역 `JwtGuard`가 Controller·Interceptor·DTO 검증 전에 처리합니다. 보호 API는 Bearer Access Token의 서명·만료·발급자·대상·토큰 종류를 검증하고, 성공한 claims를 `request.user`에 저장합니다. Controller는 `@CurrentUser() user: AuthenticatedUser`로 검증된 정보를 받아 Service에 전달하며 JWT를 다시 디코딩하거나 검증하지 않습니다. 갱신·Access Token 발급 API는 전역 Guard에서 검증한 Refresh Cookie 정보를 사용합니다. 인증 실패는 요청 본문 디코딩과 Service·DB 호출 전에 401로 종료합니다. 로그인·콜백·헬스체크의 공개 경로와 갱신 실패 시 인증 쿠키 삭제 정책을 유지합니다. 탈퇴·온보딩 상태와 그룹·회차 접근 권한은 기존 Service에서 DB 조회로 확인하므로 SQL 순서와 쿼리 수를 유지합니다.

Group·Settle·User 및 인증 토큰·로그아웃 컨트롤러는 일반 객체를 반환합니다. 전역 `ApiResponseInterceptor`가 `ApiResponseDto`를 사용해 `{ data, meta: { code, message, detail } }`로 한 번 감쌉니다. `@ApiSuccess`가 도메인 성공 메타데이터를 지정하며 컨트롤러는 직접 JSON을 직렬화하지 않습니다. 공통 예외 응답은 `{ code, message, detail, error, details? }`이며 기존 클라이언트의 `data`, `error`, `details` 접근을 유지합니다. 인증 리다이렉트, 헬스체크의 `{ status, checks }`, 영수증 바이너리, OpenAPI JSON은 각 프로토콜의 기존 형식을 유지합니다. 영수증 업로드는 multipart 스트림이므로 JSON 파이프를 사용하지 않고, 기존 계정 검증 이후에 제한된 크기로 파일과 버전을 읽습니다. 쿠키를 변경하는 JSON 메서드는 `@Res({ passthrough: true })`로 헤더만 설정하고 일반 객체를 반환합니다.

`prisma/schema.prisma`가 PostgreSQL 모델을 정의하고 `npm run db:generate`가 `src/backend/generated/prisma`에 클라이언트를 생성합니다. `npm ci`와 빌드에서도 생성합니다. DAO는 복합 SQL 결과 타입을 정의합니다. 기존 CHECK·지연 외래키·부분 인덱스는 `scripts/migrations` SQL로 유지하며 Prisma 자동 스키마 변경은 실행하지 않습니다.

User 조회·온보딩 수정, 그룹 초대 조회, 실시간 사용자 상태는 Prisma 모델 API를 사용합니다. 정산·멱등성·그룹 생성의 원자적 CTE는 Prisma raw query에서 바인딩으로 실행합니다. 풀은 기존 pg 계측을 공유합니다. 읽기 트랜잭션은 Prisma의 RepeatableRead와 READ ONLY 설정을 사용합니다. 세션 lock/unlock은 Prisma 쓰기 트랜잭션과 `pg_advisory_xact_lock`으로 대체하여 오류 시 자동으로 해제됩니다. 이 변경에 따라 해당 API는 BEGIN/COMMIT 쿼리가 추가됩니다. 헬스체크는 Prisma에서 `SELECT 1` 한 번만 실행하며 트랜잭션·잠금을 사용하지 않습니다.

컨트롤러에는 `key`, `read`, `mutate` 헬퍼를 두지 않습니다. 각 API 메서드가 Service를 직접 호출하고, 멱등성 키는 `@RequiredIdempotencyKey()`로 받습니다. 변경 메서드는 Service가 전달한 알림 수신자를 보관하고 성공한 경우에만 `after()`로 WebSocket 알림을 예약합니다. 초대 생성·취소는 그룹 상세만, 송금 확인은 정산 화면만 갱신하도록 기존 알림 범위를 유지합니다. Origin 검사는 전역 `OriginGuard`에서 처리합니다. `@RequiredHeader()`는 헤더 누락·빈 값·공백·문자열이 아닌 값을 Controller 메서드 실행 전에 거절합니다. `@RequiredIdempotencyKey()`는 해당 검증에 기존 `invalid_request_key` 응답을 적용합니다. 모임·회차 생성은 도메인 생성 키 오류 메시지를 지정합니다. 필수 헤더가 없는 보호 요청도 JWT 인증을 먼저 수행하며, 인증된 요청의 헤더 검증 실패는 Service·DB 호출 0회로 종료합니다. 값이 있는 헤더는 원문 그대로 전달하고 UUID 버전 검증은 Service의 라이브러리 호출로 유지합니다.

UUID 검증에는 직접 작성한 정규식 대신 `class-validator`의 `isUUID`를 사용합니다. 모임·회차 생성 키는 `isUUID(key, '7')`로 UUIDv7만 허용하고 소문자로 정규화합니다. 일반 멱등성 키는 기존과 같이 버전 1~8만 허용하며 nil/max UUID는 거부합니다. 영수증 작업 ID는 기존 UUID 문자열 형식 범위를 유지하는 `loose` 옵션으로 검증합니다. 검증 실패의 오류 코드와 검증·SQL 실행 순서는 유지합니다.

워커는 Nest 진입점에서 한 번 시작합니다. HTTP 변경 알림은 응답 완료 후 전송하고, 프론트는 기존 WebSocket invalidation으로 재조회합니다. 성공 mutation에 직접 GET을 추가하지 않았습니다.

프론트와 공유 모듈은 백엔드 런타임을 import하지 않습니다. 순수 도메인 함수는 `shared/domain`에 두고, DTO 타입은 `import type`으로 공유합니다. `app`도 JWT·DB·Nest 런타임 대신 공통 URL 정책만 참조합니다.

```bash
npm run build:backend
npm run typecheck
npm test
npm run test:domain       # 격리된 로컬 TEST_DATABASE_URL 필요
npm run test:integration
npm run test:scenario     # 백엔드 사용자 시나리오
# 실제 포트·브라우저 검증은 별도로 실행
npm run test:transport   # TEST_DATABASE_URL 및 MINIO_* 설정 필요
npm run test:browser
node --import tsx src/frontend/test/integration/browserCheck.mjs
```

Controller 단위·도메인·통합·백엔드 사용자 시나리오는 서버 포트를 열지 않습니다. `@nestjs/testing`으로 초기화한 앱의 실제 Express/Nest 라우터에 `node-mocks-http` 기반 Request/Response와 메모리 본문 스트림을 주입하여 Guard·Pipe·Interceptor·예외 필터·쿠키·응답 완료 후 변경 알림을 검증합니다. 도메인·통합·시나리오는 실제 PostgreSQL을 사용하며 카카오·S3 저장소·WebSocket 전송은 대역을 사용합니다. 시나리오는 로그인 응답의 토큰·쿠키와 앞 요청의 ID·버전을 이어서 사용합니다. `npm run test:all`이 이 네 계층을 실행합니다. CI도 PostgreSQL만 시작하여 이 계층을 검증하며, 실제 소켓 회귀 검증은 `transport`, 브라우저 검증은 `test:browser`로 분리합니다. 운영 이미지의 네트워크 헬스 확인은 배포 빌드 검증으로 유지합니다.

참고한 프레임워크 문서: [Nest controllers](https://docs.nestjs.com/controllers), [Prisma raw queries](https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/raw-queries), [Prisma transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions).

## Nest 진입점 전환 검증 (2026-10-08)

별도 사본에서 `npm ci`, Prisma·Nest·Next 운영 빌드, `npm run dev`의 백엔드 변경 자동 재시작, `npm start`의 운영 실행을 확인했습니다. 프론트·백엔드 타입 검사와 단위 테스트 116건, 헬스·라우팅·정산 통합 테스트 23건이 통과했습니다. WebSocket 통합 시나리오도 새 테스트 DB에서 통과했으며 인증·사용자별 변경 알림·영수증 워커·SQL 호출 수·요청 제한을 검증했습니다. 이 시나리오의 계정 검증 요청에도 필수 `Idempotency-Key`를 넣어 헤더 검증을 통과한 뒤 계정 검증에 도달하도록 수정했습니다.

운영 서버에서는 Next 화면·Prisma DB 헬스·Swagger UI·메트릭이 200으로 응답했고, 인증 없는 보호 API 및 `/api/docs` HTML은 401로 응답했습니다. 인증된 OpenAPI의 45개 API와 컴파일된 요청 DTO의 400 응답을 확인했습니다. `npm ls --all`의 의존성 오류와 미검토 설치 스크립트는 0건이며, audit 결과의 범위는 [의존성 관리](DEPENDENCIES.md)의 정적 번들 설명을 따릅니다. Dockerfile의 실행 명령은 수정했으나 이번 검증에서 Docker 이미지 빌드는 실행하지 않았습니다.
