import nextEnvironment from '@next/env';

// Load environment values before importing modules that read configuration.
nextEnvironment.loadEnvConfig(
  process.cwd(),
  process.env.NODE_ENV !== 'production',
);
const { bootstrap } = await import('./global/runtime/bootstrap');
await bootstrap();
