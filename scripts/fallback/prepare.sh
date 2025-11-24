#!/usr/bin/env bash
set -euo pipefail

PORT=${PORT:-8910}
DB_PORT=${DB_PORT:-5540}
DB_NAME=${DB_NAME:-metasheet_fallback}
DB_USER=${DB_USER:-metasheet}
DB_PASS=${DB_PASS:-metasheet}
JWT_SECRET=${JWT_SECRET:-fallback-jwt-secret}
WORKDIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
META_ENV="$WORKDIR/.env.fallback"

echo "Preparing fallback environment (port=$PORT db_port=$DB_PORT)"

cat > "$META_ENV" <<EOF
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@localhost:$DB_PORT/$DB_NAME
JWT_SECRET=$JWT_SECRET
PORT=$PORT
NODE_ENV=staging-fallback
EOF

echo "Created $META_ENV"
echo "(Manual step) Start Postgres on $DB_PORT with db $DB_NAME if not running."
echo "Example (Docker): docker run -d --name ms-fallback -e POSTGRES_PASSWORD=$DB_PASS -e POSTGRES_USER=$DB_USER -e POSTGRES_DB=$DB_NAME -p $DB_PORT:5432 postgres:15"

echo "Run migrations"
pushd "$WORKDIR/packages/core-backend" >/dev/null
DATABASE_URL="postgresql://$DB_USER:$DB_PASS@localhost:$DB_PORT/$DB_NAME" npm run -s migrate
popd >/dev/null

echo "Fallback prepare complete. Next: seed.sh"
