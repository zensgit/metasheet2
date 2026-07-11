import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The attendance integration harness resets the plugin's 60s settings cache in
// beforeEach via `getAttendancePluginForTest().resetAttendanceSettingsCacheForTests?.()`
// (attendance-plugin.test.ts). That helper used to be exported ONLY nested under
// __attendanceReportFieldCatalogForTests, so the TOP-LEVEL optional call silently
// no-op'd and the 60s settings cache leaked across the shared attendance suite.
// This locks the export at the top level of module.exports so the beforeEach
// reset actually runs. A source assertion (not a module-load one) — the plugin
// is a large CJS module and asserting its shape via require is flaky across the
// forks pool's multi-file runs.
// Normalize CRLF → LF so the '\n  …' anchors below hold regardless of the
// checkout's line endings (review NIT).
const source = readFileSync(resolve(__dirname, '../../../../plugins/plugin-attendance/index.cjs'), 'utf8').replace(/\r\n/g, '\n')

describe('attendance settings-cache reset export (top-level, so the harness reset is not a no-op)', () => {
  it('exports resetAttendanceSettingsCacheForTests at the top level of module.exports', () => {
    const exportsStart = source.indexOf('module.exports = {')
    expect(exportsStart, 'module.exports block').toBeGreaterThan(-1)
    // the first nested test bag (a 2-space `  __attendance…ForTests: {` KEY, not a
    // mention inside a comment) begins the nested region; the top-level entry must
    // appear before it.
    const firstNestedBag = source.indexOf('\n  __attendance', exportsStart)
    const topLevelExport = source.indexOf('\n  resetAttendanceSettingsCacheForTests,', exportsStart)
    expect(firstNestedBag, 'first nested __attendance…ForTests key').toBeGreaterThan(-1)
    expect(topLevelExport, 'top-level `resetAttendanceSettingsCacheForTests,` in module.exports').toBeGreaterThan(-1)
    expect(topLevelExport).toBeLessThan(firstNestedBag)
  })
})
