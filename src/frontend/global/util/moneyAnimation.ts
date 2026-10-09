export function digitSequence(previous: string | undefined, current: string | undefined, direction: 'up' | 'down'): string[] {
  if (previous === current) return [current ?? '']
  if (previous === undefined) return ['', ...digitSequence('0', current, direction)]
  const target = current ?? '0'
  const sequence = [previous]
  let value = Number(previous)
  while (String(value) !== target) {
    value = (value + (direction === 'up' ? 1 : 9)) % 10
    sequence.push(String(value))
  }
  return sequence
}

export function collapseMovesByPlace(columns: Iterable<readonly [number, number]>): Map<number, number> {
  const result = new Map<number, number>()
  let moves = 0
  for (const [place, ownMoves] of [...columns].sort(([left], [right]) => right - left)) {
    moves = Math.max(moves, ownMoves)
    result.set(place, moves)
  }
  return result
}
