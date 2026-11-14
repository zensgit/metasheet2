/**
 * Approval routing — the multi-source rule of the requester resolver, without a database.
 *
 * Invariants pinned here:
 *  - the multi-source probe is assembled from the pull-source rule fragments and the shared
 *    threshold, carries its marker, reads only directory tables that already exist and writes nothing;
 *  - with the switch off the resolver issues exactly the statements it issued before the rule
 *    existed, in the same order and with the same text; with the switch on it adds one statement,
 *    only when no policy governs and no preview override is given;
 *  - one mapping turns a routing-policy error into its HTTP error: the two policy faults keep their
 *    status, code and sentence at every call site, and the missing policy answers its own code with
 *    one fixed sentence;
 *  - the resolver is called from a closed set of files, and only the admin preview passes the
 *    preview override;
 *  - every registered directory adapter is a pull-type provider;
 *  - the probe text is not matched by the query fakes of the three resolver unit files, so those
 *    fakes reject it as an unknown statement;
 *  - a pull source is counted in one place only: the rule module and statements assembled from its
 *    fragments;
 *  - the routing-policy error is one class, shared by the resolver, the service and the routes.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'

import '../../src/directory/adapters'
import {
  APPROVAL_ROUTING_CANDIDATES_SQL,
  APPROVAL_ROUTING_PULL_TYPE_ROWS_SQL,
  ApprovalRoutingStatusUnavailableError,
  NON_ACTIVE_PULL_SOURCE_LINKED_ACCOUNT_COUNT_SQL,
  groupSameCorpRows,
  readApprovalRoutingStatus,
} from '../../src/directory/approval-routing-status'
import { DirectoryProviderAdapterUnavailableError, resolveDirectoryAdapter } from '../../src/directory/directory-adapter-registry'
import * as leaf from '../../src/directory/pull-source-rule'
import {
  APPROVAL_ROUTING_POLICY_EXISTS_SQL,
  APPROVAL_ROUTING_POLICY_REQUIRED_CODE,
  APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED,
  COUNT_ACTIVE_PULL_SOURCES_SQL,
  POLICY_REQUIRED_MESSAGE,
  PULL_SOURCE_THRESHOLD,
  PullSourceCountUnavailableError,
  pullSourceKeySql,
  pullSourcePredicateSql,
} from '../../src/directory/pull-source-rule'
import * as resolverModule from '../../src/services/ApprovalDirectoryOrg'
import {
  APPROVAL_ROUTING_MULTI_SOURCE_PROBE_MARKER,
  ApprovalRoutingPolicyError,
  approvalRoutingMultiSourceProbeSql,
  resolveApprovalRequesterOrgRelations,
} from '../../src/services/ApprovalDirectoryOrg'
import {
  APPROVAL_ROUTING_POLICY_MISCONFIGURED_CODE,
  routingPolicyRequiredLogLine,
  routingPolicyServiceError,
  type RoutingPolicyErrorContext,
} from '../../src/services/ApprovalProductService'

const SRC_ROOT = join(__dirname, '../../src')
const REPO_ROOT = join(__dirname, '../../../..')
const LEAF_FILE = 'directory/pull-source-rule.ts'
const RESOLVER_FILE = 'services/ApprovalDirectoryOrg.ts'

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walkTs(full))
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}
const srcFile = (file: string): string => readFileSync(join(SRC_ROOT, file), 'utf8')
/** Every source file except one-off migrations, as `[path relative to src, text]`. */
const SOURCES: Array<[string, string]> = walkTs(SRC_ROOT)
  .map((full): [string, string] => [relative(SRC_ROOT, full).split('\\').join('/'), readFileSync(full, 'utf8')])
  .filter(([file]) => !file.startsWith('db/migrations/'))
  .sort(([left], [right]) => left.localeCompare(right))

const PROBE_KERNEL = approvalRoutingMultiSourceProbeSql(false)
const PROBE_SCOPED = approvalRoutingMultiSourceProbeSql(true)

afterEach(() => {
  delete process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED]
})

// ── U2 ──────────────────────────────────────────────────────────────────────────────────────────
describe('U2 multi-source probe statement', () => {
  it('is this statement, word for word', () => {
    expect(PROBE_KERNEL).toBe(`/* approval-routing:multi-source-probe */
WITH requester_orgs AS (
  SELECT DISTINCT ai.org_id
    FROM directory_accounts a
    JOIN directory_account_links dal ON dal.directory_account_id = a.id
    JOIN directory_integrations ai ON ai.id = a.integration_id
   WHERE dal.local_user_id = $1
     AND dal.link_status = 'linked'
     AND a.is_active = true
)
SELECT i.org_id AS org_id,
       count(DISTINCT (i.provider, i.corp_id))::int AS pull_source_count
  FROM directory_integrations i
  JOIN requester_orgs ro ON ro.org_id = i.org_id
 WHERE (i.provider <> 'local' AND i.status = 'active')
 GROUP BY i.org_id
HAVING count(DISTINCT (i.provider, i.corp_id)) >= 2
 ORDER BY i.org_id ASC`)
  })

  it('differs between the two paths only by the organisation boundary', () => {
    expect(PROBE_SCOPED).toBe(PROBE_KERNEL.replace('     AND a.is_active = true\n', '     AND a.is_active = true\n     AND ai.org_id = $2\n'))
    expect(PROBE_SCOPED).not.toBe(PROBE_KERNEL)
    expect(PROBE_KERNEL).not.toContain('$2')
  })

  it('starts with its marker', () => {
    expect(APPROVAL_ROUTING_MULTI_SOURCE_PROBE_MARKER).toBe('/* approval-routing:multi-source-probe */')
    expect(PROBE_KERNEL.startsWith(APPROVAL_ROUTING_MULTI_SOURCE_PROBE_MARKER)).toBe(true)
    expect(PROBE_SCOPED.startsWith(APPROVAL_ROUTING_MULTI_SOURCE_PROBE_MARKER)).toBe(true)
  })

  it('takes the source predicate, the source key and the threshold from the rule module', () => {
    for (const sql of [PROBE_KERNEL, PROBE_SCOPED]) {
      expect(sql).toContain(` WHERE ${pullSourcePredicateSql('i')}\n`)
      expect(sql).toContain(`count(DISTINCT ${pullSourceKeySql('i')})::int AS pull_source_count`)
      expect(sql).toContain(`HAVING count(DISTINCT ${pullSourceKeySql('i')}) >= ${PULL_SOURCE_THRESHOLD}\n`)
      expect(sql).not.toMatch(/count\(\*\)/i)
    }
  })

  it('writes the threshold nowhere by hand', () => {
    const resolverSource = srcFile(RESOLVER_FILE)
    const builder = resolverSource.slice(
      resolverSource.indexOf('export function approvalRoutingMultiSourceProbeSql'),
      resolverSource.indexOf('ORDER BY i.org_id ASC`'),
    )
    expect(builder).toContain('>= ${PULL_SOURCE_THRESHOLD}')
    expect(builder).toContain("${pullSourcePredicateSql('i')}")
    expect(builder).toContain("pullSourceKeySql('i')")
    expect(builder.replace(/\$[12]\b/g, '')).not.toMatch(/\d/)
    expect(resolverSource).not.toMatch(/provider\s*<>\s*'local'/)
    expect(PROBE_SCOPED.replace(/\$[12]\b/g, '').match(/\d+/g)).toEqual([String(PULL_SOURCE_THRESHOLD)])
  })

  it('reads only directory tables that already exist and writes nothing', () => {
    const tables = [...PROBE_SCOPED.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/g)].map((match) => match[1])
    expect([...new Set(tables)].sort()).toEqual(['directory_account_links', 'directory_accounts', 'directory_integrations', 'requester_orgs'])
    expect(PROBE_SCOPED).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|LOCK)\b/i)
    expect(PROBE_SCOPED).not.toContain('org_directory_routing_policy')
    expect(PROBE_SCOPED).not.toContain('sync_enabled')
  })

  it('reaches a requester through a linked, active account and no further condition', () => {
    const reach = PROBE_KERNEL.slice(PROBE_KERNEL.indexOf('WITH requester_orgs'), PROBE_KERNEL.indexOf(')\nSELECT'))
    expect(reach).toContain("dal.link_status = 'linked'")
    expect(reach).toContain('a.is_active = true')
    expect(reach.match(/\bAND\b/g)).toHaveLength(2)
    expect(reach).not.toMatch(/\.status\s*=/)
  })
})

// ── U3 ──────────────────────────────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>
interface Fixture { policies?: Row[]; requester?: Row | null; probeRows?: Row[] }

const REQUESTER_ROW: Row = {
  integration_id: '00000000-0000-4000-8000-000000000001',
  account_id: '00000000-0000-4000-8000-0000000000a1',
  external_user_id: 'ext-requester',
  raw: {},
  title: 'Engineer',
  primary_department_id: '00000000-0000-4000-8000-0000000000d1',
  primary_department_active: true,
  primary_external_department_id: 'dept-1',
  primary_department_raw: { dept_manager_userid_list: 'ext-head' },
  primary_department_name: 'Engineering',
}
const POLICY_ROW: Row = { org_id: 'org-a', canonical_integration_id: '00000000-0000-4000-8000-000000000001', canonical_status: 'active' }

/** Records every statement; answers the policy probe, the requester pick and the multi-source probe, and nothing else. */
function recorder(fixture: Fixture) {
  const statements: Array<{ text: string; params: unknown[] }> = []
  const query = async <R>(text: string, params: unknown[] = []): Promise<{ rows: R[] }> => {
    statements.push({ text, params })
    if (text.includes(APPROVAL_ROUTING_MULTI_SOURCE_PROBE_MARKER)) return { rows: (fixture.probeRows ?? []) as R[] }
    if (text.includes('org_directory_routing_policy')) return { rows: (fixture.policies ?? []) as R[] }
    if (text.includes('FROM directory_account_links l') && text.includes('LEFT JOIN directory_account_departments')) {
      return { rows: (fixture.requester ? [fixture.requester] : []) as R[] }
    }
    return { rows: [] }
  }
  return { statements, query }
}
const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

interface Scenario {
  name: string
  fixture: Fixture
  options?: Record<string, unknown>
  /** Statement fingerprints recorded from the resolver as it was before the rule existed. */
  golden: string[]
  /** Whether the multi-source probe runs with the switch on. */
  probes: boolean
}
const SCENARIOS: Scenario[] = [
  {
    name: 'kernel path, no policy, requester found',
    fixture: { requester: REQUESTER_ROW },
    golden: ['9c359b068aa993af', 'de1eb31ca58d1098', '18ad521f9f4dd04a', '5413f06cdcc1f7db'],
    probes: true,
  },
  {
    name: 'kernel path, no policy, both chains',
    fixture: { requester: REQUESTER_ROW },
    options: { includeManagerChain: true, includeDeptHeadChain: true, includeDepartmentFieldContext: true },
    golden: ['9c359b068aa993af', 'de1eb31ca58d1098', '18ad521f9f4dd04a', '5413f06cdcc1f7db', 'd6a5410bc91e6e7c', '6afe82dfd6b4124c'],
    probes: true,
  },
  {
    name: 'kernel path, no policy, requester absent',
    fixture: { requester: null },
    golden: ['9c359b068aa993af', 'de1eb31ca58d1098'],
    probes: true,
  },
  {
    name: 'organisation-scoped path, no policy',
    fixture: { requester: REQUESTER_ROW },
    options: { orgId: 'org-a' },
    golden: ['cc2b97c21d7d9901', 'e6dce222b7526a2e', '18ad521f9f4dd04a', '5413f06cdcc1f7db'],
    probes: true,
  },
  {
    name: 'kernel path, policy present',
    fixture: { requester: REQUESTER_ROW, policies: [POLICY_ROW] },
    golden: ['9c359b068aa993af', '2b47842da8a9403d', '18ad521f9f4dd04a', '5413f06cdcc1f7db'],
    probes: false,
  },
  {
    name: 'organisation-scoped path, policy present',
    fixture: { requester: REQUESTER_ROW, policies: [POLICY_ROW] },
    options: { orgId: 'org-a' },
    golden: ['cc2b97c21d7d9901', '2b47842da8a9403d', '18ad521f9f4dd04a', '5413f06cdcc1f7db'],
    probes: false,
  },
  {
    name: 'preview override to an integration',
    fixture: { requester: REQUESTER_ROW },
    options: { overrideCanonicalIntegrationId: '00000000-0000-4000-8000-000000000002' },
    golden: ['2b47842da8a9403d', '18ad521f9f4dd04a', '5413f06cdcc1f7db'],
    probes: false,
  },
  {
    name: 'preview override to the legacy path',
    fixture: { requester: REQUESTER_ROW },
    options: { overrideCanonicalIntegrationId: null },
    golden: ['de1eb31ca58d1098', '18ad521f9f4dd04a', '5413f06cdcc1f7db'],
    probes: false,
  },
]

describe('U3 statements issued by the resolver', () => {
  it.each(SCENARIOS)('switch off — $name: the statement sequence is the recorded one', async (scenario) => {
    const { statements, query } = recorder(scenario.fixture)

    await resolveApprovalRequesterOrgRelations('user-1', query, scenario.options ?? {})

    expect(statements.map((statement) => fingerprint(statement.text))).toEqual(scenario.golden)
    expect(statements.some((statement) => statement.text.includes(APPROVAL_ROUTING_MULTI_SOURCE_PROBE_MARKER))).toBe(false)
  })

  it.each(['', 'false', 'TRUE', ' true ', '1'])('a switch value of %j issues no additional statement', async (value) => {
    process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED] = value
    const scenario = SCENARIOS[0]
    const { statements, query } = recorder(scenario.fixture)

    await resolveApprovalRequesterOrgRelations('user-1', query, {})

    expect(statements.map((statement) => fingerprint(statement.text))).toEqual(scenario.golden)
  })

  it.each(SCENARIOS)('switch on — $name: the probe is the one additional statement, or none', async (scenario) => {
    process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED] = 'true'
    const { statements, query } = recorder(scenario.fixture)

    await resolveApprovalRequesterOrgRelations('user-1', query, scenario.options ?? {})

    const probes = statements.filter((statement) => statement.text.includes(APPROVAL_ROUTING_MULTI_SOURCE_PROBE_MARKER))
    const others = statements.filter((statement) => !statement.text.includes(APPROVAL_ROUTING_MULTI_SOURCE_PROBE_MARKER))
    expect(others.map((statement) => fingerprint(statement.text))).toEqual(scenario.golden)
    expect(probes).toHaveLength(scenario.probes ? 1 : 0)
    if (scenario.probes) {
      const scoped = scenario.options?.orgId !== undefined
      expect(probes[0]).toEqual({ text: scoped ? PROBE_SCOPED : PROBE_KERNEL, params: scoped ? ['user-1', 'org-a'] : ['user-1'] })
      // after the policy probe, before the requester pick
      expect(statements.indexOf(probes[0])).toBe(1)
    }
  })

  it('switch on, a probe row: raises policy_required before any requester pick and carries the row only in typed properties', async () => {
    process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED] = 'true'
    const { statements, query } = recorder({ requester: REQUESTER_ROW, probeRows: [{ org_id: 'org-first', pull_source_count: 3 }, { org_id: 'org-second', pull_source_count: 2 }] })

    const error = await resolveApprovalRequesterOrgRelations('user-1', query, {}).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApprovalRoutingPolicyError)
    expect(error).toMatchObject({ reason: 'policy_required', orgId: 'org-first', sourceCount: 3, message: POLICY_REQUIRED_MESSAGE })
    expect(statements).toHaveLength(2)
    expect(statements.some((statement) => statement.text.includes('LEFT JOIN directory_account_departments'))).toBe(false)
  })

  it('switch on, the probe fails: the failure propagates unchanged and is not a routing-policy error', async () => {
    process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED] = 'true'
    const failure = new Error('connection reset')
    const query = async <R>(text: string): Promise<{ rows: R[] }> => {
      if (text.includes(APPROVAL_ROUTING_MULTI_SOURCE_PROBE_MARKER)) throw failure
      return { rows: [] }
    }

    const error = await resolveApprovalRequesterOrgRelations('user-1', query, {}).catch((caught: unknown) => caught)

    expect(error).toBe(failure)
    expect(error).not.toBeInstanceOf(ApprovalRoutingPolicyError)
  })

  it('the two policy faults carry their own reasons and their sentences', async () => {
    const twoOrgs = recorder({ policies: [POLICY_ROW, { ...POLICY_ROW, org_id: 'org-b' }] })
    const broken = recorder({ policies: [{ ...POLICY_ROW, canonical_status: 'disabled' }] })
    const missing = recorder({ policies: [{ ...POLICY_ROW, canonical_status: null }] })

    const ambiguous = await resolveApprovalRequesterOrgRelations('user-1', twoOrgs.query, {}).catch((caught: unknown) => caught)
    const disabled = await resolveApprovalRequesterOrgRelations('user-1', broken.query, {}).catch((caught: unknown) => caught)
    const absent = await resolveApprovalRequesterOrgRelations('user-1', missing.query, {}).catch((caught: unknown) => caught)

    expect(ambiguous).toMatchObject({
      reason: 'multi_org_ambiguous',
      message: 'approval routing is policy-managed in 2 orgs this user is linked in; multi-org routing requires explicit resolution',
    })
    expect(disabled).toMatchObject({
      reason: 'canonical_unavailable',
      message: `the approval_routing policy for org "org-a" points at a 'disabled' integration; fix the routing policy`,
    })
    expect(absent).toMatchObject({
      reason: 'canonical_unavailable',
      message: 'the approval_routing policy for org "org-a" points at a missing integration; fix the routing policy',
    })
  })
})

// ── U4 ──────────────────────────────────────────────────────────────────────────────────────────
const MISCONFIGURED_SENTENCES: Record<RoutingPolicyErrorContext, string> = {
  form_contact: 'The directory routing policy governing a form-chosen contact is misconfigured, so approver resolution cannot run. Contact an administrator.',
  department_field: 'Approval department directory is unavailable',
  org_assignee_source: 'The directory routing policy for this organization is misconfigured, so approver resolution cannot run. Contact an administrator.',
  requester_department: 'The directory routing policy for this organization is misconfigured, so the requester department cannot be resolved. Contact an administrator.',
  requester_title: 'The directory routing policy for this organization is misconfigured, so the requester title cannot be resolved. Contact an administrator.',
}
const CONTEXTS = Object.keys(MISCONFIGURED_SENTENCES) as RoutingPolicyErrorContext[]

describe('U4 routing-policy error to HTTP error', () => {
  it.each(CONTEXTS)('%s: the two policy faults keep 422 APPROVAL_ROUTING_POLICY_MISCONFIGURED and the sentence of the call site', (context) => {
    for (const reason of ['canonical_unavailable', 'multi_org_ambiguous'] as const) {
      const mapped = routingPolicyServiceError(new ApprovalRoutingPolicyError('resolver text with org "org-x"', reason, 'org-x', 4), context)
      expect({ status: mapped.statusCode, code: mapped.code, message: mapped.message, details: mapped.details }).toEqual({
        status: 422,
        code: 'APPROVAL_ROUTING_POLICY_MISCONFIGURED',
        message: MISCONFIGURED_SENTENCES[context],
        details: undefined,
      })
    }
  })

  it.each(CONTEXTS)('%s: the missing policy answers 422 APPROVAL_ROUTING_POLICY_REQUIRED with the fixed sentence', (context) => {
    const mapped = routingPolicyServiceError(new ApprovalRoutingPolicyError(POLICY_REQUIRED_MESSAGE, 'policy_required', 'org-secret', 7), context)
    expect({ status: mapped.statusCode, code: mapped.code, message: mapped.message, details: mapped.details }).toEqual({
      status: 422,
      code: 'APPROVAL_ROUTING_POLICY_REQUIRED',
      message: 'Approval routing requires a canonical directory source policy for this organization',
      details: undefined,
    })
    expect(JSON.stringify(mapped)).not.toContain('org-secret')
    expect(mapped.message).not.toMatch(/\d/)
  })

  it('an error built the single-argument way maps as a policy fault', () => {
    const mapped = routingPolicyServiceError(new ApprovalRoutingPolicyError('legacy construction'), 'org_assignee_source')
    expect(mapped.code).toBe('APPROVAL_ROUTING_POLICY_MISCONFIGURED')
  })

  it('the two codes are distinct constants', () => {
    expect(APPROVAL_ROUTING_POLICY_REQUIRED_CODE).toBe('APPROVAL_ROUTING_POLICY_REQUIRED')
    expect(APPROVAL_ROUTING_POLICY_MISCONFIGURED_CODE).toBe('APPROVAL_ROUTING_POLICY_MISCONFIGURED')
  })

  it('the server log line carries the organisation and the count that the sentence leaves out', () => {
    const error = new ApprovalRoutingPolicyError(POLICY_REQUIRED_MESSAGE, 'policy_required', 'org-logged', 3)
    expect(routingPolicyRequiredLogLine(error)).toBe('Approval routing requires a policy: org=org-logged activePullSources=3')
    expect(error.message).not.toContain('org-logged')
  })

  it('every call site of the service answers through the mapping', () => {
    const service = srcFile('services/ApprovalProductService.ts')
    // The code literal appears once, in the constant the mapping uses.
    expect(service.split("'APPROVAL_ROUTING_POLICY_MISCONFIGURED'")).toHaveLength(2)
    expect(service.split('instanceof ApprovalRoutingPolicyError')).toHaveLength(3)
    expect(service.match(/routingPolicyServiceError\(\w+, '(\w+)'\)/g)?.sort()).toEqual([
      "routingPolicyServiceError(error, 'form_contact')",
      "routingPolicyServiceError(orgPolicyError, 'department_field')",
      "routingPolicyServiceError(orgPolicyError, 'org_assignee_source')",
      "routingPolicyServiceError(orgPolicyError, 'requester_department')",
      "routingPolicyServiceError(orgPolicyError, 'requester_title')",
    ])
  })

  it('the department selector maps the missing policy only', () => {
    const route = srcFile('routes/approvals.ts')
    expect(route.split('instanceof ApprovalRoutingPolicyError')).toHaveLength(2)
    expect(route).toContain("if (error instanceof ApprovalRoutingPolicyError && error.reason === 'policy_required') {")
    expect(route.match(/routingPolicyServiceError\(/g)).toHaveLength(1)
  })
})

// ── U5 ──────────────────────────────────────────────────────────────────────────────────────────
describe('U5 callers of the resolver', () => {
  it('the resolver module is imported by a closed set of files', () => {
    const importers = SOURCES.filter(([, text]) => /from\s+['"][^'"]*\/ApprovalDirectoryOrg['"]/.test(text)).map(([file]) => file)
    expect(importers).toEqual([
      'approvals/approval-departure-transfer-dispatch.ts',
      'directory/directory-sync.ts',
      'index.ts',
      'routes/admin-directory-routing-policy.ts',
      'routes/approvals.ts',
      'routes/attendance-admin.ts',
      'services/ApprovalProductService.ts',
    ])
  })

  it('the requester resolution is called from a closed set of sites', () => {
    const calls = Object.fromEntries(
      SOURCES
        .filter(([file]) => file !== RESOLVER_FILE)
        .map(([file, text]): [string, number] => [file, text.split('resolveApprovalRequesterOrgRelations(').length - 1])
        .filter(([, count]) => count > 0),
    )
    expect(calls).toEqual({
      'index.ts': 1,
      'routes/admin-directory-routing-policy.ts': 2,
      'routes/approvals.ts': 1,
      'services/ApprovalProductService.ts': 3,
    })
    const plugin = readFileSync(join(REPO_ROOT, 'plugins/plugin-attendance/index.cjs'), 'utf8')
    expect(plugin).not.toContain('resolveApprovalRequesterOrgRelations')
  })

  it('only the admin preview passes the preview override', () => {
    const users = SOURCES.filter(([file, text]) => file !== RESOLVER_FILE && text.includes('overrideCanonicalIntegrationId')).map(([file]) => file)
    expect(users).toEqual(['routes/admin-directory-routing-policy.ts'])
    expect(srcFile('routes/admin-directory-routing-policy.ts').split('overrideCanonicalIntegrationId')).toHaveLength(2)
  })
})

// ── U6 ──────────────────────────────────────────────────────────────────────────────────────────
describe('U6 registered directory adapters', () => {
  const REGISTERED = ['dingtalk', 'wecom']

  it('the registration module registers exactly the providers checked here', () => {
    const registrations = srcFile('directory/adapters/index.ts').match(/^registerDirectoryAdapter\(/gm) ?? []
    expect(registrations).toHaveLength(REGISTERED.length)
  })

  it.each(REGISTERED)('%s is a pull-type provider', (provider) => {
    expect(resolveDirectoryAdapter(provider).provider).toBe(provider)
    expect(resolveDirectoryAdapter(provider).provider).not.toBe('local')
  })

  it('no adapter is registered for the local directory', () => {
    expect(() => resolveDirectoryAdapter('local')).toThrow(DirectoryProviderAdapterUnavailableError)
  })
})

// ── U7 ──────────────────────────────────────────────────────────────────────────────────────────
describe('U7 the query fakes of the resolver unit files do not match the probe', () => {
  const FAKE_FILES = ['approval-directory-org.test.ts', 'approval-manager-chain.test.ts', 'approval-dept-head-chain.test.ts']
  const fragmentsOf = (file: string): string[] =>
    [...readFileSync(join(__dirname, file), 'utf8').matchAll(/text\.includes\('((?:[^'\\]|\\.)*)'\)/g)].map((match) => match[1])

  it('the fragment list is read from the three files and includes the known dispatch fragments', () => {
    const all = new Set(FAKE_FILES.flatMap(fragmentsOf))
    for (const known of [
      'FROM directory_account_links l',
      'org_directory_routing_policy',
      'LEFT JOIN directory_account_departments',
      'a.integration_id = $2',
      'JOIN directory_integrations di',
      'di.org_id = $2',
      'ad.is_manager = true',
      'JOIN directory_account_departments ad',
      'd.external_department_id = $2',
      'FROM directory_account_links',
      'WHERE directory_account_id = $1::uuid',
      'JOIN directory_account_links l',
      'a.external_user_id = $2',
      'p.org_id = $2',
    ]) {
      expect(all.has(known), known).toBe(true)
    }
    for (const file of FAKE_FILES) expect(fragmentsOf(file).length, file).toBeGreaterThanOrEqual(8)
  })

  it.each(FAKE_FILES)('no dispatch fragment of %s occurs in either form of the probe', (file) => {
    const matched = fragmentsOf(file).filter((fragment) => PROBE_KERNEL.includes(fragment) || PROBE_SCOPED.includes(fragment))
    expect(matched).toEqual([])
  })

  it.each(FAKE_FILES)('%s rejects a statement none of its fragments match', (file) => {
    expect(readFileSync(join(__dirname, file), 'utf8')).toMatch(/throw new Error\(`unexpected query: /)
  })
})

// ── U12 ─────────────────────────────────────────────────────────────────────────────────────────
/** A `count(DISTINCT (…))` whose tuple names both `provider` and `corp_id`: a hand-written count of pull sources. */
function handWrittenSourceCounts(text: string): string[] {
  return [...text.matchAll(/count\s*\(\s*distinct\s*\(([^()]*)\)/gi)]
    .map((match) => match[1])
    .filter((tuple) => /\bprovider\b/.test(tuple) && /\bcorp_id\b/.test(tuple))
}
/** Whether an assembled statement counts pull sources: it reads `directory_integrations` and counts distinct `(provider, corp_id)`. */
function countsPullSources(sql: string): boolean {
  return /\b(?:FROM|JOIN)\s+directory_integrations\b/i.test(sql) && handWrittenSourceCounts(sql).length > 0
}
/** String and template literals of a source file that hold both conditions of an active pull source. */
function literalsWithBothConditions(file: string, text: string): number {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const literal = node.getText(source)
      if (/provider\s*<>\s*'local'/.test(literal) && /status\s*=\s*'active'/.test(literal)) count += 1
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

describe('U12 a pull source is counted in one place', () => {
  it('the scanners recognise a hand-written count and a hand-written pair of conditions', () => {
    expect(handWrittenSourceCounts('SELECT count(DISTINCT (x.provider, x.corp_id)) FROM directory_integrations x')).toHaveLength(1)
    expect(handWrittenSourceCounts('select COUNT ( distinct (\n  di.corp_id,\n  di.provider\n)) from directory_integrations di')).toHaveLength(1)
    expect(countsPullSources('SELECT count(DISTINCT (x.provider, x.corp_id)) FROM other_table x')).toBe(false)
    // An identity read that counts one person's open ids inside an enterprise is not a source count.
    expect(handWrittenSourceCounts('SELECT COUNT(DISTINCT identity.provider_open_id) FROM t identity WHERE identity.corp_id = a.corp_id')).toEqual([])
    expect(literalsWithBothConditions('x.ts', "const q = `SELECT 1 FROM t i WHERE i.provider <> 'local' AND i.status = 'active'`")).toBe(1)
    expect(literalsWithBothConditions('x.ts', "const q = `WHERE ${p} AND i.status = 'active'` // provider <> 'local'")).toBe(0)
  })

  it('no source file writes a count of distinct (provider, corp_id) by hand', () => {
    const offenders = SOURCES.filter(([, text]) => handWrittenSourceCounts(text).length > 0).map(([file]) => file)
    expect(offenders).toEqual([])
  })

  it('the source key and the source predicate are used only by the rule module and the resolver', () => {
    const users = SOURCES
      .filter(([, text]) => /\bpullSourceKeySql\(|\bPULL_SOURCE_KEY_SQL\b|\bpullSourcePredicateSql\(|\bPULL_SOURCE_PREDICATE_SQL\b|\bCOUNT_ACTIVE_PULL_SOURCES_SQL\b/.test(text))
      .map(([file]) => file)
    expect(users).toEqual([LEAF_FILE, RESOLVER_FILE])
    expect(srcFile(RESOLVER_FILE)).toMatch(/from '\.\.\/directory\/pull-source-rule'/)
  })

  it('the statements that count pull sources are the leaf count and the probe, all assembled from the fragments', () => {
    const exported = [...Object.values(leaf), ...Object.values(resolverModule), PROBE_KERNEL, PROBE_SCOPED]
      .filter((value): value is string => typeof value === 'string')
      .filter(countsPullSources)
    expect([...new Set(exported)].sort()).toEqual([COUNT_ACTIVE_PULL_SOURCES_SQL, PROBE_KERNEL, PROBE_SCOPED].sort())
    for (const sql of exported) {
      expect(sql).toContain(pullSourceKeySql('i'))
      expect(sql).toContain(pullSourcePredicateSql('i'))
    }
    for (const sql of [APPROVAL_ROUTING_CANDIDATES_SQL, APPROVAL_ROUTING_PULL_TYPE_ROWS_SQL, NON_ACTIVE_PULL_SOURCE_LINKED_ACCOUNT_COUNT_SQL, APPROVAL_ROUTING_POLICY_EXISTS_SQL]) {
      expect(countsPullSources(sql)).toBe(false)
    }
  })

  it('the two conditions of an active pull source stand together in a closed list of statements', () => {
    const carriers = Object.fromEntries(
      SOURCES.map(([file, text]): [string, number] => [file, literalsWithBothConditions(file, text)]).filter(([, count]) => count > 0),
    )
    // The binding reconciliation filters bindings by their remote integration row; it counts no source.
    expect(carriers).toEqual({ 'directory/department-binding-reconciliation.ts': 3 })
  })
})

// ── U14 ─────────────────────────────────────────────────────────────────────────────────────────
describe('U14 one routing-policy error class', () => {
  it('the resolver exports the class of the rule module', () => {
    expect(resolverModule.ApprovalRoutingPolicyError).toBe(leaf.ApprovalRoutingPolicyError)
    expect(new resolverModule.ApprovalRoutingPolicyError('x')).toBeInstanceOf(leaf.ApprovalRoutingPolicyError)
  })

  it('the class is defined in the rule module only', () => {
    const definers = SOURCES.filter(([, text]) => /class\s+ApprovalRoutingPolicyError\b/.test(text)).map(([file]) => file)
    expect(definers).toEqual([LEAF_FILE])
    expect(srcFile(RESOLVER_FILE)).not.toMatch(/class\s+ApprovalRoutingPolicyError\b/)
    expect(srcFile(RESOLVER_FILE)).toMatch(/^export \{ ApprovalRoutingPolicyError \}$/m)
  })

  it('the service and the routes take the class from the resolver', () => {
    const users = SOURCES.filter(([file, text]) => file !== LEAF_FILE && /\bApprovalRoutingPolicyError\b/.test(text)).map(([file]) => file)
    expect(users).toEqual([
      'routes/admin-directory-routing-policy.ts',
      'routes/approvals.ts',
      RESOLVER_FILE,
      'services/ApprovalProductService.ts',
    ])
    expect(srcFile('services/ApprovalProductService.ts')).toMatch(/import \{[^}]*\bApprovalRoutingPolicyError\b[^}]*\} from '\.\/ApprovalDirectoryOrg'/)
    expect(srcFile('routes/approvals.ts')).toMatch(/import \{[^}]*\bApprovalRoutingPolicyError\b[^}]*\} from '\.\.\/services\/ApprovalDirectoryOrg'/)
    expect(srcFile('routes/admin-directory-routing-policy.ts')).toMatch(/import \{[^}]*\bApprovalRoutingPolicyError\b[^}]*\} from '\.\.\/services\/ApprovalDirectoryOrg'/)
    const fromLeaf = SOURCES
      .filter(([, text]) => /import \{[^}]*\bApprovalRoutingPolicyError\b[^}]*\} from '[^']*pull-source-rule'/.test(text))
      .map(([file]) => file)
    expect(fromLeaf).toEqual([RESOLVER_FILE])
  })
})

// ── status block ────────────────────────────────────────────────────────────────────────────────
describe('approval routing status block', () => {
  function fake(answers: { count?: unknown; policy?: Row[]; candidates?: Row[]; pullTypeRows?: Row[]; linked?: unknown; failOn?: string }) {
    const statements: string[] = []
    const query = async (sql: string, params?: unknown[]): Promise<{ rows: Row[] }> => {
      statements.push(sql)
      expect(params).toEqual(['org-a'])
      if (answers.failOn === sql) throw new Error('read failed')
      if (sql === COUNT_ACTIVE_PULL_SOURCES_SQL) return { rows: answers.count === undefined ? [] : [{ pull_source_count: answers.count }] }
      if (sql === APPROVAL_ROUTING_POLICY_EXISTS_SQL) return { rows: answers.policy ?? [] }
      if (sql === APPROVAL_ROUTING_CANDIDATES_SQL) return { rows: answers.candidates ?? [] }
      if (sql === APPROVAL_ROUTING_PULL_TYPE_ROWS_SQL) return { rows: answers.pullTypeRows ?? [] }
      if (sql === NON_ACTIVE_PULL_SOURCE_LINKED_ACCOUNT_COUNT_SQL) return { rows: answers.linked === undefined ? [] : [{ linked_account_count: answers.linked }] }
      throw new Error(`unexpected statement: ${sql.slice(0, 60)}`)
    }
    return { statements, query }
  }

  it('reports the data judgement whatever the switch says, and the switch separately', async () => {
    const answers = { count: 2, linked: 0, candidates: [{ integration_id: 'int-1', provider: 'dingtalk', name: 'Label', status: 'active', corp_id: 'never-read' }] }

    const off = await readApprovalRoutingStatus(fake(answers).query, 'org-a')
    process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED] = 'true'
    const on = await readApprovalRoutingStatus(fake(answers).query, 'org-a')

    expect(off).toEqual({
      enforced: false,
      hasPolicy: false,
      activePullSourceCount: 2,
      policyRequired: true,
      candidates: [{ integrationId: 'int-1', provider: 'dingtalk', name: 'Label', status: 'active' }],
      sameCorpGroups: [],
      nonActivePullSourceLinkedAccountCount: 0,
    })
    expect(on).toEqual({ ...off, enforced: true })
  })

  it('reads the rule judgement first, then the three other statements, each once', async () => {
    const { statements, query } = fake({ count: 2, linked: 0 })

    await readApprovalRoutingStatus(query, 'org-a')

    expect(statements).toEqual([
      COUNT_ACTIVE_PULL_SOURCES_SQL,
      APPROVAL_ROUTING_POLICY_EXISTS_SQL,
      APPROVAL_ROUTING_CANDIDATES_SQL,
      APPROVAL_ROUTING_PULL_TYPE_ROWS_SQL,
      NON_ACTIVE_PULL_SOURCE_LINKED_ACCOUNT_COUNT_SQL,
    ])
  })

  it('reports a rule judgement passed in by the caller and does not read it again', async () => {
    const { statements, query } = fake({ count: 0, linked: 0 })

    const block = await readApprovalRoutingStatus(query, 'org-a', { required: true, sourceCount: 2, hasPolicy: false })

    expect(block).toMatchObject({ hasPolicy: false, activePullSourceCount: 2, policyRequired: true })
    expect(statements).toEqual([
      APPROVAL_ROUTING_CANDIDATES_SQL,
      APPROVAL_ROUTING_PULL_TYPE_ROWS_SQL,
      NON_ACTIVE_PULL_SOURCE_LINKED_ACCOUNT_COUNT_SQL,
    ])
  })

  it('the admin GET reads the rule judgement once, hands it to the block and labels from it alone', () => {
    const route = srcFile('routes/admin-directory-routing-policy.ts')
    const handler = route.slice(route.indexOf("router.get('/', async"), route.indexOf("router.patch('/:purpose'"))

    expect(handler.match(/isApprovalRoutingPolicyRequired\(/g)).toHaveLength(1)
    expect(handler).toContain('ruleStatus = await isApprovalRoutingPolicyRequired(query, orgId)')
    expect(handler).toContain('approvalRouting = await readApprovalRoutingStatus(query, orgId, ruleStatus)')
    expect(handler).toContain('const approvalRoutingRefused = isApprovalRoutingRequirePolicyEnabled() && ruleStatus?.required === true')
    expect(handler).not.toMatch(/approvalRouting\??\.(policyRequired|enforced)/)
  })

  it('a policy or a single source means no policy is required', async () => {
    const governed = await readApprovalRoutingStatus(fake({ count: 3, policy: [{ present: 1 }], linked: 4 }).query, 'org-a')
    const single = await readApprovalRoutingStatus(fake({ count: 1, linked: '0' }).query, 'org-a')

    expect(governed).toMatchObject({ hasPolicy: true, activePullSourceCount: 3, policyRequired: false, nonActivePullSourceLinkedAccountCount: 4 })
    expect(single).toMatchObject({ hasPolicy: false, activePullSourceCount: 1, policyRequired: false })
  })

  it('rejects when the source count or the account count cannot be read, and when any read fails', async () => {
    await expect(readApprovalRoutingStatus(fake({ linked: 0 }).query, 'org-a')).rejects.toBeInstanceOf(PullSourceCountUnavailableError)
    await expect(readApprovalRoutingStatus(fake({ count: 2 }).query, 'org-a')).rejects.toBeInstanceOf(ApprovalRoutingStatusUnavailableError)
    await expect(readApprovalRoutingStatus(fake({ count: 2, linked: -1 }).query, 'org-a')).rejects.toBeInstanceOf(ApprovalRoutingStatusUnavailableError)
    await expect(readApprovalRoutingStatus(fake({ count: 2, linked: 'many' }).query, 'org-a')).rejects.toBeInstanceOf(ApprovalRoutingStatusUnavailableError)
    for (const failOn of [APPROVAL_ROUTING_POLICY_EXISTS_SQL, APPROVAL_ROUTING_CANDIDATES_SQL, APPROVAL_ROUTING_PULL_TYPE_ROWS_SQL, NON_ACTIVE_PULL_SOURCE_LINKED_ACCOUNT_COUNT_SQL]) {
      await expect(readApprovalRoutingStatus(fake({ count: 2, linked: 0, failOn }).query, 'org-a')).rejects.toThrow('read failed')
    }
    expect(new ApprovalRoutingStatusUnavailableError().message).not.toMatch(/\d/)
  })

  it('reads only tables that already exist, scoped to the organisation, and writes nothing', () => {
    for (const sql of [APPROVAL_ROUTING_CANDIDATES_SQL, APPROVAL_ROUTING_PULL_TYPE_ROWS_SQL, NON_ACTIVE_PULL_SOURCE_LINKED_ACCOUNT_COUNT_SQL]) {
      const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/g)].map((match) => match[1])
      expect(tables.every((table) => ['directory_integrations', 'directory_accounts', 'directory_account_links'].includes(table)), sql).toBe(true)
      expect(sql).toContain('i.org_id = $1')
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|LOCK)\b/i)
    }
    expect(APPROVAL_ROUTING_CANDIDATES_SQL).toContain("i.status = 'active'")
    expect(APPROVAL_ROUTING_CANDIDATES_SQL).not.toMatch(/corp_id|config/)
  })

  it('groups rows of one provider and enterprise and exposes counts and booleans only', () => {
    const verified = { appKey: 'key-1', corpName: 'Corp', appName: 'App', identityVerification: {
      corpId: 'corp-x', appKey: 'key-1', corpName: 'Corp', appName: 'App', appCorpId: 'corp-x', appCorpName: 'Corp',
      source: 'admin_console', checkedAt: '2026-10-30T00:00:00.000Z', checkedBy: 'administrator',
    } }
    const groups = groupSameCorpRows([
      { provider: 'dingtalk', corp_id: 'corp-x', config: verified },
      { provider: 'dingtalk', corp_id: 'corp-x', config: JSON.stringify({ appKey: 'key-2' }) },
      { provider: 'dingtalk', corp_id: 'corp-y', config: { appKey: 'key-3' } },
      { provider: 'wecom', corp_id: 'corp-x', config: { appKey: ' key-4 ' } },
      { provider: 'wecom', corp_id: 'corp-x', config: { appKey: 'key-4' } },
      { provider: 'wecom', corp_id: 'corp-x', config: null },
    ])

    expect(groups).toEqual([
      { provider: 'dingtalk', rowCount: 2, appKeysDiffer: true, identityStatuses: ['unverified', 'verified'] },
      { provider: 'wecom', rowCount: 3, appKeysDiffer: true, identityStatuses: ['unverified', 'unverified', 'unverified'] },
    ])
    expect(JSON.stringify(groups)).not.toMatch(/corp-x|key-/)
    expect(groupSameCorpRows([
      { provider: 'wecom', corp_id: 'corp-x', config: { appKey: ' key-4 ' } },
      { provider: 'wecom', corp_id: 'corp-x', config: { appKey: 'key-4' } },
    ])).toEqual([{ provider: 'wecom', rowCount: 2, appKeysDiffer: false, identityStatuses: ['unverified', 'unverified'] }])
  })
})
