// Run against an isolated local DB + dev server, with Chrome --remote-debugging-port=9223.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signInKakao, completeOnboarding } from '../src/lib/auth-store.ts'
import { readAccessToken, ACCESS_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME } from '../src/lib/auth.ts'

const database = process.env.TEST_DATABASE_URL
assert.ok(database && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname), 'TEST_DATABASE_URL must point to an isolated local PostgreSQL database')
assert.ok(new URL(database).pathname.toLowerCase().includes('test'), 'TEST_DATABASE_URL database name must include test')
process.env.DATABASE_URL = database
const origin = process.env.BROWSER_APP_ORIGIN ?? 'http://localhost:3087'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Browser checks run only against localhost')
const debuggerOrigin = process.env.CHROME_DEBUG_ORIGIN ?? 'http://127.0.0.1:9223'
const tab = await (await fetch(`${debuggerOrigin}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
let nextId = 1
const pending = new Map()
const exceptions = []
const dialogs = []
let loseNextExpenseResponse = false
function cdp(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer); pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result)
  }
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  if (message.method === 'Page.javascriptDialogOpening') { dialogs.push(message.params.message); void cdp('Page.handleJavaScriptDialog', { accept: true }) }
  if (message.method === 'Fetch.requestPaused') {
    const paused = message.params
    if (loseNextExpenseResponse && paused.request.method === 'POST' && paused.responseStatusCode === 200) {
      loseNextExpenseResponse = false
      void cdp('Fetch.fulfillRequest', { requestId: paused.requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'transaction_retry', message: '저장 응답을 확인하지 못했어요. 다시 시도해 주세요.' })).toString('base64') })
    } else void cdp('Fetch.continueResponse', { requestId: paused.requestId })
  }
})
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression, label = expression) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return } catch (error) { if (!/context|navigation/i.test(error.message)) throw error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const text = await evaluate('document.body.innerText').catch(() => '')
  throw new Error(`Timed out: ${label}\n${text.slice(0, 1800)}`)
}
const hasText = text => `Boolean(document.body?.innerText.includes(${JSON.stringify(text)}))`
async function navigate(path, text) { await cdp('Page.navigate', { url: new URL(path, origin).href }); if (text) await waitFor(hasText(text), text) }
async function click(text) {
  await waitFor(`Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === ${JSON.stringify(text)} && !button.disabled && button.getClientRects().length > 0)`, `enabled button ${text}`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)} && !button.disabled && button.getClientRects().length > 0).click()`)
}
async function fill(selector, value) {
  await waitFor(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(element => ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName) && element.getClientRects().length > 0)`, `input ${selector}`)
  await evaluate(`(() => { const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(element => ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName) && element.getClientRects().length > 0); if (!element) throw new Error('Input missing'); const setter = Object.getOwnPropertyDescriptor(element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', {bubbles:true})); element.dispatchEvent(new Event('change', {bubbles:true})); })()`)
}
async function setSession(session) {
  await cdp('Network.clearBrowserCookies')
  await cdp('Network.setCookies', { cookies: [
    { name: ACCESS_TOKEN_COOKIE_NAME, value: session.accessToken, url: origin, path: '/', httpOnly: true, sameSite: 'Lax' },
    { name: REFRESH_TOKEN_COOKIE_NAME, value: session.refreshToken, url: origin, path: '/api/auth', httpOnly: true, sameSite: 'Lax' },
  ] })
}
async function api(session, path, method = 'GET', body) {
  const response = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, Cookie: `${ACCESS_TOKEN_COOKIE_NAME}=${session.accessToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json()
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${result.message ?? ''}`)
  return result.data ?? result
}
const runId = randomUUID()
async function user(label, number, onboarding = false) {
  const subject = `browser-${runId}-${label}`
  const limited = await signInKakao(subject, { displayName: `검증 ${label}`, email: null, profileImageUrl: null })
  const session = onboarding ? limited : await completeOnboarding(readAccessToken(limited.accessToken), { bankName: `${label}은행`, accountNumber: number, accountHolder: `검증 ${label}` })
  return { subject, session }
}

try {
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable')
  await cdp('Fetch.enable', { patterns: [{ urlPattern: `${origin}/api/rounds/*/expenses`, requestStage: 'Response' }] })
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  const owner = await user('A', '001111', true)
  const payer = await user('B', '002222')
  const participant = await user('C', '003333')
  await setSession(owner.session)
  await navigate('/onboarding', '계좌 등록하고 시작하기')
  await fill('[name=bankName]', 'A은행'); await fill('[name=accountNumber]', '001111'); await fill('[name=accountHolder]', '검증 A')
  await click('계좌 등록하고 시작하기')
  await waitFor(`location.pathname === '/home' && ${hasText('함께 쓴 돈, 함께 정리해요')}`)
  const ownerCookies = (await cdp('Network.getCookies', { urls: [origin, `${origin}/api/auth`] })).cookies
  owner.session = { ...owner.session, accessToken: ownerCookies.find(cookie => cookie.name === ACCESS_TOKEN_COOKIE_NAME).value, refreshToken: ownerCookies.find(cookie => cookie.name === REFRESH_TOKEN_COOKIE_NAME).value }
  console.log('PASS onboarding through the real HTTP API')

  await navigate('/home/groups', '새 모임 만들기')
  assert.equal(await evaluate("Boolean(document.querySelector('[name=currency]'))"), false)
  await fill('[name=name]', `브라우저 검증 ${runId.slice(0, 6)}`)
  await click('모임 만들기')
  await waitFor(hasText('현재 멤버 1명'))
  const groupId = (await evaluate('location.pathname')).split('/').at(-1)
  await click('초대 링크 만들기')
  await waitFor("Boolean(document.querySelector('input[aria-label=\"공유 링크\"]')?.value)")
  const invitePath = new URL(await evaluate("document.querySelector('input[aria-label=\"공유 링크\"]').value")).pathname
  for (const member of [payer, participant]) {
    await setSession(member.session)
    await navigate(invitePath, '초대 수락하고 참여하기')
    assert.equal(await evaluate(hasText('기준 통화')), false)
    await click('초대 수락하고 참여하기')
    await waitFor(`location.pathname === '/home/groups/${groupId}' && ${hasText('현재 멤버')}`)
  }
  await setSession(owner.session)
  await navigate(`/home/groups/${groupId}`, '현재 멤버 3명')
  assert.equal(await evaluate("document.querySelector('[name=currency]').value"), 'KRW')
  assert.deepEqual(await evaluate("Array.from(document.querySelector('[name=currency]').options, option => option.value)"), ['KRW', 'USD', 'JPY'])
  await fill('[name=name]', '지출과 제외 검증')
  await click('이 멤버로 기록 시작')
  await waitFor(hasText('지출 내역이 없습니다.'))
  const roundId = (await evaluate('location.pathname')).split('/').at(-1)
  assert.equal((await api(owner.session, `/api/rounds/${roundId}`)).currency, 'KRW')
  await click('정산 확정')
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('지출 내역이 없습니다')")
  console.log('PASS group creation, explicit invitations, round creation, and empty-confirm rejection')

  await click('지출 추가')
  await fill('[name=description]', '저녁 식사')
  await fill('[name=amount]', '10001')
  await fill('[name=payerId]', payer.session.userId)
  loseNextExpenseResponse = true
  await click('지출 저장')
  await waitFor(hasText('저장 응답을 확인하지 못했어요.'))
  await click('새로고침')
  await waitFor("document.querySelector('.large-money')?.textContent.includes('10,001')")
  await click('지출 저장')
  await waitFor(hasText('전체 균등 분배'))
  await waitFor("!document.querySelector('.expense-form')")
  assert.equal((await api(owner.session, `/api/rounds/${roundId}`)).expenses.length, 1)
  console.log('PASS lost successful write response, refreshed version, same-key retry without duplicate expense')

  await click('지출 추가')
  await fill('input[name=description]', '응답 복구 검증')
  await fill('[name=amount]', '10')
  loseNextExpenseResponse = true
  await click('지출 저장')
  await waitFor(hasText('저장 응답을 확인하지 못했어요.'))
  await fill('[name=amount]', '20')
  await click('지출 저장')
  await waitFor(hasText('이전 요청의 저장 결과를 먼저 확인해야 해요.'))
  await click('이전 요청 확인 후 새로고침')
  await waitFor("!document.querySelector('.expense-form') && document.querySelectorAll('.expense-card').length === 2")
  const recovered = (await api(owner.session, `/api/rounds/${roundId}`)).expenses.filter(expense => expense.description === '응답 복구 검증')
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].amountMinor, '10')
  await evaluate("Array.from(document.querySelectorAll('.expense-card')).find(card => card.textContent.includes('응답 복구 검증')).querySelector('button.danger-text').click()")
  await waitFor("document.querySelectorAll('.expense-card').length === 1")
  console.log('PASS changed pending input is blocked and explicit recovery restores the committed original')
  const imagePath = join(tmpdir(), `da-moa-browser-${runId}.png`)
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64'))
  const fileInput = await cdp('Runtime.evaluate', { expression: "document.querySelector('input[type=file]')" })
  await cdp('DOM.setFileInputFiles', { files: [imagePath], objectId: fileInput.result.objectId })
  await click('선택한 증빙 업로드')
  await waitFor(hasText('증빙이 서버에 저장됐어요.'))
  await waitFor("Array.from(document.querySelectorAll('button')).some(button => button.textContent.includes('증빙 1 보기'))")
  await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('증빙 1 보기')).click()")
  await waitFor("Boolean(document.querySelector('.receipt-preview')?.complete)")
  await evaluate("document.querySelector('button[aria-label=\"검증 B 제외\"]').click()")
  await waitFor(hasText('해당 사용자와 연관된 정산이 있습니다.'))
  assert.equal(await evaluate("document.querySelectorAll('.expense-highlight').length"), 1)
  await click('수정')
  await evaluate("document.querySelector('input[type=radio][value=SELECTED]').click()")
  await waitFor("Boolean(document.querySelector('input[name=participantIds]'))")
  await evaluate(`document.querySelector('input[name=participantIds][value="${payer.session.userId}"]').click()`)
  await click('지출 저장')
  await waitFor("!document.querySelector('.expense-form')")
  await evaluate("document.querySelector('button[aria-label=\"검증 B 제외\"]').click()")
  await click('이 사용자 제외하기')
  await waitFor(hasText('제외됨 · 기록 보존'))
  console.log('PASS manual payer, receipt upload/read, exclusion highlight, owner edit, excluded creditor retained')

  await navigate(`/home/groups/${groupId}`, '현재 멤버 2명')
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.check-row')).some(row => row.textContent.includes('검증 B'))"), false)
  await fill('[name=name]', '취소할 두 번째 회차')
  await fill('[name=currency]', 'USD')
  await click('이 멤버로 기록 시작')
  await waitFor(hasText('회차 전체 취소'))
  const secondRoundId = (await evaluate('location.pathname')).split('/').at(-1)
  const [firstRound, secondRound] = await Promise.all([api(owner.session, `/api/rounds/${roundId}`), api(owner.session, `/api/rounds/${secondRoundId}`)])
  assert.equal(firstRound.groupId, secondRound.groupId)
  assert.equal(firstRound.currency, 'KRW')
  assert.equal(secondRound.currency, 'USD')
  assert.equal(await evaluate("document.querySelector('.tab-heading').textContent.includes('USD')"), true)
  assert.equal(await evaluate("Boolean(document.querySelector('[name=currency]'))"), false)
  console.log('PASS one group creates independent KRW and USD rounds with currency selected only at creation')
  await click('회차 전체 취소')
  await waitFor(`location.pathname === '/home/groups/${groupId}' && ${hasText('현재 멤버 2명')}`)
  await navigate(`/home/rounds/${roundId}`, '정산 확정')
  await click('정산 확정')
  await waitFor(hasText('기록 단계로 다시 열기'))
  await click('기록 단계로 다시 열기')
  await waitFor(hasText('정산 확정'))
  await click('정산 확정')
  await click('전송 안내 확인')
  await waitFor(hasText('랜덤 돌리기'))
  assert.equal(await evaluate("Boolean(document.querySelector('input[aria-label=\"공유 링크\"]'))"), false)
  await click('랜덤 돌리기')
  await waitFor(hasText('정산 안내 링크 복사'))
  assert.equal(await evaluate("document.querySelector('.bank-details').textContent.includes('002222')"), true)
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.bank-details')).some(dl => dl.textContent.includes('003333'))"), false)
  await api(payer.session, '/api/me/bank-account', 'PUT', { bankName: 'B새은행', accountNumber: '000888', accountHolder: '검증 B' })
  await click('최신 정보 새로고침')
  await waitFor("document.querySelector('.bank-details')?.textContent.includes('000888')")
  const artifactDir = process.env.BROWSER_ARTIFACT_DIR ?? join(tmpdir(), 'da-moa-browser-artifacts')
  await mkdir(artifactDir, { recursive: true })
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(join(artifactDir, 'settlement.png'), Buffer.from(screenshot.data, 'base64'))
  await click('정산 안내 링크 복사')
  await waitFor("document.querySelector('.copy-link [role=status]')?.textContent.length > 0")
  await click('정산 종료 표시')
  await waitFor(hasText('회차 생성자가 정산 종료를 표시했어요.'))
  await navigate(`/home/rounds/${roundId}`, '종료된 회차예요.')
  assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(button => ['지출 추가', '수정', '정산 확정', '기록 단계로 다시 열기', '회차 전체 취소'].includes(button.textContent.trim()))"), false)
  console.log('PASS simultaneous rounds, cancellation, reopen, lock, one-time draw, personalized/latest accounts, copy, completion read-only')

  await setSession(payer.session)
  await navigate('/home/history', '지출과 제외 검증')
  await navigate(`/settlements/${roundId}`, '이 사람에게 받아요')
  assert.equal(await evaluate("document.querySelectorAll('.bank-details').length"), 0)
  await navigate('/home/all', '회원 탈퇴')
  await click('회원 탈퇴')
  await waitFor("location.pathname === '/'")
  payer.session = await signInKakao(payer.subject, { displayName: '검증 B', email: null, profileImageUrl: null })
  assert.equal(payer.session.purpose, 'onboarding')
  await setSession(payer.session)
  await navigate('/onboarding', '재가입 완료')
  await evaluate("document.querySelector('input[type=checkbox]').click()")
  await click('재가입 완료')
  await waitFor("location.pathname === '/home'")
  await navigate('/home/groups', '모임을 만들거나 초대 링크를 받아 참여해 주세요.')
  await navigate('/home/history', '지출과 제외 검증')
  assert.ok(dialogs.some(text => text.includes('이대로 사용자들에게 메시지를 전송할까요?')))
  assert.deepEqual(exceptions, [])
  console.log('PASS leaver history, soft withdrawal, explicit rejoin, no automatic membership restoration')
  console.log(`Browser evidence: ${join(artifactDir, 'settlement.png')}`)
} finally {
  ws.close()
  await fetch(`${debuggerOrigin}/json/close/${tab.id}`).catch(() => {})
}
