# ---- 构建阶段：安装全部依赖并打包 React ----
FROM node:20-alpine AS build
WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm install

# 拷贝源码并构建前端（产物：client/dist）
COPY . .
RUN npm run build

# ---- 运行阶段：仅保留生产依赖 ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm install --omit=dev && npm cache clean --force

# 后端源码 + 前端构建产物
COPY --from=build /app/server/src ./server/src
COPY --from=build /app/client/dist ./client/dist

# 数据持久化目录（首次启动自动写入初始演示数据）
RUN mkdir -p /app/server/data
VOLUME ["/app/server/data"]

EXPOSE 3000

# 启动即完成「依赖安装（镜像构建期）+ 数据初始化（首启自动播种）+ 服务启动」
CMD ["node", "server/src/index.js"]
