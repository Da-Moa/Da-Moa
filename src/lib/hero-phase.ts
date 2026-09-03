export function heroPhase(scrolled: number) {
  if (scrolled >= 230) return 2
  if (scrolled >= 18) return 1
  return 0
}
