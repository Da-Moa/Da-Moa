FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/Da-Moa/Da-Moa"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
