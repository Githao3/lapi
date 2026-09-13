# ---------- build stage: compile the web console ----------
FROM node:24-alpine AS build
# 国内服务器可传 --build-arg NPM_REGISTRY=https://registry.npmmirror.com 加快依赖安装
ARG NPM_REGISTRY=https://registry.npmjs.org
# SKIP_WEB_BUILD=1 = 前端产物已在宿主机构建好（web/dist 随代码一起上传），
# 镜像内不再装 devDependencies、不跑 vite —— 内存紧张的服务器用这个模式。
ARG SKIP_WEB_BUILD=0
WORKDIR /app
RUN npm config set registry "$NPM_REGISTRY" && npm install -g pnpm@10 && pnpm config set registry "$NPM_REGISTRY"
COPY package.json pnpm-lock.yaml ./
RUN if [ "$SKIP_WEB_BUILD" != "1" ]; then pnpm install --frozen-lockfile; else echo "[build] 跳过 devDependencies 安装"; fi
COPY . .
RUN if [ "$SKIP_WEB_BUILD" = "1" ]; then \
      test -f web/dist/index.html || { echo "[build] SKIP_WEB_BUILD=1 但上下文里没有 web/dist，请先在本机 pnpm build 并上传 web/dist"; exit 1; }; \
      echo "[build] 使用预先构建的 web/dist"; \
    else pnpm build; fi

# ---------- runtime: relay + console, no dev tooling ----------
FROM node:24-alpine
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
ENV NODE_ENV=production \
    LAPI_DB=/data/lapi.db
RUN npm config set registry "$NPM_REGISTRY" && npm install -g pnpm@10 && pnpm config set registry "$NPM_REGISTRY"
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
