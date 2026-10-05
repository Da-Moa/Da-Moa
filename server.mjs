import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import next from 'next'
import { createWsController } from './src/Global/Websocket/Backend/Controller/ws-controller.mjs'
import { collectDatabaseMetrics, httpMetrics, trackHttpResponse } from './src/lib/http-metrics.mjs'

const portArg = process.argv.findIndex(value => value === '--port' || value === '-p')
const port = Number(portArg < 0 ? process.env.PORT || 3000 : process.argv[portArg + 1])
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
const metricsPort = process.env.METRICS_PORT ? Number(process.env.METRICS_PORT) : null
if (metricsPort !== null && (!Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65535 || metricsPort === port)) throw new Error('Invalid METRICS_PORT')
const websocket = createWsController(port)
const server = createServer((request, response) => {
  if (websocket.handleRequest(request, response)) return
  if (metricsPort !== null) trackHttpResponse(request, response)
  void handle(request, response)
})
const app = next({ dev: process.env.NODE_ENV !== 'production', httpServer: server, port })
const handle = app.getRequestHandler()
server.on('upgrade', websocket.handleUpgrade)
server.on('close', websocket.close)

await app.prepare()
if (metricsPort !== null) {
  await collectDatabaseMetrics()
  setInterval(collectDatabaseMetrics, 30000).unref()
}
if (metricsPort !== null) createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/metrics') { response.writeHead(404).end(); return }
  response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' }).end(httpMetrics())
}).listen(metricsPort, process.env.HOST || '127.0.0.1')
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0')
server.listen(port, host, () => {
  const listensOnAllInterfaces = host === '0.0.0.0' || host === '::'
  const localHost = listensOnAllInterfaces ? 'localhost' : host.includes(':') ? `[${host}]` : host
  console.log(`Ready on port ${port}`)
  console.log(`  Local:   http://${localHost}:${port}`)
  if (listensOnAllInterfaces) {
    const addresses = new Set(Object.values(networkInterfaces()).flatMap(entries => (entries ?? [])
      .filter(entry => entry.family === 'IPv4' && !entry.internal)
      .map(entry => entry.address)))
    for (const address of addresses) console.log(`  Network: http://${address}:${port}`)
  }
})
