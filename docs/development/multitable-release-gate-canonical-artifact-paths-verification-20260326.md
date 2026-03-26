# Multitable Release Gate Canonical Artifact Paths Verification

## Scope

Validated the clean slice that makes the canonical multitable pilot release-gate report self-describing by recording resolved artifact paths for:

- gate output root
- gate JSON report
- gate Markdown report
- gate log
- smoke output root

This slice only changes the canonical gate report surface and its focused tests.

## Commands

Executed:

```bash
bash -n scripts/ops/multitable-pilot-release-gate.sh
```

```bash
node --test scripts/ops/multitable-pilot-release-gate.test.mjs scripts/ops/multitable-pilot-readiness.test.mjs
```

```bash
node --check scripts/ops/multitable-pilot-readiness.mjs
```

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

```bash
pnpm --filter @metasheet/web build
```

## Results

- Shell syntax check passed for `multitable-pilot-release-gate.sh`.
- Focused Node tests passed for release-gate canonical fields and readiness fallback behavior.
- `multitable-pilot-readiness.mjs` syntax check passed.
- Frontend type-check passed.
- Frontend production build passed.

## Assertions Locked

- local direct gate runs write `outputRoot`, `reportPath`, `reportMdPath`, `logPath`, and `liveSmoke.outputRoot`
- staging direct gate runs write the same canonical fields
- gate Markdown summary surfaces gate output root, gate log path, and smoke output root
- readiness can recover gate markdown and gate log paths from canonical gate JSON when explicit env paths are omitted

## Conclusion

The canonical multitable pilot release-gate report is now self-describing. Downstream tools no longer have to infer where gate-side diagnostics live when only the gate JSON artifact is preserved.
