#!/usr/bin/env node
/**
 * Integration Guard terminal branch assertion (governance slice, 2026-07-25).
 *
 * Runs as the LAST step of the `integration-guard` job with `if: always()`, so it executes
 * regardless of which earlier steps ran, skipped, or failed. It is the runtime door that closes the
 * "set the initial value to `relevant=unknown`" false-green: if the classifier ever emits anything
 * other than the literal strings `true`/`false` for `steps.changes.outputs.relevant`, every
 * `==\'true\'`/`==\'false\'` gated step below it evaluates to false and is SKIPPED (not failed) by
 * GitHub — so without this step the job would report green having run nothing at all. This step
 * fails the job (non-zero exit) in that case.
 *
 * This is the SECOND, INDEPENDENT door against that mutation class — scripts/ops/
 * integration-guard-classify.mjs's own `classify()` already only ever returns a JS boolean, so the
 * shell string it ever writes is only ever `relevant=true` or `relevant=false`; this step additionally
 * catches any other way `relevant` could end up wrong at runtime (a future edit reintroducing an
 * inline default, a step reordering, etc.) without relying on the classifier script being correct.
 * Neuter either door independently and the other must still catch the mutation — see the "两道
 * fail-closed门互相掩护" note in the contract test file for why both are kept and tested separately.
 *
 * @param {{ relevant: string | undefined, noopOutcome: string | undefined, pluginOutcome: string | undefined, webOutcome: string | undefined }} state
 * @returns {{ ok: boolean, message: string }}
 */
export function assertBranch({ relevant, noopOutcome, pluginOutcome, webOutcome }) {
  if (relevant !== 'true' && relevant !== 'false') {
    return {
      ok: false,
      message:
        `integration-guard: steps.changes.outputs.relevant must be strictly 'true' or 'false', got ` +
        `${JSON.stringify(relevant)}. A classification result that is empty, 'unknown', or any other ` +
        `value means every relevant==true/false gated step below was SKIPPED (not failed) and this ` +
        `job would otherwise report SUCCESS having run nothing at all.`,
    }
  }

  if (relevant === 'true') {
    if (pluginOutcome === 'success' && webOutcome === 'success' && noopOutcome === 'skipped') {
      return { ok: true, message: 'integration-guard: relevant=true, both real test steps succeeded, no-op skipped.' }
    }
    return {
      ok: false,
      message:
        `integration-guard: relevant=true but the real branch did not run to completion as expected ` +
        `(plugin step outcome=${JSON.stringify(pluginOutcome)}, web step outcome=${JSON.stringify(webOutcome)}, ` +
        `no-op step outcome=${JSON.stringify(noopOutcome)}; expected plugin=success, web=success, no-op=skipped).`,
    }
  }

  // relevant === 'false'
  if (noopOutcome === 'success' && pluginOutcome === 'skipped' && webOutcome === 'skipped') {
    return { ok: true, message: 'integration-guard: relevant=false, no-op succeeded, both real test steps skipped.' }
  }
  return {
    ok: false,
    message:
      `integration-guard: relevant=false but the no-op branch did not run to completion as expected ` +
      `(no-op step outcome=${JSON.stringify(noopOutcome)}, plugin step outcome=${JSON.stringify(pluginOutcome)}, ` +
      `web step outcome=${JSON.stringify(webOutcome)}; expected no-op=success, plugin=skipped, web=skipped).`,
  }
}

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`
}

if (isMainModule()) {
  const result = assertBranch({
    relevant: process.env.RELEVANT,
    noopOutcome: process.env.NOOP_OUTCOME,
    pluginOutcome: process.env.PLUGIN_OUTCOME,
    webOutcome: process.env.WEB_OUTCOME,
  })
  if (result.ok) {
    process.stdout.write(`${result.message}\n`)
    process.exit(0)
  } else {
    process.stderr.write(`${result.message}\n`)
    process.exit(1)
  }
}
