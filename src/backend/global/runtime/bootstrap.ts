import { networkInterfaces } from 'node:os';
import { createBackend } from '../../domain/main';
import { RuntimeLifecycle } from './runtimeLifecycle';

function serverPort(value: string | undefined, name: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Invalid ${name}`);
  return port;
}

export async function bootstrap() {
  const development = process.env.NODE_ENV !== 'production';
  const port = serverPort(process.env.PORT || '3000', 'PORT');
  const metricsPort = process.env.METRICS_PORT
    ? serverPort(process.env.METRICS_PORT, 'METRICS_PORT')
    : undefined;
  if (metricsPort === port)
    throw new Error('METRICS_PORT must differ from PORT');
  const host = process.env.HOST || (development ? '0.0.0.0' : '127.0.0.1');
  const backend = await createBackend(async (app) => {
    // Preserve the successful exit-code contract after all framework shutdown hooks finish.
    app.enableShutdownHooks(['SIGTERM', 'SIGINT'], { useProcessExit: true });
    await app.get(RuntimeLifecycle).prepare(app, {
      frontend: { dev: development, port },
      metricsPort,
      host,
    });
  });
  try {
    await backend.app.listen(port, host);
  } catch (error) {
    await backend.app.close();
    throw error;
  }
  const allInterfaces = host === '0.0.0.0' || host === '::';
  const localHost = allInterfaces
    ? 'localhost'
    : host.includes(':')
      ? `[${host}]`
      : host;
  console.log(`Ready on port ${port}\n  Local:   http://${localHost}:${port}`);
  if (allInterfaces) {
    const addresses = new Set(
      Object.values(networkInterfaces()).flatMap((entries) =>
        (entries ?? [])
          .filter((entry) => entry.family === 'IPv4' && !entry.internal)
          .map((entry) => entry.address),
      ),
    );
    for (const address of addresses)
      console.log(`  Network: http://${address}:${port}`);
  }
}
