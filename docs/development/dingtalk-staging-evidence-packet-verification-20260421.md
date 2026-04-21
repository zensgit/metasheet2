# DingTalk Staging Evidence Packet Verification 2026-04-21

## Scope

Verify the new packet exporter locally without requiring staging credentials or
remote access.

## Commands Run

```bash
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

Result:

```text
tests 4
pass 4
fail 0
duration_ms 143.40625
```

```bash
node --check scripts/ops/export-dingtalk-staging-evidence-packet.mjs
node --check scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

Result: both syntax checks passed.

```bash
rm -rf tmp/dingtalk-staging-evidence-packet-smoke
node scripts/ops/export-dingtalk-staging-evidence-packet.mjs \
  --output-dir tmp/dingtalk-staging-evidence-packet-smoke
find tmp/dingtalk-staging-evidence-packet-smoke -maxdepth 3 -type f | sort
```

Result: export completed and wrote:

```text
tmp/dingtalk-staging-evidence-packet-smoke/README.md
tmp/dingtalk-staging-evidence-packet-smoke/docker/app.staging.env.example
tmp/dingtalk-staging-evidence-packet-smoke/docs/development/dingtalk-live-tenant-validation-checklist-20260408.md
tmp/dingtalk-staging-evidence-packet-smoke/docs/development/dingtalk-stack-merge-readiness-20260408.md
tmp/dingtalk-staging-evidence-packet-smoke/docs/development/dingtalk-staging-canary-deploy-20260408.md
tmp/dingtalk-staging-evidence-packet-smoke/docs/development/dingtalk-staging-execution-checklist-20260408.md
tmp/dingtalk-staging-evidence-packet-smoke/manifest.json
tmp/dingtalk-staging-evidence-packet-smoke/scripts/ops/build-dingtalk-staging-images.sh
tmp/dingtalk-staging-evidence-packet-smoke/scripts/ops/deploy-dingtalk-staging.sh
tmp/dingtalk-staging-evidence-packet-smoke/scripts/ops/repair-env-file.sh
tmp/dingtalk-staging-evidence-packet-smoke/scripts/ops/validate-env-file.sh
```

## Test Coverage

- Required docs/config/scripts are copied into the packet.
- `manifest.json` records packet identity, file list, and optional evidence.
- `README.md` includes operator order and no-evidence warning.
- Optional evidence directories are copied into `evidence/`.
- Missing optional evidence directories fail closed.
- Unknown CLI arguments fail closed.

## Not Run

- Real 142/shared-dev staging smoke was not run in this change. The exporter is
  a local handoff generator and deliberately avoids remote dependencies.

