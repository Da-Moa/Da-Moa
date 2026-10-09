import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createValidationPipe } from '../../global/apiPayload/validation.pipe';
import { PageQueryDTO } from '../../global/apiPayload/dto/req/page.request.dto';
import {
  CreateExpenseRequestDTO,
  CustomShareRequestDTO,
  ExpenseRequestDTO,
  VersionRequestDTO,
  SettlementCheckRequestDTO,
} from '../../domain/settle/dto/req/settle.request.dto';
import { BankAccountRequestDTO } from '../../domain/user/dto/req/user.request.dto';
import { AppError } from '../../global/apiPayload/errors';

const pipe = createValidationPipe();
const transform = (value: unknown, metatype: new () => object) =>
  pipe.transform(value, { type: 'body', metatype });
const expense = {
  expectedVersion: 1,
  currency: 'USD',
  description: '식사',
  amount: '0.30',
  payerId: 'user-a',
  splitMode: 'CUSTOM',
  customShares: [
    { userId: 'user-a', amount: '0.10' },
    { userId: 'user-b', amount: '0.20' },
  ],
};

test('조회 DTO가 숫자 문자열을 변환하고 기본값·정수 범위를 적용한다', async () => {
  assert.equal((await transform({ limit: '2' }, PageQueryDTO)).limit, 2);
  assert.equal((await transform({}, PageQueryDTO)).limit, 20);
  for (const limit of ['0', '101', '1.5', 'NaN'])
    await assert.rejects(
      transform({ limit }, PageQueryDTO),
      (error) => error instanceof AppError && error.status === 400,
    );
});

test('지출 DTO가 중첩 분배를 변환하고 필수 생성 필드와 부분 수정 필드를 구분한다', async () => {
  const result = await transform(expense, CreateExpenseRequestDTO);
  assert.ok(result instanceof CreateExpenseRequestDTO);
  assert.ok(result.customShares);
  assert.ok(result.customShares[0] instanceof CustomShareRequestDTO);
  assert.equal(result.customShares[0].amount, '0.10');
  assert.ok(
    (await transform(
      { expectedVersion: 1, amount: '0.40' },
      ExpenseRequestDTO,
    )) instanceof ExpenseRequestDTO,
  );
  await assert.rejects(
    transform({ expectedVersion: 1, amount: '0.40' }, CreateExpenseRequestDTO),
    (error) => error instanceof AppError && error.status === 400,
  );
  await assert.rejects(
    transform(
      {
        ...expense,
        customShares: [{ userId: 'user-a', amount: '0.30', unexpected: true }],
      },
      CreateExpenseRequestDTO,
    ),
    (error) =>
      error instanceof AppError &&
      (error.details as { field?: string } | undefined)?.field ===
        'customShares.0.unexpected',
  );
});

test('JSON DTO가 버전·불리언·금액의 강제 변환을 거부하고 도메인 오류 코드를 유지한다', async () => {
  for (const expectedVersion of [
    '1',
    true,
    null,
    0,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    await assert.rejects(
      transform({ expectedVersion }, VersionRequestDTO),
      (error) => error instanceof AppError && error.code === 'invalid_version',
    );
  await assert.rejects(
    transform(
      { expectedVersion: 1, checked: 'false' },
      SettlementCheckRequestDTO,
    ),
    (error) => error instanceof AppError && error.code === 'invalid_input',
  );
  await assert.rejects(
    transform({ ...expense, amount: 0.3 }, CreateExpenseRequestDTO),
    (error) => error instanceof AppError && error.code === 'invalid_amount',
  );
  await assert.rejects(
    transform({ ...expense, currency: 'XXX' }, CreateExpenseRequestDTO),
    (error) =>
      error instanceof AppError && error.code === 'unsupported_currency',
  );
});

test('계좌 DTO가 선행 0을 유지하고 알 수 없는 필드·문자열 버전을 거부한다', async () => {
  const input = {
    bankCode: '004',
    accountNumber: '001234',
    accountHolder: '사용자',
    expectedBankVersion: 0,
  };
  const result = await transform(input, BankAccountRequestDTO);
  assert.ok(result instanceof BankAccountRequestDTO);
  assert.equal(result.accountNumber, '001234');
  for (const invalid of [
    { ...input, expectedBankVersion: '0' },
    { ...input, unknown: true },
    { ...input, verifyWithOpenBanking: true },
  ])
    await assert.rejects(
      transform(invalid, BankAccountRequestDTO),
      (error) => error instanceof AppError && error.status === 400,
    );
});
