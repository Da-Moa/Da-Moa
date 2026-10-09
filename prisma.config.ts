import { defineConfig } from 'prisma/config';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL || process.env.POSTGRES_URL },
});
