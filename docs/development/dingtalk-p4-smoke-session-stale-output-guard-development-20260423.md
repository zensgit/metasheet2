# DingTalk P4 Smoke Session Stale Output Guard Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Scope: harden local P4 smoke-session reruns before final 142 execution

## Problem

The P4 smoke-session wrapper can be rerun with an existing `--output-dir` while operators iterate on final DingTalk evidence. Before this change, failed reruns could leave stale generated artifacts in place:

- A failed bootstrap preflight could leave previous `workspace/evidence.json`, compiled summaries, status reports, or TODO Markdown in the session directory.
- A failed final strict compile could leave a previous passing `compiled/summary.json`, making the directory look healthier than the latest run.
- Generated next commands still carried a sample packet output path (`artifacts/dingtalk-staging-evidence-packet/142-final`) instead of a path derived from the current session directory.
- Packet export and final handoff commands did not pin `--output-dir`, so operators had to infer or manually align packet paths during closeout.

## Changes

- `dingtalk-p4-smoke-session.mjs` now clears generated bootstrap outputs before a new bootstrap run:
  - `preflight`
  - `workspace`
  - `compiled`
  - `session-summary.json`
  - `session-summary.md`
  - `smoke-status.json`
  - `smoke-status.md`
  - `smoke-todo.md`
- Finalization clears `compiled/` before strict compile so the compiled summary always reflects the latest evidence validation.
- Packet output paths are now derived from the session output directory with a sanitized `<session-name>-final` suffix.
- Generated export, final handoff, and final closeout commands now share the same derived packet path.
- Generated commands no longer hardcode `artifacts/dingtalk-staging-evidence-packet/142-final`.
- The master DingTalk plan/TODO now tracks this smoke-session rerun hardening as complete.

## Operator Impact

For a session directory such as:

```bash
output/dingtalk-p4-remote-smoke-session/142-session
```

the generated final packet path is now:

```bash
artifacts/dingtalk-staging-evidence-packet/142-session-final
```

The closeout chain now points to one consistent packet directory:

```bash
node scripts/ops/export-dingtalk-staging-evidence-packet.mjs \
  --output-dir artifacts/dingtalk-staging-evidence-packet/142-session-final \
  --include-output output/dingtalk-p4-remote-smoke-session/142-session \
  --require-dingtalk-p4-pass

node scripts/ops/dingtalk-p4-final-handoff.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --output-dir artifacts/dingtalk-staging-evidence-packet/142-session-final

node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-session-final \
  --docs-output-dir docs/development
```

## Out Of Scope

- No real 142 staging, DingTalk tenant, robot webhook, or browser-client smoke was executed.
- No admin token, DingTalk robot token, SEC secret, or public form token was generated or used.
- This does not change the evidence schema, remote smoke API calls, packet validator, or final docs generator.
