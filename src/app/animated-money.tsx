'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { formatMoney, type Currency } from '../lib/money'
import { collapseMovesByPlace, digitSequence } from '../lib/money-animation'

function placedCharacters(value: string) {
  let place = [...value].filter(character => character >= '0' && character <= '9').length - 1
  return [...value].map((character, index) => {
    if (character < '0' || character > '9') return { anchor: place + 1, character, index, place: null }
    const digitPlace = place--
    return { anchor: null, character, index, place: digitPlace }
  })
}

function moneyParts(value: string, currency: Currency) {
  if (currency === 'USD') return { prefix: '$', body: value.slice(1), suffix: '' }
  return { prefix: '', body: value.slice(0, -1), suffix: value.slice(-1) }
}

export function AnimatedMoney({ amountMinor, currency, className = 'large-money', prefix = '', announce = true }: {
  amountMinor: string; currency: Currency; className?: string; prefix?: string; announce?: boolean
}) {
  const formatted = formatMoney(amountMinor, currency)
  const [transition, setTransition] = useState(() => ({ from: formatted, to: formatted, amountMinor, direction: 'up' as 'up' | 'down', sequence: 0 }))
  useEffect(() => {
    setTransition(previous => previous.to === formatted ? previous : {
      from: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? formatted : previous.to,
      to: formatted,
      amountMinor,
      direction: BigInt(amountMinor) > BigInt(previous.amountMinor) ? 'up' : 'down',
      sequence: previous.sequence + 1,
    })
  }, [amountMinor, formatted])
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const finish = () => { if (motion.matches) setTransition(current => current.from === current.to ? current : { ...current, from: current.to }) }
    motion.addEventListener('change', finish)
    return () => motion.removeEventListener('change', finish)
  }, [])
  const from = moneyParts(transition.from, currency)
  const to = moneyParts(transition.to, currency)
  const previousCharacters = placedCharacters(from.body)
  const currentCharacters = placedCharacters(to.body)
  const previousDigits = new Map(previousCharacters.flatMap(item => item.place === null ? [] : [[item.place, item.character] as const]))
  const currentDigits = new Map(currentCharacters.flatMap(item => item.place === null ? [] : [[item.place, item.character] as const]))
  const currentSymbols = new Set(currentCharacters.flatMap(item => item.anchor === null ? [] : [`${item.character}:${item.anchor}`]))
  const digitColumns = new Map([...new Set([...previousDigits.keys(), ...currentDigits.keys()])].map(place => {
    const previous = previousDigits.get(place)
    const current = currentDigits.get(place)
    return [place, { previous, current, sequence: digitSequence(previous, current, transition.direction) }] as const
  }))
  const collapseAt = collapseMovesByPlace([...previousDigits.keys()].filter(place => !currentDigits.has(place)).map(place => [place, digitColumns.get(place)!.sequence.length - 1] as const))
  const maxMoves = Math.max(0, ...[...digitColumns.values()].map(column => column.sequence.length - 1))
  const duration = maxMoves === 0 ? 0 : Math.min(800, Math.max(240, maxMoves * 80))
  const stepDuration = maxMoves === 0 ? 0 : duration / maxMoves
  const settlePlace = [...digitColumns].find(([, column]) => column.sequence.length - 1 === maxMoves)?.[0]
  const settle = () => setTransition(current => current.sequence === transition.sequence && current.from !== current.to ? { ...current, from: current.to } : current)
  useEffect(() => {
    if (duration === 0) return
    const timeout = window.setTimeout(() => setTransition(current => current.sequence === transition.sequence ? { ...current, from: current.to } : current), duration + 50)
    return () => window.clearTimeout(timeout)
  }, [duration, transition.sequence])
  const digit = (place: number) => {
    const column = digitColumns.get(place)!
    const moves = column.sequence.length - 1
    const disappearing = column.current === undefined
    const collapseDelay = (collapseAt.get(place) ?? moves) * stepDuration
    if (moves === 0) return <span className={`settlement-money-digit${disappearing ? ' settlement-money-digit-disappearing' : ''}`} data-place={place} key={`digit-${place}`} style={disappearing ? { '--digit-collapse-delay': `${collapseDelay}ms` } as CSSProperties : undefined}>{column.current ?? column.previous}</span>
    const track = transition.direction === 'down' ? [...column.sequence].reverse() : column.sequence
    return <span
      className={`settlement-money-digit settlement-money-digit-changing roll-${transition.direction}${disappearing ? ' settlement-money-digit-disappearing' : ''}`}
      data-current={column.current ?? ''}
      data-place={place}
      data-sequence={column.sequence.join(',')}
      data-track={track.map(character => character || '\u00a0').join('\n')}
      key={`digit-${place}-${transition.sequence}`}
      onAnimationEnd={place === settlePlace ? event => { if (event.animationName === `settlement-digit-roll-${transition.direction}`) settle() } : undefined}
      style={{ '--digit-collapse-delay': `${collapseDelay}ms`, '--digit-duration': `${moves * stepDuration}ms`, '--digit-offset': `${-moves}em` } as CSSProperties}
    ><span>{column.current || '\u00a0'}</span></span>
  }
  const layoutCharacters = previousDigits.size > currentDigits.size ? previousCharacters : currentCharacters
  return <strong aria-atomic="true" aria-label={`${prefix}${transition.to}`} aria-live={announce ? 'polite' : undefined} className={`${className} settlement-animated-money`}>
    <span aria-hidden="true"><span>{prefix}{to.prefix}</span>{layoutCharacters.map(item => {
      if (item.place === null) {
        const disappearing = transition.from !== transition.to && !currentSymbols.has(`${item.character}:${item.anchor}`)
        const symbolMoves = collapseAt.get(item.anchor ?? -1) ?? 0
        return <span className={disappearing ? 'settlement-money-symbol-disappearing' : undefined} data-anchor={item.anchor ?? undefined} key={`symbol-${item.index}`} style={disappearing ? { '--symbol-delay': `${symbolMoves * stepDuration}ms` } as CSSProperties : undefined}>{item.character}</span>
      }
      return digit(item.place)
    })}<span>{to.suffix}</span></span>
  </strong>
}
