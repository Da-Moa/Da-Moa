/** @type {import('next').NextConfig} */
export default {
  allowedDevOrigins: (process.env.NEXT_DEV_ALLOWED_ORIGINS ?? '192.168.219.141').split(',').map(origin => origin.trim()).filter(Boolean),
}
