# DingTalk P4 Stack Rebase Repair Development - 2026-04-23

## Scope

This change records the operational repair of the DingTalk P4 stacked PR chain. It does not merge the DingTalk business stack into `main`; it only documents the branch rebase/push repair and the post-repair readiness evidence.

## Stack Segment

Root base:

```text
codex/dingtalk-person-delivery-skip-reasons-20260422
```

Validated PR order:

```text
#1076 -> #1078 -> #1082 -> #1083 -> #1085 -> #1086 -> #1087 -> #1089 -> #1090 -> #1093 -> #1094 -> #1095 -> #1097 -> #1099 -> #1100
```

## Repair Actions

The dirty section started after #1076 because downstream branches still pointed at stale parent heads. Each child branch was rebased onto its updated parent and pushed with `--force-with-lease`.

| PR | Branch | New Head |
| --- | --- | --- |
| #1078 | `codex/dingtalk-p4-api-smoke-runner-20260422` | `332e31ef8` |
| #1082 | `codex/dingtalk-p4-smoke-preflight-20260422` | `239cd0c025` |
| #1083 | `codex/dingtalk-p4-manual-evidence-kit-20260423` | `9740975e6` |
| #1085 | `codex/dingtalk-p4-artifact-gate-20260423` | `187b144cb` |
| #1086 | `codex/dingtalk-p4-smoke-workspace-20260423` | `171be76fa` |
| #1087 | `codex/dingtalk-p4-smoke-session-20260423` | `3051e7ed7` |
| #1089 | `codex/dingtalk-p4-smoke-session-env-template-20260423` | `bcea75cb5` |
| #1090 | `codex/dingtalk-p4-smoke-session-finalize-20260423` | `1b72e6c41` |
| #1093 | `codex/dingtalk-p4-evidence-packet-final-gate-20260423` | `0762c7959` |
| #1094 | `codex/dingtalk-p4-packet-stale-output-guard-20260423` | `1a817c28e` |
| #1095 | `codex/dingtalk-p4-packet-publish-check-20260423` | `dbc8529bc` |
| #1097 | `codex/dingtalk-p4-final-handoff-command-20260423` | `fa7d4aa39` |
| #1099 | `codex/dingtalk-p4-smoke-status-report-20260423` | `8567f6648` |
| #1100 | `codex/dingtalk-p4-evidence-record-cli-20260423` | `5993bc714` |

## Design Notes

The repair preserves the original stack shape. No branch was retargeted to `main`, and no business diff was squashed into a different PR.

`--force-with-lease` was used because every repaired branch is a PR branch whose history had to be restacked onto the updated parent. This is safer than a blind force push because it refuses to overwrite unexpected remote updates.

The top-of-stack verification was run from #1100 after every downstream branch had been repaired. That gives coverage over all scripts added by the P4 evidence pipeline.

## Artifacts

Post-repair readiness report:

```text
output/pr-stack-readiness-dingtalk-p4-after-repair-20260423.md
```

Delivery verification summary:

```text
output/delivery/dingtalk-p4-stack-rebase-repair-20260423/TEST_AND_VERIFICATION.md
```
