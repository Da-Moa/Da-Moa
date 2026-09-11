import nextEnv from '@next/env'
import { retryDisconnect } from '../src/lib/openbanking-store.ts'

nextEnv.loadEnvConfig(process.cwd())
// Run with node --import tsx scripts/retry-openbanking-disconnect.mjs from the scheduler.
// Unknown remote outcomes require operator/provider confirmation; this command never blindly retries them.
// After fixing a confirmed configuration/credential rejection, --retry-rejected resumes those paused items.
if (process.argv.slice(2).some(value => value !== '--retry-rejected')) throw new Error('Only --retry-rejected is supported')
const result = await retryDisconnect(undefined, { retryRejected: process.argv.includes('--retry-rejected') })
console.info('Open banking disconnect cleanup', result)
if (result.pending || result.needsOperator) process.exitCode = 1
