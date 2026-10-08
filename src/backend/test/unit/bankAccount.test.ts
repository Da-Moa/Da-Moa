import assert from 'node:assert/strict'
import test from 'node:test'
import { BANKS, bankDisplayName, bankSelectionCode, formatAccountNumber, normalizeBankAccountInput, parseClipboardAccount, recognizedAccountNumber, suggestBanks } from '../../../shared/domain/user/index.ts'

test('manual bank input keeps leading zeroes and rejects former verification fields', () => {
  const input = { bankCode: '002', accountNumber: '031-1234 5678-901', accountHolder: ' 테스트 ', expectedBankVersion: 0 }
  assert.deepEqual(normalizeBankAccountInput(input), {
    bankCode: '002', bankName: 'KDB산업은행', accountNumber: '03112345678901', formattedAccountNumber: '031-1234-5678-901', accountHolder: '테스트', expectedBankVersion: 0, confirmRejoin: false,
  })
  assert.throws(() => normalizeBankAccountInput({ ...input, birthDate: '1990-01-01' }))
  assert.throws(() => normalizeBankAccountInput({ ...input, verifyWithOpenBanking: true }))
  assert.deepEqual(normalizeBankAccountInput({ ...input, verifyWithOpenBanking: false }), normalizeBankAccountInput(input))
  assert.equal(normalizeBankAccountInput({ ...input, bankCode: '092' }).formattedAccountNumber, '03112345678901')
  assert.equal(normalizeBankAccountInput({ ...input, accountNumber: '9999-9999' }).formattedAccountNumber, '99999999')
  for (const accountNumber of ['', '123x4567', '1234/5678', '12345678901234567']) assert.throws(() => normalizeBankAccountInput({ ...input, accountNumber }))
})

test('account display inserts separators only for documented bank layouts', () => {
  for (const [bank, number, expected] of [
    ['004', '12340312345678', '123403-12-345678'],
    ['088', '230123456789', '230-123-456789'],
    ['003', '12345678914123', '123-456789-14-123'],
    ['002', '03112345678901', '031-1234-5678-901'],
    ['007', '140012345678', '1400-1234-5678'],
    ['090', '1355123456789', '1355-12-3456789'],
    ['089', '110212345678', '110-212-345678'],
    ['092', '300112345678', '3001-1234-5678'],
    ['092', '100012345678', '1000-1234-5678'],
    ['032', '1041234567890', '104-1234-5678-90'],
  ]) assert.equal(formatAccountNumber(bank, number), expected)
  assert.equal(formatAccountNumber('KB국민은행', '12340312345678'), '123403-12-345678')
  assert.equal(formatAccountNumber('토스뱅크', '100012345678'), '1000-1234-5678')
  assert.equal(formatAccountNumber('004', '12349912345678'), '123499-12-345678')
  assert.equal(formatAccountNumber(null, '230123456789'), '230123456789')
  assert.equal(formatAccountNumber('088', '230-123-456789'), '230-123-456789')
  assert.equal(formatAccountNumber('004', '230-123-456789'), '230123456789')
  assert.equal(formatAccountNumber('088', '230-123-45678x'), '230-123-45678x')
  assert.equal(formatAccountNumber('092', '10000', true), '1000-0')
  assert.equal(formatAccountNumber('092', '100012345', true), '1000-1234-5')
  assert.equal(formatAccountNumber('092', '10000'), '10000')
})

test('account number suggests supported banks without silently selecting one', () => {
  assert.deepEqual(suggestBanks(''), [])
  assert.deepEqual(suggestBanks('33331042'), ['090'])
  assert.deepEqual(suggestBanks('3333123456789'), ['090'])
  assert.ok(suggestBanks('100004459947').includes('092'))
  assert.ok(suggestBanks('100004459947').includes('088'))
  assert.ok(suggestBanks('611123456789').includes('081'))
  assert.equal(formatAccountNumber('090', '33331042', true), '3333-10-42')
  assert.equal(formatAccountNumber('090', '3333123456789'), '3333-12-3456789')
  assert.equal(recognizedAccountNumber('090', '33331042'), null)
  assert.equal(recognizedAccountNumber('090', '3333123456789'), '3333-12-3456789')
  assert.equal(recognizedAccountNumber('092', '100004459947'), '1000-0445-9947')
})

test('reported bank layouts are suggested, formatted, and accepted for saving', () => {
  for (const [bankCode, number, formatted] of [
    ['081', '40212345678901', '402-123456-78901'],
    ['004', '94160201234567', '941602-01-234567'],
    ['090', '3310101234567', '3310-10-1234567'],
    ['089', '100112345678', '100-112-345678'],
    ['003', '98212345601010', '982-123456-01-010'],
    ['004', '94160201358511', '941602-01-358511'],
    ['089', '100150532064', '100-150-532064'],
    ['003', '98216737701010', '982-167377-01-010'],
    ['004', '35060104400218', '350601-04-400218'],
  ]) {
    assert.ok(suggestBanks(number).includes(bankCode), bankCode)
    assert.equal(formatAccountNumber(bankCode, number), formatted)
    assert.equal(formatted.replace(/-/g, ''), number)
    assert.equal(recognizedAccountNumber(bankCode, number), formatted)
    assert.equal(normalizeBankAccountInput({ bankCode, accountNumber: number, accountHolder: '테스트', expectedBankVersion: 0 }).formattedAccountNumber, formatted)
  }
  assert.ok(suggestBanks('402911').includes('081'))
  assert.ok(suggestBanks('331010').includes('090'))
  assert.ok(suggestBanks('100150').includes('089'))
})

test('clipboard accounts extract one complete number and select only an unambiguous bank', () => {
  for (const text of ['카카오뱅크 3333-12-3456789', '카카오 3333123456789 예금주 테스트', '3333 12 3456789', '계좌번호: 3333123456789\n예금주: 테스트']) {
    assert.deepEqual(parseClipboardAccount(text), { accountNumber: '3333123456789', bankCode: '090' }, text)
  }
  assert.deepEqual(parseClipboardAccount('산업은행\n031-1234-5678-901\n테스트'), { accountNumber: '03112345678901', bankCode: '002' })
  assert.deepEqual(parseClipboardAccount('토스뱅크 1000-0445-9947'), { accountNumber: '100004459947', bankCode: '092' })
  assert.deepEqual(parseClipboardAccount('신한은행 100004459947'), { accountNumber: '100004459947', bankCode: '088' })
  assert.deepEqual(parseClipboardAccount('100004459947'), { accountNumber: '100004459947', bankCode: null })
  assert.deepEqual(parseClipboardAccount('카카오뱅크 100004459947'), { accountNumber: '100004459947', bankCode: '090' })
  assert.deepEqual(parseClipboardAccount('카카오뱅크 9999-9999'), { accountNumber: '99999999', bankCode: '090' })
  assert.deepEqual(parseClipboardAccount('9999-9999'), { accountNumber: '99999999', bankCode: null })
  for (const text of ['', '계좌 없음', '3333-12', '3333-12-3456789***', '3333-12-3456789xxxx', '333312345678900000', '3333123456789\n3333987654321', 'x'.repeat(4097)]) {
    assert.equal(parseClipboardAccount(text), null, text.slice(0, 80))
  }
})

test('Nonghyup names and cooperative aliases select one unified bank', () => {
  for (const name of ['농협', 'NH농협', 'NH 농협', 'NH농협은행', '농협은행', '지역농협', '지역 농협', '지역농축협', '지역축협', '농축협', '축협']) {
    assert.deepEqual(parseClipboardAccount(`${name} 3510221772213`), { accountNumber: '3510221772213', bankCode: '011' }, name)
    assert.equal(bankDisplayName(name), '농협')
  }
  assert.deepEqual(parseClipboardAccount('지역농협 351-0221-7722-13'), { accountNumber: '3510221772213', bankCode: '011' })
  assert.deepEqual(parseClipboardAccount('농협은행 3510221772213'), { accountNumber: '3510221772213', bankCode: '011' })
  assert.deepEqual(parseClipboardAccount('토스뱅크 신한은행 100004459947'), { accountNumber: '100004459947', bankCode: null })
  assert.deepEqual(parseClipboardAccount('농협 3333123456789'), { accountNumber: '3333123456789', bankCode: '011' })
  assert.equal(bankDisplayName('NH투자증권'), 'NH투자증권')
  assert.equal(bankDisplayName(null), null)
})

test('one Nonghyup selection supports both institutions and preserves account formatting', () => {
  assert.deepEqual(BANKS.filter(bank => bank.name.includes('농협')), [{ code: '011', name: '농협' }])
  assert.equal(bankSelectionCode('012'), '011')
  assert.equal(bankSelectionCode('090'), '090')
  for (const [number, code, formatted] of [
    ['3510221772213', '012', '351-0221-7722-13'],
    ['3010123456781', '011', '301-0123-4567-81'],
    ['12345652123456', '012', '123456-52-12345-6'],
    ['12312012345', '011', '123-12-01234-5'],
  ]) {
    assert.ok(suggestBanks(number).includes('011'))
    assert.ok(!suggestBanks(number).includes('012'))
    assert.equal(formatAccountNumber('농협', number), formatted)
    assert.equal(recognizedAccountNumber('011', number), formatted)
    const input = normalizeBankAccountInput({ bankCode: '011', accountNumber: number, accountHolder: '테스트', expectedBankVersion: 0 })
    assert.equal(input.bankCode, code)
    assert.equal(input.bankName, '농협')
    assert.equal(input.formattedAccountNumber, formatted)
    assert.equal(input.accountNumber, number)
  }
  assert.equal(formatAccountNumber('농협', '3510221', true), '351-0221')
  assert.equal(formatAccountNumber('지역농축협', '3510221772213'), '351-0221-7722-13')
  assert.equal(normalizeBankAccountInput({ bankCode: '012', accountNumber: '99999999', accountHolder: '테스트', expectedBankVersion: 0 }).bankCode, '012')
})

test('phone-shaped accounts paste only with a bank supporting that alias', () => {
  for (const number of ['01031144018', '010-3114-4018', '011-123-1004']) {
    const accountNumber = number.replace(/-/g, '')
    assert.ok(suggestBanks(number).includes('003'))
    assert.deepEqual(suggestBanks(number), ['003', '004'])
    assert.equal(parseClipboardAccount(number), null)
    assert.deepEqual(parseClipboardAccount(number, '003'), { accountNumber, bankCode: '003' })
    assert.deepEqual(parseClipboardAccount(number, '004'), { accountNumber, bankCode: '004' })
    assert.deepEqual(parseClipboardAccount(`IBK기업은행 ${number}`), { accountNumber, bankCode: '003' })
    assert.equal(formatAccountNumber('003', number), accountNumber)
    assert.equal(formatAccountNumber('003', number, true), accountNumber)
    assert.equal(recognizedAccountNumber('003', number), accountNumber)
    assert.equal(recognizedAccountNumber('004', number), accountNumber)
    for (const bank of ['090', '092', '012', '011', '238']) {
      assert.equal(recognizedAccountNumber(bank, number), null)
      assert.equal(parseClipboardAccount(number, bank), null)
    }
    assert.equal(normalizeBankAccountInput({ bankCode: '003', accountNumber: number, accountHolder: '테스트', expectedBankVersion: 0 }).formattedAccountNumber, accountNumber)
  }
  assert.deepEqual(parseClipboardAccount('KB국민은행 01031144018'), { accountNumber: '01031144018', bankCode: '004' })
  assert.equal(parseClipboardAccount('카카오뱅크 01031144018'), null)
  assert.equal(parseClipboardAccount('카카오뱅크 01031144018', '003'), null)
  assert.equal(parseClipboardAccount('IBK기업은행 KB국민은행 01031144018'), null)
  assert.equal(parseClipboardAccount('IBK기업은행 01031144018\n01012345678'), null)
})
