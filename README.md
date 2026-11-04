# ARGUS · 全视守望

宿主机 + Docker 容器 + nginx 子域站点的一体化实时监测台。

一个进程、一个页面，把三层全看清：机器的 CPU/内存/磁盘/网络，每个 compose 项目下每个容器的死活与资源，以及 nginx 里每个 `server_name` 的实际可达性、响应码、延迟和证书剩余天数。

```
  宿主机 ──┐
  容器    ─┼──> ARGUS ──> WebSocket ──> 单页仪表盘
  nginx   ─┘
```

## 为什么叫 ARGUS

希腊神话里的百眼巨人 Ἄργος，全身是眼、永不闭眼。赫拉派他看守，正合"把宿主机、容器、子域三层一起盯住"这件事。

## 特性

- **零前端依赖**：页面是原生 JS + Canvas 自绘曲线，没有构建步骤、没有 CDN 请求，断网也能看。
- **零后端重依赖**：只有 `express` 和 `ws`。Docker 数据直接走 unix socket 的 HTTP API，不引 dockerode。
- **真实宿主机指标**：容器里挂 `/proc:/host/proc` 后读的是宿主机 `/proc`，不是容器自己的假数据。
- **nginx 静态解析**：递归扫配置目录，解析 `server` 块里的 `server_name` / `listen` / `proxy_pass` / `ssl_certificate`，自动生成探测目标。日志能在的话还会统计 `access.log` 尾部的请求量与 5xx。
- **状态跃迁告警**：站点掉线/恢复、容器退出/启动、5xx 突增、CPU/内存/磁盘超阈值、证书临期，只在**状态变化**时发一次，带冷却，可推 webhook。
- **只读挂载**：容器对宿主机只有读权限，观测工具不该有写能力。

## 快速开始

### 本地跑（Windows / macOS / Linux 都行）

```bash
npm install
cp .env.example .env
npm start
# 打开 http://127.0.0.1:8848
```

本地没有 docker / nginx 时页面照样能开，只是对应面板显示"未接入"，不报错、不白屏。

### 服务器上跑（Docker Compose）

```bash
git clone https://github.com/chenjieya/ARGUS.git /project/docker/argus
cd /project/docker/argus
cp .env.example .env
docker compose up -d --build
curl http://127.0.0.1:8083/api/health
```

`.env` 默认值已经对准当前服务器（原生 nginx + `/etc/nginx/conf.d`），通常不用改：

```ini
# 宿主机上 nginx 配置目录的真实路径（原生安装，不是容器）
NGINX_CONF_HOST=/etc/nginx/conf.d
NGINX_LOG_HOST=/var/log/nginx
```

端口只绑了 `127.0.0.1:8083`，外部访问走宿主机 nginx 反代。

### 接入宿主机 nginx

把 `deploy/nginx-argus.conf` 放到 `/etc/nginx/conf.d/status.alvis.conf`，然后：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

证书复用 `/etc/nginx/ssl/alvis.org.cn/` 下的 `*.alvis.org.cn` 通配符证书，`status.alvis.org.cn` 已被 SAN 覆盖，不需要单独签发。WebSocket 升级头只在 `location /ws` 里透传，不依赖主配置里的 `map $http_upgrade $connection_upgrade`。

## 自动部署

仓库已推到 `https://github.com/chenjieya/ARGUS.git`，`main` 分支的 push 会触发 `.github/workflows/deploy.yml`。

**还差最后一步：在 GitHub 仓库 → Settings → Secrets and variables → Actions 里加四个 secret**

| Secret | 值 |
| --- | --- |
| `DEPLOY_HOST` | `152.136.107.93` |
| `DEPLOY_USER` | `alvis` |
| `DEPLOY_SSH_KEY` | 私钥全文（需先把对应公钥加到服务器 `~/.ssh/authorized_keys`） |
| `DEPLOY_PATH` | `/project/docker/argus` |

服务器当前是**密码登录**，Actions 用密钥更稳妥。生成一对专用密钥：

```bash
ssh-keygen -t ed25519 -C "argus-deploy" -f ~/.ssh/argus_deploy -N ""
# 公钥追加到服务器
ssh-copy-id -i ~/.ssh/argus_deploy.pub alvis@152.136.107.93
# 私钥内容（整段含 BEGIN/END）填进 DEPLOY_SSH_KEY
cat ~/.ssh/argus_deploy
```

服务器上先手动跑一次确认链路：

```bash
cd /project/docker/argus && bash deploy/deploy.sh main
```

之后每次 `git push origin main` 会自动：语法检查 → 启动冒烟测试 → 构建镜像 → SSH 到服务器执行 `deploy/deploy.sh`。

如果不想用 Actions，服务器上装个 cron 也一样：

```cron
*/5 * * * * cd /project/docker/argus && bash deploy/deploy.sh main >> /var/log/argus-deploy.log 2>&1
```

## 配置项

全部在 `.env`，改完 `docker compose up -d` 生效。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8848` | 容器内监听端口（compose 映射到宿主机 `127.0.0.1:8083`） |
| `AUTH_USER` / `AUTH_PASS` | 空 | 同时填了才启用 Basic 认证；`/api/health` 永远放行 |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | 也可填 `tcp://ip:2375` 之外的自定义路径 |
| `HOST_PROC` | `/host/proc` | 宿主机 proc 挂载点 |
| `NGINX_CONF_DIR` | `/etc/nginx-src` | 容器内配置目录 |
| `DISK_PATHS` | `/host` | `df` 的目标挂载点，逗号分隔 |
| `METRIC_INTERVAL` | `2000` | 指标采样间隔 ms |
| `DOCKER_INTERVAL` | `5000` | 容器采集间隔 ms |
| `PROBE_INTERVAL` | `20000` | 站点探测间隔 ms |
| `HISTORY_SIZE` | `900` | 曲线保留点数 |
| `FAIL_THRESHOLD` | `2` | 连续失败几次判宕机 |
| `ALERT_WEBHOOK` | 空 | POST JSON 到该地址 |
| `TLS_WARN_DAYS` | `14` | 证书剩余天数告警线 |
| `CPU_WARN` / `MEM_WARN` / `DISK_WARN` | `90/92/90` | 资源告警阈值 % |

手动补充的探测目标写 `config/targets.json`，容器启动时读入，改完重启即可：

```json
{
  "targets": [
    { "id": "api", "name": "后端 API", "url": "https://api.example.com/health", "group": "接口", "expect": 200 }
  ]
}
```

nginx 里能解析出来的子域会自动并入，不用在这里重复写。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活探针 |
| GET | `/api/snapshot` | 全量快照（首屏用） |
| GET | `/api/system` | 宿主机指标 |
| GET | `/api/history?limit=300` | 曲线历史 |
| GET | `/api/docker` | 容器列表 + 按项目聚合 |
| GET | `/api/nginx` | 解析出的站点与上游 |
| GET | `/api/targets` | 探测结果 |
| GET | `/api/events?limit=50` | 事件流 |
| POST | `/api/targets/:id/check` | 立即重探单个站点 |
| WS | `/ws` | 推送 `snapshot` / `system` / `docker` / `nginx` / `targets` |

## 目录结构

```
argus/
├── src/
│   ├── server.js              入口：HTTP + WebSocket + 四个采集循环
│   ├── config.js              环境变量集中解析
│   ├── store.js               内存状态与历史环形缓冲
│   ├── api.js                 REST 路由与 Basic 认证
│   ├── alerts.js              状态跃迁判定与 webhook
│   └── collectors/
│       ├── system.js          /proc 解析：CPU/内存/负载/网卡/df
│       ├── docker.js          unix socket 直连 daemon + stats
│       ├── nginx.js           nginx 配置词法解析 + 日志统计
│       └── probe.js           HTTP 探测 + TLS 证书到期
├── public/                    纯静态前端（index/style/app）
├── config/targets.json        手动探测目标
├── deploy/
│   ├── deploy.sh              一键部署/更新
│   └── nginx-argus.conf       反代片段
└── .github/workflows/deploy.yml
```

## 已知边界

- 历史数据只在内存里，进程重启清零。要长期留存得接时序库（InfluxDB / VictoriaMetrics），当前不做。
- nginx 解析是静态的，`include` 递归有 4 层深度上限，`map` / `if` 里的动态域名不会解析。
- 容器 stats 每次采集要对每个运行中容器各发一次请求，容器数上百时建议把 `DOCKER_INTERVAL` 调大。
- 证书检测只做 443 端口。

## License

私有项目。
