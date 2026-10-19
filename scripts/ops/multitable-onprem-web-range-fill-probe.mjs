#!/usr/bin/env node
// multitable-onprem-web-range-fill-probe.mjs — reads a BUILT apps/web/dist and reports whether the
// multitable range-fill switch (VITE_MULTITABLE_RANGE_FILL_ENABLED) was baked in as ON.
//
// Why bytes and not the environment: the on-prem package lanes build the web app in one step and
// call scripts/ops/multitable-onprem-package-build.sh with BUILD_WEB=0 in a later one, so the
// variable the packaging script sees says nothing about the dist it copies. Vite replaces
// `import.meta.env.VITE_MULTITABLE_RANGE_FILL_ENABLED` with a string literal at build time, and
// apps/web/src/multitable/utils/grid-range-fill-flags.ts keeps it as a parameter default, so the
// minified bundle carries exactly one function of the shape
//
//   (e="true"){return e==="true"}     ON  (built with the literal string true)
//   (e="false"){return e==="true"}    OFF (built with false)
//   (e=void 0){return e==="true"}     OFF (built with the variable unset)
//
// (measured on a vite 5.4 build of apps/web, 2026-10-18). The range toolbar's hint text ships in
// every build whatever the switch says, so it only proves the feature code is in this dist, never
// that the switch is on.
//
// Answers `on`, `off` or `unknown`. `unknown` — no dist, no toolbar text, zero or several functions
// of that shape — means this probe cannot attest the switch; the packaging script treats it as a
// failure, so a toolchain change that moves the shape fails the package build instead of shipping a
// package whose switch nobody verified.
//
// CLI: node scripts/ops/multitable-onprem-web-range-fill-probe.mjs <apps/web/dist>
//      prints one word (on|off|unknown) on stdout; exit 0. Exit 2 on a usage error.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RANGE_FILL_TOOLBAR_TEXT = '拖动或 Shift 选区，再拖右下角填充'

// One identifier, a baked default (a double-quoted string or `void 0`), then the exact comparison
// grid-range-fill-flags.ts makes. The back-reference keeps the parameter and the compared name equal.
export const RANGE_FILL_BAKED_DEFAULT_SHAPE =
  /\(([A-Za-z_$][A-Za-z0-9_$]*)=("(?:[^"\\]|\\.)*"|void 0)\)\{return \1==="true"\}/g

function listJsAssets(distDir) {
  const assetsDir = path.join(distDir, 'assets')
  let names
  try {
    names = fs.readdirSync(assetsDir)
  } catch {
    return null
  }
  return names
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(assetsDir, name))
}

export function probeRangeFill(distDir) {
  const files = typeof distDir === 'string' && distDir.length > 0 ? listJsAssets(distDir) : null
  if (!files || files.length === 0) {
    return { state: 'unknown', reason: 'no-js-assets', bakedDefaults: [], toolbarPresent: false }
  }
  const bakedDefaults = []
  let toolbarPresent = false
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    if (text.includes(RANGE_FILL_TOOLBAR_TEXT)) toolbarPresent = true
    for (const match of text.matchAll(RANGE_FILL_BAKED_DEFAULT_SHAPE)) {
      bakedDefaults.push(match[2])
    }
  }
  if (!toolbarPresent) {
    return { state: 'unknown', reason: 'no-range-toolbar', bakedDefaults, toolbarPresent }
  }
  if (bakedDefaults.length !== 1) {
    return { state: 'unknown', reason: `baked-default-count-${bakedDefaults.length}`, bakedDefaults, toolbarPresent }
  }
  return {
    state: bakedDefaults[0] === '"true"' ? 'on' : 'off',
    reason: 'single-baked-default',
    bakedDefaults,
    toolbarPresent,
  }
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  const args = process.argv.slice(2)
  if (args.length !== 1 || args[0].length === 0) {
    process.stderr.write('usage: multitable-onprem-web-range-fill-probe.mjs <apps/web/dist>\n')
    process.exit(2)
  }
  const result = probeRangeFill(args[0])
  if (result.state === 'unknown') {
    process.stderr.write(`[multitable-onprem-web-range-fill-probe] cannot attest the switch: ${result.reason}\n`)
  }
  process.stdout.write(`${result.state}\n`)
}
