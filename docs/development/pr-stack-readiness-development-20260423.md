# PR Stack Readiness Development - 2026-04-23

## Context

The previous mainline guard prevents a stacked PR from being treated as a `main` PR. The next gap is stack-level visibility: once a PR queue is intentionally stacked, operators need a deterministic way to verify that the chain is continuous and identify the first dirty node.

The current DingTalk queue is a stacked chain. Only `#1052` targets `main`; later PRs target the previous branch head. Manual inspection is error-prone because the open queue contains many PRs with green `pr-validate` but different bases.

## Change

Added `scripts/ops/check-pr-stack-readiness.mjs`.

The tool accepts PR numbers from bottom to top and checks:

- first PR targets `--root-base`, defaulting to `main`
- each later PR targets the previous PR's `headRefName`
- each PR is `OPEN`
- each PR is `CLEAN`
- checks are completed successfully, skipped, or neutral

It supports:

- live GitHub mode via `gh pr view`
- offline JSON mode via `--input-json`
- `text`, `markdown`, and `json` output
- `--output <path>` evidence reports

## Evidence Generated

Full open DingTalk stack:

- `output/pr-stack-dingtalk-open-1052-1100-20260423.json`
- `output/pr-stack-readiness-dingtalk-1052-1100-20260423.md`

Focused DingTalk P4 substack:

- `output/pr-stack-readiness-dingtalk-p4-1076-1100-20260423.md`

## Findings From Live Queue

Full open queue result: `FAIL`.

- `#1052` targets `main` but is `DIRTY`; it is not safe for admin merge.
- `#1065` is not continuous with the previous open PR in the sampled list, meaning the open-list sample spans more than one stack segment or has already-merged parent branches.
- `#1078` is `DIRTY`.

Focused P4 substack result: `FAIL`.

- `#1076` is now `PASS` after the earlier rebase repair.
- `#1078` is the first failing node: it targets the correct base but is `DIRTY`.
- `#1082` through `#1100` are continuous and `CLEAN` relative to their immediate bases.

## Operational Guidance

Use the mainline guard before admin-merging a direct `main` PR:

```bash
node scripts/ops/check-pr-mainline-readiness.mjs <pr>
```

Use the stack guard before advancing or rebasing a stacked queue:

```bash
node scripts/ops/check-pr-stack-readiness.mjs \
  --root-base main \
  <bottom-pr> <next-pr> ... <top-pr>
```

For the DingTalk P4 substack specifically:

```bash
node scripts/ops/check-pr-stack-readiness.mjs \
  --root-base codex/dingtalk-person-delivery-skip-reasons-20260422 \
  1076 1078 1082 1083 1085 1086 1087 1089 1090 1093 1094 1095 1097 1099 1100
```

## Non-Goals

- Does not rebase or mutate branches.
- Does not flatten a stack into `main`.
- Does not replace code review or branch protection.
- Does not infer missing closed/merged PRs; pass one continuous chain when continuity matters.
