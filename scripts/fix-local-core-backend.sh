#!/usr/bin/env bash
set -euo pipefail

echo "[fix] pruning pnpm store..."
pnpm store prune || true

echo "[fix] cleaning package node_modules..."
rm -rf packages/core-backend/node_modules || true

echo "[fix] installing with frozen lockfile..."
pnpm install --frozen-lockfile

echo "[fix] installing missing runtime deps (if needed)..."
pnpm -F @metasheet/core-backend add winston prom-client pg || true

echo "[fix] installing dev test deps (if needed)..."
pnpm -F @metasheet/core-backend add -D vitest @vitest/ui socket.io-client @types/node || true

echo "[fix] running tests..."
pnpm -F @metasheet/core-backend test
NODE_ENV=test pnpm -F @metasheet/core-backend test:integration

echo "[fix] done."

