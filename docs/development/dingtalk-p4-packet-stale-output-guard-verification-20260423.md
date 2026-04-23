# DingTalk P4 Packet Stale Output Guard Verification

- Date: 2026-04-23
- Scope: packet exporter failed-rerun safety

## Commands Run

```bash
node --check scripts/ops/export-dingtalk-staging-evidence-packet.mjs
node --check scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
git diff --cached --check
```

## Results

- `node --check scripts/ops/export-dingtalk-staging-evidence-packet.mjs`: passed.
- `node --check scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs`: passed.
- `node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs`: passed, 12/12 tests.
- `git diff --cached --check`: passed.

## Coverage Notes

- Existing ungated and gated export paths remain covered.
- New regression coverage verifies successful gated and ungated exports followed by a failed gated rerun against the same output directory remove stale `manifest.json` and `README.md`.
- Existing final-pass failure coverage still verifies bad sessions are rejected before copying new evidence.

## Remaining Remote Validation

- Export a real final packet from the 142/staging P4 session only after `--finalize` passes.
