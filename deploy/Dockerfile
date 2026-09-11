# ---------- build stage: compile the web console ----------
FROM node:24-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---------- runtime: relay + console, no dev tooling ----------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    LAPI_DB=/data/lapi.db
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY server ./server
COPY --from=build /app/web/dist ./web/dist
VOLUME /data
EXPOSE 8787
# /api/session answers before the auth guard, so it reports liveness only.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LAPI_PORT||8787)+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings", "server/index.js"]
