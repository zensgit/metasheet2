/**
 * Pull-source rule leaf module (src/directory/pull-source-rule.ts).
 *
 * Pins the invariants of the module itself: what its fragments, statements, helpers and error types
 * are. What its callers do with them is pinned next to each caller. No database: statements go through
 * an injected fake `query`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { APPROVAL_ROUTING_PULL_TYPE_ROWS_SQL, NON_ACTIVE_PULL_SOURCE_LINKED_ACCOUNT_COUNT_SQL } from '../../src/directory/approval-routing-status'
import * as leafModule from '../../src/directory/pull-source-rule'
import {
  APPROVAL_ROUTING_POLICY_EXISTS_SQL,
  APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED,
  ApprovalRoutingPolicyError,
  COUNT_ACTIVE_PULL_SOURCES_SQL,
  DIRECTORY_ORG_LOCK_KEY_PREFIX,
  DIRECTORY_ROUTING_POLICY_REQUIRED_CODE,
  DirectoryRoutingPolicyRequiredError,
  POLICY_REQUIRED_MESSAGE,
  PULL_SOURCE_COUNT_UNAVAILABLE_MESSAGE,
  PullSourceCountUnavailableError,
  PULL_SOURCE_KEY_SQL,
  PULL_SOURCE_PREDICATE_SQL,
  PULL_SOURCE_RULE_TABLES,
  PULL_SOURCE_THRESHOLD,
  countActivePullSources,
  directoryOrgLockKey,
  directoryOrgLockSql,
  isApprovalRoutingPolicyRequired,
  nonActivePullTypePredicateSql,
  pullTypePredicateSql,
  isApprovalRoutingRequirePolicyEnabled,
  pullSourceKeySql,
  pullSourcePredicateSql,
  type PullSourceRuleQuery,
} from '../../src/directory/pull-source-rule'
import { COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL, countOtherActivePullSources } from '../../src/directory/pull-source-rule'

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
    expect(PULL_SOURCE_PREDICATE_SQL).toBe("(i.provider <> 'local' AND i.status = 'active')")
    expect(pullSourcePredicateSql('x')).toBe("(x.provider <> 'local' AND x.status = 'active')")
    // Parenthesised, so a caller can negate or combine it without changing its meaning.
    expect(`NOT ${pullSourcePredicateSql()}`).toBe("NOT (i.provider <> 'local' AND i.status = 'active')")
    expect(PULL_SOURCE_KEY_SQL).toBe('(i.provider, i.corp_id)')
    expect(pullSourceKeySql('x')).toBe('(x.provider, x.corp_id)')
    expect(COUNT_ACTIVE_PULL_SOURCES_SQL).not.toContain('sync_enabled')
  })

  it('de-duplicates by (provider, corp_id) and scopes to one organisation', () => {
    expect(COUNT_ACTIVE_PULL_SOURCES_SQL).toContain('count(DISTINCT (i.provider, i.corp_id))')
    expect(COUNT_ACTIVE_PULL_SOURCES_SQL).toContain('i.org_id = $1')
    expect(COUNT_ACTIVE_PULL_SOURCES_SQL).toContain(PULL_SOURCE_PREDICATE_SQL)
    expect(COUNT_ACTIVE_PULL_SOURCES_SQL).not.toMatch(/count\(\*\)/i)
    expect(COUNT_ACTIVE_PULL_SOURCES_SQL).toBe(
      "SELECT count(DISTINCT (i.provider, i.corp_id))::int AS pull_source_count FROM directory_integrations i " +
        "WHERE i.org_id = $1 AND (i.provider <> 'local' AND i.status = 'active')",
    )
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
    expect(APPROVAL_ROUTING_POLICY_EXISTS_SQL).toBe(
      "SELECT 1 AS present FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = 'approval_routing'",
    )
  })
})

describe('pull-type fragments', () => {
  it('the pull-type fragment is the provider condition alone', () => {
    expect(pullTypePredicateSql('i')).toBe("(i.provider <> 'local')")
    expect(pullTypePredicateSql()).toBe("(i.provider <> 'local')")
    expect(pullTypePredicateSql('ri')).toBe("(ri.provider <> 'local')")
  })

  it('the non-active pull-type fragment is the complement of active within pull type', () => {
    expect(nonActivePullTypePredicateSql('i')).toBe("(i.provider <> 'local' AND i.status <> 'active')")
    expect(nonActivePullTypePredicateSql()).toBe("(i.provider <> 'local' AND i.status <> 'active')")
    expect(nonActivePullTypePredicateSql('ri')).toBe("(ri.provider <> 'local' AND ri.status <> 'active')")
    // Parenthesised, so a caller can negate or combine either fragment without changing its meaning.
    expect(`NOT ${nonActivePullTypePredicateSql()}`).toBe("NOT (i.provider <> 'local' AND i.status <> 'active')")
  })

  it('all three fragments are assembled around one pull-type condition written once', () => {
    const code = leafSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code.split("provider <> 'local'")).toHaveLength(2)
    expect(code.split("status <> 'active'")).toHaveLength(2)
    expect(code.split("status = 'active'")).toHaveLength(2)
    expect(code.split('pullTypeConditionSql(a)')).toHaveLength(4)
    for (const alias of ['i', 'x']) {
      const pullType = pullTypePredicateSql(alias).slice(1, -1)
      expect(pullSourcePredicateSql(alias)).toBe(`(${pullType} AND ${alias}.status = 'active')`)
      expect(nonActivePullTypePredicateSql(alias)).toBe(`(${pullType} AND ${alias}.status <> 'active')`)
    }
  })

  it('reject an alias that is not a plain identifier', () => {
    for (const alias of ['', 'a.b', "i; DROP TABLE x", 'I', '1a', 'a b']) {
      expect(() => pullTypePredicateSql(alias), alias).toThrow(TypeError)
      expect(() => nonActivePullTypePredicateSql(alias), alias).toThrow(TypeError)
    }
  })

  it('the count of linked accounts under non-active pull sources takes its condition from the fragment', () => {
    const carrier = readFileSync(join(SRC_ROOT, 'directory/approval-routing-status.ts'), 'utf8')
    expect(carrier).toMatch(/import \{[^}]*\bnonActivePullTypePredicateSql\b[^}]*\} from '\.\/pull-source-rule'/)
    expect(carrier).not.toMatch(/provider\s*<>\s*'local'/)
    expect(carrier).not.toMatch(/status\s*<>\s*'active'/)
    expect(carrier).toContain("WHERE i.org_id = $1 AND ${nonActivePullTypePredicateSql('i')}`")
    expect(NON_ACTIVE_PULL_SOURCE_LINKED_ACCOUNT_COUNT_SQL).toBe(
      `SELECT count(DISTINCT a.id)::int AS linked_account_count
     FROM directory_integrations i
     JOIN directory_accounts a ON a.integration_id = i.id AND a.is_active = true
     JOIN directory_account_links dal ON dal.directory_account_id = a.id AND dal.link_status = 'linked'
    WHERE i.org_id = $1 AND (i.provider <> 'local' AND i.status <> 'active')`,
    )
    expect(APPROVAL_ROUTING_PULL_TYPE_ROWS_SQL).toContain("WHERE i.org_id = $1 AND (i.provider <> 'local')")
    // The key naming the count appears in source only where the count is produced.
    const carriers = walkTs(SRC_ROOT)
      .filter((file) => readFileSync(file, 'utf8').includes('nonActivePullSourceLinkedAccountCount'))
      .map((file) => file.slice(SRC_ROOT.length + 1))
    expect(carriers).toEqual(['directory/approval-routing-status.ts'])
  })
})

describe('countActivePullSources / isApprovalRoutingPolicyRequired', () => {
  it('passes the organisation id as the only parameter', async () => {
    const { query, calls } = fakeQuery(1, 0)
    await expect(countActivePullSources(query, 'org-a')).resolves.toBe(1)
    expect(calls).toEqual([{ sql: COUNT_ACTIVE_PULL_SOURCES_SQL, params: ['org-a'] }])
  })

  it('accepts a numeric or digit-string count and fails closed on an unreadable one', async () => {
    await expect(countActivePullSources(fakeQuery('3', 0).query, 'o')).resolves.toBe(3)
    await expect(countActivePullSources(fakeQuery(0, 0).query, 'o')).resolves.toBe(0)
    for (const unreadable of [undefined, null, 'x', '', '-1', '1.5', -1, 1.5, Number.NaN, Infinity]) {
      const failure = await countActivePullSources(fakeQuery(unreadable, 0).query, 'o').catch((error: unknown) => error)
      expect(failure, String(unreadable)).toBeInstanceOf(PullSourceCountUnavailableError)
      expect(failure).not.toBeInstanceOf(ApprovalRoutingPolicyError)
      expect((failure as PullSourceCountUnavailableError).name).toBe('PullSourceCountUnavailableError')
      expect((failure as PullSourceCountUnavailableError).orgId).toBe('o')
      expect((failure as PullSourceCountUnavailableError).message).toBe(PULL_SOURCE_COUNT_UNAVAILABLE_MESSAGE)
      expect(PULL_SOURCE_COUNT_UNAVAILABLE_MESSAGE).not.toMatch(/[0-9]/)
    }
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
    expect(calls.map((call) => call.params)).toEqual([['o'], ['o']])
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
  it('is the pinned key text of the organisation pull-source lock', () => {
    expect(DIRECTORY_ORG_LOCK_KEY_PREFIX).toBe('directory:pull-sources:')
    expect(directoryOrgLockKey('default')).toBe('directory:pull-sources:default')
  })

  it('builds the advisory-lock statement from the same prefix', () => {
    expect(directoryOrgLockSql()).toBe(
      "SELECT pg_advisory_xact_lock(hashtext('directory:pull-sources:' || $1::text))",
    )
    expect(directoryOrgLockSql('$2')).toContain("hashtext('directory:pull-sources:' || $2::text)")
    expect(directoryOrgLockSql('$12')).toContain("hashtext('directory:pull-sources:' || $12::text)")
    expect(() => directoryOrgLockSql('$0')).toThrow(TypeError)
    expect(() => directoryOrgLockSql('$01')).toThrow(TypeError)
    expect(() => directoryOrgLockSql("1'); --")).toThrow(TypeError)
    expect(() => directoryOrgLockSql("$1'); --")).toThrow(TypeError)
    expect(() => directoryOrgLockSql('x$1')).toThrow(TypeError)
    expect(() => directoryOrgLockSql('$1 ')).toThrow(TypeError)
    expect(() => directoryOrgLockSql('org')).toThrow(TypeError)
  })

  it('is defined once: no other source file carries the key text', () => {
    const files = walkTs(SRC_ROOT)
    expect(files.length).toBeGreaterThan(100)
    const carriers = files.filter((file) => readFileSync(file, 'utf8').includes('directory:pull-sources:'))
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

  it('all three error classes extend Error directly', () => {
    expect(leafSource).toMatch(/class ApprovalRoutingPolicyError extends Error \{/)
    expect(leafSource).toMatch(/class DirectoryRoutingPolicyRequiredError extends Error \{/)
    expect(leafSource).toMatch(/class PullSourceCountUnavailableError extends Error \{/)
    expect(Object.getPrototypeOf(PullSourceCountUnavailableError.prototype)).toBe(Error.prototype)
  })

  it('PullSourceCountUnavailableError carries no organisation when constructed without one', () => {
    const error = new PullSourceCountUnavailableError()
    expect(error.orgId).toBeNull()
    expect(error.message).toBe(PULL_SOURCE_COUNT_UNAVAILABLE_MESSAGE)
  })
})

describe('leaf module shape', () => {
  it('imports nothing (no sync module, no database module, no cycle)', () => {
    expect(leafSource).not.toMatch(/^\s*import\s/m)
    expect(leafSource).not.toMatch(/\bimport\s*\(/)
    expect(leafSource).not.toMatch(/\brequire\s*\(/)
    expect(leafSource).not.toMatch(/^\s*export\s+(\*|\{[^}]*\})\s+from\s/m)
    expect(leafSource).not.toMatch(/^\s*export\s+(type\s+)?(\*(\s+as\s+\w+)?|\{[^}]*\})\s+from\s/m)
    expect(leafSource).not.toMatch(/\bfrom\s+['"]/)
    expect(leafSource).not.toMatch(/directory-sync|db\/|connection-pool/)
    expect(ts.preProcessFile(leafSource, true, true).importedFiles).toEqual([])
  })

  it('reads only tables that already exist', () => {
    const code = leafSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const referenced = [...code.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase())
    expect([...new Set(referenced)].sort()).toEqual([...PULL_SOURCE_RULE_TABLES].sort())
    const exportedText = Object.values(leafModule).filter((value): value is string => typeof value === 'string')
    const exportedTables = exportedText.flatMap((text) =>
      [...text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase()))
    expect([...new Set(exportedTables)].sort()).toEqual([...PULL_SOURCE_RULE_TABLES].sort())
    const runtime = [COUNT_ACTIVE_PULL_SOURCES_SQL, APPROVAL_ROUTING_POLICY_EXISTS_SQL]
      .flatMap((sql) => [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/g)].map((m) => m[1]))
    expect([...new Set(runtime)].sort()).toEqual([...PULL_SOURCE_RULE_TABLES].sort())
    // The rule reads exactly these two pre-existing tables; a later table must not appear here.
    expect([...PULL_SOURCE_RULE_TABLES].sort()).toEqual(['directory_integrations', 'org_directory_routing_policy'])
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

describe('countOtherActivePullSources', () => {
  function fakeOtherCount(rows: Array<Record<string, unknown>>) {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = []
    const query: PullSourceRuleQuery = async (sql, params) => {
      calls.push({ sql, params })
      if (sql === COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL) return { rows }
      throw new Error(`unexpected statement: ${sql}`)
    }
    return { query, calls }
  }

  it('is the active-source count with the one external source left out', () => {
    expect(COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL).toBe(
      'SELECT count(DISTINCT (i.provider, i.corp_id))::int AS other_source_count FROM directory_integrations i ' +
        "WHERE i.org_id = $1 AND (i.provider <> 'local' AND i.status = 'active') " +
        'AND NOT (i.provider = $2 AND i.corp_id = $3)',
    )
    // Assembled from the module's own fragments, and identical to the plain count up to the exclusion.
    expect(COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL).toContain(`count(DISTINCT ${PULL_SOURCE_KEY_SQL})`)
    expect(COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL).toContain(`i.org_id = $1 AND ${PULL_SOURCE_PREDICATE_SQL} AND NOT (`)
    expect(
      COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL
        .replace(' AND NOT (i.provider = $2 AND i.corp_id = $3)', '')
        .replace('other_source_count', 'pull_source_count'),
    ).toBe(COUNT_ACTIVE_PULL_SOURCES_SQL)
    expect(COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i)
    expect(COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL).not.toContain('sync_enabled')
    // Every placeholder is bound and there is no fourth.
    expect([...COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL.matchAll(/\$(\d+)/g)].map((m) => m[1]).sort()).toEqual(['1', '2', '3'])
    const code = leafSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain('`FROM directory_integrations i WHERE i.org_id = $1 AND ${PULL_SOURCE_PREDICATE_SQL} `')
  })

  it('binds the organisation, provider and corp id in that order and returns the count', async () => {
    const { query, calls } = fakeOtherCount([{ other_source_count: 2 }])
    await expect(countOtherActivePullSources(query, 'org-1', 'dingtalk', 'corp-9')).resolves.toBe(2)
    expect(calls).toEqual([{ sql: COUNT_OTHER_ACTIVE_PULL_SOURCES_SQL, params: ['org-1', 'dingtalk', 'corp-9'] }])
    await expect(countOtherActivePullSources(fakeOtherCount([{ other_source_count: 0 }]).query, 'o', 'p', 'c')).resolves.toBe(0)
    await expect(countOtherActivePullSources(fakeOtherCount([{ other_source_count: '3' }]).query, 'o', 'p', 'c')).resolves.toBe(3)
  })

  it('an unreadable count raises the same error as the plain count, never zero', async () => {
    const unreadable: Array<Array<Record<string, unknown>>> = [
      [],
      [{}],
      [{ other_source_count: null }],
      [{ other_source_count: 'two' }],
      [{ other_source_count: 1.5 }],
      [{ other_source_count: -1 }],
      [{ pull_source_count: 1 }],
    ]
    for (const rows of unreadable) {
      const failure = await countOtherActivePullSources(fakeOtherCount(rows).query, 'org-secret-1', 'dingtalk', 'corp-9').then(
        () => null,
        (error: unknown) => error,
      )
      expect(failure, JSON.stringify(rows)).toBeInstanceOf(PullSourceCountUnavailableError)
      expect(failure).not.toBeInstanceOf(ApprovalRoutingPolicyError)
      expect((failure as PullSourceCountUnavailableError).message).toBe(PULL_SOURCE_COUNT_UNAVAILABLE_MESSAGE)
      expect((failure as PullSourceCountUnavailableError).orgId).toBe('org-secret-1')
    }
    const plain = await countActivePullSources(fakeQuery(undefined, 0).query, 'org-secret-1').then(() => null, (error: unknown) => error)
    expect(plain).toBeInstanceOf(PullSourceCountUnavailableError)
    // One reader decides what an unreadable count is, for both counts.
    const code = leafSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code.split('new PullSourceCountUnavailableError(')).toHaveLength(2)
    expect(code.split('readSourceCount(')).toHaveLength(4)
  })
})

describe('the write gate takes the organisation lock from this module', () => {
  const gateSource = readFileSync(join(SRC_ROOT, 'directory/pull-source-write-gate.ts'), 'utf8')
  const gateCode = gateSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('imports the lock statement builder and writes no lock key or advisory-lock call of its own', () => {
    expect(gateSource).toMatch(/import \{[^}]*\bdirectoryOrgLockSql\b[^}]*\} from '\.\/pull-source-rule'/)
    expect(gateCode.split('directoryOrgLockSql(')).toHaveLength(2)
    expect(gateCode).toContain("await client.query(directoryOrgLockSql('$1'), [orgId])")
    expect(gateSource).not.toContain(DIRECTORY_ORG_LOCK_KEY_PREFIX)
    expect(gateSource).not.toMatch(/pull-sources/)
    expect(gateCode).not.toMatch(/pg_(try_)?advisory/i)
    expect(gateCode).not.toMatch(/hashtext/i)
  })

  it('depends on the rule module, the database module and the gate marker module only', () => {
    const imported = ts.preProcessFile(gateSource, true, true).importedFiles.map((file) => file.fileName).sort()
    expect(imported).toEqual(['../db/pg', './pull-source-gate-context', './pull-source-rule'])
  })

  it('takes its counts and its policy probe from this module', () => {
    expect(gateSource).toMatch(/import \{[^}]*\bcountOtherActivePullSources\b[^}]*\} from '\.\/pull-source-rule'/)
    expect(gateSource).toMatch(/import \{[^}]*\bcountActivePullSources\b[^}]*\} from '\.\/pull-source-rule'/)
    expect(gateSource).toMatch(/import \{[^}]*\bAPPROVAL_ROUTING_POLICY_EXISTS_SQL\b[^}]*\} from '\.\/pull-source-rule'/)
    expect(gateSource).toMatch(/import \{[^}]*\bPULL_SOURCE_THRESHOLD\b[^}]*\} from '\.\/pull-source-rule'/)
    expect(gateCode).not.toMatch(/count\s*\(/i)
  })

  it('names the two tables in three statements of its own and nowhere else: the row lock, the policy row lock and the policy delete', () => {
    const source = ts.createSourceFile('gate.ts', gateSource, ts.ScriptTarget.Latest, true)
    const statements: string[] = []
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
        && PULL_SOURCE_RULE_TABLES.some((table) => node.getText(source).includes(table))) {
        statements.push(node.getText(source).slice(1, -1).trim().split(/\s+/).join(' '))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(statements).toEqual([
      'SELECT org_id, status FROM directory_integrations WHERE id = $1 AND provider = $2 FOR UPDATE',
      'SELECT canonical_integration_id::text AS canonical_integration_id FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = $2 FOR UPDATE',
      'DELETE FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = $2',
    ])
    // Outside those literals the code does not spell either table.
    const withoutLiterals = gateCode.replace(/`[^`]*`/g, '``')
    expect(withoutLiterals).not.toMatch(/directory_integrations|org_directory_routing_policy/)
  })
})
