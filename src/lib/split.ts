export function splitAmounts(total: number, people: number) {
  const base = Math.floor(total / people)
  const remainder = total % people

  return Array.from({ length: people }, (_, index) => base + (index < remainder ? 1 : 0))
}
