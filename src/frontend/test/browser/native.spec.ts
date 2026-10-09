import { expect, test } from '@playwright/test';
import {
  accounts,
  api,
  createRound,
  expectNoGet,
  observeHttp,
  observeRealtime,
  signIn,
} from './support';

test('a stale expense version reloads once and retries before WebSocket-driven refresh', async ({
  page,
  context,
  request,
  baseURL,
}, testInfo) => {
  const round = await createRound(request, baseURL!);
  await signIn(context, baseURL!, accounts[0].id);
  const http = observeHttp(page, testInfo);
  const realtime = await observeRealtime(page);
  const path = `/api/rounds/${round.id}`;
  try {
    await page.goto(`/home/rounds/${round.id}`);
    await expect(
      page.getByRole('heading', { name: '브라우저 회차', exact: true }),
    ).toBeVisible();
    await realtime.ready();
    await page.getByRole('button', { name: '지출 추가', exact: true }).click();
    await page
      .getByRole('textbox', { name: '지출 내용', exact: true })
      .fill('충돌 복구 식비');
    await page
      .getByRole('textbox', { name: '총 금액 (KRW)', exact: true })
      .fill('6000');
    const baseline = http.count(path);
    realtime.hold();
    await api(
      request,
      baseURL!,
      accounts[1].id,
      `rounds/${round.id}/expenses`,
      'POST',
      {
        description: '다른 참여자 지출',
        amount: '3000',
        currency: 'KRW',
        payerId: accounts[1].id,
        splitMode: 'ALL',
        expectedVersion: round.version,
      },
    );
    await expect
      .poll(() =>
        realtime.keys.some((keys) => keys.includes(`round:${round.id}`)),
      )
      .toBe(true);
    await expectNoGet(page, () => http.count(path), baseline);
    await page.getByRole('button', { name: '지출 저장', exact: true }).click();
    await expect
      .poll(() =>
        http.responses
          .filter((item) => item.path === `${path}/expenses`)
          .map((item) => item.status),
      )
      .toEqual([409, 200]);
    await expect
      .poll(
        () =>
          realtime.keys.filter((keys) => keys.includes(`round:${round.id}`))
            .length,
      )
      .toBe(2);
    await expectNoGet(page, () => http.count(path), baseline + 1);
    realtime.release();
    await expect.poll(() => http.count(path)).toBe(baseline + 2);
    await expect(page.locator('#expense-editor')).toHaveCount(0);
    await expect(
      page.getByText('충돌 복구 식비', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('다른 참여자 지출', { exact: true }),
    ).toBeVisible();
  } finally {
    await http.save();
  }
});

test('expired access JWT refreshes through the HttpOnly cookie and retries the authenticated GET', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  const session = await signIn(context, baseURL!, accounts[3].id, true);
  const http = observeHttp(page, testInfo);
  try {
    await page.goto('/home/account');
    await expect(
      page.getByRole('heading', { name: '내 정보', exact: true }),
    ).toBeVisible();
    expect(
      http.responses
        .filter((item) => item.path === '/api/me')
        .map((item) => item.status),
    ).toEqual([401, 200]);
    expect(
      http.responses
        .filter((item) => item.path === '/api/auth/refresh')
        .map((item) => item.status),
    ).toEqual([200]);
    expect(
      await page.evaluate(() => localStorage.getItem('da_moa_access')),
    ).not.toBe(session.access);
    const cookies = await context.cookies();
    expect(
      cookies.find((cookie) => cookie.name === 'da_moa_refresh'),
    ).toMatchObject({ httpOnly: true, path: '/api/auth' });
  } finally {
    await http.save();
  }
});

test('expense success waits for a real WebSocket invalidation; manual refresh and reconnect remain separate', async ({
  page,
  context,
  request,
  baseURL,
}, testInfo) => {
  const round = await createRound(request, baseURL!);
  await signIn(context, baseURL!, accounts[0].id);
  const http = observeHttp(page, testInfo);
  const realtime = await observeRealtime(page);
  const path = `/api/rounds/${round.id}`;
  try {
    await page.goto(`/home/rounds/${round.id}`);
    await expect(
      page.getByRole('heading', { name: '브라우저 회차', exact: true }),
    ).toBeVisible();
    await realtime.ready();
    await page.getByRole('button', { name: '지출 추가', exact: true }).click();
    await page
      .getByRole('textbox', { name: '지출 내용', exact: true })
      .fill('실제 브라우저 식비');
    await page
      .getByRole('textbox', { name: '총 금액 (KRW)', exact: true })
      .fill('12000');
    const baseline = http.count(path);
    realtime.hold();
    const mutation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `${path}/expenses` &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '지출 저장', exact: true }).click();
    expect((await mutation).status()).toBe(200);
    await expect
      .poll(() =>
        realtime.keys.some((keys) => keys.includes(`round:${round.id}`)),
      )
      .toBe(true);
    await expectNoGet(page, () => http.count(path), baseline);
    realtime.release();
    await expect.poll(() => http.count(path)).toBe(baseline + 1);
    await expect(page.locator('#expense-editor')).toHaveCount(0);
    await expect(
      page.getByText('실제 브라우저 식비', { exact: true }),
    ).toBeVisible();
    await expectNoGet(page, () => http.count(path), baseline + 1);

    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect.poll(() => http.count(path)).toBe(baseline + 2);
    const connections = realtime.connectionCount();
    realtime.disconnect();
    await expect.poll(() => realtime.connectionCount()).toBe(connections + 1);
    await expect.poll(() => http.count(path)).toBe(baseline + 3);
    await expect(
      page.getByText('실제 브라우저 식비', { exact: true }),
    ).toBeVisible();
  } finally {
    await http.save();
  }
});

test('account save triggers no GET until its real user-scoped WebSocket invalidation is delivered', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  await signIn(context, baseURL!, accounts[2].id);
  const http = observeHttp(page, testInfo);
  const realtime = await observeRealtime(page);
  try {
    await page.goto('/home/account');
    await expect(
      page.getByRole('heading', { name: '내 정보', exact: true }),
    ).toBeVisible();
    await realtime.ready();
    await page
      .getByRole('button', { name: '계좌 수정하기', exact: true })
      .click();
    await page.getByLabel('계좌번호', { exact: true }).fill('12340312345678');
    await page
      .getByLabel('계좌번호로 찾은 은행 후보')
      .getByRole('button', { name: 'KB국민은행', exact: true })
      .click();
    await page.getByLabel('예금주', { exact: true }).fill('브라우저 서연');
    const baseline = http.count('/api/me');
    realtime.hold();
    const mutation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/me/bank-account' &&
        response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: '계좌 저장', exact: true }).click();
    expect((await mutation).status()).toBe(200);
    await expect
      .poll(() => realtime.keys.some((keys) => keys.includes('me')))
      .toBe(true);
    await expectNoGet(page, () => http.count('/api/me'), baseline);
    realtime.release();
    await expect.poll(() => http.count('/api/me')).toBe(baseline + 1);
    await expect(
      page.getByRole('button', { name: '계좌 수정하기', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByText('KB국민은행 · 123403-12-345678', { exact: true }),
    ).toBeVisible();
    await expectNoGet(page, () => http.count('/api/me'), baseline + 1);
  } finally {
    await http.save();
  }
});
