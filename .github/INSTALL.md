# Install

[README](../README.md) · **Install** · [Stack](STACK.md)

다모아를 로컬에서 실행하는 방법입니다. 앱·WebSocket 서버·영수증 워커는 같은 Node.js 프로세스에서 실행하고, PostgreSQL과 MinIO는 Docker Compose로 준비합니다.

## 1. 준비 사항

- **Node.js 22.18 이상**과 npm
- **Docker**와 **Docker Compose v2**
- 실제 로그인에 사용할 **카카오 애플리케이션 REST API 키**

카카오 키 없이 화면을 확인하려면 아래의 [개발 테스트 계정](#개발-테스트-계정)을 사용합니다.

## 2. 저장소와 의존성 설치

```bash
git clone https://github.com/Da-Moa/Da-Moa.git
cd Da-Moa
npm ci
cp .env.example .env.local
```

이미 저장소가 있다면 해당 디렉터리에서 `npm ci`부터 실행합니다.

의존성 보안 검사에는 `npm audit`를 사용합니다. `npm audit fix --force`는 NestJS·Prisma의 주요 버전을 서로 다르게 바꿀 수 있으므로 사용하지 않습니다. 호환 버전과 설치 스크립트 정책은 [의존성 관리](DEPENDENCIES.md)에 정리했습니다.

## 3. 환경 변수 설정

[.env.example](../.env.example)을 기준으로 `.env.local`을 설정합니다.

| 변수 | 로컬 설정 |
| --- | --- |
| `KAKAO_REST_API_KEY` | 카카오 애플리케이션의 REST API 키 |
| `KAKAO_REDIRECT_URI` | `http://localhost:3000/auth/v1/kakao` |
| `KAKAO_CLIENT_SECRET` | 카카오 키의 Client Secret이 활성화되어 있으면 발급된 값 |
| `AUTH_JWT_SECRET` | 32바이트 이상의 임의 비밀 문자열 |
| `DATABASE_URL` | `postgresql://da_moa:da_moa_local@127.0.0.1:55432/da_moa_dev` |
| `MINIO_ENDPOINT` | `http://127.0.0.1:9000` |
| `MINIO_BUCKET` | `da-moa-receipts-dev` |
| `MINIO_ACCESS_KEY` | `da_moa_local` |
| `MINIO_SECRET_KEY` | `da_moa_minio_local` |
| `RECEIPT_WORKER_ENABLED` | `true` — 영수증 저장 워커 실행 |

JWT 비밀 문자열은 다음 명령으로 생성한 값을 사용합니다.

```bash
openssl rand -base64 48
```

위 DB·MinIO 계정은 localhost에 바인딩된 [로컬 Compose](../compose.yaml)용입니다. `.env.local`은 Git에 포함되지 않으며 비밀 값은 `NEXT_PUBLIC_` 변수로 설정하지 않습니다.

### 카카오 설정

1. 사용하는 REST API 키에서 카카오 로그인과 **OpenID Connect**를 활성화합니다.
2. Redirect URI로 `http://localhost:3000/auth/v1/kakao`를 등록합니다.
3. `.env.local`의 `KAKAO_REDIRECT_URI`도 동일한 주소로 설정합니다.
4. Client Secret이 활성화되어 있으면 `KAKAO_CLIENT_SECRET`을 설정합니다.

포트나 접속 호스트를 변경할 때는 카카오에 등록한 URI와 환경 변수를 함께 변경합니다. 여러 접속 주소는 등록된 URI를 쉼표로 나열할 수 있습니다. 변경한 설정은 개발 서버를 재시작한 뒤 적용됩니다.

## 4. PostgreSQL·MinIO 준비

Docker를 실행한 상태에서 다음 명령을 실행합니다.

```bash
npm run db:local:up
npm run db:migrate
```

첫 명령은 PostgreSQL·MinIO를 시작하고 비공개 영수증 버킷 `da-moa-receipts-dev`를 만듭니다. 두 번째 명령은 DB 스키마와 영수증 작업 큐의 마이그레이션을 적용합니다.

| 서비스 | 접속 주소 |
| --- | --- |
| PostgreSQL | `127.0.0.1:55432` |
| MinIO S3 API | `http://127.0.0.1:9000` |
| MinIO 콘솔 | [http://127.0.0.1:9001](http://127.0.0.1:9001) |

MinIO 콘솔의 로컬 계정은 `da_moa_local` / `da_moa_minio_local`입니다.

## 5. 앱 실행

```bash
npm run dev
```

`npm run dev`는 `nest start --watch`를 실행합니다. Nest가 같은 포트에서 API·Next 화면·WebSocket을 제공하며 백엔드 변경 시 자동으로 재시작합니다.

[http://localhost:3000](http://localhost:3000)에 접속합니다. 카카오 로그인 후 계좌를 등록하고 모임과 회차를 만들어 지출을 기록할 수 있습니다. 영수증 워커는 서버 시작 시 자동으로 실행됩니다.

로그인 후 `/docs`에서 Swagger UI를, `/api/openapi.json`에서 OpenAPI JSON을 확인할 수 있습니다. `/api/health/live`, `/api/health/database`, `/api/health/minio`는 인증 없이 각 서비스 상태를 확인하는 주소입니다.

개발 서버는 같은 네트워크에서 사용할 `Network` 주소도 출력합니다. 카카오 로그인에 이 주소를 사용하려면 해당 주소의 콜백 URI도 등록해야 합니다. 로컬 접속만 허용하려면 `HOST=127.0.0.1 npm run dev`로 실행합니다.

### 종료와 재실행

앱은 실행한 터미널에서 `Ctrl+C`로 종료합니다.

```bash
npm run db:local:down
```

컨테이너를 내려도 DB·영수증은 `postgres-dev-data`·`minio-dev-data` 볼륨에 유지됩니다. 다시 실행할 때는 `npm run db:local:up`과 `npm run dev`를 사용합니다. 코드 업데이트 후에는 `npm run db:migrate`도 실행합니다.

## 개발 테스트 계정

실제 카카오 인증 없이 확인하려면 이름에 `test`가 포함된 별도 로컬 DB를 만듭니다. 아래 명령은 PostgreSQL 컨테이너가 실행 중일 때 한 번 실행합니다.

```bash
docker compose exec -T postgres createdb -U da_moa da_moa_test
```

다음 명령은 같은 터미널에서 실행합니다.

```bash
export TEST_DATABASE_URL='postgresql://da_moa:da_moa_local@127.0.0.1:55432/da_moa_test'
export DATABASE_URL="$TEST_DATABASE_URL"
npm run db:seed:test-accounts
npm run dev
```

시드가 마이그레이션을 적용하고 가입 완료 회원 5명을 준비합니다. 개발 서버의 `/login`에서 테스트 계정을 선택합니다. `첫 가입 온보딩 보기`는 시드 없이 새 가입 흐름을 확인하는 버튼입니다. `AUTH_JWT_SECRET`은 테스트 로그인에도 필요합니다.

기본 개발 DB `da_moa_dev`에는 테스트 계정 시드를 실행하지 않습니다. 테스트 계정은 실제 카카오 계정과 연결되지 않으며 운영에서는 테스트 로그인 버튼과 API가 비활성화됩니다. 일반 개발 DB로 돌아가려면 앱을 종료한 뒤 `unset DATABASE_URL TEST_DATABASE_URL`을 실행하고 다시 시작합니다.

## 검증

### 단위 테스트와 빌드

```bash
npm test
npm run build
```

빌드는 개발 서버를 종료한 상태에서 실행합니다. 빌드 결과를 로컬에서 실행하려면 `npm start`를 사용합니다.

### 도메인·통합·백엔드 사용자 시나리오 테스트

Docker를 실행한 뒤 아래 명령을 사용합니다. 각 명령은 임시 PostgreSQL을 자동으로 생성하고 테스트가 끝나거나 실패하면 해당 DB와 컨테이너를 삭제합니다. `test:all`은 DB 하나를 공유하며 계층별로 순서대로 실행합니다.

```bash
npm run test:domain
npm run test:integration
npm run test:scenario
npm run test:all
```

Nest 앱은 포트를 열지 않고 모의 요청을 실제 라우터에 주입합니다. DB는 실제 PostgreSQL이며 카카오·스토리지·WebSocket 전송은 테스트 대역을 사용하므로 MinIO 서버는 필요하지 않습니다.

CI처럼 `TEST_DATABASE_URL`을 직접 지정하면 자동 생성과 삭제를 생략합니다. 로컬 호스트의 이름에 `test`가 포함된 DB만 허용하며, 지정한 DB에는 실제 테스트 데이터를 저장합니다. 테스트 명령은 `.env.local`을 읽지 않습니다.

### 실제 전송·브라우저 테스트용 DB와 스토리지

위에서 만든 별도 테스트 DB와 개발용 버킷에서 분리한 MinIO 버킷을 사용합니다.

```bash
docker compose exec -T minio sh -c 'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb --ignore-existing local/da-moa-receipts-test'
export TEST_DATABASE_URL='postgresql://da_moa:da_moa_local@127.0.0.1:55432/da_moa_test'
export AUTH_JWT_SECRET="$(openssl rand -base64 48)"
export MINIO_ENDPOINT='http://127.0.0.1:9000'
export MINIO_BUCKET='da-moa-receipts-test'
export MINIO_ACCESS_KEY='da_moa_local'
export MINIO_SECRET_KEY='da_moa_minio_local'
npm run test:transport
```

통합 테스트는 데이터를 실제로 저장합니다. 테스트 명령은 `.env.local`을 자동으로 읽지 않으므로 환경 변수를 직접 설정합니다.

### 브라우저 검증

통합 테스트 환경 변수를 설정한 터미널에서 테스트 DB를 사용하는 서버를 시작합니다.

```bash
export DATABASE_URL="$TEST_DATABASE_URL"
npm run db:migrate
PORT=3087 npm run dev
```

Chrome을 별도 테스트 프로필로 실행합니다. macOS 예시는 다음과 같습니다.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9223 \
  --user-data-dir=/tmp/da-moa-browser-check
```

다른 터미널에서도 **같은** `TEST_DATABASE_URL`·`AUTH_JWT_SECRET`·`MINIO_*`를 설정한 뒤 실행합니다.

```bash
node --import tsx src/frontend/test/integration/browserCheck.mjs
```

[검증 스크립트](../src/frontend/test/integration/browserCheck.mjs)는 기본 앱 주소 `http://localhost:3087`과 Chrome 디버깅 주소 `http://127.0.0.1:9223`을 사용합니다. `BROWSER_APP_ORIGIN`·`CHROME_DEBUG_ORIGIN`으로 변경할 수 있으며 결과 이미지는 시스템 임시 디렉터리의 `da-moa-browser-artifacts`에 저장합니다. 실제 카카오 로그인은 별도로 확인합니다.

Next.js 개발 서버가 시작되면 `AGENTS.md`·`CLAUDE.md`를 자동 생성할 수 있습니다.
