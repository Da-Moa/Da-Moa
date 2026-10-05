'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, CircleUserRound, Search, X } from 'lucide-react'
import { ApiError } from '../../../lib/api-client'

const SHEET_DRAG_SPEED_DEBUG = process.env.NEXT_PUBLIC_SHEET_DRAG_SPEED_DEBUG === 'true'

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
    <label className="field"><span>공유 링크</span><input aria-label="공유 링크" onBlur={event => { delete event.currentTarget.dataset.touchFocus }} onFocus={event => event.target.select()} onKeyDown={event => { delete event.currentTarget.dataset.touchFocus }} onPointerDown={event => { if (event.pointerType === 'touch') event.currentTarget.dataset.touchFocus = 'true'; else delete event.currentTarget.dataset.touchFocus }} readOnly ref={input} value={url} /></label>
    {message && <p className="help-text" role="status">{message}</p>}
  </div>
}

function useSheetClose(dialogRef: RefObject<HTMLDialogElement | null>) {
  const closing = useRef(false)
  const close = useCallback(async () => {
    const dialog = dialogRef.current
    if (!dialog?.open || closing.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { dialog.close(); return }
    closing.current = true
    const { height } = dialog.getBoundingClientRect()
    const transform = getComputedStyle(dialog).transform
    // Freeze an in-progress resize before sliding out; percentage translation
    // otherwise follows the changing height and makes the sheet jump.
    dialog.dataset.closing = 'true'
    dialog.style.height = `${height}px`
    const animation = dialog.animate([{ transform }, { transform: `translate3d(0, ${height}px, 0)` }], { duration: 200, easing: 'ease-in', fill: 'forwards' })
    try { await animation.finished } catch { /* A cancelled animation must still close the dialog. */ }
    finally {
      if (dialog.isConnected) dialog.close()
      animation.cancel()
      dialog.style.removeProperty('height')
      delete dialog.dataset.closing
      closing.current = false
    }
  }, [dialogRef])
  return { close, closing }
}

function useSheetContentDrag(dialogRef: RefObject<HTMLDialogElement | null>, close: () => Promise<void>, closing: RefObject<boolean>, dismissible = true) {
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    let drag: { id: number; x: number; y: number; active: boolean; samples: { y: number; time: number }[] } | null = null
    let frame: number | null = null
    let offset = 0
    let suppressClickUntil = 0
    let rebound: Animation | null = null
    function reset() {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      drag = null
      offset = 0
      dialog!.style.removeProperty('transform')
      delete dialog!.dataset.contentDragging
    }
    function restore() {
      const transform = dialog!.style.transform
      reset()
      if (transform && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        rebound?.cancel()
        rebound = dialog!.animate([{ transform }, { transform: 'translate3d(0, 0, 0)' }], { duration: 180, easing: 'ease-out' })
      }
    }
    function start(event: TouchEvent) {
      if (event.touches.length !== 1) { restore(); return }
      const target = event.target instanceof Element ? event.target : null
      const body = target?.closest('.bank-sheet-body, .bank-grid')
      if (!dismissible || !dialog!.open || closing.current || !body || body.closest('dialog') !== dialog || target?.closest('input, textarea, select, [contenteditable="true"]')) return
      // Let native scrolling own the entire gesture if any enclosing list is
      // away from its top, including scrollable content nested in the sheet.
      for (let node = target; node && node !== dialog; node = node.parentElement) {
        if (node.scrollTop > 1) return
      }
      rebound?.cancel()
      const touch = event.touches[0]
      drag = { id: touch.identifier, x: touch.clientX, y: touch.clientY, active: false, samples: [{ y: touch.clientY, time: event.timeStamp }] }
    }
    function move(event: TouchEvent) {
      if (!drag) return
      if (!dismissible || closing.current || event.touches.length !== 1) { restore(); return }
      const touch = Array.from(event.touches).find(touch => touch.identifier === drag!.id)
      if (!touch) return
      const distance = touch.clientY - drag.y
      if (!drag.active) {
        if (Math.max(Math.abs(distance), Math.abs(touch.clientX - drag.x)) < 8) return
        if (distance <= 0 || Math.abs(touch.clientX - drag.x) >= distance || !event.cancelable) { drag = null; return }
        drag.active = true
        // Cancel an unfinished entrance once, instead of toggling its CSS rule:
        // restoring that rule on release would replay the entrance animation.
        for (const animation of dialog!.getAnimations()) {
          if (animation instanceof CSSAnimation && animation.animationName === 'bank-sheet-rise') animation.cancel()
        }
        dialog!.dataset.contentDragging = 'true'
      }
      if (!event.cancelable) { restore(); return }
      event.preventDefault()
      suppressClickUntil = performance.now() + 400
      drag.samples.push({ y: touch.clientY, time: event.timeStamp })
      while (drag.samples.length > 1 && drag.samples[0].time < event.timeStamp - 120) drag.samples.shift()
      offset = Math.max(0, distance)
      if (frame === null) frame = requestAnimationFrame(() => {
        frame = null
        dialog!.style.transform = `translate3d(0, ${offset}px, 0)`
      })
    }
    function end(event: TouchEvent) {
      if (!drag) return
      const touch = Array.from(event.changedTouches).find(touch => touch.identifier === drag!.id)
      if (!touch) return
      if (!drag.active) { reset(); return }
      if (event.cancelable) event.preventDefault()
      suppressClickUntil = performance.now() + 400
      const distance = Math.max(0, touch.clientY - drag.y)
      const sample = drag.samples.find(sample => sample.time >= event.timeStamp - 120)
      const elapsed = sample ? event.timeStamp - sample.time : 0
      const recentDistance = sample ? touch.clientY - sample.y : 0
      const flick = elapsed > 0 && recentDistance >= 16 && recentDistance / elapsed >= .7
      const threshold = Math.max(64, Math.min(120, dialog!.offsetHeight * .2))
      if (dismissible && !closing.current && distance >= 8 && (distance >= threshold || flick)) {
        if (frame !== null) cancelAnimationFrame(frame)
        frame = null
        dialog!.style.transform = `translate3d(0, ${distance}px, 0)`
        drag = null
        void close().finally(reset)
      } else restore()
    }
    function suppressClick(event: MouseEvent) {
      if (event.detail > 0 && performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation() }
    }
    dialog.addEventListener('touchstart', start, { passive: true })
    // A native non-passive listener can take over a downward pull before the
    // browser starts scrolling; React's delegated touch listeners are passive.
    dialog.addEventListener('touchmove', move, { passive: false })
    dialog.addEventListener('touchend', end, { passive: false })
    dialog.addEventListener('touchcancel', restore)
    dialog.addEventListener('click', suppressClick, true)
    dialog.addEventListener('close', reset)
    window.addEventListener('resize', restore)
    return () => {
      reset()
      rebound?.cancel()
      dialog.removeEventListener('touchstart', start)
      dialog.removeEventListener('touchmove', move)
      dialog.removeEventListener('touchend', end)
      dialog.removeEventListener('touchcancel', restore)
      dialog.removeEventListener('click', suppressClick, true)
      dialog.removeEventListener('close', reset)
      window.removeEventListener('resize', restore)
    }
  }, [dialogRef, close, closing, dismissible])
}

function SheetHeader({ dialogRef, titleId, title, subtitle, closeLabel, dismissible = true, close, closing }: {
  dialogRef: RefObject<HTMLDialogElement | null>; titleId: string; title: string; subtitle?: string;
  closeLabel: string; dismissible?: boolean; close: () => Promise<void>; closing: RefObject<boolean>;
}) {
  const areaRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; y: number; height: number; moved: boolean; samples: { y: number; time: number }[] } | null>(null)
  const initialHeight = useRef<number | null>(null)
  const limits = useRef<{ minimum: number; maximum: number } | null>(null)
  const frame = useRef<number | null>(null)
  const pendingHeight = useRef<number | null>(null)
  const peakSpeed = useRef(0)
  const [speedStats, setSpeedStats] = useState<{ peak: number; released: number | null; closed: boolean }>({ peak: 0, released: null, closed: false })
  function finishDrag() {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    pendingHeight.current = null
    const pointerId = drag.current?.pointerId
    drag.current = null
    const area = areaRef.current
    if (pointerId !== undefined && area?.hasPointerCapture(pointerId)) area.releasePointerCapture(pointerId)
    if (area) delete area.dataset.dragging
  }
  function resize(nextHeight: number) {
    const dialog = dialogRef.current
    const area = areaRef.current
    if (!dialog?.open || !area || closing.current) return
    initialHeight.current ??= dialog.offsetHeight
    if (!limits.current) {
      dialog.style.setProperty('--sheet-height', `${dialog.offsetHeight}px`)
      dialog.dataset.resized = 'true'
      const content = area.parentElement!
      const padding = parseFloat(getComputedStyle(content).paddingBottom)
      const fixedHeight = Array.from(content.children).filter(child => !child.matches('.bank-sheet-body, .bank-grid')).reduce((sum, child) => {
        const style = getComputedStyle(child)
        return sum + (child as HTMLElement).offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom)
      }, 0)
      const maximum = parseFloat(getComputedStyle(dialog).maxHeight)
      limits.current = { maximum, minimum: Math.min(maximum, initialHeight.current ?? maximum, Math.max(180, fixedHeight + padding + 64)) }
    }
    const { minimum, maximum } = limits.current
    const adjusted = Math.round(Math.max(minimum, Math.min(maximum, nextHeight)))
    dialog.style.setProperty('--sheet-height', `${adjusted}px`)
  }
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    const dialog = dialogRef.current
    const target = event.target as Element
    if (!dialog?.open || closing.current || !event.isPrimary || event.button !== 0 || target.closest('button:not(.bank-sheet-resize-handle)')) return
    target.closest<HTMLButtonElement>('.bank-sheet-resize-handle')?.focus({ preventScroll: true })
    limits.current = null
    peakSpeed.current = 0
    if (SHEET_DRAG_SPEED_DEBUG) setSpeedStats({ peak: 0, released: null, closed: false })
    drag.current = { pointerId: event.pointerId, y: event.clientY, height: dialog.offsetHeight, moved: false, samples: [{ y: event.clientY, time: event.timeStamp }] }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.dataset.dragging = 'true'
    event.preventDefault()
  }
  function recordDragPoint(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    current.samples.push({ y: event.clientY, time: event.timeStamp })
    // Only recent motion counts; pausing before release cancels the flick.
    while (current.samples.length > 1 && current.samples[0].time < event.timeStamp - 120) current.samples.shift()
    const distance = event.clientY - current.samples[0].y
    const elapsed = event.timeStamp - current.samples[0].time
    const speed = elapsed > 0 ? distance / elapsed : 0
    if (SHEET_DRAG_SPEED_DEBUG) peakSpeed.current = Math.max(peakSpeed.current, Math.abs(speed) * 1000)
    return { distance, speed }
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    recordDragPoint(event)
    current.moved ||= Math.abs(current.y - event.clientY) >= 4
    if (current.moved) pendingHeight.current = current.height + current.y - event.clientY
    // Coalesce pointer events into one layout write and one diagnostic update
    // per frame; speed sampling still uses every event.
    if ((current.moved || SHEET_DRAG_SPEED_DEBUG) && frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null
      if (pendingHeight.current !== null) resize(pendingHeight.current)
      pendingHeight.current = null
      if (SHEET_DRAG_SPEED_DEBUG) {
        const peak = Math.round(peakSpeed.current)
        setSpeedStats(previous => previous.peak === peak ? previous : { peak, released: null, closed: false })
      }
    })
  }
  function releaseDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    const requestedHeight = current.height + current.y - event.clientY
    const moved = current.moved || Math.abs(current.y - event.clientY) >= 4
    const { distance, speed } = recordDragPoint(event)!
    if (SHEET_DRAG_SPEED_DEBUG) setSpeedStats({ peak: Math.round(peakSpeed.current), released: Math.round(Math.abs(speed) * 1000), closed: false })
    const flick = Math.abs(distance) >= 16 && Math.abs(speed) >= .7
    if (moved) resize(requestedHeight)
    finishDrag()
    const dialog = dialogRef.current
    if (!moved || !dialog?.open || closing.current) return
    const maximum = limits.current!.maximum
    const original = Math.min(initialHeight.current ?? current.height, maximum)
    if (flick && speed < 0) resize(maximum)
    else if (flick && speed > 0 && dismissible) void close()
    else resize(original)
  }
  function resizeWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    limits.current = null
    resize((dialogRef.current?.offsetHeight ?? 0) + (event.key === 'ArrowUp' ? 48 : -48))
  }
  useEffect(() => {
    const dialog = dialogRef.current
    function reset() {
      finishDrag()
      initialHeight.current = null
      limits.current = null
      if (SHEET_DRAG_SPEED_DEBUG) setSpeedStats(previous => ({ ...previous, closed: true }))
      dialog?.style.removeProperty('--sheet-height')
      if (dialog) delete dialog.dataset.resized
    }
    function fitViewport() {
      finishDrag()
      limits.current = null
      if (dialog?.open && dialog.dataset.resized) resize(dialog.offsetHeight)
    }
    dialog?.addEventListener('close', reset)
    window.addEventListener('resize', fitViewport)
    return () => {
      finishDrag()
      dialog?.removeEventListener('close', reset)
      window.removeEventListener('resize', fitViewport)
    }
  }, [dialogRef, closing])
  const speedSummary = <><span>최대 드래그 속도 <strong>{speedStats.peak.toLocaleString('ko-KR')} px/s</strong></span><span>놓을 때 {speedStats.released === null ? '—' : `${speedStats.released.toLocaleString('ko-KR')} px/s`} · 기준 700 px/s</span></>
  return <><div className="bank-sheet-drag-area" onLostPointerCapture={finishDrag} onPointerCancel={finishDrag} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={releaseDrag} ref={areaRef}>
    <button aria-label="창 높이 조절 (위아래 방향키)" className="bank-sheet-resize-handle" onKeyDown={resizeWithKeyboard} type="button"><span aria-hidden="true" className="bank-sheet-handle" /></button>
    <header className="bank-sheet-header"><div>{subtitle && <p>{subtitle}</p>}<h2 autoFocus id={titleId} ref={node => { if (node) node.autofocus = true }} tabIndex={-1}>{title}</h2></div><button aria-label={closeLabel} className="icon-button" disabled={!dismissible} onClick={() => void close()} type="button"><X aria-hidden="true" size={20} /></button></header>
    {SHEET_DRAG_SPEED_DEBUG && <div aria-label="드래그 속도" className="bank-sheet-speed">{speedSummary}</div>}
  </div>
    {SHEET_DRAG_SPEED_DEBUG && speedStats.closed && speedStats.peak > 0 && typeof document !== 'undefined' && createPortal(<div className="sheet-drag-speed-result" role="status">{speedSummary}</div>, document.body)}
  </>
}

export function BottomSheet({ dialogRef, id, titleId, title, subtitle, closeLabel, dismissible = true, fillHeight = false, onClose, children }: {
  dialogRef: RefObject<HTMLDialogElement | null>; id: string; titleId: string; title: string; subtitle?: string;
  closeLabel: string; dismissible?: boolean; fillHeight?: boolean; onClose?: () => void; children: ReactNode;
}) {
  const { close, closing } = useSheetClose(dialogRef)
  useSheetContentDrag(dialogRef, close, closing, dismissible)
  return <dialog aria-labelledby={titleId} className={`bank-sheet${fillHeight ? ' bank-sheet-fill' : ''}`} id={id} ref={dialogRef} onCancel={event => { event.preventDefault(); if (dismissible) void close() }} onClick={event => { if (event.target === event.currentTarget && dismissible) void close() }} onClose={event => { if (!event.currentTarget.open) onClose?.() }}>
    <div className="bank-sheet-content"><SheetHeader close={close} closeLabel={closeLabel} closing={closing} dialogRef={dialogRef} dismissible={dismissible} subtitle={subtitle} title={title} titleId={titleId} />
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
  useSheetContentDrag(dialogRef, close, closing)
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
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!opened || !dialog || dialog.open) return
    dialog.showModal()
    dialog.querySelector<HTMLButtonElement>(`[data-value="${value || options[0]?.value}"]`)?.focus({ preventScroll: true })
  }, [opened, value, options])
  function open() {
    if (disabled || closing.current) return
    clearTimeout(scrollTimer.current)
    setScrolling(false)
    setScrollbarHovered(false)
    setSearch('')
    setOpened(true)
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
      <div className="bank-sheet-content"><SheetHeader close={close} closeLabel={`${label} 닫기`} closing={closing} dialogRef={dialogRef} title={title} titleId={`${id}-title`} />
        {searchPlaceholder && <div className="round-search-bar currency-search"><Search aria-hidden="true" size={21} /><input aria-label={searchPlaceholder} autoComplete="off" maxLength={100} onChange={event => setSearch(event.target.value)} placeholder={searchPlaceholder} type="search" value={search} /></div>}
        <div aria-label={`${label} 목록`} className="bank-grid" data-scrolling={scrolling || undefined} data-scrollbar-hovered={scrollbarHovered || undefined} onPointerMove={event => { const list = event.currentTarget; setScrollbarHovered(event.pointerType === 'mouse' && event.clientX >= list.getBoundingClientRect().left + list.clientLeft + list.clientWidth) }} onPointerLeave={() => setScrollbarHovered(false)} onScroll={showScrollbar} role="group">{filtered.map(option => <button aria-pressed={value === option.value} className="bank-tile" data-value={option.value} key={option.value} onClick={() => choose(option.value)} type="button">{option.icon}<span>{option.label}</span></button>)}</div>
        {filtered.length === 0 && <p className="help-text" role="status">검색 결과가 없어요.</p>}
      </div>
    </dialog>
  </>
}
