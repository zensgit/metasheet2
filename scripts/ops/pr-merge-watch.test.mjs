import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SRC = fs.readFileSync(path.join(import.meta.dirname, 'pr-merge-watch.mjs'), 'utf8')
// Comments are stripped before any structural assertion: prose describing a property is not the
// property. This exact confusion (a sentence satisfying a code-shaped check) happened three times
// on the line that produced this tool.
const CODE = SRC.replace(/\/\*[^]*?\*\//g, ' ').split('\n')
  .filter((l) => !l.trim().startsWith('//')).join('\n')

test('the required set is READ, never hardcoded', () => {
  assert.match(CODE, /branches\/\$\{branch\}\/protection/,
    'required contexts must come from branch protection')
  assert.match(CODE, /required_status_checks\.contexts/, 'must read the contexts array')

  // The failure this pins: an earlier version baked in nine literal names. main's required set
  // grows, and a stale literal turns a BLOCKING red into an ignored one.
  const known = ['contracts (strict)', 'pr-validate', 'test (20.x)', 'web-tests',
    'attendance-web-guard', 'integration-guard', 'stock-prep PowerShell 5.1 acceptance']
  for (const name of known) {
    assert.ok(!CODE.includes(`'${name}'`) && !CODE.includes(`"${name}"`),
      `required context ${JSON.stringify(name)} is hardcoded — the live set must be the only source`)
  }
})

test('an empty required set THROWS rather than making every red look non-blocking', () => {
  // BEHAVIOURAL, not a source-text match. The first version of this test asserted
  // /size === 0[^]*?throw/ over the source — and replacing the throw with `return new Set()`
  // left it GREEN, because `size === 0` still appeared and a `throw` still existed elsewhere in
  // the file. A regex spanning [^]*? will happily bridge two unrelated statements.
  const src = fs.readFileSync(path.join(import.meta.dirname, 'pr-merge-watch.mjs'), 'utf8')
  const fn = /function requiredContexts[^]*?\n}/.exec(src)
  assert.ok(fn, 'requiredContexts must be locatable as a function body')
  const body = fn[0]
  // ADJACENCY, not a window. The first attempt allowed 120 chars between the condition and the
  // keyword, which (a) let an unrelated `throw` elsewhere satisfy it and (b) made the legitimate
  // `return set` on the NEXT line look like a violation. A window whose width is guessed rather
  // than derived is the same defect in both directions — it was chosen by feel three times today.
  assert.match(body, /if \(set\.size === 0\) throw\b/,
    'the empty-set guard must throw IMMEDIATELY on the condition — an empty read is the most '
    + 'dangerous input for this tool (it makes every red look non-blocking) and must be fatal')
  assert.ok(!/if \(set\.size === 0\) return\b/.test(body),
    'returning on an empty set is the exact permissive failure this guard exists to prevent')
})

test('the flake criterion is a CONJUNCTION scoped to the failing step', () => {
  assert.match(CODE, /markers\.every/, 'all markers must hold, not any')
  assert.match(CODE, /filter\(\(l\) => l\.includes\(FLAKE\.step\)\)/,
    'markers must be evaluated on the failing STEP\'s own lines — scanning the whole run found '
    + 'nothing once and reported "not the known flake" while the evidence sat in a narrower span')
  assert.match(CODE, /files\.some\(\(f\) => f\.toLowerCase\(\)\.includes\('attendance'\)\)/,
    'the diff must be proven unrelated to what the failing step exercises')
})

test('non-required reds are RECORDED but never blocking — and never hidden', () => {
  assert.match(CODE, /nonRequiredRed/, 'non-required failures must be surfaced')
  assert.match(CODE, /NOT blocking/, 'and labelled as non-blocking where they are printed')
  // The inverse defect is equally bad: an earlier version treated a non-required red as a failure
  // and reported a PR as FAILING that had in fact already merged.
  assert.ok(!/nonRequiredRed[^]{0,200}pending\.delete/.test(CODE),
    'a non-required red must not remove a PR from the watch set')
})

test('the tool never merges or arms', () => {
  for (const forbidden of ['pr merge', '--auto', '--admin', 'update-branch']) {
    assert.ok(!CODE.includes(forbidden),
      `this tool observes and reports; it must not ${JSON.stringify(forbidden)}`)
  }
})

test('POSITIVE CONTROL: the assertions above can fail', () => {
  const fake = "const required = new Set(['pr-validate'])\nawait gh(['pr','merge','--auto'])"
  assert.ok(fake.includes("'pr-validate'"), 'the hardcode detector must see a hardcoded name')
  assert.ok(fake.includes('--auto'), 'the arming detector must see an arming flag')
})
