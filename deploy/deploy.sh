#!/usr/bin/env bash
# ARGUS 一键部署 / 更新脚本
# 用法：./deploy/deploy.sh [分支]
set -euo pipefail

BRANCH="${1:-main}"
APP_DIR="${ARGUS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HEALTH_URL="${ARGUS_HEALTH_URL:-http://127.0.0.1:8083/api/health}"
COMPOSE="docker compose"

cd "$APP_DIR"

log() { printf '\033[36m[argus]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[argus:error]\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker 未安装"
docker compose version >/dev/null 2>&1 || COMPOSE="docker-compose"

if [ -d .git ]; then
  log "拉取 origin/$BRANCH"
  git fetch --all --prune
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
fi

if [ ! -f .env ]; then
  log "生成 .env（首次）"
  cp .env.example .env
fi

log "构建镜像"
$COMPOSE build --pull argus

log "滚动重启"
$COMPOSE up -d --remove-orphans argus

log "等待健康检查"
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    log "健康检查通过（${i}s）"
    break
  fi
  sleep 1
  if [ "$i" = "30" ]; then
    $COMPOSE logs --tail 60 argus
    die "健康检查超时"
  fi
done

log "清理旧镜像"
docker image prune -f --filter "label!=keep" >/dev/null 2>&1 || true

log "完成 · $HEALTH_URL"
$COMPOSE ps argus
