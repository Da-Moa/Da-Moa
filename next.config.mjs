import { networkInterfaces } from 'node:os'

const networkAddresses = Object.values(networkInterfaces()).flatMap(entries => (entries ?? [])
  .filter(entry => entry.family === 'IPv4' && !entry.internal)
  .map(entry => entry.address))

/** @type {import('next').NextConfig} */
export default {
  experimental: { proxyClientMaxBodySize: 11 * 1024 * 1024 },
  serverExternalPackages: ['graphile-worker'],
  allowedDevOrigins: process.env.NEXT_DEV_ALLOWED_ORIGINS === undefined
    ? [...new Set(['192.168.219.141', ...networkAddresses])]
    : process.env.NEXT_DEV_ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean),
}
