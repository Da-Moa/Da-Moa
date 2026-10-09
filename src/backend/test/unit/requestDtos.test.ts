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

test('query DTOs convert numeric strings and enforce integer bounds with a default', async () => {
  assert.equal((await transform({ limit: '2' }, PageQueryDTO)).limit, 2);
  assert.equal((await transform({}, PageQueryDTO)).limit, 20);
  for (const limit of ['0', '101', '1.5', 'NaN'])
    await assert.rejects(
      transform({ limit }, PageQueryDTO),
      (error) => error instanceof AppError && error.status === 400,
    );
});

test('expense DTOs transform nested shares and distinguish required creation from partial updates', async () => {
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

test('JSON DTOs reject coerced versions, booleans and amounts while preserving domain error codes', async () => {
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

test('bank DTOs retain account leading zeroes and reject unknown fields and numeric-string versions', async () => {
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
