# DingTalk P4 Strict Artifact Gate Verification

- Date: 2026-04-23
- Scope: evidence compiler strict artifact validation

## Commands Run

```bash
node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs
node --test scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
git diff --cached --check
```

## Results

- `node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs`: passed.
- `node --test scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs`: passed, 11 tests.
- `git diff --cached --check`: passed after staging the artifact-gate changes.

## Coverage Notes

- Passing evidence now creates real non-empty files under `artifacts/<check-id>/`.
- Strict mode fails for missing artifact files with `artifact_ref_missing`.
- Strict mode fails for wrong per-check folders with `artifact_ref_wrong_folder`.
- Strict mode fails for absolute paths with `artifact_ref_not_relative`.
- Strict mode fails for path traversal with `artifact_ref_path_traversal`.
- Strict mode fails for empty files with `artifact_ref_empty`.
- Strict mode fails for external URL refs unless `--allow-external-artifact-refs` is set.

## Remaining Remote Validation

- Run the 142/staging smoke with a generated evidence kit.
- Capture real DingTalk-client/admin artifacts into the bundle.
- Compile the completed evidence with `--strict`.
