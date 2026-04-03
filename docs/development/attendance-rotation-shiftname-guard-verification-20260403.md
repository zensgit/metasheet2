# Attendance Rotation Shift Name Guard Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "returns 409 when deleting a shift that is still referenced by an active rotation assignment" --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

## Expected

- Focused integration passes with a rotation rule whose `shiftSequence` stores the shift name, not the shift UUID.
- Deleting that referenced shift returns `409 CONFLICT`.
- The existing direct assignment guard remains unaffected.

## Notes

- This verifies the real deployed contract observed in Run 31: rotation rules may reference shift names.
- Long-term normalization to UUID-based references should be tracked separately if rename-safe integrity is required.
