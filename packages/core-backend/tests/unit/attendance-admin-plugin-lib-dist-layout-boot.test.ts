import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #4814 P1 — production boot crash.
 *
 * `attendance-admin.ts` module-scope-`require()`s two files inside
 * `plugins/plugin-attendance/lib/`, resolved via
 * `../../src/util/resolve-plugin-attendance-lib.ts`. `tsconfig.json`'s
 * `rootDir: "."` puts the COMPILED output ONE DIRECTORY DEEPER than the
 * source tree (`dist/src/routes/`, not `dist/routes/`), so a hard-coded
 * relative-depth `require(...)` string that is correct from `src/routes/`
 * is silently WRONG once compiled — and because `src/index.ts` imports this
 * router statically at module scope, that wrongness throws during module
 * init and crash-loops the whole backend on the first boot after deploy.
 *
 * Nothing else in the repo catches this class: `tsc --noEmit` never
 * resolves `require(<string literal>)` at runtime (it is untyped, both call
 * sites carry `@typescript-eslint/no-require-imports` disables), and
 * `docker-build.yml` builds the image but never boots it.
 *
 * This test IS the boot gate. It runs the REAL `tsc` build (same compiler,
 * same `tsconfig.json` used in production), lays the emitted output out
 * EXACTLY like the production image (`Dockerfile.backend`: `WORKDIR /app`,
 * `dist/src/routes/` sitting next to a sibling `/app/plugins/`), and — in a
 * subprocess, so the real router's DB-pool / message-bus module-scope side
 * effects can never leak into other tests in this worker — `require()`s the
 * REAL compiled `attendance-admin.js` from that real layout. A regression
 * to any hard-coded relative-depth `require` (in this file, or reintroduced
 * directly inside `attendance-admin.ts` bypassing the resolver) reproduces
 * #4814 P1 and reds this test with `MODULE_NOT_FOUND` — proven by running
 * this exact test against the pre-fix source (see PR #4814 report).
 */
describe('attendance-admin.ts plugin-attendance require — dist-layout boot (#4814 P1)', () => {
  it(
    'the compiled router resolves plugins/plugin-attendance/lib/*.cjs from the production dist/src/routes/ layout',
    () => {
      const coreBackendRoot = path.resolve(__dirname, '../..')
      const repoRoot = path.resolve(coreBackendRoot, '../..')
      const tsc = path.join(coreBackendRoot, 'node_modules/.bin/tsc')
      const tsconfigPath = path.join(coreBackendRoot, 'tsconfig.json')
      const realPluginsDir = path.join(repoRoot, 'plugins/plugin-attendance')
      const realNodeModulesDir = path.join(coreBackendRoot, 'node_modules')

      expect(fs.existsSync(tsc)).toBe(true)
      expect(fs.existsSync(tsconfigPath)).toBe(true)
      expect(fs.existsSync(realPluginsDir)).toBe(true)
      // A dangling node_modules symlink below would surface as the probe's
      // require() throwing MODULE_NOT_FOUND for an unrelated package (e.g.
      // `express`/`pg`) -- indistinguishable, in the final assertions, from
      // the #4814 P1 bug this test targets. Fail loudly and specifically
      // here instead.
      expect(fs.existsSync(realNodeModulesDir)).toBe(true)

      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'w6-dist-layout-boot-'))
      try {
        // Production layout per `Dockerfile.backend`: WORKDIR /app,
        // `packages/core-backend/dist/src/routes/` sitting four levels
        // under a SIBLING `/app/plugins/` — not five, as a naive
        // `../../../../` computed from `src/routes/` would assume.
        //
        // `dist` is built DIRECTLY into place (not built elsewhere and
        // symlinked in): Node resolves a required file's real path before
        // walking its `node_modules` ancestry, so a symlinked `dist`
        // escapes this layout entirely and the `node_modules` symlink
        // below would never be found — that failure mode is unrelated to
        // the #4814 P1 bug this test targets, so the probe must not
        // manufacture it.
        const probeApp = path.join(tmpRoot, 'app')
        const probeDist = path.join(probeApp, 'packages/core-backend/dist')
        fs.mkdirSync(path.join(probeApp, 'packages/core-backend'), { recursive: true })

        // Real build: the exact `tsc` binary + `tsconfig.json` this package
        // ships, not a hand-simulated layout — emitted straight into the
        // probe's `dist/`. `tsconfig.json` sets `noEmitOnError: false`, so
        // `tsc` still emits (and this build should still be treated as
        // successful for THIS test's purpose) even if it exits non-zero
        // because of an unrelated type error anywhere else in
        // `core-backend` -- this test is a boot-resolution gate, not a
        // second `type-check` job, and must not fail opaquely on a type
        // error somewhere else in the package. Only a missing emit (the
        // thing `noEmitOnError` cannot save) is this test's failure.
        let tscStderr = ''
        try {
          execFileSync(tsc, ['-p', tsconfigPath, '--outDir', probeDist], {
            cwd: coreBackendRoot,
            stdio: 'pipe',
            timeout: 120_000,
          })
        } catch (e) {
          tscStderr = String((e as { stderr?: Buffer | string })?.stderr ?? e)
        }
        const routerPath = path.join(probeDist, 'src/routes/attendance-admin.js')
        expect(fs.existsSync(routerPath), `tsc did not emit ${routerPath}. tsc output:\n${tscStderr}`).toBe(true)

        fs.symlinkSync(realNodeModulesDir, path.join(probeApp, 'packages/core-backend/node_modules'), 'dir')
        fs.mkdirSync(path.join(probeApp, 'plugins'), { recursive: true })
        fs.symlinkSync(realPluginsDir, path.join(probeApp, 'plugins/plugin-attendance'), 'dir')

        // Runs in a CHILD PROCESS deliberately: requiring the real router
        // executes real module-scope code (DB pool + message bus
        // singletons) that must never run inside this test worker.
        const probeScript = [
          'process.exitCode = 0;',
          'try {',
          "  const mod = require('./dist/src/routes/attendance-admin.js');",
          "  console.log('PROBE_RESULT: RESOLVED_OK ' + JSON.stringify(Object.keys(mod).sort()));",
          '} catch (e) {',
          "  console.log('PROBE_RESULT: FAILED ' + (e && e.code) + ' | ' + (e && e.message));",
          '}',
          'process.exit(process.exitCode);',
        ].join('\n')
        // The probe script's `require('./dist/...')` is resolved relative
        // to ITS OWN file location (Node module resolution, not `cwd`), so
        // it must live inside `probeApp/packages/core-backend/` — exactly
        // where the real `index.js` that does the real
        // `require('./dist/...')`-equivalent import lives in production.
        const probeDir = path.join(probeApp, 'packages/core-backend')
        const probeScriptPath = path.join(probeDir, 'probe.js')
        fs.writeFileSync(probeScriptPath, probeScript, 'utf8')

        const stdout = execFileSync('node', [probeScriptPath], {
          cwd: probeDir,
          encoding: 'utf8',
          timeout: 30_000,
        })
        fs.rmSync(probeScriptPath, { force: true })

        // Positive assertions FIRST: on failure, the reported message names
        // the real cause (what stdout actually was) rather than leading
        // with a `not.toContain` pass/fail that gives no diagnostic detail.
        expect(stdout).toContain('PROBE_RESULT: RESOLVED_OK')
        expect(stdout).toContain('attendanceAdminRouter')
        expect(stdout).not.toContain('MODULE_NOT_FOUND')
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
