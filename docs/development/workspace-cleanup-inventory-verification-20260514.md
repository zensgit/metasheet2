# Workspace Cleanup Inventory Verification 2026-05-14

## Verification Commands

```bash
git status --short

git status --short | awk '{print $2}' | sed 's#/$##' | awk '
  /^docs\/development\/integration-core-/ {core++ ; next}
  /^docs\/development\/integration-k3wise|^docs\/development\/k3wise-|^output\/delivery\/multitable-onprem|^output\/releases/ {k3++ ; next}
  /^docs\/development\/multitable-feishu/ {feishu++ ; next}
  /^docs\/operations\/|^docs\/development\/operations-|^docs\/development\/staging-/ {ops++ ; next}
  /^output\/dingtalk-live-acceptance/ {dingtalk++ ; next}
  /^\.claude/ {local++ ; next}
  {other++}
  END {printf "core=%d\nk3=%d\nfeishu=%d\nops=%d\ndingtalk=%d\nlocal=%d\nother=%d\n", core+0,k3+0,feishu+0,ops+0,dingtalk+0,local+0,other+0}'

find output/dingtalk-live-acceptance -type f 2>/dev/null | wc -l

git ls-tree -r --name-only origin/main -- \
  docs/development/k3wise-bridge-machine-codex-handoff-20260513.md \
  docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md \
  docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md \
  docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md

git diff --check

files="$(git diff --name-only)"
pattern='access_''token=[^[:space:]]+|SEC[0-9A-Za-z]{20,}|ey''J[0-9A-Za-z_-]+\.|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}'
rg -n "${pattern}" ${files}
```

## Observed Inventory

Root checkout classification before this cleanup package:

```text
core=10
k3=4
feishu=5
ops=5
dingtalk=1
local=1
other=0
```

`output/dingtalk-live-acceptance/20260510/` contained 16 files. These are local
operator evidence outputs and should remain untracked.

The K3 delivery/output directories contain generated zip/tgz bundles,
checksums, delivery manifests, and verification outputs. These are generated
release artifacts, not source files.

## Expected Post-Merge Effect

After this ignore-rule package lands and the root checkout is refreshed onto a
mainline containing it:

- `.claude/` no longer appears as ordinary untracked source work;
- `output/dingtalk-live-acceptance/` no longer appears as ordinary untracked
  source work;
- generated multitable on-prem release bundles under `output/delivery/` and
  `output/releases/` no longer pollute `git status`;
- source docs still appear if they are truly new and not present on the current
  branch.

## Result

The cleanup is safe because it is ignore-only and docs-only. It does not remove
or mutate local evidence files.
