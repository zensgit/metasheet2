# Visual CI call-contract reconciliation — 2026-10-21

Source repair: `1c94a7ca501ab3334e1c23962950c90c6bc4d4bc`. This document is a separate closeout commit. Product/image source remains `ed7b2945542346f52a1fc25b265b3f064b657aba`.

## Failure and change

[Draft #6472](https://github.com/zensgit/metasheet2/pull/6472) at `c88ca7caecec2103d58d2453a316bc500eabced9` reached the [Visual web cohort](https://github.com/zensgit/metasheet2/actions/runs/39568816887/job/119117584346) after its backend, PostgreSQL and type steps. Two test assertions still described the old call arity. The panel now always passes its optional `managedSourceId` to both list and image services. In these unmanaged fixtures that exact argument is `undefined`.

Three assertions now require that explicit `undefined` argument, alongside the same exact token, file, part and AbortSignal checks. The image assertion follows the first failing list assertion, so it was repaired too. No product source, workflow, test case, threshold or baseline changed.

## Verification

Using existing Node20.20.2 dependencies from `apps/web`, the unchanged ten-file workflow cohort reproduced **197 passed / 2 failed / 0 skipped**, 199 total. After the three-line repair, only the affected `tests/plm-embed-visual-preview.spec.ts` was rerun: **12 passed / 0 failed / 0 skipped**. The other nine files had already passed all 187 cases and were not rerun. This is evidence across two executions, not a claim of one complete green 199-case run.

```sh
node node_modules/vitest/vitest.mjs run --no-cache --watch=false --config vite.config.ts \
  tests/plm-embed-visual-preview.spec.ts --reporter=json \
  --outputFile=/tmp/plm6472-visual-preview-green-20261021.json
git diff --check
```

The initial edit command used a repository-relative path while running in `apps/web`, failed before editing, and the shell subsequently ran the unchanged cohort. That is the retained red reproduction, not a repaired run. The path was corrected before the successful focused run. Individual JSON assertion statuses and the exact three-line diff were checked independently. Evidence manifest SHA256: `51aeec0b6cba5fcd1324b0abf2d5ed32466e0e1f9cb5c22fe1b98590049df63f`.

## Boundaries

The previous head has 46 successful and two failed terminal checks. Its remaining Discussion/PostgreSQL failure still requires the dedicated `PLM_NATIVE_READ_TOKEN` for private Native checkout; no credential fallback was introduced. Final-head CI remains required. Installed-image proof for the unchanged product source is separate from this test repair. Keep this PR Draft; no merge, deployment, production enablement or real notification. The full engineering goal remains incomplete.
