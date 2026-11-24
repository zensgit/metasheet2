#!/usr/bin/env bash

# Called through the attendance staging runner after assert_staging_only.
# Layer exactly the compiled guard over the verified live image. Compose must
# resolve an identical stack, except for backend image and build identity.
action_authorization_fence_repair() (
  set -euo pipefail
  require_sha
  require_compose_v2
  local baseline=135a04df0bcc2c3f2d60a05f7de0b721b5b5e10f
  local base_image_id=sha256:1505a2b97422ad85131d787328473d2d4d784375978ab8fde98b3883399e029b
  local catalog_digest=49ffece37de8bb24ce108156bb1803170fe96c6ccf64a7c8b3ea3183add50d34
  local base_image="ghcr.io/${IMAGE_OWNER}/metasheet2-backend:$baseline"
  local repaired_image="ghcr.io/${IMAGE_OWNER}/metasheet2-backend:$DEPLOY_SHA"
  local new_sha="$DEPLOY_SHA"
  [[ "$new_sha" != "$baseline" ]] || fail "repair commit equals staging baseline"
  [[ -r "$OVERRIDE_FILE" ]] || fail "existing staging override is missing"
  [[ "$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER")" == "$base_image" ]] \
    || fail "staging backend image tag changed after the read-only probe"
  [[ "$(docker inspect -f '{{.Image}}' "$BACKEND_CONTAINER")" == "$base_image_id" ]] \
    || fail "staging backend image ID changed after the read-only probe"
  [[ "$(docker image inspect -f '{{.Id}}' "$base_image")" == "$base_image_id" ]] \
    || fail "local rollback tag no longer names the original image"
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$BACKEND_CONTAINER")" == "$STAGING_COMPOSE_FILE,$OVERRIDE_FILE" ]] \
    || fail "running staging backend is managed by different compose files"

  local other_ids_before
  other_ids_before="$(docker inspect -f '{{.Id}}' "$WEB_CONTAINER" "$POSTGRES_CONTAINER" "$REDIS_CONTAINER")"

  local expected_build="$baseline"
  check_fence() {
    local supported="$1"
    action_authorization_fence_status
    python3 - "${OUTPUT_DIR}/authorization-fence-status.json" "$expected_build" "$catalog_digest" "$supported" <<'PY'
import json
import sys

file, build, digest, supported = sys.argv[1:]
with open(file) as f:
    p = json.load(f)
assert p['buildCommit'] == build and p['digest'] == digest, 'build or catalog fingerprint differs'
assert p['initialSchemaPublic'] is True and p['readOnly'] is True, 'catalog probe is inconclusive'
assert p['ordinary'] is True and p['tableCount'] == p['tableCountExpected'] == 22
assert p['exactDepartmentEnabled'] is False and p['activationEnabled'] is False, 'scope switch is live'
assert p['profileSupported'] is (supported == 'true'), 'unexpected fence verdict'
assert p['previewFenceReady'] is (supported == 'true'), 'unexpected preview readiness'
PY
  }
  check_fence false
  cp "${OUTPUT_DIR}/authorization-fence-status.json" "${OUTPUT_DIR}/authorization-fence-before.json"

  local image_dir="${HERE}/authorization-fence-image"
  [[ -s "$image_dir/authorization-operation-fence.js" ]] || fail "compiled repair is missing"
  [[ -s "$image_dir/authorization-operation-fence.ts" ]] || fail "repair source is missing"
  docker build --pull=false --network=none \
    --build-arg "FENCE_BASE_IMAGE=$base_image" \
    --build-arg "FENCE_REPAIR_COMMIT=$new_sha" \
    --tag "$repaired_image" "$image_dir" > "${OUTPUT_DIR}/authorization-fence-build.log" 2>&1
  [[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$repaired_image")" == "$new_sha" ]] \
    || fail "local staging repair image did not retain exact source identity"
  docker run --rm --network=none --entrypoint node "$repaired_image" -e '
    const assert = require("node:assert/strict")
    const fence = require("/app/packages/core-backend/dist/src/admin/authorization-operation-fence.js")
    const staging = { ordinary: true, digest: process.argv[1], baseDigest: process.argv[2] }
    assert.equal(fence.isSupportedAuthorizationOperationSchema(staging), true)
    assert.equal(fence.isSupportedAuthorizationOperationSchema({ ...staging, ordinary: false }), false)
    assert.equal(fence.isSupportedAuthorizationOperationSchema({ ...staging, baseDigest: "unknown" }), false)
  ' "$catalog_digest" e68f86e512384bede332535e0d51b8b164d1e880aadba5c0f439f5b9d2b8b2b9

  # Preserve existing permissions and every unrelated line. The copy lives beside
  # the deployed override so replacement and rollback are atomic.
  local saved candidate
  saved="$(mktemp "${RUNNER_PERSIST_DIR}/.fence-rollback.XXXXXX")"
  candidate="$(mktemp "${RUNNER_PERSIST_DIR}/.fence-candidate.XXXXXX")"
  cp -p "$OVERRIDE_FILE" "$saved"
  cp -p "$OVERRIDE_FILE" "$candidate"
  local installed=false completed=false
  finish_repair() {
    local rc=$?
    if [[ "$completed" != true && "$installed" == true ]]; then
      cp -p "$saved" "$candidate"
      mv -f "$candidate" "$OVERRIDE_FILE"
      DEPLOY_SHA="$baseline"
      if compose_staging up -d --no-deps --pull never backend >/dev/null 2>&1 \
          && wait_for_health_commit "$baseline" 15 3; then
        echo 'rollback=verified' >> "${OUTPUT_DIR}/summary.txt"
      else
        echo 'rollback=failed' >> "${OUTPUT_DIR}/summary.txt"
      fi
    fi
    rm -f -- "$candidate"
    if [[ "$installed" != true || "$completed" == true ]]; then
      rm -f -- "$saved"
    fi
    return "$rc"
  }
  trap finish_repair EXIT
  python3 - "$candidate" "$base_image" "$repaired_image" <<'PY'
from pathlib import Path
import sys

path, baseline, repaired = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
old = '    image: ' + baseline + '\n'
new = '    image: ' + repaired + '\n'
data = path.read_text()
assert data.count(old) == 1, 'expected exactly one pinned staging backend override'
path.write_text(data.replace(old, new))
PY
  (
    cd "$STAGING_DIR"
    python3 - "$STAGING_COMPOSE_FILE" "$OVERRIDE_FILE" "$candidate" "$IMAGE_OWNER" "$baseline" "$new_sha" "$repaired_image" <<'PY'
import json
import os
import subprocess
import sys

compose, old, new, owner, baseline, candidate, image = sys.argv[1:]
def resolved(override, sha):
    env = dict(os.environ, IMAGE_OWNER=owner, IMAGE_TAG=sha)
    cmd = ['docker', 'compose', '--project-directory', os.getcwd(), '-f', compose,
           '-f', override, 'config', '--format', 'json']
    run = subprocess.run(cmd, capture_output=True, env=env)
    assert run.returncode == 0, 'compose config failed'
    return json.loads(run.stdout)

before, after = resolved(old, baseline), resolved(new, candidate)
backend = after['services']['backend']
assert backend['container_name'] == 'metasheet-staging-backend' and backend['image'] == image
for key in ['DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED', 'DELEGATED_SCOPE_ACTIVATION_ENABLED']:
    assert backend['environment'].get(key) != 'true', 'scope switch would be live'
assert backend['environment']['METASHEET_BUILD_COMMIT'] == candidate
assert backend['environment']['METASHEET_BUILD_IMAGE_TAG'] == candidate
before_backend = before['services']['backend']
backend['image'] = before_backend['image']
for key in ['METASHEET_BUILD_COMMIT', 'METASHEET_BUILD_IMAGE_TAG']:
    backend['environment'][key] = before_backend['environment'][key]
assert before == after, 'staging compose changed outside backend image and build identity'
PY
  )
  mv -f "$candidate" "$OVERRIDE_FILE"
  installed=true
  compose_staging up -d --no-deps --pull never backend > "${OUTPUT_DIR}/authorization-fence-compose.log" 2>&1
  wait_for_health_commit "$new_sha"
  [[ "$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER")" == "$repaired_image" ]] \
    || fail "restarted backend is not the repair image"
  [[ "$(docker inspect -f '{{.Id}}' "$WEB_CONTAINER" "$POSTGRES_CONTAINER" "$REDIS_CONTAINER")" == "$other_ids_before" ]] \
    || fail "a non-backend staging container changed"
  expected_build="$new_sha"
  check_fence true
  {
    echo 'action=authorization-fence-repair'
    echo "baseline=$baseline"
    echo "repaired=$new_sha"
    echo "catalog_digest=$catalog_digest"
    echo "web_postgres_redis=unchanged"
    echo "scope_switches=off"
    echo "schema=unchanged"
    echo "result=ok"
  } > "${OUTPUT_DIR}/summary.txt"
  completed=true
)
