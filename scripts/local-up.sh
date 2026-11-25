#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .data/wechat-collector/.env ]]; then
  docker compose -f deploy/wechat/compose.yaml up -d
fi
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build "$@"
