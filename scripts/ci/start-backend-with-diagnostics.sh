#!/usr/bin/env bash
set -euo pipefail

echo "=== ENVIRONMENT DIAGNOSTICS ==="
echo "Node version: $(node -v)"
echo "npm version: $(npm -v)"
echo "pnpm version: $(pnpm -v 2>/dev/null || echo 'pnpm not found')"

echo ""
echo "=== ENV VARIABLES ==="
env | grep -E 'DATABASE_URL|KANBAN|APPROVAL|PORT|HOST|JWT|NODE' || true

echo ""
echo "=== POSTGRES READINESS ==="
pg_isready -h 127.0.0.1 -p 5432 || echo "PostgreSQL not ready yet"

echo ""
echo "=== PORT STATUS ==="
# Kill any leftover processes
pkill -f "src/index.ts" || echo "No existing node processes to kill"
lsof -i :8900 || echo "Port 8900 is free"

echo ""
echo "=== RUNNING MIGRATIONS ==="
pnpm -F @metasheet/core-backend db:migrate || {
  echo "::error::Migration failed"
  exit 1
}

echo ""
echo "=== SEEDING DATABASE ==="
pnpm -F @metasheet/core-backend seed:rbac || echo "RBAC seed failed (non-fatal)"
pnpm -F @metasheet/core-backend seed:demo || echo "Demo seed failed (non-fatal)"

echo ""
echo "=== CHECKING NODE AND TSX ==="
which tsx || echo "tsx not found in PATH"
which node || echo "node not found"

echo ""
echo "=== STARTING BACKEND SERVER ==="
# Start with enhanced error tracing
cd packages/core-backend
nohup npx tsx src/index.ts > ../../server.log 2>&1 &

SERVER_PID=$!
echo "Server PID: $SERVER_PID"
echo $SERVER_PID > server.pid

# Give it time to start
sleep 3

echo ""
echo "=== PROCESS CHECK ==="
if ps -p $SERVER_PID > /dev/null; then
  echo "Server process $SERVER_PID is running"
  ps -ef | grep $SERVER_PID | grep -v grep || true
else
  echo "::error::Server process $SERVER_PID died immediately"
fi

echo ""
echo "=== PORT BINDING CHECK ==="
lsof -i :8900 || echo "::warning::Port 8900 still not bound after 3 seconds"

echo ""
echo "=== SERVER LOG (last 100 lines) ==="
if [ -f server.log ]; then
  tail -n 100 server.log
else
  echo "::error::No server.log file created"
fi

# Create artifacts directory for CI
if [ -n "${CI:-}" ]; then
  mkdir -p /tmp/ci-artifacts-$$
  cp server.log /tmp/ci-artifacts-$$/server-initial.log 2>/dev/null || true
  echo "Created artifact directory: /tmp/ci-artifacts-$$"
fi

echo ""
echo "=== HEALTH CHECK LOOP ==="
for i in {1..20}; do
  echo -n "Attempt $i: "

  if curl -fsS http://127.0.0.1:8900/health >/dev/null 2>&1; then
    echo "✓ Health check succeeded!"

    # Additional checks once healthy
    echo ""
    echo "=== RBAC HEALTH CHECK ==="
    curl -s http://127.0.0.1:8900/api/permissions/health | jq . || echo "Failed to get RBAC health"

    echo ""
    echo "=== INITIAL METRICS ==="
    curl -s http://127.0.0.1:8900/metrics/prom | grep -E 'rbac_perm_queries' || echo "No RBAC metrics yet"

    exit 0
  else
    echo "✗ Failed (checking logs for errors)"

    # Show recent errors from log
    if [ -f server.log ]; then
      grep -i -E 'error|exception|fail|crash|reject' server.log | tail -n 3 || true
    fi
  fi

  # On final attempt, dump everything
  if [ $i -eq 20 ]; then
    echo ""
    echo "::error::Server never became healthy after 20 attempts"
    echo ""
    echo "=== FULL SERVER LOG ==="
    cat server.log || echo "No server log available"

    echo ""
    echo "=== FINAL DIAGNOSTICS ==="
    ps -ef | grep node | grep -v grep || echo "No node processes"
    lsof -i :8900 || echo "Port 8900 not bound"

    # Save artifacts for CI
    if [ -n "${CI:-}" ]; then
      cp server.log /tmp/ci-artifacts-$$/server-final.log 2>/dev/null || true
      echo "Diagnostic artifacts saved to /tmp/ci-artifacts-$$"
    fi

    exit 1
  fi

  sleep 1
done