FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.7.0
WORKDIR /app

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/context/package.json ./packages/context/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/plugins/package.json ./packages/plugins/package.json
COPY packages/workflow/package.json ./packages/workflow/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm db:generate
ENV API_URL=http://api:3001
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000 3001
CMD ["node", "apps/api/dist/main.js"]
