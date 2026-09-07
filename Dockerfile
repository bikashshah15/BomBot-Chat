FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=postgresql://build@127.0.0.1:5432/build
ENV PROFILE=local
ENV LLM_BASE_URL=http://127.0.0.1:11434/v1
ENV LLM_MODEL=build-only
ENV OSV_MODE=offline
ENV RETENTION=ephemeral
ENV LLM_TEMPERATURE=0
ENV LLM_TOP_P=1
ENV LLM_MAX_OUTPUT_TOKENS=4096
ENV LLM_SEED=null
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/lib ./lib
COPY --from=builder --chown=node:node /app/scripts ./scripts
USER node
EXPOSE 3000
CMD ["node", "server.js"]
