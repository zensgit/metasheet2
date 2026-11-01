#!/usr/bin/env bash
set -euo pipefail

# Restore only a fresh synthetic view owned by this invocation.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec node "$SCRIPT_DIR/ops/phase5-snapshot-fixture.mjs"
