import { memo } from 'react'
import { SheetSelect } from '../../../../Global/Util/Frontend'
import { CURRENCIES, CURRENCY_CODES, requireCurrency, type Currency } from '../../Shared'

const currencyOptions = CURRENCY_CODES.map(code => ({ value: code, label: CURRENCIES[code].name, searchText: `${code} ${CURRENCIES[code].countries}`, icon: <img alt="" draggable={false} height={18} src={`/flags/${CURRENCIES[code].flag}.svg`} width={24} /> }))

export const CurrencySelect = memo(function CurrencySelect({ value, onChange, disabled }: { value: Currency; onChange: (value: Currency) => void; disabled: boolean }) {
  return <SheetSelect disabled={disabled} label="지출 통화" name="currency" onChange={value => onChange(requireCurrency(value))} options={currencyOptions} searchPlaceholder="통화 또는 나라 검색" sheetClassName="currency-sheet" title="통화를 선택해 주세요" value={value} />
})

export function CurrencyDivider({ currency }: { currency: Currency }) {
  return <p className="currency-divider"><span>{CURRENCIES[currency].name} · {currency}</span></p>
}
