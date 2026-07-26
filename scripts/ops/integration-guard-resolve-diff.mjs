#!/usr/bin/env node
/**
 * Integration Guard BASE_SHA resolver (governance slice, #4614 P2, 2026-07-26).
 *
 * THE DEFECT THIS CLOSES. The classifier step used to decide its git command with inline bash:
 *   if [[ -z "${BASE_SHA:-}" || "$BASE_SHA" == "0000000000000000000000000000000000000000" ]]; then
 *     git diff-tree --root --no-commit-id --name-only -z -r "$HEAD_SHA"
 *   else
 *     git diff --name-only -z "$BASE_SHA" "$HEAD_SHA"
 *   fi
 * That fallback branch is meant for an INITIAL PUSH (a brand-new branch, where
 * `github.event.before` really is the all-zeros sentinel — there is no prior commit to diff
 * against). But the condition fires identically whenever BASE_SHA is EMPTY for ANY reason —
 * including a `pull_request`/`merge_group` event where it should never legitimately be empty.
 * And the fallback command itself is silently wrong for those events: `github.sha` (HEAD_SHA) on
 * a `pull_request` event is GitHub's own ephemeral MERGE COMMIT, and
 * `git diff-tree --root --no-commit-id -r <merge-sha>` emits ZERO paths for any merge commit
 * (`diff-tree` ignores merges by design unless `-m`/`-c` is passed) — verified against this
 * line's own real GitHub-generated merge commit in PR #4614's review evidence:
 *   $ git diff-tree --root --no-commit-id --name-only -z -r b83e180d8 | wc -l   # fallback branch
 *   0
 *   $ git diff --name-only -z 97cf62033 b83e180d8 | wc -l                       # real BASE_SHA branch
 *   6
 * So a run where BASE_SHA ends up empty/zero/malformed on a `pull_request`/`merge_group` event —
 * for ANY reason (a GitHub payload quirk, a future workflow edit, a mutation) — silently
 * classifies as `relevant=false` regardless of what the PR actually touched. Exact-pinning the
 * `env: BASE_SHA: ...` EXPRESSION TEXT (see the contract test's Pin 6) only proves that
 * expression was not edited; it cannot prove the RUNTIME VALUE that expression evaluates to is
 * ever non-empty/well-formed, because that is a GitHub Actions runtime fact, not a source-text
 * fact — a fail-open condition guarded only by an exact pin is nonetheless fail-open.
 *
 * THE FIX. `resolveDiffArgs()` below decides the git invocation, and is fail-CLOSED by event:
 *   - a well-formed 40-hex BASE_SHA is ALWAYS accepted (any event) — `git diff` against it is safe
 *     regardless of why the workflow ran;
 *   - the ROOT fallback (`git diff-tree --root ...`) is allow-listed to the `push` event ONLY,
 *     and only when BASE_SHA is genuinely missing/the all-zeros sentinel (the actual initial-push
 *     shape) — this is the ONLY legitimate use of that fallback;
 *   - EVERY OTHER combination — `pull_request`/`merge_group` with a missing/zero/malformed
 *     BASE_SHA, a malformed (non-hex, non-empty, non-zero) BASE_SHA on ANY event including
 *     `push`, or an unrecognised event name with a missing/zero BASE_SHA — throws. There is no
 *     "unknown event defaults to permissive" branch: an event this function has not been told is
 *     safe is treated as UNSAFE, not silently allowed through, which is the same fail-open shape
 *     this whole fix exists to close, just moved one layer up.
 * A thrown error exits this script non-zero. This runs as its OWN workflow step (`id: resolve-diff`
 * in integration-guard.yml, no `if`), separate from the classifier step that reads its output —
 * NOT piped directly into scripts/ops/integration-guard-classify.mjs under a shared `pipefail`.
 * That distinction matters: `classify.mjs` correctly classifies an EMPTY diff as `relevant=false`
 * (its own documented behaviour for a genuinely empty change list), so if this script's failure
 * were only visible through a shell pipeline's exit code, classify.mjs would still run to
 * completion on the resulting empty stdin and write `relevant=false` to `$GITHUB_OUTPUT` — leaving
 * `steps.changes.outputs.relevant` set to a value indistinguishable from "genuinely no relevant
 * changes" while the pipeline's overall exit code disagreed. Splitting into its own step avoids
 * that ambiguity: this step's exit code IS this script's exit code; when it fails, GitHub's default
 * step-skip-on-earlier-failure leaves the classify step UNRUN, so `relevant` is never set to
 * anything at all — caught by scripts/ops/integration-guard-assert-branch.mjs's existing
 * relevant!=='true'/'false' rejection, no special-casing needed there. Either way the JOB reds
 * instead of silently no-op-ing green; this is what makes the MECHANISM by which it reds precise
 * and testable rather than an unverified claim about shell pipeline semantics.
 *
 * WHY A SEPARATE SCRIPT, NOT MORE BASH. Per owner ruling (#4614): "Extract this into a
 * behaviourally testable script rather than pinning more Bash text." `resolveDiffArgs()` is a
 * pure function (no filesystem, no subprocess) so scripts/ops/integration-guard-required-wiring-
 * contract.test.mjs can drive it directly with synthetic event/BASE_SHA/HEAD_SHA combinations —
 * including the exact malformed/missing/zero cases this fix is about — without needing GitHub
 * Actions, a real git repository, or even a real commit to exist. The CLI entrypoint below is the
 * only part that touches `git`/stdout, and is kept intentionally thin (resolve, then exec) so the
 * fail-closed decision is fully covered by the pure-function tests without ever needing to spawn a
 * real `git diff` in test — see the contract test file for why that matters (this same file is
 * also invoked from plugin-tests.yml's `test` job, which checks out with the default shallow
 * `fetch-depth: 1` and would not have the commit objects a real-git-diff test might need).
 */

import { spawnSync } from 'node:child_process'

export const ZERO_SHA = '0000000000000000000000000000000000000000'
const SHA_RE = /^[0-9a-f]{40}$/i

/** Events legitimately allowed to fall back to the root diff-tree when BASE_SHA is missing/zero.
 * ONLY an initial push (a brand-new branch, where `github.event.before` really is the all-zeros
 * sentinel because there is no prior commit) may do this — see the file header. */
const ROOT_FALLBACK_ALLOWED_EVENTS = new Set(['push'])

/**
 * @param {{ eventName: string | undefined, baseSha: string | undefined, headSha: string | undefined }} input
 * @returns {{ args: string[] }} the `git` argv that will emit a NUL-delimited changed-path list on stdout
 * @throws {Error} whenever BASE_SHA is missing/zero on a non-`push` event, or malformed on ANY event
 */
export function resolveDiffArgs({ eventName, baseSha, headSha }) {
  const head = (headSha ?? '').trim()
  if (!head) {
    throw new Error(
      'integration-guard: HEAD_SHA is missing/empty — there is no commit to diff against at all.',
    )
  }

  const base = (baseSha ?? '').trim()
  // isMissingOrZero is checked FIRST and separately from the SHA_RE format check below: the
  // all-zeros sentinel is itself 40 valid hex characters, so `SHA_RE.test(ZERO_SHA)` is `true` —
  // if the format check ran first, the zero-sha case would be misclassified as "a well-formed
  // BASE_SHA" and diffed against literally (which always fails at the git level, since the
  // all-zeros object never exists), silently bypassing the fail-closed/root-fallback decision
  // entirely. Order matters here, not just presence of both checks.
  const isMissingOrZero = base === '' || base === ZERO_SHA

  if (isMissingOrZero) {
    if (ROOT_FALLBACK_ALLOWED_EVENTS.has(eventName)) {
      return { args: ['diff-tree', '--root', '--no-commit-id', '--name-only', '-z', '-r', head] }
    }
    throw new Error(
      `integration-guard: BASE_SHA is missing/zero (${JSON.stringify(baseSha)}) for event ` +
        `${JSON.stringify(eventName)} — refusing the root diff-tree fallback. That fallback emits ` +
        `ZERO paths for a merge commit (the shape of HEAD_SHA on a real pull_request event), which ` +
        `would silently classify this run as relevant=false regardless of what actually changed — ` +
        `the exact mechanism behind PR #4614's real b83e180d8 evidence. Only the "push" event, ` +
        `with a genuinely missing/zero BASE_SHA (an initial push with no prior commit), may use ` +
        `that fallback.`,
    )
  }

  if (SHA_RE.test(base)) {
    return { args: ['diff', '--name-only', '-z', base, head] }
  }

  // Fail CLOSED: BASE_SHA is present, non-zero, and not a well-formed 40-hex SHA — malformed, on
  // ANY event including `push` (a garbled value is not the legitimate "initial push" signal, so
  // it must not silently pass through as if it were).
  throw new Error(
    `integration-guard: BASE_SHA is malformed (${JSON.stringify(baseSha)}) for event ` +
      `${JSON.stringify(eventName)} — a value that is neither empty, the all-zeros sentinel, nor ` +
      `a well-formed 40-character hex SHA must not be diffed against or treated as an initial-push ` +
      `signal.`,
  )
}

// ---------------------------------------------------------------------------
// CLI entrypoint — only runs when this file is executed directly. Resolves the git invocation
// from EVENT_NAME/BASE_SHA/HEAD_SHA env vars and execs it, writing its NUL-delimited stdout
// straight through (the workflow's own `id: resolve-diff` step redirects this to a temp file that
// the SEPARATE classify step below it then reads — see that step's comment for why this is a
// dedicated step rather than a shell pipe into integration-guard-classify.mjs). Fails closed
// (non-zero exit, no git ever spawned) on any invalid BASE_SHA — see resolveDiffArgs() above.
// ---------------------------------------------------------------------------

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`
}

if (isMainModule()) {
  let resolved
  try {
    resolved = resolveDiffArgs({
      eventName: process.env.EVENT_NAME,
      baseSha: process.env.BASE_SHA,
      headSha: process.env.HEAD_SHA,
    })
  } catch (err) {
    process.stderr.write(`${err.message || err}\n`)
    process.exit(1)
  }

  process.stderr.write(`Integration Guard: resolved diff command: git ${resolved.args.join(' ')}\n`)
  const result = spawnSync('git', resolved.args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) {
    process.stderr.write(`integration-guard: failed to spawn git: ${result.error.message}\n`)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}
