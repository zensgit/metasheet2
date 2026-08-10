import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_ATTENDANCE_LIB_CLOSED_FILE_SET,
  PluginAttendanceLibResolutionError,
  resolveCoreBackendRepoRoot,
  resolvePluginAttendanceLibPath,
} from '../../src/util/resolve-plugin-attendance-lib'

/**
 * Hardening gate for `resolvePluginAttendanceLibPath`.
 *
 * Each case below plants a file the resolver must refuse, and asserts both
 * that the resolver refuses (with a diagnosable `code`) and — via a module
 * that records its own execution to a marker file — that the planted module
 * never ran. "Did not resolve" and "resolved but was not required" are kept
 * distinct from "was never reachable at all".
 *
 * The first two tests are the negative control: with nothing planted, the
 * resolver must still resolve canonically from both the `src/routes/` and
 * the `dist/src/routes/` start dirs, which is the dual compiled/source
 * layout property this resolver exists for.
 */

const CLOSED_MEMBER = 'attendance-shift-service.cjs'

interface Fixture {
  readonly root: string
  readonly srcStartDir: string
  readonly distStartDir: string
  readonly pluginLibDir: string
  readonly canonicalTarget: string
  readonly markerPath: string
  readonly outsideDir: string
}

let fixture: Fixture
let tmpRoot: string

/** A `.cjs` module that records the fact it executed, so "did not resolve" and
 * "resolved but was not run" cannot be confused with "was never reachable". */
function plantModule(filePath: string, who: string, markerPath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    [
      "const fs = require('fs')",
      `fs.appendFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(who)} + '\\n')`,
      `module.exports = { WHO: ${JSON.stringify(who)} }`,
    ].join('\n'),
    'utf8',
  )
}

function markersFired(markerPath: string): string[] {
  if (!fs.existsSync(markerPath)) return []
  return fs
    .readFileSync(markerPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

/** Requires the resolved module through a real `require`, so "the resolver
 * returned path P" is upgraded to "the module at P actually ran". */
function requireResolved(resolved: string): { WHO: string } {
  const req = createRequire(path.join(fixture.root, 'probe.cjs'))
  delete req.cache[req.resolve(resolved)]
  return req(resolved) as { WHO: string }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'w6-resolver-hardening-'))
  // `os.tmpdir()` is itself a symlink on macOS (`/var` -> `/private/var`), and
  // the resolver rejects symlinked path components. Realpath the fixture root
  // so the test exercises the resolver's real checks rather than tripping on
  // the harness's own layout.
  tmpRoot = fs.realpathSync(tmpRoot)
  const root = path.join(tmpRoot, 'app')
  const pluginLibDir = path.join(root, 'plugins/plugin-attendance/lib')
  const outsideDir = path.join(tmpRoot, 'outside')
  fs.mkdirSync(path.join(root, 'packages/core-backend/src/routes'), { recursive: true })
  fs.mkdirSync(path.join(root, 'packages/core-backend/dist/src/routes'), { recursive: true })
  fs.mkdirSync(pluginLibDir, { recursive: true })
  fs.mkdirSync(outsideDir, { recursive: true })
  // The NAMED repo-root anchor.
  fs.writeFileSync(path.join(root, 'packages/core-backend/package.json'), '{"name":"@metasheet/core-backend"}', 'utf8')

  const markerPath = path.join(tmpRoot, 'markers.log')
  const canonicalTarget = path.join(pluginLibDir, CLOSED_MEMBER)
  plantModule(canonicalTarget, 'CANONICAL', markerPath)

  fixture = {
    root,
    srcStartDir: path.join(root, 'packages/core-backend/src/routes'),
    distStartDir: path.join(root, 'packages/core-backend/dist/src/routes'),
    pluginLibDir,
    canonicalTarget,
    markerPath,
    outsideDir,
  }
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('resolvePluginAttendanceLibPath hardening', () => {
  describe('negative control — nothing planted, both production layouts still resolve', () => {
    it('resolves canonically from the src/routes/ start dir and the module executes', () => {
      const resolved = resolvePluginAttendanceLibPath(fixture.srcStartDir, CLOSED_MEMBER)
      expect(resolved).toBe(fixture.canonicalTarget)
      expect(requireResolved(resolved).WHO).toBe('CANONICAL')
      expect(markersFired(fixture.markerPath)).toEqual(['CANONICAL'])
    })

    it('resolves to the SAME canonical path from the dist/src/routes/ start dir (dual layout)', () => {
      const fromSrc = resolvePluginAttendanceLibPath(fixture.srcStartDir, CLOSED_MEMBER)
      const fromDist = resolvePluginAttendanceLibPath(fixture.distStartDir, CLOSED_MEMBER)
      expect(fromDist).toBe(fromSrc)
      expect(fromDist).toBe(fixture.canonicalTarget)
    })
  })

  describe('a nearer look-alike root planted ahead of the canonical root', () => {
    it('the canonical file still wins from both start dirs and the look-alike root never executes', () => {
      const shadow = path.join(
        fixture.root,
        'packages/core-backend/plugins/plugin-attendance/lib',
        CLOSED_MEMBER,
      )
      plantModule(shadow, 'SHADOW', fixture.markerPath)
      // Prove the plant is real and sits strictly nearer both start dirs than the
      // canonical file, so this is a genuine ambiguity, not a decoy that could never matter.
      expect(fs.existsSync(shadow)).toBe(true)
      expect(shadow.length).toBeGreaterThan(fixture.canonicalTarget.length)

      for (const startDir of [fixture.srcStartDir, fixture.distStartDir]) {
        const resolved = resolvePluginAttendanceLibPath(startDir, CLOSED_MEMBER)
        expect(resolved).toBe(fixture.canonicalTarget)
        expect(requireResolved(resolved).WHO).toBe('CANONICAL')
      }
      expect(markersFired(fixture.markerPath)).not.toContain('SHADOW')
    })

    it('a SECOND repo-root anchor is refused as ambiguous rather than silently preferred', () => {
      // A second root that also carries the named anchor is indistinguishable
      // from the real root by name alone, so it must be refused rather than guessed.
      fs.mkdirSync(path.join(fixture.root, 'packages/core-backend/packages/core-backend'), { recursive: true })
      fs.writeFileSync(
        path.join(fixture.root, 'packages/core-backend/packages/core-backend/package.json'),
        '{"name":"decoy"}',
        'utf8',
      )
      expect(() => resolveCoreBackendRepoRoot(fixture.srcStartDir)).toThrowError(
        /REPO_ROOT_AMBIGUOUS/,
      )
      let thrown: unknown
      try {
        resolvePluginAttendanceLibPath(fixture.srcStartDir, CLOSED_MEMBER)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(PluginAttendanceLibResolutionError)
      expect((thrown as PluginAttendanceLibResolutionError).code).toBe('REPO_ROOT_AMBIGUOUS')
    })
  })

  describe('a directory standing in for the target file', () => {
    it('a directory carrying index.js at the target path is refused as NOT_A_REGULAR_FILE and never executes', () => {
      fs.rmSync(fixture.canonicalTarget, { force: true })
      plantModule(path.join(fixture.canonicalTarget, 'index.js'), 'DIR-MASQUERADE', fixture.markerPath)
      expect(fs.lstatSync(fixture.canonicalTarget).isDirectory()).toBe(true)

      let thrown: unknown
      try {
        resolvePluginAttendanceLibPath(fixture.srcStartDir, CLOSED_MEMBER)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(PluginAttendanceLibResolutionError)
      expect((thrown as PluginAttendanceLibResolutionError).code).toBe('NOT_A_REGULAR_FILE')
      expect(markersFired(fixture.markerPath)).toEqual([])
    })
  })

  describe('a symlinked target file', () => {
    it('a symlinked target pointing outside the repo root is refused and never executes', () => {
      const outside = path.join(fixture.outsideDir, 'evil.cjs')
      plantModule(outside, 'SYMLINK-FILE', fixture.markerPath)
      fs.rmSync(fixture.canonicalTarget, { force: true })
      fs.symlinkSync(outside, fixture.canonicalTarget)
      expect(fs.lstatSync(fixture.canonicalTarget).isSymbolicLink()).toBe(true)

      let thrown: unknown
      try {
        resolvePluginAttendanceLibPath(fixture.srcStartDir, CLOSED_MEMBER)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(PluginAttendanceLibResolutionError)
      expect((thrown as PluginAttendanceLibResolutionError).code).toBe('SYMLINK_COMPONENT_REJECTED')
      expect(markersFired(fixture.markerPath)).toEqual([])
    })
  })

  describe('a symlinked parent directory (the isFile()-insufficiency case)', () => {
    it('a symlinked lib/ directory is refused even though the leaf lstats as a regular file', () => {
      const outsideLib = path.join(fixture.outsideDir, 'lib')
      plantModule(path.join(outsideLib, CLOSED_MEMBER), 'SYMLINK-DIR', fixture.markerPath)
      fs.rmSync(fixture.pluginLibDir, { recursive: true, force: true })
      fs.symlinkSync(outsideLib, fixture.pluginLibDir, 'dir')

      // The point of this case: the final component alone passes an isFile() check.
      const leaf = path.join(fixture.pluginLibDir, CLOSED_MEMBER)
      expect(fs.lstatSync(leaf).isFile()).toBe(true)
      expect(fs.lstatSync(leaf).isSymbolicLink()).toBe(false)

      let thrown: unknown
      try {
        resolvePluginAttendanceLibPath(fixture.srcStartDir, CLOSED_MEMBER)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(PluginAttendanceLibResolutionError)
      expect((thrown as PluginAttendanceLibResolutionError).code).toBe('SYMLINK_COMPONENT_REJECTED')
      expect(markersFired(fixture.markerPath)).toEqual([])
    })
  })

  describe('path traversal and the closed file set', () => {
    it('a traversal relativeLibPath is unrepresentable (not merely filtered) and never executes', () => {
      const escaped = path.join(fixture.root, 'escaped.cjs')
      plantModule(escaped, 'ESCAPE', fixture.markerPath)

      for (const payload of [
        '../../../escaped.cjs',
        '../../escaped.cjs',
        './../escaped.cjs',
        'sub/../../escaped.cjs',
        path.join(fixture.root, 'escaped.cjs'),
      ]) {
        let thrown: unknown
        try {
          resolvePluginAttendanceLibPath(fixture.srcStartDir, payload)
        } catch (error) {
          thrown = error
        }
        expect(thrown, `payload ${payload} was not refused`).toBeInstanceOf(PluginAttendanceLibResolutionError)
        expect((thrown as PluginAttendanceLibResolutionError).code).toBe('FILE_NOT_IN_CLOSED_SET')
      }
      expect(markersFired(fixture.markerPath)).toEqual([])
    })

    it('an arbitrary OTHER file that really exists under lib/ is still refused (closed set, not existence)', () => {
      const sibling = path.join(fixture.pluginLibDir, 'attendance-not-in-the-closed-set.cjs')
      plantModule(sibling, 'SIBLING', fixture.markerPath)
      expect(fs.existsSync(sibling)).toBe(true)

      let thrown: unknown
      try {
        resolvePluginAttendanceLibPath(fixture.srcStartDir, 'attendance-not-in-the-closed-set.cjs')
      } catch (error) {
        thrown = error
      }
      expect((thrown as PluginAttendanceLibResolutionError).code).toBe('FILE_NOT_IN_CLOSED_SET')
      expect(markersFired(fixture.markerPath)).toEqual([])
    })
  })

  describe('the closed set itself', () => {
    it('is non-empty and every member is a real regular file in THIS repository', () => {
      // Non-vacuity: an empty set would make every case above pass trivially.
      expect(PLUGIN_ATTENDANCE_LIB_CLOSED_FILE_SET.length).toBeGreaterThan(0)
      const realRepoRoot = resolveCoreBackendRepoRoot(__dirname)
      for (const member of PLUGIN_ATTENDANCE_LIB_CLOSED_FILE_SET) {
        const real = path.join(realRepoRoot, 'plugins/plugin-attendance/lib', member)
        expect(fs.existsSync(real), `${member} is in the closed set but does not exist at ${real}`).toBe(true)
        expect(fs.lstatSync(real).isFile()).toBe(true)
      }
    })

    it('covers every file the production code actually requires through this resolver', () => {
      // Derived, not hand-listed: scan the real call sites for their literal
      // `requirePluginAttendanceLib(__dirname, '<file>')` arguments and require
      // the closed set to be a superset. A new require with a file nobody added
      // to the set would otherwise only surface as a production boot crash.
      const realRepoRoot = resolveCoreBackendRepoRoot(__dirname)
      const callSites = [
        'packages/core-backend/src/routes/attendance-admin.ts',
        'packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts',
      ]
      const requested = new Set<string>()
      for (const relative of callSites) {
        const text = fs.readFileSync(path.join(realRepoRoot, relative), 'utf8')
        for (const match of text.matchAll(/requirePluginAttendanceLib<[^>]*>\(\s*__dirname,\s*'([^']+)'/gs)) {
          requested.add(match[1])
        }
        for (const match of text.matchAll(/requirePluginAttendanceLib\(\s*__dirname,\s*'([^']+)'/gs)) {
          requested.add(match[1])
        }
      }
      // Non-empty-domain leg: an empty scan would satisfy the subset check vacuously.
      expect(requested.size).toBeGreaterThan(0)
      const unclaimed = [...requested].filter((file) => !PLUGIN_ATTENDANCE_LIB_CLOSED_FILE_SET.includes(file))
      expect(unclaimed).toEqual([])
    })
  })
})
