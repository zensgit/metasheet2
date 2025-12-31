#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${1:-http://127.0.0.1:7778}
DATABASE_URL=${DATABASE_URL:-}
JWT_SECRET=${JWT_SECRET:-dev-secret-key}
USER_ID=${USER_ID:-dev-federation-admin}
PLM_URL=${PLM_URL:-http://127.0.0.1:7910}
PLM_TOKEN=${PLM_TOKEN:-test-token}
PLM_API_KEY=${PLM_API_KEY:-test-api-key}

if [[ -z "$DATABASE_URL" ]]; then
  echo "DATABASE_URL is required"
  exit 2
fi

export DATABASE_URL JWT_SECRET USER_ID PLM_URL PLM_TOKEN PLM_API_KEY

TOKEN=$(JWT_SECRET="$JWT_SECRET" USER_ID="$USER_ID" node scripts/gen-dev-token.js)

request() {
  local method=$1
  local url=$2
  local data=${3:-}
  local response
  if [[ -n "$data" ]]; then
    response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -d "$data")
  else
    response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" \
      -H "Authorization: Bearer $TOKEN")
  fi

  local body=${response%$'\n'*}
  local status=${response##*$'\n'}
  if [[ "$status" != "200" ]]; then
    echo "Request failed ($method $url) status=$status"
    echo "$body"
    exit 1
  fi
  echo "$body" > /dev/null
}

request GET "$BASE_URL/api/federation/systems"

request PATCH "$BASE_URL/api/federation/systems/plm" \
  "{\"baseUrl\":\"$PLM_URL\",\"credentials\":{\"type\":\"bearer\",\"token\":\"$PLM_TOKEN\"}}"

request PATCH "$BASE_URL/api/federation/systems/plm" \
  "{\"credentials\":{\"type\":\"apikey\",\"apiKey\":\"$PLM_API_KEY\"}}"

NODE_PATH=packages/core-backend/node_modules node <<'NODE'
const { Client } = require('pg')

const databaseUrl = process.env.DATABASE_URL
const expected = {
  'plm.url': process.env.PLM_URL,
  'plm.apiToken': process.env.PLM_TOKEN,
  'plm.apiKey': process.env.PLM_API_KEY
}

async function main() {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  const keys = Object.keys(expected)
  const { rows } = await client.query(
    'SELECT key, value FROM system_configs WHERE key = ANY($1) ORDER BY key',
    [keys]
  )
  await client.end()

  const found = new Map(rows.map((row) => [row.key, JSON.parse(row.value)]))
  const missing = keys.filter((key) => !found.has(key))
  if (missing.length) {
    console.error(`Missing system_configs keys: ${missing.join(', ')}`)
    process.exit(1)
  }
  for (const key of keys) {
    const expectedValue = expected[key]
    const actualValue = found.get(key)
    if (expectedValue !== actualValue) {
      console.error(`Mismatched ${key}: expected=${expectedValue} actual=${actualValue}`)
      process.exit(1)
    }
  }

  console.log('Federation config verification passed')
}

main().catch((error) => {
  console.error('Federation config verification failed', error)
  process.exit(1)
})
NODE
