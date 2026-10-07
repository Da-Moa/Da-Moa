/** @type {import('next').NextConfig} */
export default {
  experimental: { proxyClientMaxBodySize: 11 * 1024 * 1024 },
  serverExternalPackages: ['graphile-worker'],
  allowedDevOrigins: (process.env.NEXT_DEV_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean),
}
