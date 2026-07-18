# 第 38 节：Dockerfile + 部署 —— 把云 agent 服务跑起来

> 前 7 节写完了完整的云 agent server，但一直在本地 `npx tsx` 跑。这节课把它打包成 Docker 镜像，用 `docker compose` 一键拉起 server + Redis，配 nginx 做负载均衡和 TLS 终止。这是云化的最后一步——从「能跑」到「能部署、能扩展、能运维」。

## 目标

- 多阶段 Dockerfile：构建期编译 TS，运行期只带 `dist/` + `node_modules` + 源码（tsx 模式），最小化镜像
- `docker-compose.yml`：一键起 server（可水平扩展）+ Redis + nginx
- nginx 配置：sticky session + WebSocket upgrade + TLS 终止（生产前置 HTTPS）
- 健康检查、资源限制、日志策略
- 理解「开发态 vs 生产态」：开发用 tsx 热重载，生产用编译产物

## 知识准备

### 为什么用 Docker？

云 agent 服务相比普通 web app 有两个特殊需求：
1. **bash 工具的隔离**（这节课不深入）：agent 跑 `bash` 工具时，容器化能把每个 session 的文件系统、进程空间隔离——这是 kimi-code 的 `kaos` 包想做的事（它的 `container` 后端目前只有注释）。
2. **可复现部署**：环境、依赖、Node 版本锁死在镜像里，不会出现「我机器上能跑」。

这节先做部署容器化（需求 2），bash 工具的 per-session 容器化是更深的议题（对照 `kaos` 的设计，超出本课范围，自检里点出方向）。

### 多阶段构建的必要性

mini-pi 编译后产物很小（几 KB 的 JS + `node_modules/ioredis`），但构建期需要 `typescript` + `tsx` + 全部 source。如果全打进一个镜像：
- 镜像体积大（200MB+）
- 攻击面大（攻击者拿到镜像能读到全部源码）
- 构建慢（每次都装 dev 依赖）

多阶段构建：第一阶段装全部依赖 + 编译；第二阶段只复制 `dist/` + 生产 `node_modules`。最终镜像小一个数量级。

### TLS 终止为什么要放 nginx？

mini-pi server 本身**不做 TLS**——和 kimi-code 的 `kap-server` 策略一致（`start.ts:195-202` 明确「terminate TLS at a reverse proxy」）。原因：
- TLS 证书管理（Let's Encrypt 续期、OCSP stapling）nginx 做得最成熟
- 多节点时证书只需配一次（nginx 层），server 节点都用 HTTP
- 性能：nginx 的 TLS 实现（BoringSSL）比 Node 快

## 代码实战

### 1. `Dockerfile`：多阶段构建

```dockerfile
# mini-pi/Dockerfile

# ===== 阶段 1：构建 =====
FROM node:22-alpine AS builder

WORKDIR /app

# 先复制 package.json + lock，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm ci

# 复制源码
COPY tsconfig.json ./
COPY src/ ./src/

# 编译
RUN npm run build

# 裁剪 dev 依赖（只留生产依赖）
RUN npm prune --production

# ===== 阶段 2：运行 =====
FROM node:22-alpine AS runner

WORKDIR /app

# 安全：用非 root 用户跑
RUN addgroup -S mini_pi && adduser -S mini_pi -G mini_pi

# 只复制必要文件
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# 数据目录（session 文件、用户数据、jwt secret）
RUN mkdir -p /data && chown mini_pi:mini_pi /data
VOLUME /data

USER mini_pi

ENV MINI_PI_HOST=0.0.0.0
ENV MINI_PI_PORT=3000
ENV MINI_PI_DATA_DIR=/data

EXPOSE 3000

# healthcheck：每 30s 打 healthz
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
	CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "dist/server/main.js"]
```

**几个设计点**：

**`node:22-alpine` 而非 `node:22`**：Alpine Linux 镜像 ~50MB vs Debian 版 ~900MB。安全角度 Alpine 也更好（自带 musl libc，更少已知漏洞）。代价是某些 native 模块要重编译，但 mini-pi 只用 `ioredis`（纯 JS），无此问题。

**`npm ci` 而非 `npm install`**：`ci` 严格按 lock 文件装，更快、更可复现、不会改 lock。

**非 root 用户**：即使容器内 agent 被 RCE 拿到 shell，也只是 `mini_pi` 用户权限，不能改容器内系统文件。纵深防御。

**`VOLUME /data`**：session 文件、用户数据、JWT secret 都落 `/data`。容器销毁后数据保留（通过 volume mount）。`main.ts` 要改成读 `MINI_PI_DATA_DIR`。

### 2. `server/main.ts`：数据目录参数化

```ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const dataDir = process.env.MINI_PI_DATA_DIR ?? `${cwd}/.mini-pi`;
await mkdir(dataDir, { recursive: true });

const sessionsDir = join(dataDir, "server-sessions");
const usersFile = join(dataDir, "users.json");
const secretFile = join(dataDir, "jwt-secret");

await mkdir(sessionsDir, { recursive: true });

// ... 其余初始化 ...
```

这样容器和本地开发共用代码，只是 `MINI_PI_DATA_DIR` 不同。

### 3. `docker-compose.yml`：server + Redis + nginx

```yaml
# mini-pi/docker-compose.yml
version: "3.9"

services:
	redis:
		image: redis:7-alpine
		restart: unless-stopped
		# 持久化（可选，pub/sub 本身不持久化，但留个 option）
		command: redis-server --appendonly yes
		volumes:
			- redis-data:/data
		healthcheck:
			test: ["CMD", "redis-cli", "ping"]
			interval: 10s
			timeout: 3s
			retries: 3

	mini-pi-1:
		build: .
		restart: unless-stopped
		environment:
			OPENAI_API_KEY: ${OPENAI_API_KEY}
			OPENAI_BASE_URL: ${OPENAI_BASE_URL:-https://api.openai.com/v1}
			OPENAI_MODEL: ${OPENAI_MODEL:-gpt-4o-mini}
			REDIS_URL: redis://redis:6379
			MINI_PI_DATA_DIR: /data
		volumes:
			- mini-pi-data:/data
		depends_on:
			redis:
				condition: service_healthy
		deploy:
			resources:
				limits:
					memory: 512M
					cpus: "0.5"

	mini-pi-2:
		build: .
		restart: unless-stopped
		environment:   # 和 mini-pi-1 一致
			OPENAI_API_KEY: ${OPENAI_API_KEY}
			OPENAI_BASE_URL: ${OPENAI_BASE_URL:-https://api.openai.com/v1}
			OPENAI_MODEL: ${OPENAI_MODEL:-gpt-4o-mini}
			REDIS_URL: redis://redis:6379
			MINI_PI_DATA_DIR: /data
		volumes:
			- mini-pi-data:/data   # ★ 共享同一个 volume！
		depends_on:
			redis:
				condition: service_healthy

	nginx:
		image: nginx:alpine
		restart: unless-stopped
		ports:
			- "80:80"
			- "443:443"
		volumes:
			- ./nginx.conf:/etc/nginx/nginx.conf:ro
			- ./certs:/etc/nginx/certs:ro   # TLS 证书（自签或 Let's Encrypt）
		depends_on:
			- mini-pi-1
			- mini-pi-2

volumes:
	redis-data:
	mini-pi-data:
```

**关键设计**：

**两个 server 节点共享 `mini-pi-data` volume**：这是教学简化——两个容器看同一个文件系统。生产里要用 NFS / 分布式文件系统（GlusterFS、EFS）或改成 per-node 存储 + session 重建。这里共享让我们能看到「节点 A 创建的 session，节点 B 能 resume」的实际效果。

**Redis 持久化**：pub/sub 本身不持久化（消息发出去就丢），但 `--appendonly yes` 开了 AOF 以防 Redis 重启丢一些状态（虽然这节的 broadcaster 不依赖 Redis 持久化）。真正生产要持久化的是 session 文件（在 `mini-pi-data` volume 里），不是 Redis。

**`deploy.resources.limits`**：限制单容器 CPU/内存。防一个节点的 agent 跑飞拖垮宿主机。

### 4. `nginx.conf`：负载均衡 + sticky + WS + TLS

```nginx
# mini-pi/nginx.conf
events {
	worker_connections 1024;
}

http {
	upstream mini_pi_backend {
		# sticky：按 sessionId 哈希
		# 从 URL 路径提取：/sessions/<id>/... 或 /sessions/<id>/ws
		# nginx 的 $request_uri 里能正则提取，这里用 map 简化
		hash $session_id consistent;
		server mini-pi-1:3000;
		server mini-pi-2:3000;
	}

	# 从 URI 提取 sessionId
	map $request_uri $session_id {
		default "";
		~^/sessions/(?<s>[^/]+) $s;
	}

	server {
		listen 80;
		# 生产：301 到 443
		return 301 https://$host$request_uri;
	}

	server {
		listen 443 ssl;
		http2 on;

		ssl_certificate /etc/nginx/certs/cert.pem;
		ssl_certificate_key /etc/nginx/certs/key.pem;
		ssl_protocols TLSv1.2 TLSv1.3;

		location / {
			proxy_pass http://mini_pi_backend;
			proxy_http_version 1.1;
			proxy_set_header Host $host;
			proxy_set_header X-Real-IP $remote_addr;
			proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
			proxy_set_header X-Forwarded-Proto $scheme;

			# WebSocket upgrade
			proxy_set_header Upgrade $http_upgrade;
			proxy_set_header Connection $connection_upgrade;

			# SSE / WS：禁用 buffering，长连接
			proxy_buffering off;
			proxy_cache off;
			proxy_read_timeout 86400;   # WS 长连接不主动断
			proxy_send_timeout 86400;
		}
	}

	# WS upgrade 用的 map
	map $http_upgrade $connection_upgrade {
		default upgrade;
		"" close;
	}
}
```

**关键点**：

**`hash $session_id consistent`**：sticky。同一 session 落同一节点，保证 `Agent` 实例在本地 `pool` 里。节点挂了，新请求会被 rehash 到其他节点，那个节点会 `Agent.resume()` 从磁盘重建——session 不丢，只是内存中的 Agent 状态丢。

**`map $request_uri $session_id`**：从 `/sessions/sess_xxx/...` 提取 `sess_xxx`。这是 nginx 风格的 URI 解析。

**`proxy_buffering off`**：SSE 和 WS 必须！默认 nginx 会攒批响应，流式体验会变成「等几秒一次吐一大坨」。

**`proxy_read_timeout 86400`**：WS 连接默认 60 秒无数据会被 nginx 断。设 1 天，让长连接保持。

### 5. 生产前置：TLS 证书

```bash
# 开发自签（测试用）
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout certs/key.pem -out certs/cert.pem \
  -days 365 -subj "/CN=localhost"

# 生产：Let's Encrypt + certbot（certbot 自管 nginx 配置）
```

## 运行：完整部署

```bash
cd mini-pi

# 1. 配置环境变量
echo "OPENAI_API_KEY=sk-..." > .env

# 2. 一键拉起
docker compose up -d --build
# → 创建网络、起 redis、构建 mini-pi 镜像、起 mini-pi-1/2、起 nginx

# 3. 查看状态
docker compose ps
#NAME           STATUS                    PORTS
#mini-pi-1      Up (healthy)              3000/tcp
#mini-pi-2      Up (healthy)              3000/tcp
#nginx          Up                        0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
#redis          Up (healthy)              6379/tcp

# 4. 测试（通过 nginx）
curl -k https://localhost/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
# → {"user":...,"token":"..."}

# 5. 建 session
curl -k -X POST https://localhost/sessions \
  -H "Authorization: Bearer $TOKEN"
# → {"sessionId":"sess_xxx"}（可能落到节点 1 或 2）

# 6. WebSocket 连接（通过 nginx）
# 在 test-ws.mjs 里改 wss://localhost/sessions/.../ws?token=...

# 7. 模拟节点挂掉
docker compose stop mini-pi-1
# → nginx 探活失败，摘掉 mini-pi-1
# → 新请求自动落 mini-pi-2
# → 已有 session 的 agent 在 mini-pi-1 的内存里丢了，
#    但下一个请求落 mini-pi-2 会 resume 重建

# 8. 拉起节点 1
docker compose start mini-pi-1
# → nginx 重新加回
```

## 与 kimi-code 对照

| 维度 | mini-pi（这节） | kimi-code |
|---|---|---|
| Dockerfile | 多阶段、Alpine、非 root | 仅有 klient e2e 用的测试 Dockerfile |
| docker-compose | server + Redis + nginx | ❌ |
| 多节点 | docker compose scale | ❌（单进程设计） |
| TLS 终止 | nginx | 建议但未配（"terminate TLS at a reverse proxy"） |
| healthz | `GET /healthz` | `GET /healthz`（`registerApiV1Routes.ts`） |
| nginx 配置 | sticky + WS upgrade | ❌ |
| 原生二进制 | ❌ | ✅（`apps/kimi-code` 的 SEA + Nix 构建） |

**关键洞察**：kimi-code 在**发布形态**上走了一条完全不同的路——它用 **Nix + Node SEA** 把 CLI 打包成单个原生二进制（`apps/kimi-code` 的 `build:native:sea` 脚本），因为它的定位是「用户本地跑的 CLI 工具」，不是「云服务」。二进制的好处是零依赖、单文件、安装即用。

我们的 mini-pi 云版选 Docker 路线，因为定位是「云服务」——容器化是云部署的事实标准。这不是 kimi-code 落后，而是产品形态差异。理解这个差异，你就理解了「CLI 产品」和「云服务」的工程取舍。

**延伸思考**：如果把 mini-pi 也做成 CLI（前 30 节的形态）+ 云服务（这 8 节的形态）双形态，像 kimi-code 那样「同一份代码两种部署」，需要什么？
- CLI 形态用 `cli.ts`（已有）
- 云服务形态用 `server/main.ts`（已有）
- 共用 `src/agent/` `src/session/` `src/tools/`（已共用）
- CLI 形态可选打包成 SEA（学 kimi-code），云服务形态 Docker 化（这节）

我们的 mini-pi 架构已经支撑了这种双形态——这就是分层设计的红利。

## 自检

- [ ] 多阶段 Dockerfile 相比单阶段节省了什么？为什么不能用 `.dockerignore` 解决？
- [ ] 两个 server 节点共享 `mini-pi-data` volume。生产里这样做有什么风险？（提示：并发写、文件锁、单点故障）
- [ ] `proxy_buffering off` 为什么是 SSE/WS 必备？开着会怎样？
- [ ] sticky session 下，如果节点 1 挂了，连在节点 1 的 WebSocket 客户端会怎样？怎么恢复？（提示：客户端重连，重新落到节点 2，session 从磁盘 resume）
- [ ] 思考题：怎么实现「bash 工具的 per-session 容器隔离」？（提示：bash 工具改成 spawn 一个 docker container，挂载该 session 的工作目录。这是 kimi-code `kaos` 包想做但没做的事）
- [ ] 思考题：如果用 k8s 而不是 docker compose，需要改什么？（提示：Deployment + Service + Ingress + HPA；sticky 用 Service 的 `sessionAffinity`）

## 产出

- `Dockerfile` —— 多阶段构建（builder + runner）
- `docker-compose.yml` —— server × 2 + Redis + nginx
- `nginx.conf` —— sticky + WS upgrade + TLS
- `server/main.ts` —— 参数化 `MINI_PI_DATA_DIR`
- **mini-pi 现在是一个完整的云 agent 服务了** 🎓

## 阶段 9 总结：从 CLI 到云服务的完整链路

回顾这 8 节，我们沿着清晰的递进路线，把一个本地 CLI 改造成了多用户云服务：

| 节 | 主题 | 核心能力 |
|---|---|---|
| 31 | HTTP server 基础 | `node:http` 包裹 Agent |
| 32 | SSE 流式 | 事件驱动 → 网络流 |
| 33 | Session REST API | 跨请求对话延续 |
| 34 | JWT 认证 | per-user 身份 |
| 35 | per-user 隔离 | 存储 + 越权防护 |
| 36 | WebSocket | 双向实时 + 多端订阅 |
| 37 | Redis pub/sub | 水平扩展 |
| 38 | Dockerfile + nginx | 容器化部署 |

**架构演进的本质**：前 30 节攒下的解耦设计——`Agent` 类与 I/O 无关、`AgentEventEmitter` 事件抽象、`Session` 纯逻辑持久化、`Tool` 接口无状态——让云化改造**没动一行业务代码**。所有改动都在新的 `server/` 层：包裹 Agent、加路由、加认证、加隔离、加广播、加部署。这就是分层架构的回报。

**对照 kimi-code**：`kap-server` 走到了我们的 L33-L34 之间——它有 HTTP + SSE + WS + Session，但没有用户、没有 per-user 隔离、没有水平扩展、没有部署清单。我们的 mini-pi 通过这 8 节**走到了 kimi-code 前面**——不是因为 kimi-code 不会做，而是它的定位是「单用户本地工具」，云化不是它的目标。理解这个差异，你就理解了「为什么架构要按产品定位分层」。

**没做的**（自检方向）：
- bash 工具的容器沙箱（per-session 隔离执行环境，对照 `kaos`）
- session 的 LRU 淘汰 + idle timeout
- token refresh 机制
- 审计日志 + 计费（per-user token 用量）
- k8s manifest（Deployment + HPA + Ingress）

这些是真正的生产化方向，但超出 8 节入门课的范围。学完这阶段，你应该有信心读 kimi-code 的 `kap-server` 源码，并理解它每一个设计决策的取舍。
