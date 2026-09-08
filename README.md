# 다모아

카카오로 로그인한 모임 참여자들이 지출을 기록하고 회차별로 비용을 나누는 앱입니다. 회차를 만들 때마다 KRW·JPY·USD 중 통화를 선택하며, 회차 안에서 여러 결제자의 지출을 합산해 각자 보낼 금액과 받을 금액을 계산합니다.

## 실행

Node.js **22.18 이상**과 Docker가 필요합니다. 로컬 개발은 Docker PostgreSQL을, Vercel Preview·Production은 각 환경의 Neon `DATABASE_URL`을 사용합니다.

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
| `DATABASE_URL` | 로컬은 `postgresql://da_moa:da_moa_local@127.0.0.1:55432/da_moa_dev_test`, Vercel은 환경별 Neon 연결 문자열 |

```bash
npm run db:local:up
npm run db:migrate
npm run db:seed:test-accounts
npm run dev
```

`npm run db:local:down`은 컨테이너만 중지하고 DB 데이터는 Docker volume에 유지합니다. `.env.local`은 Git·Vercel 배포에 포함되지 않습니다.

[http://localhost:3000](http://localhost:3000)에서 시작합니다. API 문서는 `/api/docs`, OpenAPI JSON은 `/api/openapi.json`에서 확인할 수 있습니다. [intent.md](intent.md)는 정책 결정 기록, [spec.md](spec.md)는 요구사항·상태·권한·인수 기준입니다. 금액 부호는 최신 명세를 따라 **부담액 − 결제액**, 양수는 보낼 돈·음수는 받을 돈입니다.

## 사용자 흐름

1. 카카오 로그인 후 은행·계좌번호·예금주를 등록합니다. 실제 계좌 여부나 본인 소유 여부를 검증하는 기능은 아직 없습니다.
2. 모임을 만들고 초대 링크를 공유합니다. 초대받은 사람은 로그인한 뒤 참여를 직접 수락합니다.
3. 생성자가 본인 포함 최소 2명과 회차 통화를 골라 기록을 시작합니다. 같은 모임에서 서로 다른 통화의 회차를 동시에 진행할 수 있습니다. 생성한 회차의 통화는 변경할 수 없으며 과거 회차의 통화와 금액은 유지됩니다.
4. 참여자가 결제자 한 명과 금액을 입력하고 전체 또는 선택한 사용자끼리 균등 분배합니다. 기록 단계에서 작성자 또는 모임 생성자가 수정·삭제할 수 있습니다.
5. 생성자가 정산을 확정합니다. 전송 전에는 생성자가 기록 단계로 다시 열 수 있습니다. 전송을 확인하면 원본이 잠기며, 나머지가 있으면 생성자가 ‘랜덤 돌리기’를 한 번 실행합니다.
6. 최종 안내에서 본인 금액과 필요한 수취 계좌를 확인하고 **링크만 복사**합니다. ‘전송’ 버튼이 외부 메시지를 보내거나 은행 이체를 실행하는 것은 아닙니다.
7. 생성자가 정산 종료를 표시합니다. 이는 입금 검증이 아니며, 종료한 회차는 모두에게 읽기 전용입니다.

결제자도 부담자로 선택되어 있으면 자신의 몫을 그대로 부담합니다. 결제자가 부담자가 아니면 다른 부담자들이 결제액을 나눕니다. 나머지는 각 지출의 서로 다른 부담자에게 최소 단위 1씩 배분하며 저장된 결과를 다시 추첨하지 않습니다. KRW·JPY는 정수, USD는 소수점 이하 최대 2자리입니다. 입력·계산·저장·응답에 정확한 문자열과 BigInt를 사용합니다.

영수증은 지출 저장 후 별도로 업로드하는 **증빙 이미지**입니다. JPEG·PNG·WebP 파일당 최대 2 MiB를 PostgreSQL에 저장합니다. OCR·자동 금액 입력, 환불 기록, 복수 결제자, 환전, 실제 송금·입금 추적, 카카오 메시지 발송은 제공하지 않습니다.

## 이탈·탈퇴와 개인정보

- 생성자는 제외할 수 없습니다. 제외 대상자가 결제자 겸 부담자이거나 특정 사용자 분배의 부담자이면 관련 내역을 표시하며 제외를 막습니다. 수정 후 다시 시도합니다. 허용된 제외는 해당 회차의 전체 분배만 다시 계산하고 현재 모임에서 이탈 처리합니다.
- 이탈·회차 제외 후에도 본인이 참여한 회차를 조회할 수 있습니다. 이미 만들어진 다른 회차의 구성은 바뀌지 않으며 다음 회차 후보에서는 빠집니다.
- 참여 이력이 있는 회차가 하나라도 미종료이면 회원탈퇴를 막습니다. 가능한 탈퇴는 `deletedAt`을 설정하고 세션·활성 멤버십을 폐기하며 과거 기록을 보존합니다.
- 같은 검증된 카카오 계정으로 명시적으로 재가입하면 같은 내부 회원과 과거 조회 권한을 사용합니다. 이전 모임과 관리 권한은 자동 복구하지 않습니다. 생성자가 탈퇴한 모임의 관리 복구·권한 이전 기능은 없습니다.
- KRW 개인 안내에는 **본인이 지급할 수취인의 최신 계좌만** 보입니다. USD·JPY에는 상대방과 금액만 보입니다. 계좌 변경은 완료 회차의 원본 금액을 바꾸지 않으며 링크 재접속·새로고침으로 최신값을 조회합니다.

## 저장·재시도

개인별 물리 정산 테이블을 만들지 않습니다. 회차의 분담·개인 잔액과 공통 `보내는 사람 → 받는 사람` 송금 행을 하나의 DB 트랜잭션으로 저장합니다. 변경 요청은 `Idempotency-Key`를 사용하고 회차 변경은 `expectedVersion`도 요구합니다. 응답이 유실되면 같은 키·본문으로 재시도하며 이미 성공한 작업을 다시 적용하지 않습니다. 버전 충돌은 최신 정보를 확인한 뒤 새 제출로 처리합니다.

초기 쓰기는 공통 PostgreSQL advisory transaction lock으로 직렬화합니다. 읽기는 별도 스냅샷을 사용합니다. 이 방식과 PostgreSQL의 작은 증빙 저장은 초기 구현 선택이며, 실제 쓰기 대기나 이미지 저장 비용이 문제가 될 때 잠금 세분화·비공개 객체 저장소 이행을 검토합니다.

## 검증

```bash
npm test
npm run build
```

`npm test`는 `node --import tsx --test`로 금액·분배·인증·권한·API 계약을 검증합니다. DB 트랜잭션·롤백·동시 요청과 Route Handler 검증에는 **이름에 `test`가 포함된 별도 DB**를 먼저 만들고 `TEST_DATABASE_URL`로 지정합니다. 테스트가 마이그레이션과 검증용 회원·모임·지출을 실제로 저장하므로 개발·운영 DB를 사용하지 않습니다. 테스트 명령은 `.env.local`을 자동으로 읽지 않습니다.

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

`BROWSER_APP_ORIGIN` 기본값은 `http://localhost:3087`, `CHROME_DEBUG_ORIGIN`은 `http://127.0.0.1:9223`입니다. 스크립트는 검증용 세션을 발급해 모바일 크기의 Chrome에서 가입·초대·지출·증빙·제외·확정·추첨·계좌 갱신·링크 복사·종료·재가입과 응답 유실 재시도를 검사합니다. 카카오 인증 서버의 로그인 화면은 자동화하지 않습니다. 결과 이미지는 시스템 임시 디렉터리의 `da-moa-browser-artifacts/settlement.png`에 저장하며 `BROWSER_ARTIFACT_DIR`로 위치를 지정할 수 있습니다.

카카오 로그인 자체는 서로 다른 실제 계정으로 초대·정산 링크에서 진입해 로그인 후 원래 화면으로 복귀하는지 별도로 확인합니다.

### 개발 테스트 계정

화면·DB 확인용 가입 완료 회원 3명은 로컬 개발 DB에 반복해서 시드할 수 있습니다.

```bash
npm run db:seed:test-accounts
```

원격 개발 DB에는 `DATABASE_URL`과 `ALLOW_REMOTE_TEST_ACCOUNT_SEED=true`를 함께 명시한 경우에만 시드할 수 있습니다. 운영 DB에는 이 플래그를 사용하지 않습니다.

시드는 `테스트 민지`, `테스트 준호`, `테스트 서연`과 서로 다른 테스트 계좌를 생성하고 목록을 출력합니다. 이 회원들은 `provider='test'`와 고정 `provider_subject`를 사용하므로 실제 카카오 로그인과 연결되지 않습니다. 개발 서버를 로컬 주소로 실행하면 `/login`에 세 계정의 로그인 버튼이 표시되고, 선택한 계정의 테스트 세션을 발급합니다. 운영 빌드에서는 버튼이 사라지고 `/api/auth/test-login`도 404를 반환합니다.

## 배포

배포 런타임도 Node 22.18 이상으로 맞추고 개발·Preview·Production DB를 분리합니다. Vercel Project Settings의 Preview와 Production에 각각 해당 Neon `DATABASE_URL`을 등록합니다. `vercel.json`이 빌드 전 `npm run db:migrate`를 실행하며, 마이그레이션은 기존 사용자 ID와 카카오 식별자를 보존하고 완료한 이행을 반복하지 않습니다.

기존 회원은 계좌 정보가 없으므로 첫 이행에서 기존 세션을 폐기하고 **한 번 재로그인·계좌 등록**을 요구합니다. 스키마를 먼저 이행하고 새 가입·소프트 삭제·도메인 코드를 배포합니다. 구버전의 회원 물리 삭제 코드로 되돌리거나 스키마 롤백으로 과거 자료를 삭제하지 않습니다. 배포 플랫폼의 요청 크기·실행 시간 안에서 2 MiB 이미지 업로드와 Neon 연결을 확인합니다.

회차별 통화 선택 전환은 `004` 추가 마이그레이션으로 적용합니다. 기존 `001~003` 파일과 과거 회차의 통화·금액·정산 결과를 유지하며 인증 이행·기존 세션 폐기를 반복하지 않습니다.
