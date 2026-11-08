import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

import {
  listLinkedDirectoryAccountIds,
  resolveActivationDirectorySource,
} from '../../src/auth/user-activate'

type SourceRow = Record<string, unknown>

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'

function sourceRow(overrides: SourceRow = {}): SourceRow {
  return {
    id: ACCOUNT_ID,
    account_active: true,
    integration_status: 'active',
    local_user_id: 'u1',
    link_status: 'linked',
    account_provider: 'dingtalk',
    integration_provider: 'dingtalk',
    account_corp_id: 'corp-1',
    integration_corp_id: 'corp-1',
    account_open_id: null,
    account_union_id: null,
    integration_org_id: 'org-src',
    ...overrides,
  }
}

function clientReturning(rows: SourceRow[]) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows }))
  return { client: { query }, query }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe('resolveActivationDirectorySource', () => {
  it('queries the explicit account path with only the account id as the parameter', async () => {
    const { client, query } = clientReturning([sourceRow()])
    const result = await resolveActivationDirectorySource(client, {
      userId: 'u1',
      directoryAccountId: ACCOUNT_ID,
    })
    expect(result).toEqual({ orgId: 'org-src', directoryAccountId: ACCOUNT_ID })
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]
    expect(params).toEqual([ACCOUNT_ID])
    expect(sql).toContain('WHERE da.id = $1')
    expect(sql).toContain('FOR SHARE OF di')
    expect(sql).not.toContain("l.local_user_id = $1")
  })

  it('trims the account id before use and returns the trimmed value', async () => {
    const { client, query } = clientReturning([sourceRow()])
    const result = await resolveActivationDirectorySource(client, {
      userId: 'u1',
      directoryAccountId: `  ${ACCOUNT_ID} `,
    })
    expect(query.mock.calls[0][1]).toEqual([ACCOUNT_ID])
    expect(result.directoryAccountId).toBe(ACCOUNT_ID)
  })

  it('accepts a non-DingTalk (local) account: no DingTalk eligibility is required', async () => {
    const { client } = clientReturning([
      sourceRow({
        account_provider: 'local',
        integration_provider: 'local',
        account_corp_id: null,
        integration_corp_id: null,
      }),
    ])
    await expect(
      resolveActivationDirectorySource(client, { userId: 'u1', directoryAccountId: ACCOUNT_ID }),
    ).resolves.toEqual({ orgId: 'org-src', directoryAccountId: ACCOUNT_ID })
  })

  it('accepts a DingTalk account whose corp ids disagree: no corp consistency is required', async () => {
    const { client } = clientReturning([
      sourceRow({ account_corp_id: 'corp-a', integration_corp_id: 'corp-b' }),
    ])
    await expect(
      resolveActivationDirectorySource(client, { userId: 'u1', directoryAccountId: ACCOUNT_ID }),
    ).resolves.toEqual({ orgId: 'org-src', directoryAccountId: ACCOUNT_ID })
  })

  it('forwards the requested org: a matching value is confirmed', async () => {
    const { client } = clientReturning([sourceRow()])
    await expect(
      resolveActivationDirectorySource(client, {
        userId: 'u1',
        directoryAccountId: ACCOUNT_ID,
        requestedOrgId: ' org-src ',
      }),
    ).resolves.toEqual({ orgId: 'org-src', directoryAccountId: ACCOUNT_ID })
  })

  it('forwards the requested org: a different value is refused with ACTIVATE_ORG_MISMATCH', async () => {
    const { client } = clientReturning([sourceRow()])
    expect(
      await codeOf(
        resolveActivationDirectorySource(client, {
          userId: 'u1',
          directoryAccountId: ACCOUNT_ID,
          requestedOrgId: 'org-other',
        }),
      ),
    ).toBe('ACTIVATE_ORG_MISMATCH')
  })

  it('treats a blank requested org as not supplied', async () => {
    const { client } = clientReturning([sourceRow()])
    await expect(
      resolveActivationDirectorySource(client, {
        userId: 'u1',
        directoryAccountId: ACCOUNT_ID,
        requestedOrgId: '   ',
      }),
    ).resolves.toEqual({ orgId: 'org-src', directoryAccountId: ACCOUNT_ID })
  })

  it('refuses a blank account id without querying', async () => {
    for (const directoryAccountId of ['', '   ', undefined as unknown as string]) {
      const { client, query } = clientReturning([sourceRow()])
      expect(
        await codeOf(resolveActivationDirectorySource(client, { userId: 'u1', directoryAccountId })),
      ).toBe('ACTIVATE_SOURCE_MISSING')
      expect(query).not.toHaveBeenCalled()
    }
  })

  const passThrough: Array<[string, SourceRow[], string]> = [
    ['account not found', [], 'ACTIVATE_SOURCE_MISSING'],
    ['account without a link', [sourceRow({ link_status: null, local_user_id: null })], 'ACTIVATE_SOURCE_MISSING'],
    ['account linked to another user', [sourceRow({ local_user_id: 'u2' })], 'ACTIVATE_LINK_MISMATCH'],
    ['account out of service', [sourceRow({ account_active: false })], 'ACTIVATE_SOURCE_INACTIVE'],
    ['integration inactive', [sourceRow({ integration_status: 'inactive' })], 'ACTIVATE_INTEGRATION_INACTIVE'],
    ['integration without an org', [sourceRow({ integration_org_id: '  ' })], 'ACTIVATE_SOURCE_INELIGIBLE'],
  ]
  it.each(passThrough)('passes the closed-set error code through unchanged: %s', async (_name, rows, code) => {
    const { client } = clientReturning(rows)
    const error = await resolveActivationDirectorySource(client, {
      userId: 'u1',
      directoryAccountId: ACCOUNT_ID,
    }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error?.code).toBe(code)
  })

  it('propagates a query failure without rewriting it', async () => {
    const failure = Object.assign(new Error('connection lost'), { code: '57P01' })
    const client = { query: vi.fn(async () => { throw failure }) }
    await expect(
      resolveActivationDirectorySource(client, { userId: 'u1', directoryAccountId: ACCOUNT_ID }),
    ).rejects.toBe(failure)
  })
})

describe('listLinkedDirectoryAccountIds', () => {
  it('reads only exact linked rows of the given user in a stable order', async () => {
    const { client, query } = clientReturning([
      { directory_account_id: 'da-1' },
      { directory_account_id: 'da-2' },
    ])
    await expect(listLinkedDirectoryAccountIds(client, 'u1')).resolves.toEqual(['da-1', 'da-2'])
    const [sql, params] = query.mock.calls[0]
    expect(params).toEqual(['u1'])
    expect(sql).toContain('FROM directory_account_links')
    expect(sql).toContain('local_user_id = $1')
    expect(sql).toContain("link_status = 'linked'")
    expect(sql).toContain('ORDER BY directory_account_id')
    expect(sql).not.toMatch(/FOR\s+(SHARE|UPDATE)/i)
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i)
  })

  it('returns an empty list when nothing is linked', async () => {
    const { client } = clientReturning([])
    await expect(listLinkedDirectoryAccountIds(client, 'u1')).resolves.toEqual([])
  })
})

describe('export surface has no production caller', () => {
  const SRC_ROOT = resolve(__dirname, '../../src')
  const OWNER_FILE = resolve(SRC_ROOT, 'auth/user-activate.ts')
  const NAMES = ['resolveActivationDirectorySource', 'listLinkedDirectoryAccountIds']

  function listSourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...listSourceFiles(full))
      else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|vue)$/.test(entry)) out.push(full)
    }
    return out
  }

  it('scans a non-trivial source tree', () => {
    expect(listSourceFiles(SRC_ROOT).length).toBeGreaterThan(50)
    expect(readFileSync(OWNER_FILE, 'utf8')).toContain('export async function resolveActivationDirectorySource')
  })

  it.each(NAMES)('%s is not referenced by any other file under src', (name) => {
    const referrers = listSourceFiles(SRC_ROOT)
      .filter((file) => file !== OWNER_FILE)
      .filter((file) => readFileSync(file, 'utf8').includes(name))
    expect(referrers).toEqual([])
  })

  it.each(NAMES)('%s is not called inside its own file', (name) => {
    const sourceFile = ts.createSourceFile(
      OWNER_FILE,
      readFileSync(OWNER_FILE, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const references: number[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === name) {
        const parent = node.parent
        const isDeclarationName = ts.isFunctionDeclaration(parent) && parent.name === node
        if (!isDeclarationName) references.push(node.getStart())
      }
      node.forEachChild(visit)
    }
    visit(sourceFile)
    expect(references).toEqual([])
  })
})
