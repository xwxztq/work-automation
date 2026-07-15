#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -n "${DOCKER_BIN:-}" ]]; then
  docker_bin="$DOCKER_BIN"
elif command -v docker >/dev/null 2>&1; then
  docker_bin="$(command -v docker)"
elif [[ -x /Applications/Docker.app/Contents/Resources/bin/docker ]]; then
  docker_bin=/Applications/Docker.app/Contents/Resources/bin/docker
else
  echo "未找到 Docker CLI。请先安装并启动 Docker Desktop。" >&2
  exit 1
fi

# Docker Desktop 的 credential helper 与 CLI 位于同一目录；使用绝对路径时也要让 helper 可被找到。
export PATH="$(dirname "$docker_bin"):$PATH"

proxy_for_container() {
  local value="${1:-}"
  value="${value/127.0.0.1/host.docker.internal}"
  value="${value/localhost/host.docker.internal}"
  printf '%s' "$value"
}

# 宿主机回环代理从容器内要通过 Docker Desktop 的宿主机别名访问。
export DOCKER_HTTP_PROXY="$(proxy_for_container "${HTTP_PROXY:-${http_proxy:-}}")"
export DOCKER_HTTPS_PROXY="$(proxy_for_container "${HTTPS_PROXY:-${https_proxy:-}}")"

if ! "$docker_bin" info >/dev/null 2>&1; then
  echo "Docker daemon 尚未就绪。请先启动 Docker Desktop。" >&2
  exit 1
fi

action="${1:-up}"
shift || true

case "$action" in
  up)
    if [[ ! -f .env.local && ! -f .env && -z "${LINEAR_API_KEY:-}" ]]; then
      echo "提示：尚未发现 LINEAR_API_KEY；服务可以启动，但自动扫描前需在 .env.local 中配置它。" >&2
    fi
    "$docker_bin" compose up -d --build "$@"
    "$docker_bin" compose ps
    ;;
  down)
    "$docker_bin" compose down "$@"
    ;;
  restart)
    "$docker_bin" compose restart "$@"
    "$docker_bin" compose ps
    ;;
  rebuild)
    "$docker_bin" compose up -d --build --force-recreate "$@"
    "$docker_bin" compose ps
    ;;
  logs)
    "$docker_bin" compose logs -f --tail=200 "$@"
    ;;
  status|ps)
    "$docker_bin" compose ps "$@"
    ;;
  validate)
    "$docker_bin" compose config --quiet
    echo "Compose 配置有效。"
    ;;
  *)
    echo "用法: ./docker.sh [up|down|restart|rebuild|logs|status|validate]" >&2
    exit 2
    ;;
esac
