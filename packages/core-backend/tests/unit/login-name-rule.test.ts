/**
 * #6259 — one login-name rule for every writer that accepts an operator-chosen login name.
 *
 * Before #6259 `routes/admin-users.ts` and `directory/directory-sync.ts` each carried their own
 * copy of the regex + English sentence. This suite pins:
 *   1. the rule itself (regex, byte-identical English message, `login_name_ascii` code, error type);
 *   2. single definition: no file under src/ other than auth/login-name-rule.ts spells the rule's
 *      regex or its message, and both writers import the shared module — so re-inlining a copy in
 *      either writer turns this red even when the copy is behaviourally identical.
 * Behaviour through each writer is pinned next to its other tests:
 *   - admin-users-routes.test.ts   (POST /api/admin/users answers the shared message);
 *   - directory-sync-bind-account.test.ts (admission throws LoginNameRuleError at both checks);
 *   - admin-directory-routes.test.ts (admit-user maps the type to 400 INVALID_USERNAME).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LOGIN_NAME_PATTERN,
  LOGIN_NAME_RULE_CODE,
  LOGIN_NAME_RULE_ERROR_CODE,
  LOGIN_NAME_RULE_MESSAGE,
  LoginNameRuleError,
  assertLoginName,
  validateLoginName,
} from '../../src/auth/login-name-rule'

const SRC_ROOT = resolve(__dirname, '../../src')
const RULE_MODULE = ['auth', 'login-name-rule.ts'].join(sep)

// Literal on purpose: the English message must stay byte-identical to the pre-#6259 copies.
const PRE_6259_MESSAGE =
  'Username must be 3-64 characters and include at least one letter. Only lowercase letters, numbers, dot, underscore, and dash are allowed'

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full))
    else if (/\.(ts|js|mjs|cjs)$/.test(entry)) out.push(full)
  }
  return out
}

describe('login-name rule (shared module)', () => {
  it('keeps the rule, message and codes unchanged', () => {
    expect(LOGIN_NAME_PATTERN.source).toBe('^(?=.*[a-z])[a-z0-9._-]{3,64}$')
    expect(LOGIN_NAME_PATTERN.flags).toBe('')
    expect(LOGIN_NAME_RULE_MESSAGE).toBe(PRE_6259_MESSAGE)
    expect(LOGIN_NAME_RULE_CODE).toBe('login_name_ascii')
    expect(LOGIN_NAME_RULE_ERROR_CODE).toBe('INVALID_USERNAME')
  })

  it('accepts lowercase ASCII login names and rejects the rest', () => {
    for (const ok of ['liqing', 'operator.a', 'a_b-c', 'abc', 'x1y', 'a'.repeat(64)]) {
      expect(validateLoginName(ok), ok).toBeNull()
    }
    for (const bad of ['测试员', '李青', 'ab', '123', '...', 'Liqing', 'li qing', 'a'.repeat(65), 'li@qing']) {
      expect(validateLoginName(bad), bad).toBe(PRE_6259_MESSAGE)
    }
    // Absent login name is not this rule's business (callers require some identifier separately).
    expect(validateLoginName(null)).toBeNull()
    expect(validateLoginName(undefined)).toBeNull()
    expect(validateLoginName('')).toBeNull()
  })

  it('throws a typed LoginNameRuleError whose message is the unchanged English sentence', () => {
    expect(() => assertLoginName('liqing')).not.toThrow()
    expect(() => assertLoginName(null)).not.toThrow()
    let thrown: unknown
    try {
      assertLoginName('测试员')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LoginNameRuleError)
    expect(thrown).toBeInstanceOf(Error)
    const error = thrown as LoginNameRuleError
    expect(error.message).toBe(PRE_6259_MESSAGE)
    expect(error.code).toBe('INVALID_USERNAME')
    expect(error.rule).toBe('login_name_ascii')
    expect(error.name).toBe('LoginNameRuleError')
  })
})

describe('login-name rule (single definition across src/)', () => {
  const files = listSourceFiles(SRC_ROOT)

  it('scans a non-trivial source tree', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((file) => relative(SRC_ROOT, file) === RULE_MODULE)).toBe(true)
  })

  it('spells the regex and the English message only in auth/login-name-rule.ts', () => {
    const regexBody = '[a-z0-9._-]{3,64}'
    const messageHead = 'Username must be 3-64 characters'
    const offenders = files
      .filter((file) => relative(SRC_ROOT, file) !== RULE_MODULE)
      .filter((file) => {
        const text = readFileSync(file, 'utf8')
        return text.includes(regexBody) || text.includes(messageHead)
      })
      .map((file) => relative(SRC_ROOT, file).split(sep).join('/'))
    expect(offenders).toEqual([])
  })

  it.each([
    ['routes/admin-users.ts', 'validateLoginName'],
    ['directory/directory-sync.ts', 'assertLoginName'],
  ])('%s takes the rule from ../auth/login-name-rule', (file, symbol) => {
    const text = readFileSync(join(SRC_ROOT, ...file.split('/')), 'utf8')
    const importLine = text
      .split(/\r?\n/)
      .find((line) => /from '\.\.\/auth\/login-name-rule'/.test(line))
    expect(importLine, `${file} must import ../auth/login-name-rule`).toBeTruthy()
    expect(importLine).toContain(symbol)
    // ...and actually call it (an unused import would leave a private copy in charge).
    expect(text.split(`${symbol}(`).length - 1).toBeGreaterThanOrEqual(1)
  })
})
