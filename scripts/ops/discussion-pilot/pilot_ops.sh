#!/usr/bin/env bash
# Discussion pilot ops — runs ON THE DEPLOY HOST over SSH (dispatched via
# .github/workflows/discussion-pilot-ops.yml). One action per dispatch, mirroring the
# owner's three-口令 protocol. All service traffic stays on 127.0.0.1 / a private
# docker bridge — no public HTTP anywhere in the acceptance path (P1 transport rule).
#
# Actions:
#   status            read-only: containers, health, flags, nginx public-exposure check
#   stage0-provision  clone/refresh Yuantus @ origin/main, host-generated secrets,
#                     127.0.0.1-only compose override, up + health, private bridge to the
#                     metasheet backend, ms2 .env PLM_* keys (apiMode/tenant/org), backend recreate
#   stage0-datasource register/verify the 'plm' data source (needs MS2_ADMIN_BEARER)
#   stage0-probe      Stage-0.3 strict probe + MODE=dark smoke (expects flags OFF)
#   grant-read        seed pilot tenant + sign/import READ SKUs license (in-container signer)
#   light-read        DISCUSSION_READ_SESSION_ENABLED=true + restart + MODE=lit smoke
#   rollback-read     flag back to false + restart + MODE=dark smoke (uniform-401 dark proof)
#
# Env (from workflow inputs): PILOT_TENANT, PILOT_ORG, MS2_PUBLIC_ORIGIN, PART_ID (optional),
#   MS2_ADMIN_BEARER (only for stage0-datasource), MS2_ENV_FILE (default: auto-detect)
set -euo pipefail

ACTION="${1:?usage: pilot_ops.sh <action>}"
PILOT_DIR="${PILOT_DIR:-$HOME/yuantus-pilot}"
REPO_URL="${YUANTUS_REPO_URL:-https://github.com/zensgit/yuantus-plm.git}"
SECRETS_DIR="$PILOT_DIR/.pilot-secrets"
COMPOSE_PROJ="yuantus-pilot"
YUANTUS_PORT=17910           # host loopback bind; container-internal stays 7910
BRIDGE_NET="discussion-pilot-bridge"
YUANTUS_ALIAS="yuantus-pilot-api"
PILOT_TENANT="${PILOT_TENANT:-pilot-tenant}"
PILOT_ORG="${PILOT_ORG:-pilot-org}"
MS2_PUBLIC_ORIGIN="${MS2_PUBLIC_ORIGIN:-}"
EVIDENCE_DIR="${EVIDENCE_DIR:-/tmp/discussion-pilot-evidence}"
mkdir -p "$EVIDENCE_DIR"

log() { echo "[pilot-ops] $*"; }
die() { echo "[pilot-ops][error] $*" >&2; exit 1; }

yq_compose() { docker compose -p "$COMPOSE_PROJ" -f "$PILOT_DIR/repo/docker-compose.yml" -f "$PILOT_DIR/docker-compose.pilot-override.yml" "$@"; }

detect_ms2_env_file() {
  # the prod backend uses env_file: — find it next to the deployed compose
  for f in "${MS2_ENV_FILE:-}" "$HOME/metasheet2/.env" "$HOME/metasheet2/.env.production"; do
    [ -n "$f" ] && [ -f "$f" ] && { echo "$f"; return 0; }
  done
  die "ms2 backend env_file not found; set MS2_ENV_FILE explicitly"
}

set_env_kv() { # file key value  (idempotent upsert)
  local f=$1 k=$2 v=$3
  if grep -q "^${k}=" "$f" 2>/dev/null; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$f"
  else
    echo "${k}=${v}" >> "$f"
  fi
}

nginx_exposure_check() {
  # P1: the v1.2 sslip.io vhosts must NOT route public HTTP onto the pilot Yuantus.
  local hits
  hits=$(grep -rlE "plm\..*sslip\.io|proxy_pass.*(:7910|:${YUANTUS_PORT})" /etc/nginx 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "PUBLIC-EXPOSURE-RISK: nginx routes reference the PLM upstream:" | tee -a "$EVIDENCE_DIR/nginx-check.txt"
    echo "$hits" | tee -a "$EVIDENCE_DIR/nginx-check.txt"
    return 1
  fi
  log "nginx check clean (no sslip/plm proxy to $YUANTUS_PORT)"; return 0
}

yuantus_health() {
  curl -fsS -m 10 "http://127.0.0.1:${YUANTUS_PORT}/api/v1/health" >/dev/null
}

case "$ACTION" in

status)
  { echo "== containers =="; docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -Ei "metasheet|yuantus" || true
    echo "== metasheet-backend PRODUCT_MODE / PLM (DECIDES pilot feasibility on THIS host) =="
    MS2_CID=$(docker ps -qf name=metasheet-backend || true)
    if [ -n "$MS2_CID" ]; then
      pm=$(docker exec "$MS2_CID" sh -c 'echo "PRODUCT_MODE=${PRODUCT_MODE:-<unset>} ENABLE_PLM=${ENABLE_PLM:-<unset>}"' 2>/dev/null || echo "exec-failed")
      echo "  $pm"
      # PLM embed routes mounted? (loopback; unauthenticated probe — expect 401, not 404)
      code=$(docker exec "$MS2_CID" sh -c 'curl -s -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:8900/api/plm-embed/discussion/threads -H "X-PLM-Embed-Token: probe"' 2>/dev/null || echo "ERR")
      echo "  plm-embed read route probe -> HTTP $code  (401/403=mounted; 404=NOT mounted => attendance mode, pilot NOT feasible here)"
    else
      echo "  metasheet-backend container NOT found"
    fi
    echo "== yuantus health (pilot) =="; yuantus_health && echo OK || echo "UNREACHABLE (no pilot instance yet — normal before stage0)"
    echo "== flags (pilot .env) =="; grep -E "^YUANTUS_DISCUSSION|^YUANTUS_PREAUTH_RATE_LIMIT_ENABLED" "$PILOT_DIR/yuantus.env" 2>/dev/null || echo "(no pilot env yet)"
    echo "== nginx exposure =="; nginx_exposure_check || true
    echo "== docker host disk =="; df -Pk / | awk 'NR==2{print "  avail_kb="$4" use="$5}'
  } | tee "$EVIDENCE_DIR/status.txt"
  ;;

stage0-provision)
  [ -n "$MS2_PUBLIC_ORIGIN" ] || die "MS2_PUBLIC_ORIGIN required (the origin the ms2 web UI is served from)"
  mkdir -p "$PILOT_DIR" "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"

  # 1) Yuantus source @ current origin/main (version hard-requirement)
  if [ -d "$PILOT_DIR/repo/.git" ]; then
    git -C "$PILOT_DIR/repo" fetch origin main && git -C "$PILOT_DIR/repo" reset --hard origin/main
  else
    git clone --depth 1 "$REPO_URL" "$PILOT_DIR/repo"
  fi
  log "yuantus @ $(git -C "$PILOT_DIR/repo" rev-parse --short HEAD)"

  # 2) host-generated secrets (idempotent; never leave the host)
  [ -f "$SECRETS_DIR/jwt.secret" ] || python3 -c "import secrets;print(secrets.token_urlsafe(48))" > "$SECRETS_DIR/jwt.secret"
  [ -f "$SECRETS_DIR/embed_seed.b64" ] || python3 -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())" > "$SECRETS_DIR/embed_seed.b64"
  chmod 600 "$SECRETS_DIR"/*
  EMBED_PUB=$(docker run --rm -i python:3.11-slim sh -c "pip -q install cryptography >/dev/null 2>&1 && python - <<'PY'
import base64,sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization as s
k=Ed25519PrivateKey.from_private_bytes(base64.b64decode(sys.stdin.read().strip()))
print(base64.b64encode(k.public_key().public_bytes(s.Encoding.Raw,s.PublicFormat.Raw)).decode())
PY" < "$SECRETS_DIR/embed_seed.b64")
  [ -n "$EMBED_PUB" ] || die "embed pubkey derivation failed"
  echo "$EMBED_PUB" > "$SECRETS_DIR/embed_pub.b64"

  # 3) pilot env (flags OFF; limiter ON — the governed posture)
  cat > "$PILOT_DIR/yuantus.env" <<EOF
YUANTUS_JWT_SECRET_KEY=$(cat "$SECRETS_DIR/jwt.secret")
YUANTUS_EMBED_TOKEN_SIGNING_KEY=$(cat "$SECRETS_DIR/embed_seed.b64")
YUANTUS_EMBED_TOKEN_KEY_ID=embed-1
YUANTUS_ENABLE_METASHEET=true
YUANTUS_METASHEET_EMBED_URL=${MS2_PUBLIC_ORIGIN}/plm-embed/bom-review
YUANTUS_EMBED_ALLOWED_ORIGINS=${MS2_PUBLIC_ORIGIN}
YUANTUS_PREAUTH_RATE_LIMIT_ENABLED=true
YUANTUS_DISCUSSION_READ_SESSION_ENABLED=false
YUANTUS_DISCUSSION_SESSION_ENABLED=false
EOF
  chmod 600 "$PILOT_DIR/yuantus.env"

  # 4) loopback-only override (P1: never a public bind)
  cat > "$PILOT_DIR/docker-compose.pilot-override.yml" <<EOF
services:
  api:
    env_file: [$PILOT_DIR/yuantus.env]
    ports: !override
      - "127.0.0.1:${YUANTUS_PORT}:7910"
EOF

  # 5) up + health
  yq_compose up -d --build postgres minio api
  for i in $(seq 1 60); do yuantus_health && break; sleep 2; [ "$i" = 60 ] && die "yuantus health timeout"; done
  log "yuantus healthy on 127.0.0.1:${YUANTUS_PORT}"

  # 6) private bridge: metasheet backend <-> pilot api (no compose edits, reversible)
  docker network inspect "$BRIDGE_NET" >/dev/null 2>&1 || docker network create "$BRIDGE_NET"
  API_CID=$(yq_compose ps -q api)
  docker network disconnect "$BRIDGE_NET" "$API_CID" >/dev/null 2>&1 || true
  docker network connect --alias "$YUANTUS_ALIAS" "$BRIDGE_NET" "$API_CID"
  MS2_CID=$(docker ps -qf name=metasheet-backend)
  [ -n "$MS2_CID" ] || die "metasheet-backend container not found"
  docker network disconnect "$BRIDGE_NET" "$MS2_CID" >/dev/null 2>&1 || true
  docker network connect "$BRIDGE_NET" "$MS2_CID"

  # 7) ms2 .env: the P1-complete key set (apiMode/tenant/org — NOT just URL+ID)
  ENVF=$(detect_ms2_env_file); cp "$ENVF" "$ENVF.pilot-backup.$(date +%s)"
  set_env_kv "$ENVF" PLM_URL "http://${YUANTUS_ALIAS}:7910"
  set_env_kv "$ENVF" PLM_API_MODE "yuantus"
  set_env_kv "$ENVF" PLM_TENANT_ID "$PILOT_TENANT"
  set_env_kv "$ENVF" PLM_ORG_ID "$PILOT_ORG"
  set_env_kv "$ENVF" PLM_EMBED_ALLOWED_ORIGINS "$MS2_PUBLIC_ORIGIN"
  set_env_kv "$ENVF" PLM_EMBED_AUDIENCE "metasheet2.embed"
  set_env_kv "$ENVF" YUANTUS_EMBED_PUBLIC_KEYS "{\"embed-1\":\"${EMBED_PUB}\"}"
  grep -q "^REDIS_URL=" "$ENVF" || set_env_kv "$ENVF" REDIS_URL "redis://redis:6379"
  grep -q "^PLM_EMBED_DATA_SOURCE_ID=" "$ENVF" || log "NOTE: PLM_EMBED_DATA_SOURCE_ID not set yet — run stage0-datasource next"

  # 8) recreate backend to pick up env (same image, no deploy)
  ( cd "$(dirname "$ENVF")" && docker compose -f docker-compose.app.yml up -d --no-deps --force-recreate backend )
  # network connect does not survive recreation — reconnect
  MS2_CID=$(docker ps -qf name=metasheet-backend)
  docker network connect "$BRIDGE_NET" "$MS2_CID" 2>/dev/null || true

  # 9) P1 exposure check LAST (fail loud if nginx would publish the pilot)
  nginx_exposure_check || die "disable the sslip/plm nginx vhost before proceeding (see nginx-check.txt)"
  log "stage0-provision complete"
  ;;

stage0-datasource)
  [ -n "${MS2_ADMIN_BEARER:-}" ] || die "MS2_ADMIN_BEARER required"
  ENVF=$(detect_ms2_env_file)
  # register (or find) the pilot plm data source via the backend's own REST API on loopback
  EXISTING=$(curl -fsS -m 15 http://127.0.0.1:8900/api/data-sources -H "Authorization: Bearer $MS2_ADMIN_BEARER" \
    | python3 -c "import json,sys;ds=[d for d in json.load(sys.stdin) if d.get('type')=='plm' and d.get('name')=='yuantus-pilot'];print(ds[0]['id'] if ds else '')" 2>/dev/null || true)
  if [ -n "$EXISTING" ]; then DS_ID="$EXISTING"; log "reusing data source $DS_ID"; else
    DS_ID=$(curl -fsS -m 15 -X POST http://127.0.0.1:8900/api/data-sources \
      -H "Authorization: Bearer $MS2_ADMIN_BEARER" -H 'Content-Type: application/json' \
      -d "{\"name\":\"yuantus-pilot\",\"type\":\"plm\",\"config\":{\"connection\":{\"url\":\"http://${YUANTUS_ALIAS}:7910\"},\"options\":{\"apiMode\":\"yuantus\",\"tenantId\":\"${PILOT_TENANT}\",\"orgId\":\"${PILOT_ORG}\"}}}" \
      | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
    [ -n "$DS_ID" ] || die "data source registration failed"
    log "registered data source $DS_ID"
  fi
  set_env_kv "$ENVF" PLM_EMBED_DATA_SOURCE_ID "$DS_ID"
  ( cd "$(dirname "$ENVF")" && docker compose -f docker-compose.app.yml up -d --no-deps --force-recreate backend )
  docker network connect "$BRIDGE_NET" "$(docker ps -qf name=metasheet-backend)" 2>/dev/null || true
  log "stage0-datasource complete (id=$DS_ID)"
  ;;

stage0-probe)
  SMOKE="$(dirname "$0")/smoke.sh"
  YUANTUS_BASE="http://127.0.0.1:${YUANTUS_PORT}" MS2_BASE="http://127.0.0.1:8900" \
  USERNAME="${PILOT_ADMIN_USER:-pilot-admin}" PASSWORD="$(cat "$SECRETS_DIR/pilot_admin.pass" 2>/dev/null || echo unset)" \
  TENANT_ID="$PILOT_TENANT" ORG_ID="$PILOT_ORG" PART_ID="$(cat "$SECRETS_DIR/part_id" 2>/dev/null || echo unset)" \
  MODE=dark bash "$SMOKE" | tee "$EVIDENCE_DIR/smoke-dark.txt"
  ;;

grant-read)
  # seed pilot identity/meta/data (idempotent-ish; pilot instance only)
  [ -f "$SECRETS_DIR/pilot_admin.pass" ] || python3 -c "import secrets;print(secrets.token_urlsafe(18))" > "$SECRETS_DIR/pilot_admin.pass"
  chmod 600 "$SECRETS_DIR/pilot_admin.pass"
  ADMIN_PASS=$(cat "$SECRETS_DIR/pilot_admin.pass")
  yq_compose exec -T api yuantus seed-identity --tenant "$PILOT_TENANT" --org "$PILOT_ORG" \
      --username "${PILOT_ADMIN_USER:-pilot-admin}" --password "$ADMIN_PASS" --user-id 9001 --roles admin || true
  yq_compose exec -T api yuantus seed-meta || true
  yq_compose exec -T api sh -c "YUANTUS_TENANT_ID=$PILOT_TENANT YUANTUS_ORG_ID=$PILOT_ORG yuantus seed-data --part-count 3 --doc-count 1 --bom-roots 1 --bom-depth 1" || true

  # sign READ SKUs in-container (repo canonical scheme), kid pilot-read-1, 30d expiry
  docker cp "$(dirname "$0")/sign_pilot_license.py" "$(yq_compose ps -q api)":/tmp/sign_pilot_license.py
  yq_compose exec -T api sh -c "cd /app 2>/dev/null || cd /srv/app 2>/dev/null || cd /; \
    python /tmp/sign_pilot_license.py --tenant-id $PILOT_TENANT \
      --features bom_multitable,metasheet_review --kid pilot-read-1 \
      --priv-out /tmp/pilot-read-1.pem --out /tmp/pilot-license.json" | tee "$EVIDENCE_DIR/license-issue.txt"
  PUB=$(grep -A1 'YUANTUS_LICENSE_PUBLIC_KEYS' "$EVIDENCE_DIR/license-issue.txt" | tail -1)
  set_env_kv "$PILOT_DIR/yuantus.env" YUANTUS_LICENSE_PUBLIC_KEYS "$PUB"
  yq_compose up -d --no-deps --force-recreate api
  for i in $(seq 1 60); do yuantus_health && break; sleep 2; done
  yq_compose exec -T api yuantus license import /tmp/pilot-license.json --tenant-id "$PILOT_TENANT" | tee -a "$EVIDENCE_DIR/license-issue.txt"
  # keep custody copies on host, then remove from container
  docker cp "$(yq_compose ps -q api)":/tmp/pilot-read-1.pem "$SECRETS_DIR/pilot-read-1.pem"
  docker cp "$(yq_compose ps -q api)":/tmp/pilot-license.json "$SECRETS_DIR/pilot-license.json"
  yq_compose exec -T api rm -f /tmp/pilot-read-1.pem /tmp/pilot-license.json /tmp/sign_pilot_license.py
  # remember a real seeded part id for smoke
  yq_compose exec -T api python -c "
from yuantus.meta_engine.bootstrap import import_all_models; import_all_models()
from yuantus.database import SessionLocal
from yuantus.meta_engine.models.item import Item
s=SessionLocal();p=s.query(Item).filter(Item.item_type_id=='Part').first();print(p.id if p else '')" \
    | tr -d '\r' | tail -1 > "$SECRETS_DIR/part_id" || true
  log "grant-read complete (part_id=$(cat "$SECRETS_DIR/part_id" 2>/dev/null))"
  ;;

light-read)
  set_env_kv "$PILOT_DIR/yuantus.env" YUANTUS_DISCUSSION_READ_SESSION_ENABLED true
  yq_compose up -d --no-deps --force-recreate api
  docker network connect --alias "$YUANTUS_ALIAS" "$BRIDGE_NET" "$(yq_compose ps -q api)" 2>/dev/null || true
  for i in $(seq 1 60); do yuantus_health && break; sleep 2; done
  SMOKE="$(dirname "$0")/smoke.sh"
  YUANTUS_BASE="http://127.0.0.1:${YUANTUS_PORT}" MS2_BASE="http://127.0.0.1:8900" \
  USERNAME="${PILOT_ADMIN_USER:-pilot-admin}" PASSWORD="$(cat "$SECRETS_DIR/pilot_admin.pass")" \
  TENANT_ID="$PILOT_TENANT" ORG_ID="$PILOT_ORG" PART_ID="$(cat "$SECRETS_DIR/part_id")" \
  MODE=lit bash "$SMOKE" | tee "$EVIDENCE_DIR/smoke-lit.txt"
  ;;

rollback-read)
  set_env_kv "$PILOT_DIR/yuantus.env" YUANTUS_DISCUSSION_READ_SESSION_ENABLED false
  yq_compose up -d --no-deps --force-recreate api
  docker network connect --alias "$YUANTUS_ALIAS" "$BRIDGE_NET" "$(yq_compose ps -q api)" 2>/dev/null || true
  for i in $(seq 1 60); do yuantus_health && break; sleep 2; done
  SMOKE="$(dirname "$0")/smoke.sh"
  YUANTUS_BASE="http://127.0.0.1:${YUANTUS_PORT}" MS2_BASE="http://127.0.0.1:8900" \
  USERNAME="${PILOT_ADMIN_USER:-pilot-admin}" PASSWORD="$(cat "$SECRETS_DIR/pilot_admin.pass")" \
  TENANT_ID="$PILOT_TENANT" ORG_ID="$PILOT_ORG" PART_ID="$(cat "$SECRETS_DIR/part_id")" \
  MODE=dark bash "$SMOKE" | tee "$EVIDENCE_DIR/smoke-dark-rollback.txt"
  ;;

*) die "unknown action: $ACTION" ;;
esac
