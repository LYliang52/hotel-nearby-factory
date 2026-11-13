# 在线部署用镜像：Node 22 + Chromium（跑「携程实时价」的服务端 Chrome）
FROM node:22-slim

# Chromium + 中文字体 + 运行依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    fonts-liberation \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 让项目里的 lib/cdp.mjs 找到 Chromium
ENV CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    HNF_DATA_DIR=/data

WORKDIR /app

# 本项目零第三方依赖，这一步基本为空，保留以兼容将来
COPY package.json ./
RUN npm install --omit=dev || true

# 复制代码（.dockerignore 已排除 config.json / 登录态 / 价格 / 打包产物等）
COPY . .

# 不写 EXPOSE：端口由部署平台注入的 PORT 环境变量决定（Railway/Render 都是动态端口）

# 部署平台会注入 PORT；数据目录挂载到 /data（持久卷），否则重启后登录态和补录价格会丢
CMD ["node", "server.mjs"]
