export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build'
      && (process.env.DATABASE_URL || process.env.POSTGRES_URL) && process.env.RECEIPT_WORKER_ENABLED !== 'false') {
    const { startReceiptWorker } = await import('./Domain/Settle/Backend')
    await startReceiptWorker()
  }
}
