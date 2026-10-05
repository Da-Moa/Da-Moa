'use client'

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChevronDown, CircleUserRound, Search, X } from 'lucide-react'
import { ApiError } from '../../../lib/api-client'

export function ErrorNotice({ error, retry, hint, retryLabel = '다시 시도' }: { error: Error | null; retry?: () => void; hint?: string; retryLabel?: string }) {
  const [recovering, setRecovering] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  if (!error) return null
  async function recover() {
    if (!(error instanceof ApiError) || !error.recover || recovering) return
    setRecovering(true); setRecoveryError(null)
    try { await error.recover(); window.location.reload() }
    catch (cause) { setRecoveryError(cause instanceof Error ? cause.message : '이전 요청 결과를 확인하지 못했어요.'); setRecovering(false) }
  }
  return <div className="notice notice-error" role="alert"><p>{error.message}</p>
    {hint && <p>{hint}</p>}
    {retry && <button className="text-button" type="button" onClick={retry}>{retryLabel}</button>}
    {error instanceof ApiError && error.recover && <><p>이전 요청을 확인한 뒤 페이지를 새로 불러와요. 현재 수정한 입력은 저장되지 않아요.</p><button className="text-button" disabled={recovering} onClick={() => void recover()} type="button">{recovering ? '이전 요청 확인 중…' : '이전 요청 확인 후 새로고침'}</button>{recoveryError && <p>{recoveryError}</p>}</>}
  </div>
}

export function Loading({ text = '불러오는 중…' }: { text?: string }) { return <p className="loading-message" role="status">{text}</p> }
export function ParticipantAvatar({ profileImageUrl }: { profileImageUrl: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  return <span aria-hidden="true" className="participant-avatar"><CircleUserRound size={24} />
    {profileImageUrl && failedUrl !== profileImageUrl && <img alt="" decoding="async" loading="lazy" onError={() => setFailedUrl(profileImageUrl)} referrerPolicy="no-referrer" src={profileImageUrl} />}
  </span>
}

export function CopyLink({ path, label = '링크 복사', hideButton = false }: { path: string; label?: string; hideButton?: boolean }) {
  const [message, setMessage] = useState('')
  const [url, setUrl] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { setUrl(new URL(path, window.location.origin).href) }, [path])
  async function copy() {
    try { await navigator.clipboard.writeText(url); setMessage('링크를 복사했어요. 원하는 대화방에 붙여 넣어 주세요.') }
    catch { input.current?.select(); setMessage('자동 복사를 사용할 수 없어요. 아래 링크를 선택해 직접 복사해 주세요.') }
  }
  return <div className="copy-link">{!hideButton && <button className="primary-button" type="button" disabled={!url} onClick={() => void copy()}>{label}</button>}
    <label className="field"><span>공유 링크</span><input aria-label="공유 링크" onFocus={event => event.target.select()} readOnly ref={input} value={url} /></label>
    {message && <p className="help-text" role="status">{message}</p>}
  </div>
}

function useSheetClose(dialogRef: RefObject<HTMLDialogElement | null>) {
  const closing = useRef(false)
  async function close() {
    const dialog = dialogRef.current
    if (!dialog?.open || closing.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { dialog.close(); return }
    closing.current = true
    const animation = dialog.animate([{ transform: getComputedStyle(dialog).transform }, { transform: 'translateY(100%)' }], { duration: 200, easing: 'ease-in', fill: 'forwards' })
    try { await animation.finished } catch { /* A cancelled animation must still close the dialog. */ }
    if (dialog.isConnected) dialog.close()
    animation.cancel()
    closing.current = false
  }
  return { close, closing }
}

export function BottomSheet({ dialogRef, id, titleId, title, subtitle, closeLabel, dismissible = true, onClose, children }: {
  dialogRef: RefObject<HTMLDialogElement | null>; id: string; titleId: string; title: string; subtitle?: string;
  closeLabel: string; dismissible?: boolean; onClose?: () => void; children: ReactNode;
}) {
  const { close } = useSheetClose(dialogRef)
  return <dialog aria-labelledby={titleId} className="bank-sheet" id={id} ref={dialogRef} onCancel={event => { event.preventDefault(); if (dismissible) void close() }} onClick={event => { if (event.target === event.currentTarget && dismissible) void close() }} onClose={event => { if (!event.currentTarget.open) onClose?.() }}>
    <div className="bank-sheet-content"><div aria-hidden="true" className="bank-sheet-handle" /><header className="bank-sheet-header"><div>{subtitle && <p>{subtitle}</p>}<h2 id={titleId}>{title}</h2></div><button aria-label={closeLabel} className="icon-button" disabled={!dismissible} onClick={() => void close()} type="button"><X aria-hidden="true" size={20} /></button></header>
      <div className="bank-sheet-body"><div className="stack">{children}</div></div>
    </div>
  </dialog>
}

export function SheetSelect({ label, name, title, value, onChange, options, disabled, sheetClassName, showSelectedIcon, searchPlaceholder }: {
  label: string; name: string; title: string; value: string; onChange: (value: string) => void;
  options: readonly { value: string; label: string; icon?: ReactNode; searchText?: string }[]; disabled?: boolean; sheetClassName?: string; showSelectedIcon?: boolean; searchPlaceholder?: string;
}) {
  const id = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const { close, closing } = useSheetClose(dialogRef)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [opened, setOpened] = useState(false)
  const [scrolling, setScrolling] = useState(false)
  const [scrollbarHovered, setScrollbarHovered] = useState(false)
  const [search, setSearch] = useState('')
  useEffect(() => () => clearTimeout(scrollTimer.current), [])
  function showScrollbar() {
    setScrolling(true)
    clearTimeout(scrollTimer.current)
    scrollTimer.current = setTimeout(() => setScrolling(false), 800)
  }
  const filtered = options.filter(option => `${option.label} ${option.searchText ?? ''}`.toLocaleLowerCase('ko-KR').includes(search.trim().toLocaleLowerCase('ko-KR')))
  const selected = options.find(option => option.value === value)
  function open() {
    if (disabled || closing.current) return
    clearTimeout(scrollTimer.current)
    setScrolling(false)
    setScrollbarHovered(false)
    setSearch('')
    dialogRef.current?.showModal()
    setOpened(true)
    dialogRef.current?.querySelector<HTMLButtonElement>(`[data-value="${value || options[0].value}"]`)?.focus()
  }
  function choose(next: string) {
    if (closing.current) return
    onChange(next)
    void close()
  }
  return <>
    <div className={`bank-select${value ? ' bank-select-filled' : ''}`}>
      <span id={`${id}-label`}>{label}</span>
      <button aria-controls={`${id}-sheet`} aria-expanded={opened} aria-haspopup="dialog" aria-labelledby={`${id}-label ${id}-value`} className="bank-select-trigger" disabled={disabled} onClick={open} ref={trigger} type="button"><span className="bank-select-value" id={`${id}-value`}>{showSelectedIcon && selected?.icon}{selected?.label}</span><ChevronDown aria-hidden="true" size={20} /></button>
      <select aria-hidden="true" autoComplete="off" className="bank-select-native" disabled={disabled} name={name} onChange={event => choose(event.currentTarget.value)} onInvalid={event => { event.preventDefault(); open() }} required tabIndex={-1} value={value}>{!value && <option value="" disabled>{title}</option>}{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    </div>
    <dialog aria-labelledby={`${id}-title`} className={`bank-sheet ${sheetClassName ?? ''}`} id={`${id}-sheet`} onCancel={event => { event.preventDefault(); void close() }} onClick={event => { if (event.target === event.currentTarget) void close() }} onClose={() => { setOpened(false); trigger.current?.focus() }} ref={dialogRef}>
      <div className="bank-sheet-content"><div className="bank-sheet-handle" aria-hidden="true" /><header className="bank-sheet-header"><h2 id={`${id}-title`}>{title}</h2><button aria-label={`${label} 닫기`} className="icon-button" onClick={() => void close()} type="button"><X aria-hidden="true" size={20} /></button></header>
        {searchPlaceholder && <div className="round-search-bar currency-search"><Search aria-hidden="true" size={21} /><input aria-label={searchPlaceholder} autoComplete="off" maxLength={100} onChange={event => setSearch(event.target.value)} placeholder={searchPlaceholder} type="search" value={search} /></div>}
        <div aria-label={`${label} 목록`} className="bank-grid" data-scrolling={scrolling || undefined} data-scrollbar-hovered={scrollbarHovered || undefined} onPointerMove={event => { const list = event.currentTarget; setScrollbarHovered(event.pointerType === 'mouse' && event.clientX >= list.getBoundingClientRect().left + list.clientLeft + list.clientWidth) }} onPointerLeave={() => setScrollbarHovered(false)} onScroll={showScrollbar} role="group">{filtered.map(option => <button aria-pressed={value === option.value} className="bank-tile" data-value={option.value} key={option.value} onClick={() => choose(option.value)} type="button">{option.icon}<span>{option.label}</span></button>)}</div>
        {filtered.length === 0 && <p className="help-text" role="status">검색 결과가 없어요.</p>}
      </div>
    </dialog>
  </>
}
