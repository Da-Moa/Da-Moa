'use client'

import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, CircleUserRound, Search, X } from 'lucide-react'
import { ApiError } from '../../../lib/api-client'

const SHEET_DRAG_SPEED_DEBUG = process.env.NEXT_PUBLIC_SHEET_DRAG_SPEED_DEBUG === 'true'
const sheetMotionOptions = (distance: number) => ({ duration: Math.min(320, Math.max(180, 160 + Math.abs(distance) * .22)), easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'forwards' as const })

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
    for (const animation of dialog.getAnimations()) animation.cancel()
    // Continue from the current visible position even if a snap is in progress.
    dialog.dataset.closing = 'true'
    dialog.style.height = `${height}px`
    dialog.style.transform = transform
    const offset = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform).m42
    const animation = dialog.animate([{ transform }, { transform: `translate3d(0, ${height}px, 0)` }], sheetMotionOptions(height - offset))
    try { await animation.finished } catch { /* A cancelled animation must still close the dialog. */ }
    finally {
      if (dialog.isConnected) dialog.close()
      animation.cancel()
      dialog.style.removeProperty('height')
      dialog.style.removeProperty('transform')
      delete dialog.dataset.closing
      closing.current = false
    }
  }, [dialogRef])
  return { close, closing }
}

function useSheetSizing(dialogRef: RefObject<HTMLDialogElement | null>, closing: RefObject<boolean>) {
  const initialHeight = useRef<number | null>(null)
  const visibleHeight = useRef<number | null>(null)
  const limits = useRef<{ minimum: number; maximum: number } | null>(null)
  const resize = useCallback((nextHeight: number) => {
    const dialog = dialogRef.current
    const content = dialog?.querySelector<HTMLElement>('.bank-sheet-content')
    if (!dialog?.open || !content || closing.current) return
    initialHeight.current ??= dialog.offsetHeight
    if (!limits.current) {
      dialog.dataset.positioned = 'true'
      const padding = parseFloat(getComputedStyle(content).paddingBottom)
      const fixedHeight = Array.from(content.children).filter(child => !child.matches('.bank-sheet-body, .bank-grid')).reduce((sum, child) => {
        const style = getComputedStyle(child)
        return sum + (child as HTMLElement).offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom)
      }, 0)
      const maximum = parseFloat(getComputedStyle(dialog).maxHeight)
      limits.current = { maximum, minimum: Math.min(maximum, initialHeight.current, Math.max(180, fixedHeight + padding + 64)) }
    }
    const { minimum, maximum } = limits.current
    visibleHeight.current = Math.round(Math.max(minimum, Math.min(maximum, nextHeight)))
    // The panel stays full height; only its resting offset and scroll viewport change.
    dialog.style.setProperty('--sheet-height', `${visibleHeight.current}px`)
    dialog.style.setProperty('--sheet-offset', `${maximum - visibleHeight.current}px`)
    return limits.current
  }, [dialogRef, closing])
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    function reset() {
      initialHeight.current = null
      visibleHeight.current = null
      limits.current = null
      dialog?.style.removeProperty('--sheet-height')
      dialog?.style.removeProperty('--sheet-offset')
      if (dialog) delete dialog.dataset.positioned
    }
    function fitViewport() {
      limits.current = null
      if (dialog?.open && dialog.dataset.positioned) resize(visibleHeight.current ?? dialog.offsetHeight)
    }
    function prepare() {
      if (dialog?.open && !dialog.dataset.positioned) resize(dialog.offsetHeight)
      else if (!dialog?.open) reset()
    }
    // showModal() is also called by domain screens. Observe it before the first paint.
    const observer = new MutationObserver(prepare)
    if (dialog) observer.observe(dialog, { attributes: true, attributeFilter: ['open'] })
    prepare()
    dialog?.addEventListener('close', reset)
    window.addEventListener('resize', fitViewport)
    return () => {
      observer.disconnect()
      dialog?.removeEventListener('close', reset)
      window.removeEventListener('resize', fitViewport)
    }
  }, [dialogRef, resize])
  return { resize, initialHeight, visibleHeight, limits }
}

function useSheetMotion(dialogRef: RefObject<HTMLDialogElement | null>, close: () => Promise<void>, closing: RefObject<boolean>, sizing: ReturnType<typeof useSheetSizing>, dismissible: boolean) {
  const { resize, initialHeight, visibleHeight } = sizing
  const geometry = useRef<{ visible: number; original: number; maximum: number; offset: number; expandable: boolean } | null>(null)
  const frame = useRef<number | null>(null)
  const offset = useRef(0)
  const settling = useRef<Animation | null>(null)
  const clearFrame = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }, [])
  const settle = useCallback((height: number) => {
    const dialog = dialogRef.current
    if (!dialog?.open || closing.current) return
    const transform = getComputedStyle(dialog).transform
    const start = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform).m42
    const previous = settling.current
    settling.current = null
    previous?.cancel()
    for (const animation of dialog.getAnimations()) animation.cancel()
    dialog.dataset.settling = 'true'
    dialog.style.transform = `translate3d(0, ${start}px, 0)`
    const bounds = resize(height)
    if (!bounds) return
    const target = bounds.maximum - visibleHeight.current!
    const delta = start - target
    if (Math.abs(delta) < 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dialog.style.removeProperty('transform')
      delete dialog.dataset.settling
      return
    }
    const animation = dialog.animate([{ transform: dialog.style.transform }, { transform: `translate3d(0, ${target}px, 0)` }], sheetMotionOptions(delta))
    settling.current = animation
    void animation.finished.catch(() => {}).finally(() => {
      if (settling.current !== animation) return
      settling.current = null
      if (!closing.current) dialog.style.removeProperty('transform')
      delete dialog.dataset.settling
      animation.cancel()
    })
  }, [dialogRef, closing, resize, visibleHeight])
  const begin = useCallback((expandable: boolean) => {
    const dialog = dialogRef.current
    if (!dialog?.open || closing.current) return false
    clearFrame()
    const transform = getComputedStyle(dialog).transform
    const currentOffset = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform).m42
    for (const animation of dialog.getAnimations()) animation.cancel()
    settling.current = null
    delete dialog.dataset.settling
    dialog.style.transform = `translate3d(0, ${currentOffset}px, 0)`
    dialog.dataset.dragging = 'true'
    const bounds = resize(visibleHeight.current ?? dialog.offsetHeight)
    if (!bounds) return false
    geometry.current = { visible: visibleHeight.current!, original: Math.min(initialHeight.current!, bounds.maximum), maximum: bounds.maximum, offset: currentOffset, expandable }
    offset.current = currentOffset
    return true
  }, [dialogRef, closing, clearFrame, resize, initialHeight, visibleHeight])
  const move = useCallback((distance: number) => {
    const current = geometry.current
    if (!current) return
    offset.current = Math.max(current.expandable ? 0 : current.offset, Math.min(current.maximum, current.offset + distance))
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null
      const dialog = dialogRef.current
      if (dialog?.open && !closing.current) dialog.style.transform = `translate3d(0, ${offset.current}px, 0)`
    })
  }, [dialogRef, closing])
  const pause = useCallback((expandable: boolean) => settling.current ? begin(expandable) : false, [begin])
  const finish = useCallback((cancelled = false) => {
    const current = geometry.current
    const dialog = dialogRef.current
    if (!current || !dialog?.open || closing.current) return
    clearFrame()
    dialog.style.transform = `translate3d(0, ${offset.current}px, 0)`
    geometry.current = null
    delete dialog.dataset.dragging
    delete dialog.dataset.contentDragging
    let height = current.visible
    if (!cancelled) {
      const positions = [{ offset: current.maximum - current.original, height: current.original }]
      if (current.expandable || Math.abs(current.visible - current.maximum) < 1) positions.push({ offset: 0, height: current.maximum })
      const closingOffset = current.maximum - current.original + Math.max(64, Math.min(120, current.original * .25))
      height = dismissible && offset.current >= closingOffset ? 0 : positions.reduce((nearest, position) => Math.abs(position.offset - offset.current) < Math.abs(nearest.offset - offset.current) ? position : nearest).height
    }
    if (height === 0) void close()
    else settle(height)
  }, [dialogRef, closing, clearFrame, dismissible, close, settle])
  useEffect(() => {
    const dialog = dialogRef.current
    function reset() {
      clearFrame()
      geometry.current = null
      settling.current?.cancel()
      settling.current = null
      dialog?.style.removeProperty('transform')
      if (dialog) { delete dialog.dataset.dragging; delete dialog.dataset.contentDragging; delete dialog.dataset.settling }
    }
    function fitViewport() { reset() }
    dialog?.addEventListener('close', reset)
    window.addEventListener('resize', fitViewport)
    return () => {
      reset()
      dialog?.removeEventListener('close', reset)
      window.removeEventListener('resize', fitViewport)
    }
  }, [dialogRef, clearFrame])
  return { begin, move, finish, settle, pause }
}

function useSheetContentDrag(dialogRef: RefObject<HTMLDialogElement | null>, closing: RefObject<boolean>, motion: ReturnType<typeof useSheetMotion>, dismissible = true) {
  const { begin, move: moveSheet, finish, pause } = motion
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    let drag: { id: number; x: number; y: number; expandable: boolean; active: boolean; prepared: boolean } | null = null
    let suppressClickUntil = 0
    function cancel() {
      if (drag?.active || drag?.prepared) finish(true)
      drag = null
    }
    function start(event: TouchEvent) {
      if (event.touches.length !== 1) { cancel(); return }
      const target = event.target instanceof Element ? event.target : null
      const body = target?.closest('.bank-sheet-content')
      if (!dismissible || !dialog!.open || closing.current || !body || body.closest('dialog') !== dialog || target?.closest('.bank-sheet-drag-area, input, textarea, select, [contenteditable="true"]')) return
      const lists = Array.from(body.querySelectorAll('.bank-sheet-body, .bank-grid'))
      if (lists.some(list => list.scrollTop > 1)) return
      let expandable = lists.every(list => list.scrollHeight <= list.clientHeight + 1)
      for (let node = target; node && node !== dialog; node = node.parentElement) {
        if (node.scrollTop > 1) return
        if (node.scrollHeight > node.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)) expandable = false
      }
      suppressClickUntil = 0
      const touch = event.touches[0]
      drag = { id: touch.identifier, x: touch.clientX, y: touch.clientY, expandable, active: false, prepared: pause(expandable) }
    }
    function move(event: TouchEvent) {
      if (!drag) return
      if (!dismissible || closing.current || event.touches.length !== 1) { cancel(); return }
      const touch = Array.from(event.touches).find(touch => touch.identifier === drag!.id)
      if (!touch) return
      const distance = touch.clientY - drag.y
      if (!drag.active) {
        if (Math.max(Math.abs(distance), Math.abs(touch.clientX - drag.x)) < 8) return
        if ((distance < 0 && !drag.expandable) || Math.abs(touch.clientX - drag.x) >= Math.abs(distance) || !event.cancelable || (!drag.prepared && !begin(drag.expandable))) { cancel(); return }
        drag.active = true
        dialog!.dataset.contentDragging = 'true'
      }
      if (!event.cancelable) { cancel(); return }
      event.preventDefault()
      suppressClickUntil = performance.now() + 400
      moveSheet(distance)
    }
    function end(event: TouchEvent) {
      if (!drag) return
      const touch = Array.from(event.changedTouches).find(touch => touch.identifier === drag!.id)
      if (!touch) return
      if (drag.active) {
        if (event.cancelable) event.preventDefault()
        suppressClickUntil = performance.now() + 400
        moveSheet(touch.clientY - drag.y)
        finish()
      } else if (drag.prepared) finish(true)
      drag = null
    }
    function suppressClick(event: MouseEvent) {
      if (event.detail > 0 && performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation() }
    }
    function reset() { drag = null }
    dialog.addEventListener('touchstart', start, { passive: true })
    // Take over a sheet drag before the browser starts native list scrolling.
    dialog.addEventListener('touchmove', move, { passive: false })
    dialog.addEventListener('touchend', end, { passive: false })
    dialog.addEventListener('touchcancel', cancel)
    dialog.addEventListener('click', suppressClick, true)
    dialog.addEventListener('close', reset)
    window.addEventListener('resize', cancel)
    return () => {
      cancel()
      dialog.removeEventListener('touchstart', start)
      dialog.removeEventListener('touchmove', move)
      dialog.removeEventListener('touchend', end)
      dialog.removeEventListener('touchcancel', cancel)
      dialog.removeEventListener('click', suppressClick, true)
      dialog.removeEventListener('close', reset)
      window.removeEventListener('resize', cancel)
    }
  }, [dialogRef, closing, begin, moveSheet, finish, pause, dismissible])
}

function SheetHeader({ dialogRef, titleId, title, subtitle, closeLabel, dismissible = true, close, closing, sizing, motion }: {
  dialogRef: RefObject<HTMLDialogElement | null>; titleId: string; title: string; subtitle?: string;
  closeLabel: string; dismissible?: boolean; close: () => Promise<void>; closing: RefObject<boolean>;
  sizing: ReturnType<typeof useSheetSizing>;
  motion: ReturnType<typeof useSheetMotion>;
}) {
  const areaRef = useRef<HTMLDivElement>(null)
  const speedFrame = useRef<number | null>(null)
  const drag = useRef<{ pointerId: number; y: number; moved: boolean; samples: { y: number; time: number }[] } | null>(null)
  const peakSpeed = useRef(0)
  const [speedStats, setSpeedStats] = useState<{ peak: number; released: number | null; closed: boolean }>({ peak: 0, released: null, closed: false })
  function finishDrag() {
    if (speedFrame.current !== null) cancelAnimationFrame(speedFrame.current)
    speedFrame.current = null
    const pointerId = drag.current?.pointerId
    drag.current = null
    const area = areaRef.current
    if (pointerId !== undefined && area?.hasPointerCapture(pointerId)) area.releasePointerCapture(pointerId)
    if (area) delete area.dataset.dragging
  }
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    const dialog = dialogRef.current
    const target = event.target as Element
    if (!dialog?.open || closing.current || !event.isPrimary || event.button !== 0 || target.closest('button:not(.bank-sheet-resize-handle)')) return
    target.closest<HTMLButtonElement>('.bank-sheet-resize-handle')?.focus({ preventScroll: true })
    if (!motion.begin(true)) return
    peakSpeed.current = 0
    if (SHEET_DRAG_SPEED_DEBUG) setSpeedStats({ peak: 0, released: null, closed: false })
    drag.current = { pointerId: event.pointerId, y: event.clientY, moved: false, samples: [{ y: event.clientY, time: event.timeStamp }] }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.dataset.dragging = 'true'
    event.preventDefault()
  }
  function recordDragPoint(event: PointerEvent<HTMLDivElement>) {
    if (!SHEET_DRAG_SPEED_DEBUG) return
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    current.samples.push({ y: event.clientY, time: event.timeStamp })
    // Sample recent speed for diagnostics only; release position decides the snap.
    while (current.samples.length > 1 && current.samples[0].time < event.timeStamp - 120) current.samples.shift()
    const distance = event.clientY - current.samples[0].y
    const elapsed = event.timeStamp - current.samples[0].time
    const speed = elapsed > 0 ? distance / elapsed : 0
    peakSpeed.current = Math.max(peakSpeed.current, Math.abs(speed) * 1000)
    return { distance, speed }
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    recordDragPoint(event)
    current.moved ||= Math.abs(current.y - event.clientY) >= 4
    if (current.moved) motion.move(event.clientY - current.y)
    if (SHEET_DRAG_SPEED_DEBUG && speedFrame.current === null) speedFrame.current = requestAnimationFrame(() => {
      speedFrame.current = null
      const peak = Math.round(peakSpeed.current)
      setSpeedStats(previous => previous.peak === peak ? previous : { peak, released: null, closed: false })
    })
  }
  function releaseDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    const moved = current.moved || Math.abs(current.y - event.clientY) >= 4
    const point = recordDragPoint(event)
    if (point) setSpeedStats({ peak: Math.round(peakSpeed.current), released: Math.round(Math.abs(point.speed) * 1000), closed: false })
    if (moved) motion.move(event.clientY - current.y)
    finishDrag()
    motion.finish(!moved)
  }
  function cancelDrag() {
    if (!drag.current) return
    finishDrag()
    motion.finish(true)
  }
  function resizeWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    sizing.limits.current = null
    motion.settle((sizing.visibleHeight.current ?? 0) + (event.key === 'ArrowUp' ? 48 : -48))
  }
  useEffect(() => {
    const dialog = dialogRef.current
    function reset() {
      finishDrag()
      if (SHEET_DRAG_SPEED_DEBUG) setSpeedStats(previous => ({ ...previous, closed: true }))
    }
    function fitViewport() {
      finishDrag()
    }
    dialog?.addEventListener('close', reset)
    window.addEventListener('resize', fitViewport)
    return () => {
      finishDrag()
      dialog?.removeEventListener('close', reset)
      window.removeEventListener('resize', fitViewport)
    }
  }, [dialogRef, closing])
  const speedSummary = <><span>최대 드래그 속도 <strong>{speedStats.peak.toLocaleString('ko-KR')} px/s</strong></span><span>놓을 때 {speedStats.released === null ? '—' : `${speedStats.released.toLocaleString('ko-KR')} px/s`} · 놓은 위치로 결정</span></>
  return <><div className="bank-sheet-drag-area" onLostPointerCapture={cancelDrag} onPointerCancel={cancelDrag} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={releaseDrag} ref={areaRef}>
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
  const sizing = useSheetSizing(dialogRef, closing)
  const motion = useSheetMotion(dialogRef, close, closing, sizing, dismissible)
  useSheetContentDrag(dialogRef, closing, motion, dismissible)
  return <dialog aria-labelledby={titleId} className={`bank-sheet${fillHeight ? ' bank-sheet-fill' : ''}`} id={id} ref={dialogRef} onCancel={event => { event.preventDefault(); if (dismissible) void close() }} onClick={event => { if (event.target === event.currentTarget && dismissible) void close() }} onClose={event => { if (!event.currentTarget.open) onClose?.() }}>
    <div className="bank-sheet-content"><SheetHeader close={close} closeLabel={closeLabel} closing={closing} dialogRef={dialogRef} dismissible={dismissible} motion={motion} sizing={sizing} subtitle={subtitle} title={title} titleId={titleId} />
      <div className="bank-sheet-body"><div className="stack">{children}</div></div>
    </div>
  </dialog>
}

export const SheetSelect = memo(function SheetSelect({ label, name, title, value, onChange, options, disabled, sheetClassName, showSelectedIcon, searchPlaceholder }: {
  label: string; name: string; title: string; value: string; onChange: (value: string) => void;
  options: readonly { value: string; label: string; icon?: ReactNode; searchText?: string }[]; disabled?: boolean; sheetClassName?: string; showSelectedIcon?: boolean; searchPlaceholder?: string;
}) {
  const id = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const { close, closing } = useSheetClose(dialogRef)
  const sizing = useSheetSizing(dialogRef, closing)
  const motion = useSheetMotion(dialogRef, close, closing, sizing, true)
  useSheetContentDrag(dialogRef, closing, motion)
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
  const searchTerm = search.trim().toLocaleLowerCase('ko-KR')
  const filtered = opened ? options.filter(option => `${option.label} ${option.searchText ?? ''}`.toLocaleLowerCase('ko-KR').includes(searchTerm)) : []
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
    <dialog aria-label={title} className={`bank-sheet ${sheetClassName ?? ''}`} id={`${id}-sheet`} onCancel={event => { event.preventDefault(); void close() }} onClick={event => { if (event.target === event.currentTarget) void close() }} onClose={event => { if (!event.currentTarget.open) { setOpened(false); trigger.current?.focus() } }} ref={dialogRef}>
      {opened && <div className="bank-sheet-content"><SheetHeader close={close} closeLabel={`${label} 닫기`} closing={closing} dialogRef={dialogRef} motion={motion} sizing={sizing} title={title} titleId={`${id}-title`} />
        {searchPlaceholder && <div className="round-search-bar currency-search"><Search aria-hidden="true" size={21} /><input aria-label={searchPlaceholder} autoComplete="off" maxLength={100} onChange={event => setSearch(event.target.value)} placeholder={searchPlaceholder} type="search" value={search} /></div>}
        <div aria-label={`${label} 목록`} className="bank-grid" data-scrolling={scrolling || undefined} data-scrollbar-hovered={scrollbarHovered || undefined} onPointerMove={event => { const list = event.currentTarget; setScrollbarHovered(event.pointerType === 'mouse' && event.clientX >= list.getBoundingClientRect().left + list.clientLeft + list.clientWidth) }} onPointerLeave={() => setScrollbarHovered(false)} onScroll={showScrollbar} role="group">{filtered.map(option => <button aria-pressed={value === option.value} className="bank-tile" data-value={option.value} key={option.value} onClick={() => choose(option.value)} type="button">{option.icon}<span>{option.label}</span></button>)}</div>
        {filtered.length === 0 && <p className="help-text" role="status">검색 결과가 없어요.</p>}
      </div>}
    </dialog>
  </>
})
