# K3 WISE GATE Contract Checker Windows Entrypoint Verification - 2026-05-22

## Local Verification

### 1. Focused Checker Tests

Command:

```bash
node --test scripts/ops/integration-k3wise-gate-contract-check.test.mjs
```

Expected:

- Existing PASS packet behavior still passes.
- Existing missing-answer template behavior still returns `GATE_BLOCKED`.
- Existing secret scan behavior still rejects raw secrets.
- Existing `--init-template` smoke still creates packet JSON, 8 sample skeletons,
  and a blocked empty-template report.
- New Windows direct-run guard test passes for:
  - backslash Windows paths;
  - forward-slash Windows paths;
  - case-insensitive Windows paths;
  - negative non-matching script path;
  - POSIX direct-run path.
- New symlink/realpath direct-run guard test passes for equivalent physical
  paths, covering the macOS `/tmp` to `/private/tmp` package-verification case.

### 2. CLI Template Smoke

Command:

```bash
tmp_dir="$(mktemp -d)"
node scripts/ops/integration-k3wise-gate-contract-check.mjs --init-template "$tmp_dir"
test -f "$tmp_dir/README-CUSTOMER-HANDOFF.zh.md"
test -f "$tmp_dir/k3wise-gate-contract-packet.template.json"
find "$tmp_dir" -maxdepth 1 -name '*.redacted.json' | wc -l
```

Expected:

- CLI exits `0`.
- README exists.
- Packet template exists.
- Eight redacted sample skeletons exist.

### 3. Existing GATE Contract Verify

Command:

```bash
pnpm verify:integration-k3wise:gate-contract
```

Expected:

- Full existing gate-contract verification remains green.

### 4. Syntax / Whitespace

Commands:

```bash
node --check scripts/ops/integration-k3wise-gate-contract-check.mjs
git diff --check origin/main...HEAD
```

Expected:

- Syntax check passes.
- Diff check reports no whitespace or conflict-marker issues.

## Entity-Machine Retest After Package

After merge and package rebuild, retest the exact failed Windows command:

```powershell
node scripts\ops\integration-k3wise-gate-contract-check.mjs --init-template C:\metasheet\artifacts\k3wise-gate-contract-<sha>
```

PASS criteria:

- Command exits `0`.
- Target directory is created.
- Directory contains `README-CUSTOMER-HANDOFF.zh.md`.
- Directory contains `k3wise-gate-contract-packet.template.json`.
- Directory contains 8 redacted sample skeletons.
- Running the checker against the empty template returns expected
  `GATE_BLOCKED`, not silent success.

## Package Extraction Smoke

The Release verification should also extract the Windows zip to a temporary
directory and run the packaged checker directly from that extracted path:

```bash
node <extracted-package>/scripts/ops/integration-k3wise-gate-contract-check.mjs --init-template <tmp-output-dir>
```

PASS criteria:

- stdout contains `TEMPLATE_CREATED`;
- the target directory is created;
- README, packet JSON, and 8 redacted sample skeletons exist;
- checking the empty template returns exit `2` with `GATE_BLOCKED`.

## Security Check

This change does not alter packet contents or evidence rendering. Existing
secret checks still cover:

- JWT-shaped values;
- Bearer tokens;
- password/secret/token-like keys;
- DB connection strings with credentials;
- secret query parameters.

No credentials, SQL connection strings, K3 tokens, session IDs, authority codes,
or customer row values are introduced by this change.
