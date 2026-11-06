/**
 * Pull-source rule leaf module (src/directory/pull-source-rule.ts).
 *
 * Pins the invariants of the module itself; nothing in the application calls it yet, so there is no
 * behaviour to compare against. No database: statements go through an injected fake `query`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APPROVAL_ROUTING_POLICY_EXISTS_SQL,
  APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED,
  ApprovalRoutingPolicyError,
  COUNT_ACTIVE_PULL_SOURCES_SQL,
  DIRECTORY_ORG_LOCK_KEY_PREFIX,
  DIRECTORY_ROUTING_POLICY_REQUIRED_CODE,
  DirectoryRoutingPolicyRequiredError,
  POLICY_REQUIRED_MESSAGE,
  PULL_SOURCE_KEY_SQL,
  PULL_SOURCE_PREDICATE_SQL,
  PULL_SOURCE_RULE_TABLES,
  PULL_SOURCE_THRESHOLD,
  countActivePullSources,
  directoryOrgLockKey,
  directoryOrgLockSql,
  isApprovalRoutingPolicyRequired,
  isApprovalRoutingRequirePolicyEnabled,
  pullSourceKeySql,
  pullSourcePredicateSql,
  type PullSourceRuleQuery,
} from '../../src/directory/pull-source-rule'

const SRC_ROOT = join(__dirname, '../../src')
const LEAF_PATH = join(SRC_ROOT, 'directory/pull-source-rule.ts')
const REPO_ROOT = join(__dirname, '../../../..')
const leafSource = readFileSync(LEAF_PATH, 'utf8')

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walkTs(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

function fakeQuery(sourceCount: unknown, policyRows: number) {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = []
  const query: PullSourceRuleQuery = async (sql, params) => {
    calls.push({ sql, params })
    if (sql === COUNT_ACTIVE_PULL_SOURCES_SQL) {
      return { rows: sourceCount === undefined ? [] : [{ pull_source_count: sourceCount }] }
    }
    if (sql === APPROVAL_ROUTING_POLICY_EXISTS_SQL) {
      return { rows: Array.from({ length: policyRows }, () => ({ present: 1 })) }
    }
    throw new Error(`unexpected statement: ${sql}`)
  }
  return { query, calls }
}

describe('switch predicate', () => {
  const saved = process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED
  afterEach(() => {
    if (saved === undefined) delete process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED
    else process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED = saved
  })

  it('names the environment variable it reads', () => {
    expect(APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED).toBe('APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED')
  })

  it('is on only for the exact literal true', () => {
    expect(isApprovalRoutingRequirePolicyEnabled({ APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED: 'true' })).toBe(true)
    for (const value of [undefined, '', 'false', '0', 'TRUE', 'True', ' true', 'true ', ' true ', '1', 'yes', 'on']) {
      const env = value === undefined ? {} : { APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED: value }
      expect(isApprovalRoutingRequirePolicyEnabled(env), JSON.stringify(value)).toBe(false)
    }
  })

  it('defaults to off when the variable is unset', () => {
    delete process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED
    expect(isApprovalRoutingRequirePolicyEnabled()).toBe(false)
  })

  it('reads the environment on every call', () => {
    delete process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED
    expect(isApprovalRoutingRequirePolicyEnabled()).toBe(false)
    process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED = 'true'
    expect(isApprovalRoutingRequirePolicyEnabled()).toBe(true)
    process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED = '1'
    expect(isApprovalRoutingRequirePolicyEnabled()).toBe(false)
    process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED = 'TRUE'
    expect(isApprovalRoutingRequirePolicyEnabled()).toBe(false)
    process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED = 'true'
    expect(isApprovalRoutingRequirePolicyEnabled()).toBe(true)
  })

  it('compares the exact literal in source (no trim, no case folding)', () => {
    expect(leafSource).toContain("env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED === 'true'")
    expect(leafSource).not.toMatch(/toLowerCase\(\)|\.trim\(\)/)
  })
})

describe('pull-source predicate', () => {
  it('counts only active pull-type integrations and never reads sync_enabled', () => {
    expect(PULL_SOURCE_PREDICATE_SQL).toBe("i.provider <> 'local' AND i.status = 'active'")
    expect(pullSourcePredicateSql('x')).toBe("x.provider <> 'local' AND x.status = 'active'")
    expect(PULL_SOURCE_KEY_SQL).toBe('(i.provider, i.corp_id)')
    expect(pullSourceKeySql('x')).toBe('(x.provider, x.corp_id)')
    expect(COUNT_ACTIVE_PULL_SOURCES_SQL).not.toContain('sync_enabled')
  })

  it('de-duplicates by (provider, corp_id) and scopes to one organisation', () => {
    expect(COUNT_ACTIVE_PULL_SOURCES_SQL).toContain('count(DISTINCT (i.provider, i.corp_id))')
    expect(COUNT_ACTIVE_PULL_SOURCES_SQL).toContain('i.org_id = $1')
    expect(COUNT_ACTIVE_PULL_SOURCES_SQL).toContain(PULL_SOURCE_PREDICATE_SQL)
    expect(COUNT_ACTIVE_PULL_SOURCES_SQL).not.toMatch(/count\(\*\)/i)
  })

  it('uses a threshold of two', () => {
    expect(PULL_SOURCE_THRESHOLD).toBe(2)
  })

  it('rejects an alias that is not a plain identifier', () => {
    for (const alias of ['', 'a.b', "i; DROP TABLE x", 'I', '1a', 'a b']) {
      expect(() => pullSourcePredicateSql(alias), alias).toThrow(TypeError)
      expect(() => pullSourceKeySql(alias), alias).toThrow(TypeError)
    }
  })

  it('looks up the approval-routing purpose in the policy table by organisation', () => {
    expect(APPROVAL_ROUTING_POLICY_EXISTS_SQL).toContain('FROM org_directory_routing_policy')
    expect(APPROVAL_ROUTING_POLICY_EXISTS_SQL).toContain('org_id = $1')
    expect(APPROVAL_ROUTING_POLICY_EXISTS_SQL).toContain("purpose = 'approval_routing'")
  })
})

describe('countActivePullSources / isApprovalRoutingPolicyRequired', () => {
  it('passes the organisation id as the only parameter', async () => {
    const { query, calls } = fakeQuery(1, 0)
    await expect(countActivePullSources(query, 'org-a')).resolves.toBe(1)
    expect(calls).toEqual([{ sql: COUNT_ACTIVE_PULL_SOURCES_SQL, params: ['org-a'] }])
  })

  it('coerces the count and treats a missing row as zero', async () => {
    await expect(countActivePullSources(fakeQuery('3', 0).query, 'o')).resolves.toBe(3)
    await expect(countActivePullSources(fakeQuery(undefined, 0).query, 'o')).resolves.toBe(0)
    await expect(countActivePullSources(fakeQuery(null, 0).query, 'o')).resolves.toBe(0)
    await expect(countActivePullSources(fakeQuery('x', 0).query, 'o')).resolves.toBe(0)
  })

  it('requires a policy only when there are two or more sources and no policy', async () => {
    const cases: Array<[number, number, boolean]> = [
      [0, 0, false],
      [1, 0, false],
      [2, 0, true],
      [3, 0, true],
      [0, 1, false],
      [1, 1, false],
      [2, 1, false],
      [3, 1, false],
    ]
    for (const [sources, policies, required] of cases) {
      const { query } = fakeQuery(sources, policies)
      await expect(isApprovalRoutingPolicyRequired(query, 'o'), `${sources}/${policies}`).resolves.toEqual({
        required,
        sourceCount: sources,
        hasPolicy: policies > 0,
      })
    }
  })

  it('does not read the switch: the status is a pure data judgement', async () => {
    const saved = process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED
    try {
      delete process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED
      const off = await isApprovalRoutingPolicyRequired(fakeQuery(2, 0).query, 'o')
      process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED = 'true'
      const on = await isApprovalRoutingPolicyRequired(fakeQuery(2, 0).query, 'o')
      expect(off).toEqual(on)
      expect(off.required).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED
      else process.env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED = saved
    }
  })

  it('is read-only and takes no lock', async () => {
    const { query, calls } = fakeQuery(2, 0)
    await isApprovalRoutingPolicyRequired(query, 'o')
    expect(calls).toHaveLength(2)
    for (const { sql } of calls) {
      expect(sql).toMatch(/^SELECT /)
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|LOCK|FOR UPDATE|FOR SHARE|advisory)\b/i)
    }
  })

  it('propagates a query failure instead of reporting a status', async () => {
    const query: PullSourceRuleQuery = async () => {
      throw new Error('connection lost')
    }
    await expect(isApprovalRoutingPolicyRequired(query, 'o')).rejects.toThrow('connection lost')
    await expect(countActivePullSources(query, 'o')).rejects.toThrow('connection lost')
  })
})

describe('organisation lock key', () => {
  it('is the pinned key text shared with other writers of the same lock', () => {
    expect(DIRECTORY_ORG_LOCK_KEY_PREFIX).toBe('directory:capability-directory:')
    expect(directoryOrgLockKey('default')).toBe('directory:capability-directory:default')
  })

  it('builds the advisory-lock statement from the same prefix', () => {
    expect(directoryOrgLockSql()).toBe(
      "SELECT pg_advisory_xact_lock(hashtext('directory:capability-directory:' || $1::text))",
    )
    expect(directoryOrgLockSql('$2')).toContain("hashtext('directory:capability-directory:' || $2::text)")
    expect(() => directoryOrgLockSql("1'); --")).toThrow(TypeError)
    expect(() => directoryOrgLockSql('org')).toThrow(TypeError)
  })

  it('is defined once: no other source file carries the key text', () => {
    const files = walkTs(SRC_ROOT)
    expect(files.length).toBeGreaterThan(100)
    const carriers = files.filter((file) => readFileSync(file, 'utf8').includes('directory:capability-directory:'))
    expect(carriers).toEqual([LEAF_PATH])
  })
})

describe('typed errors', () => {
  it('ApprovalRoutingPolicyError keeps the legacy single-argument construction', () => {
    const error = new ApprovalRoutingPolicyError('boom')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ApprovalRoutingPolicyError')
    expect(error.message).toBe('boom')
    expect(error.reason).toBe('canonical_unavailable')
    expect(error.orgId).toBeNull()
    expect(error.sourceCount).toBeNull()
  })

  it('carries reason, organisation and count only in typed properties', () => {
    const error = new ApprovalRoutingPolicyError(POLICY_REQUIRED_MESSAGE, 'policy_required', 'org-secret-1', 7)
    expect(error.reason).toBe('policy_required')
    expect(error.orgId).toBe('org-secret-1')
    expect(error.sourceCount).toBe(7)
    expect(error.message).toBe(POLICY_REQUIRED_MESSAGE)
    expect(error.message).not.toContain('org-secret-1')
    expect(error.message).not.toMatch(/\d/)
    expect(new ApprovalRoutingPolicyError('x', 'multi_org_ambiguous').reason).toBe('multi_org_ambiguous')
  })

  it('DirectoryRoutingPolicyRequiredError is a plain Error with a fixed code and sentence', () => {
    const error = new DirectoryRoutingPolicyRequiredError()
    expect(error).toBeInstanceOf(Error)
    expect(Object.getPrototypeOf(DirectoryRoutingPolicyRequiredError.prototype)).toBe(Error.prototype)
    expect(error.name).toBe('DirectoryRoutingPolicyRequiredError')
    expect(error.code).toBe('DIRECTORY_ROUTING_POLICY_REQUIRED')
    expect(DIRECTORY_ROUTING_POLICY_REQUIRED_CODE).toBe('DIRECTORY_ROUTING_POLICY_REQUIRED')
    expect(error.message).not.toMatch(/\d/)
  })

  it('both error classes extend Error directly in source', () => {
    expect(leafSource).toMatch(/class ApprovalRoutingPolicyError extends Error \{/)
    expect(leafSource).toMatch(/class DirectoryRoutingPolicyRequiredError extends Error \{/)
  })
})

describe('leaf module shape', () => {
  it('imports nothing (no sync module, no database module, no cycle)', () => {
    expect(leafSource).not.toMatch(/^\s*import\s/m)
    expect(leafSource).not.toMatch(/\bimport\s*\(/)
    expect(leafSource).not.toMatch(/\brequire\s*\(/)
    expect(leafSource).not.toMatch(/^\s*export\s+(\*|\{[^}]*\})\s+from\s/m)
    expect(leafSource).not.toMatch(/directory-sync|db\/|connection-pool/)
  })

  it('reads only tables that already exist', () => {
    const referenced = [...leafSource.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/g)].map((m) => m[1])
    expect([...new Set(referenced)].sort()).toEqual([...PULL_SOURCE_RULE_TABLES].sort())
    const runtime = [COUNT_ACTIVE_PULL_SOURCES_SQL, APPROVAL_ROUTING_POLICY_EXISTS_SQL]
      .flatMap((sql) => [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/g)].map((m) => m[1]))
    expect([...new Set(runtime)].sort()).toEqual([...PULL_SOURCE_RULE_TABLES].sort())
    const migrations = readdirSync(join(SRC_ROOT, 'db/migrations'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(join(SRC_ROOT, 'db/migrations', name), 'utf8'))
      .join('\n')
    for (const table of PULL_SOURCE_RULE_TABLES) {
      expect(migrations, table).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b|createTable\\('${table}'`))
    }
  })

  it('has no write statements', () => {
    const sqlLiterals = [COUNT_ACTIVE_PULL_SOURCES_SQL, APPROVAL_ROUTING_POLICY_EXISTS_SQL].join('\n')
    expect(sqlLiterals).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i)
  })
})

describe('flag manifest registration', () => {
  it('registers the switch with the exact-literal reader of this module', async () => {
    const manifestUrl = join(REPO_ROOT, 'scripts/ops/global-history-flag-manifest.mjs')
    const manifest = (await import(manifestUrl)) as {
      GLOBAL_HISTORY_FLAG_BY_KEY: Record<string, { type: string; activationValue: string; danger: string; source: string; caseInsensitive?: boolean }>
    }
    const spec = manifest.GLOBAL_HISTORY_FLAG_BY_KEY[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED]
    expect(spec).toBeDefined()
    expect(spec.type).toBe('boolean')
    expect(spec.activationValue).toBe('true')
    expect(spec.danger).toBe('high')
    expect(spec.caseInsensitive).toBeUndefined()
    expect(spec.source).toBe(
      'packages/core-backend/src/directory/pull-source-rule.ts#isApprovalRoutingRequirePolicyEnabled',
    )
  })

  it('is the only approval-routing switch read anywhere in source', () => {
    const tokens = new Set<string>()
    for (const file of walkTs(SRC_ROOT)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/APPROVAL_ROUTING_[A-Z_0-9]+/g)) tokens.add(match[0])
    }
    const switches = [...tokens].filter((token) => token.endsWith('_ENABLED')).sort()
    expect(switches).toEqual(['APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED'])
    expect([...tokens].some((token) => !token.endsWith('_ENABLED'))).toBe(true)
  })
})
