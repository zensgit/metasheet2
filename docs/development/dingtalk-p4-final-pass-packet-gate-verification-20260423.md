# DingTalk P4 Final-Pass Packet Gate Verification

- Date: 2026-04-23
- Scope: packet exporter final-pass validation

## Commands Run

```bash
node --check scripts/ops/export-dingtalk-staging-evidence-packet.mjs
node --check scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.test.mjs
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/dingtalk-p4-smoke-session.test.mjs
git diff --cached --check
```

## Results

- `node --check scripts/ops/export-dingtalk-staging-evidence-packet.mjs`: passed.
- `node --check scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs`: passed.
- `node --check scripts/ops/dingtalk-p4-smoke-session.mjs`: passed.
- `node --check scripts/ops/dingtalk-p4-smoke-session.test.mjs`: passed.
- `node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs`: passed, 10/10 tests.
- `node --test scripts/ops/dingtalk-p4-smoke-session.test.mjs`: passed, 6/6 tests.
- `git diff --cached --check`: passed.

## Coverage Notes

- Existing packet export without the new gate remains compatible.
- Gate success coverage verifies a finalized passing P4 session can be copied and records `dingtalkP4FinalStatus`.
- Gate failure coverage verifies a `manual_pending` / non-final session is rejected.
- Strict schema coverage verifies missing arrays, wrong compiler tool, API bootstrap failure, non-empty manual evidence issues, failed strict compile, pending session checks, and non-pass required checks are rejected.
- Multi-include coverage verifies all included sessions are prevalidated before packet files or manifest are written.
- Argument coverage verifies `--require-dingtalk-p4-pass` requires at least one `--include-output`.
- Session finalize coverage verifies the generated final packet export command includes `--require-dingtalk-p4-pass`.

## Remaining Remote Validation

- Export a final packet from the real 142/staging session only after `--finalize` passes.
