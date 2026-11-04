FROM node:22-alpine

WORKDIR /app

# docker CLI 用于容器操作兜底；df/procps 供指标采集
RUN apk add --no-cache tini && \
    npm config set registry https://registry.npmmirror.com

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY config ./config

ENV NODE_ENV=production \
    PORT=8848 \
    HOST=0.0.0.0

EXPOSE 8848

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8848/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
