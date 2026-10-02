import { registerHooks } from 'node:module'

// Node tests execute server code outside Next.js, which normally resolves this marker.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'server-only' ? 'next/dist/compiled/server-only/empty.js' : specifier, context)
  },
})
