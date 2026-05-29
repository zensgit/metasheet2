import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'os'
import path from 'path'

import { ScriptSandbox } from '../../src/sandbox/ScriptSandbox'

// Read the private `workDir` without `any` (ESLint forbids `any`), mirroring the typed-cast
// pattern used in data-source-identifier-quoting.test.ts.
const workDirOf = (s: ScriptSandbox): string => (s as unknown as { workDir: string }).workDir

// Lane C / C1: the default sandbox workDir must derive from os.tmpdir() (portable to native
// Windows), not the hardcoded POSIX literal '/tmp/sandbox'.
describe('ScriptSandbox workDir portability (Lane C / C1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('derives the default workDir from os.tmpdir() (no hardcoded POSIX /tmp)', () => {
    // Force tmpdir to a sentinel that is NOT /tmp. This is the discriminating requirement: on
    // Linux CI os.tmpdir() already IS /tmp, so asserting equality with path.join(os.tmpdir(),
    // 'sandbox') would coincide with the literal '/tmp/sandbox' and a regression would still pass.
    // Mocking to a non-/tmp value makes a revert-to-literal fail on ANY platform.
    const spy = vi.spyOn(os, 'tmpdir').mockReturnValue('/sentinel-tmp-xyz')

    const sandbox = new ScriptSandbox()

    // (1) the production default actually consults os.tmpdir() — if it were reverted to the
    // literal, os.tmpdir() would never be called and this fails. This also confirms the spy is
    // wired to the same `os` namespace ScriptSandbox imports (else it would never register a call).
    expect(spy).toHaveBeenCalled()
    // (2) ...and the resulting path is derived from that value, not the hardcoded literal.
    expect(workDirOf(sandbox)).toBe(path.join('/sentinel-tmp-xyz', 'sandbox'))
    expect(workDirOf(sandbox)).not.toBe('/tmp/sandbox')
  })

  it('honors an explicit workDir override', () => {
    const custom = path.join(os.tmpdir(), 'custom-sandbox-override')
    const sandbox = new ScriptSandbox({ workDir: custom })
    expect(workDirOf(sandbox)).toBe(custom)
  })
})
