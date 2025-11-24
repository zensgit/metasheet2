#!/usr/bin/env bash
set -euo pipefail

WORKDIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
source "$WORKDIR/.env.fallback" || { echo "Missing .env.fallback" >&2; exit 1; }

echo "Seeding fallback demo data"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO views (id,name,description,created_at,updated_at) VALUES ('v-fallback','Fallback View','Fallback demo view',now(),now()) ON CONFLICT DO NOTHING;
SQL

echo "Seed complete"
