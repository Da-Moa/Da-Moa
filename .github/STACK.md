# Stack

[README](../README.md) · [Install](INSTALL.md) · **Stack**

저장소의 [package.json](../package.json)·[package-lock.json](../package-lock.json)과 Docker 설정을 기준으로 정리했습니다.

## 주요 기술

| 영역 | 기술 | 사용 목적 |
| --- | --- | --- |
| 언어 | TypeScript 6 | 프론트엔드·백엔드·공유 DTO와 금액 계산 로직 |
| 런타임 | Node.js 22.18 이상 | Next.js 커스텀 서버, WebSocket 서버, 영수증 워커 실행 |
| 프론트엔드 | Next.js 16 · React 19 | App Router 기반 프론트 라우팅과 화면 |
| 스타일 | CSS · Lucide React | 모바일 화면, 라이트·다크 모드, 아이콘 |
| 인증 | Kakao Login · OpenID Connect · JWT | 카카오 로그인과 Access/Refresh 토큰 인증 |
| 백엔드 | NestJS 11 · Guard · SWC · class-validator | 도메인 모듈·HTTP 컨트롤러·JWT 요청 인증 |
| 데이터베이스 | PostgreSQL 17 · Prisma · pg | 모임·회차·지출·정산 저장, Prisma 모델·트랜잭션와 커넥션 풀·SQL 트랜잭션 |
| 실시간 통신 | WebSocket · ws | 인증된 참여자에게 변경 알림을 보내 API 재조회 |
| 파일 저장소 | MinIO · AWS SDK for S3 | 비공개 영수증 객체 저장·조회·삭제 |
| 비동기 작업 | Graphile Worker | PostgreSQL 영속 큐에서 영수증 업로드 처리 |
| 이미지 처리 | Web Worker · WebAssembly · @jsquash/avif · sharp | 브라우저 AVIF 변환, 서버 이미지 검증 |
| API 문서 | @nestjs/swagger · OpenAPI | API 계약 정의와 Nest가 제공하는 `/docs`·`/api/docs` Swagger UI |
| 테스트 | node:test · assert · SWC · tsx · Chrome DevTools Protocol | 단위·통합 테스트와 모바일 브라우저 검증 |
| 개발 환경 | npm · Docker · Docker Compose | 의존성 설치와 로컬 PostgreSQL·MinIO 실행 |
| 배포 | GitHub Actions · OCI · Nginx | 테스트·빌드 자동화, Docker 배포, HTTPS·WebSocket 프록시 |

Next.js·React·TypeScript의 정확한 설치 버전은 lockfile에서 관리합니다. 앱 서버는 [Nest 진입점](../src/backend/main.ts), 로컬 서비스는 [compose.yaml](../compose.yaml), 운영 Compose·Nginx 설정·배포 스크립트는 [Deploy 저장소](https://github.com/Da-Moa/Deploy)에서 관리합니다. 앱 CI는 테스트 후 ARM64 운영 이미지를 빌드하고 실행을 확인합니다. main에서는 GHCR에 SHA 태그와 latest를 게시한 뒤 repository_dispatch로 이미지 digest를 Deploy에 전달합니다. Deploy Actions가 자체 production 환경을 사용해 A1에 배포하며, A1은 이미지를 내려받아 실행합니다. 앱에는 DEPLOY_DISPATCH_TOKEN을, Deploy에는 OCI 운영 Secret을 등록합니다.

## 도메인 라이브러리

| 라이브러리·기능 | 사용 목적 |
| --- | --- |
| `korean-account` | 은행별 계좌번호 후보와 표시 형식 |
| `BigInt` | 금액을 통화의 최소 단위로 정확하게 계산 |
| `sql-formatter` | 개발용 SQL 로그 서식 |
| `next/font/local` | 로컬 글꼴 로딩과 캐시 |

금액·분배 로직은 [공유 정산 모듈](../src/shared/domain/settle/)에 있습니다. [백엔드](../src/backend/)와 [프론트엔드](../src/frontend/)는 각자의 domain·global을 가지며, 전체 구조와 실행 경계는 [프로젝트 구조](STRUCTURE.md)에 정리했습니다.

## 이미지·글꼴 출처

### 프로젝트 로고

README는 저장소의 [다모아 로고](../public/logo/da-moa-trans.png)를 사용합니다.

### 금융기관 로고

은행 선택창은 [public/banks](../public/banks/)의 로컬 이미지를 사용합니다.

- 기본 SVG: [korea_bank_icons](https://github.com/flxh4894/korea_bank_icons/tree/80c40ce55baff328c97de6a2d65f84cef82b7f6f/assets/icons), commit `80c40ce55baff328c97de6a2d65f84cef82b7f6f`. [MIT 라이선스 원문](../public/banks/LICENSE.korea-bank-icons.txt)을 보관합니다.
- `012.svg`는 지역농축협의 NH 심볼로 `011.svg`와 같고, `030.svg`는 수협중앙회의 수협 심볼로 `007.svg`와 같습니다.
- `031.svg`·`262.svg`: [Toss의 iM 심볼](https://static.toss.im/icons/svg/icon-bank-dgb.svg). iM증권 브랜드는 [공식 사이트](https://www.imfnsec.com/)를 참고했습니다.
- `265.svg`: [Toss의 LS증권 로고](https://static.toss.im/icons/svg/icon-bank-ls.svg), [LS증권 공식 CI](https://ir.ls-sec.co.kr/companykor/pr/ci.jsp).
- `227.png`: [다올투자증권 공식 로고](https://daolsecurities.com/image/logo_header_b.png?ver=0.0.3).

로고의 색상·비율을 유지하며 상표권은 각 금융기관에 있습니다.

### 국기

통화 선택창의 [국기 SVG](../public/flags/)는 [flag-icons v7.3.2](https://github.com/lipis/flag-icons/tree/v7.3.2/flags/4x3)에서 가져왔습니다. [MIT 라이선스 원문](../public/flags/LICENSE)을 보관합니다.

### 글꼴

[Freesentation](https://github.com/Freesentation/freesentation)을 UI 서브셋으로 사용합니다. 원본의 글자·굵기·폭을 유지하고 사용자 입력 문자 범위는 제한하지 않습니다. [SIL Open Font License 1.1](../src/assets/fonts/OFL.txt)을 보관합니다.

글꼴이나 앱 문구를 변경하면 fontTools·WOFF2 지원을 갖춘 환경에서 `python3 scripts/subset-fonts.py`로 서브셋을 다시 생성합니다. 일반 npm 설치·빌드·실행에는 Python이 필요하지 않습니다.
