#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
#  1Shell 快速启动脚本
#  用法: bash start.sh
#  适用于已下载源码包的场景（非一键安装）
# ============================================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[1Shell]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

NODE_EXE="node"
if [[ -x "$ROOT_DIR/runtime/node/bin/node" ]]; then
  NODE_EXE="$ROOT_DIR/runtime/node/bin/node"
  export PATH="$ROOT_DIR/runtime/node/bin:$PATH"
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         1Shell v4.2.1                          ║${NC}"
echo -e "${GREEN}║     One Shell to rule them all.                ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""

# 检查 Node.js
if ! "$NODE_EXE" -v &>/dev/null; then
  err "未检测到 Node.js，请先安装 Node.js 20 或 22"
  err "安装方式: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt install -y nodejs"
  exit 1
fi

NODE_VER=$("$NODE_EXE" -v | tr -d 'v')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 20 || "$NODE_MAJOR" -ge 23 ]]; then
  err "Node.js 版本不受支持 (v${NODE_VER})，需要 v20 或 v22"
  exit 1
fi
log "Node.js v${NODE_VER} 已检测到"

# 安装后端依赖
if [[ ! -d "node_modules" ]]; then
  log "首次运行，正在安装后端依赖..."
  npm install
  log "后端依赖安装完成"
fi

# 缺少生产前端包时自动构建
if [[ ! -f "frontend/dist/index.html" ]]; then
  if [[ ! -f "frontend/package.json" ]]; then
    err "frontend/package.json 不存在"
    exit 1
  fi
  log "未检测到前端构建产物，正在准备前端..."
  pushd frontend >/dev/null
  if [[ ! -d "node_modules" ]]; then
    npm install
  fi
  npm run build
  popd >/dev/null
  log "前端构建完成"
fi

# 创建 .env
if [[ ! -f ".env" ]] && [[ -f ".env.example" ]]; then
  cp .env.example .env
  chmod 600 .env
  app_secret="$("$NODE_EXE" -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  {
    echo ""
    echo "APP_SECRET=$app_secret"
  } >> .env
  log "Generated APP_SECRET for credential encryption"
  log "已从 .env.example 创建 .env 配置文件"
  warn "请编辑 .env 设置登录密码和 API Key"
  echo ""
fi

# 启动
log "正在启动服务..."
log "启动后访问: http://localhost:3301"
log "默认账号: admin / admin（请在设置中修改）"
log "按 Ctrl+C 停止服务"
echo ""
exec "$NODE_EXE" server.js
