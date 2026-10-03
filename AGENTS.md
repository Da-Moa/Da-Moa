<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 다모아 repository guide

## Purpose and priorities

다모아 is a Korean app for people who sign in with Kakao, record shared expenses in a 모임, and split costs in individual 회차. The README leads with expense recording and calculating each participant's 보낼 금액 / 받을 금액. Make that workflow the main visual and functional priority. Each round has its own KRW, JPY, or USD currency.

- Organize screens around the actual domain: 모임 → 회차 → dated 지출 with a 결제자 and 부담자 → personal settlement transfers. Give the current task, round state, and personal amount prominence before secondary counts or summaries.
- Keep recording and reviewing expenses, selecting participants, and finding the next settlement action easy on mobile. Preserve access to past rounds and the distinction between editable and locked records.
- Show accurate per-round amounts and authorized recipient information. Account verification and receipt images support the settlement workflow; they do not replace it as the product's central feature.

## Read before designing or changing behavior

Start with [README.md](README.md) for the product name, purpose, supported features, and operating instructions. Read the relevant UI, domain logic, and schema before choosing a layout or changing copy. Use repository content as the source of truth; do not invent taglines, statistics, testimonials, example transactions, or unsupported capabilities. Render authorized API data and existing empty states; test fixtures are for verification.

Read [spec/정산기능-spec.md](spec/정산기능-spec.md) for settlement requirements and [spec/계좌연동-spec.md](spec/계좌연동-spec.md) for manual account entry and optional verification. The matching `intent/` files record earlier decisions. Check historical descriptions against the current code and applicable spec: the README still has older wording about creator permissions and exclusion. Current `round-store.ts` distinguishes the round creator from the group creator, and excluding someone from a round leaves their group membership intact. The settlement spec's earlier exclusion of account verification is superseded by the account-linking spec.

Pull labels, enum values, limits, bank names, and validation terminology from the files that define them. Preserve the Korean product vocabulary: 모임, 회차, 지출, 결제자, 부담자, 정산, 예금주. Existing copy includes `함께 쓴 돈, 함께 정리해요` in `home-client.tsx`, `카카오로 시작하기` in `page.tsx`, and metadata `다모아 | 간편 정산` in `layout.tsx`.

## Critical files

| Files | Responsibility |
| --- | --- |
| `src/app/page.tsx`, `src/app/layout.tsx`, `src/lib/hero-phase.ts` | Landing content, Korean document metadata, and landing animation phases. |
| `src/app/globals.css`, `src/app/home/ui.tsx` | Visual styles and shared `AppShell`, `StatusBadge`, `ParticipantAvatar`, `ErrorNotice`, `Loading`, `CopyLink`, `useResource`, and `useAction`. |
| `src/app/home/home-client.tsx`, `src/Domain/Group/Frontend/`, `src/Domain/Settle/Frontend/`, `src/app/home/round-client.tsx` | Home/history composition, group lists/membership/invites, public round creation/list UI, expense entry and round actions. |
| `src/app/settlements/settlement-client.tsx`, `src/Domain/Group/Frontend/UI/InviteClient.tsx`, `src/Domain/User/Frontend/` | Personal settlement guidance and manual confirmation of received payments, invitation acceptance, and account registration. |
| `src/lib/domain-types.ts`, `money.ts`, `split.ts` | Domain DTOs and states, exact currency parsing/formatting and limits, equal shares, remainder allocation, and transfer calculation. These files are under `src/lib/`. |
| `src/Domain/Group/Backend/`, `src/Domain/Group/Shared/`, `src/lib/round-store.ts` | Group Controller/Service/Repository, public group DTOs, SQL-backed permissions/membership/invites, expenses, receipts, round transitions, and settlement persistence. Group SQL owns groups/memberships/invites and joins active users for names in group details; other user and unfinished-round reads use public User/Settle functions with the same client. |
| `src/app/api/[...path]/route.ts`, `src/lib/openapi.ts` | Domain Route Handler and API contract; documentation is exposed at `/api/docs` and `/api/openapi.json`. Auth and account routes live separately under `src/app/api/auth/` and `src/app/api/me/`. |
| `src/proxy.ts`, `src/Global/Auth/Backend/Guard/JwtGuard.ts` | Node JWT guard for every API request before body/input checks. Exact public health/login routes; refresh/logout use their corresponding JWTs. Keep DB session and domain authorization inside existing transactions. |
| `src/Global/Auth/Backend/`, `src/lib/auth.ts`, `authorization.ts`, `src/Domain/User/Backend/`, `src/Domain/User/Shared/` | Kakao/JWT security and account authorization in Global/Auth, user lifecycle/SQL in User Backend, pure bank input/catalog and DTOs in User Shared. 금융결제원 is not currently implemented. |
| `src/Global/Util/Backend/`, `src/lib/db.ts`, `src/lib/mutations.ts`, `src/lib/api-client.ts` | Public input-validation-util/pagenation-util/idempotency-util helpers, transactions, idempotency, JWT refresh, and recovery of requests whose responses were lost. Global Auth/Websocket and Util Frontend entry points currently delegate to the existing shared implementations. |
| `server.mjs`, `src/lib/realtime.ts`, `src/lib/realtime-server.ts`, `scripts/migrations/` | Authenticated WebSocket connections, invalidation keys and authorized audiences; ordered SQL schema migrations. Browser subscriptions use `home/ui.tsx`. |
| `package.json`, `.env.example`, `compose.yaml`, `.github/workflows/ci.yml`, `scripts/browser-check.mjs` | Commands, environment names, local PostgreSQL, deployment migrations, CI, and mobile browser verification. |

## Existing visual identity

Use the existing plain CSS and shared components. `src/app/globals.css` is the style source; many intentional values are literal declarations rather than named tokens. Read the applicable selectors and overrides before adding styles.

- Palette: background `#f2f4f6`, white cards, primary text `#191f28`, secondary text `#6b7684`, brand/focus blue `#5dc4fc`, authenticated primary buttons `#146db0` with hover `#0d5f9c`, landing purple `#4c085c`, and Kakao yellow `#fee500`. Preserve these distinct roles.
- Existing tokens: `--box-border-color: #d8dee6`, `--box-shadow: 0 8px 20px rgba(25, 31, 40, .1)`, and `--control-shadow: 0 2px 7px rgba(25, 31, 40, .08)`.
- Typography: `Arial, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif`; base `h1` is `clamp(31px, 8.4vw, 39px)`, domain card headings are 19px/16px, and monetary values use tabular numerals. Inherit the existing Korean wrapping rules.
- Layout: app and landing shells have a 480px maximum width and 20px horizontal padding; `.domain-card` uses 20px radius/padding and `.stack` uses a 16px gap. Reuse these patterns, `lucide-react`, `public/logo/` assets, and the existing `src/assets/hero.png` where applicable.
- Keep native forms/dialogs, visible keyboard focus, accessible names, and reduced-motion behavior. Reuse `statusLabel` in `home/ui.tsx`: `RECORDING` = `기록 중`, `CONFIRMED` = `확정 · 전송 전`, `LOCKED` = `송금 대기중`, `COMPLETED` = `정산 종료`. Navigation is `홈`, `모임`, `정산 기록`, `전체`.

## Domain rules to preserve

- A group has at most 10 members. Any active group member can create a round with at least two participants including themselves; the round creator controls its settlement actions. Expense edits require the author or round creator and the recording state.
- Keep money as exact strings and BigInt minor units through input, calculation, storage, and responses. KRW/JPY use integers; USD allows two decimal places. Use `money.ts` helpers. Balance is **burden − paid**: positive means send, negative means receive. Never aggregate different currencies into one amount. Limits are 100,000,000 major units per expense and 1,000,000,000 per round; a round's currency is immutable.
- Round flow is `RECORDING → CONFIRMED → LOCKED → COMPLETED`; reopening is allowed before locking. `전송` locks the original records, and `랜덤 돌리기` allocates any remainder once after locking. Persist final shares, balances, and common sender-to-receiver transfers atomically; never redraw saved results. Normal completion requires recipients to manually confirm all incoming transfers; the round creator can force completion after a warning. Completed rounds are read-only.
- `링크 복사` shares guidance. The app does not execute bank transfers, automatically verify deposits, send Kakao messages, perform OCR, or exchange currencies. JPEG/PNG/WebP receipts are supporting images uploaded after saving an expense and converted to AVIF; existing image formats remain readable.
- Manual bank entry is supported without 금융결제원 consent or a birth date. Verification is optional. Show exactly `확인되지 않은 계좌입니다.` when a displayed account lacks `verifiedAt`; OAuth success alone does not establish verification. Personal KRW guidance exposes only the viewer's actual recipients' latest accounts; USD/JPY guidance omits account details.
- Preserve idempotency keys and version checks through existing mutation helpers. Group creation uses its UUIDv7 request key as the PK and rejects duplicates with 409; it does not replay mutation records. Authentication uses stateless Access/Refresh JWTs; do not query or store refresh sessions. Keep user-state and resource permission checks. The Node WebSocket server publishes only invalidation keys after commit; authenticated APIs remain the data source. Keep account details, amounts, receipts, and invite tokens out of realtime messages. Preserve past records during membership changes and soft deletion, and keep credentials server-side.

## Development and verification

Use Node.js 22.18 or newer. Local development and production use PostgreSQL; application transactions use the shared `pg` connection pool. Follow the README and `.env.example` for setup rather than embedding environment values in code.

- `npm test` runs the existing `node:test`/`tsx` checks. `npm run build` is the other CI check. Use focused existing tests while iterating, and run both for application changes.
- For DB, transaction, or Route Handler changes, use `npm run test:integration` with an explicitly configured local `TEST_DATABASE_URL` whose database name contains `test`. These tests write data; follow the README's isolation requirements.
- For UI flows, follow the README's `scripts/browser-check.mjs` setup with a test database, matching test auth secret, and Chrome debugging. Actual Kakao/금융결제원 authentication requires the separate documented live verification; mocked tests do not establish it.
- Add schema changes as ordered migrations in `scripts/migrations/`, preserving existing IDs and historical settlement data. Reuse the existing implementation and dependencies before adding another abstraction or package.
