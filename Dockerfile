# 两阶段构建：
#   stage 1 (builder): oven/bun:1 装依赖 + bun build 出 JS bundle + 砍 devDeps
#   stage 2 (runtime): oven/bun:1 只拷 dist + prod node_modules
#
# Bun runtime 跟基础镜像共用，不重复装（对比 bun build --compile 方案省 ~60MB）。
# 启动 CMD 直接 bun dist/main.js。
#
# 升级到 Bun runtime 的原因（与 uart-pesiv-node 对齐）：
#   - 干掉 axios / tsc / ncc / nodemon 整条旧链路
#   - bun build 直接出 JS bundle，Bun runtime 解释执行
#   - 原生 fetch / AbortSignal.timeout / net API 全支持

# ---- 1. builder: 装依赖 + bun build ----
FROM oven/bun:1 AS builder

WORKDIR /app

# 先 copy lockfile + manifest，让依赖装到独立 layer，源码变动不重装
COPY package.json bun.lock* ./
# build 需要 typescript / @types/bun 这种 devDep，不能 --production
RUN bun install --frozen-lockfile

# 再 copy 源码做 build（.dockerignore 已排掉 dist/ node_modules/ .git/）
COPY tsconfig.json ./
COPY src ./src
# 出 JS bundle（不是 --compile 单文件，让 runtime 镜像里复用 oven/bun:1 自带的 Bun）
RUN bun build ./src/main.ts --target=bun --outdir=dist --minify

# 砍掉 devDependencies，只留 prod deps 拷到 runtime stage
RUN bun install --frozen-lockfile --production

# ---- 2. runtime: 只带 prod deps + 编译产物 ----
FROM oven/bun:1 AS runtime

WORKDIR /app

# 拷 prod 依赖（已经是 production 树）
COPY --from=builder /app/node_modules ./node_modules
# 拷编译产物（JS bundle）
COPY --from=builder /app/dist ./dist
# package.json 留着方便 metadata 排查（不影响启动）
COPY package.json ./

ENV NODE_ENV=production

# DTU 设备通过 TCP 连进来（port 9000，与旧 config.localport 一致）
EXPOSE 9000

# PR #20 鉴权：NODE_TOKEN 必须通过运行时注入（k8s secret / docker --env）
# 不要在 Dockerfile 里 ARG/ENV 写明文 token，会进镜像层
# 部署示例：
#   docker run -d --name uartnode \
#     -e NODE_TOKEN=<plainToken from admin rotate-token> \
#     -p 9000:9000 uartnode
CMD ["bun", "dist/main.js"]
