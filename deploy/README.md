# 部署到 Linux 服务器（Docker + 公网直连）

本目录是把 lapi 放到公网服务器上的一套文件。Windows 本机那份继续跑它自己的
`data/`，两者只共享 git 代码，互不影响。

## 两套凭据（先分清，再动手）

| 凭据 | 谁拿着 | 能做什么 | 存在哪 |
| --- | --- | --- | --- |
| **用户 key**（`LAPI_GATEWAY_TOKEN`） | 你发给使用者 | 只能调用 `/v1` 转发；**打不开面板**，看不到渠道与上游 key | 面板「访问凭据」可改 |
| **管理密码**（`LAPI_ADMIN_PASSWORD`） | 只有你自己 | 登录面板，管理渠道、上游 key、日志、设置 | 面板里只写不读，从不返回给浏览器 |

绑定 `127.0.0.1`（本机自用）时两者都不校验，和原来完全一样；一旦绑定到
`0.0.0.0` 或其它地址，两者都必须设置，否则服务会拒绝相应请求（fail-closed）。

## 前置条件

- 服务器：Linux，已装 Docker 与 `docker compose` 插件。
- 一个域名，A 记录指向服务器公网 IP；80/443 端口可访问（Caddy 自动签证书用）。
- 反代选 Caddy（本文示例）或 Nginx + certbot 均可。

## 步骤

### 1. 把代码放到服务器

```bash
git clone <你的仓库地址> /opt/lapi      # 建议把本分支合并进 main 后再 clone
cd /opt/lapi
```

### 2. 生成两条随机凭据

```bash
openssl rand -hex 24   # → 管理密码
openssl rand -hex 24   # → 用户 key（两条不要相同）
```

### 3. 配置并启动

```bash
cd /opt/lapi/deploy
cp .env.example .env
vi .env                 # 填入上面两条随机串
docker compose up -d --build
docker compose logs -f --tail=50
```

构建慢或超时（国内服务器常见）：拉基础镜像慢就给 Docker 配镜像加速器（各云厂商控制台
有专属地址，写进 `/etc/docker/daemon.json` 的 `registry-mirrors`）；装 npm 依赖慢就在
`.env` 里取消 `NPM_REGISTRY=https://registry.npmmirror.com` 的注释再重新 build。

服务器内存紧张（vite 打包峰值要几百 MB，1.6G 小机器上跑别的服务时会拖垮整机）就用低内存模式：
在本机 `pnpm build` 出 `web/dist`，把它和代码一起上传，然后在 `.env` 里设 `SKIP_WEB_BUILD=1`。
这样镜像内只装生产依赖（express/undici，几十 MB），完全不跑 vite。

```bash
# 本机
pnpm build && scp -r web/dist user@服务器:/opt/lapi/web/
# 服务器
cd /opt/lapi/deploy && echo 'SKIP_WEB_BUILD=1' >> .env && docker compose up -d --build
```

启动后容器只监听宿主机 `127.0.0.1:8787`（见 `docker-compose.yml` 的 ports），
公网入口全部交给 Caddy：

```bash
curl -sS http://127.0.0.1:8787/api/session   # 应返回 {"ok":true,...,"auth_required":true}
```

宿主机 8787 已被别的程序占用时，把 `docker-compose.yml` 里映射的**左边**数字改掉
（如 `127.0.0.1:18787:8787`），Caddyfile 里的 `reverse_proxy` 目标同步改；容器内的
`LAPI_PORT` 保持 8787 不动。

### 4. 配 HTTPS 入口

装了 Caddy 的话：

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile      # 先把域名替换成你自己的
sudo systemctl reload caddy
```

不想在宿主机装 Caddy，就用容器跑（占宿主机 80/443，反代到宿主回环的 8787）：

```bash
docker run -d --name caddy --restart unless-stopped --network host \
  -v /opt/lapi/deploy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v caddy_data:/data -v caddy_config:/config caddy:2
```

Nginx 用户注意两点：`proxy_buffering off;`（SSE 必需）和放宽 `proxy_read_timeout`。

浏览器打开 `https://你的域名`，用**管理密码**登录面板，在「渠道」页添加上游渠道。

### 5. 发给使用者

只给他们两样东西：

- `base_url`: `https://你的域名`
- `key`: **用户 key**（不是管理密码）

Claude Code / claude CLI：

```bash
export ANTHROPIC_BASE_URL=https://你的域名
export ANTHROPIC_AUTH_TOKEN=用户key        # 或 ANTHROPIC_API_KEY，两者都会带上
```

OpenAI 兼容客户端：

```bash
export OPENAI_BASE_URL=https://你的域名/v1
export OPENAI_API_KEY=用户key
```

拿到用户 key 的人只能调 `/v1/*` 转发；访问面板会得到 401，拿不到任何上游信息。

## 日常运维

```bash
# 升级（代码更新后）
cd /opt/lapi && git pull && cd deploy && docker compose up -d --build

# 改配置：优先在面板「设置 → 访问凭据」里改（改完要重启容器才换监听地址，改凭据立即生效）
docker compose restart

# 备份：整个 data 目录就是全部数据（含明文上游 key，注意权限）
chmod 700 /opt/lapi/deploy/data
tar czf lapi-backup-$(date +%F).tar.gz -C /opt/lapi/deploy data

# 看日志
docker compose logs -f --tail=100
```

`deploy/data/lapi.db` 里存着明文的上游 key，和本机同策略；别把它放进任何同步盘或
公开备份。

## 环境变量与面板的关系

`LAPI_BIND` / `LAPI_PORT` / `LAPI_ADMIN_PASSWORD` / `LAPI_GATEWAY_TOKEN` 只在
「数据库里还没有这个设置」时生效，用来做首次引导。一旦在面板里保存过某项，
之后就以面板里的值为准（环境变量不再覆盖它）。所以忘记管理密码时：

```bash
sqlite3 deploy/data/lapi.db "DELETE FROM settings WHERE key='admin_password';"
docker compose restart      # 重新落到 .env 里的 LAPI_ADMIN_PASSWORD
```

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| 面板返回 503 `admin password not configured` | 首次启动没给 `LAPI_ADMIN_PASSWORD`，补进 `.env` 后 `docker compose up -d` |
| 转发返回 503 `requires a relay key` | 同上，缺 `LAPI_GATEWAY_TOKEN` |
| 转发返回 401 `invalid gateway key` | 使用者填错 key：要填**用户 key**，不是管理密码 |
| 登录返回 429 | 密码连续输错触发了限速，等提示的秒数或改 `.env` 里的密码 |
| `docker build` 卡在 npm 或超时 | 国内网络：`.env` 里启用 `NPM_REGISTRY=https://registry.npmmirror.com` |
| `docker pull` 拉不动基础镜像 | 给 Docker 配 `registry-mirrors`（用云厂商控制台给的专属加速地址） |
| 容器起了但 `curl 127.0.0.1:8787` 连不上 | 看 `docker compose logs`；多半是宿主机端口被占，改映射左侧端口 |
| 流式回答变成一次性输出 | 反代缓冲了 SSE：Caddy 用 `flush_interval -1`，Nginx 用 `proxy_buffering off` |
| 端口和预期不一致 | 端口被占用时服务会自动顺延并写回设置；`docker-compose.yml` 的映射要跟着改 |
