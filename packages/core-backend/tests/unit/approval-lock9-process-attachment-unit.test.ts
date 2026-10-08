/**
 * Lock-9 (approver process attachments) — no-DB gates. Auto-collected: `tests/unit/*.test.ts` is
 * Vitest's default include glob (no workflow edit needed, `approval-ci-coverage-enumeration.test.ts`
 * T1's own docstring). Real-DB gates (G-1, G-2, G-4 through-production-wiring, G-5, G-6, G-7, G-8,
 * G-9, G-11, G-12, G-13, G-14, G-16) live in
 * tests/integration/approval-lock9-process-attachments-realdb.db.test.ts.
 *
 * Reference: docs/development/approval-lock9-handler-process-attachments-20260819.md (RATIFIED,
 * §4.1 amendment applied).
 */
import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { usePinnedServer } from '../utils/pinned-server'
import { createApprovalAttachmentRouter } from '../../src/routes/approval-attachments'
import { authorizeAttachmentDownload, type AttachmentRowForAuth, type DownloadAuthChecks } from '../../src/services/approval-attachment-storage'
import { APPROVAL_ACTION_TYPES } from '../../src/types/approval-product'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
function read(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8')
}

const pinned = usePinnedServer()
function serve(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

// =================================================================================================
// G-10 — "No new action verb": APPROVAL_ACTION_TYPES is byte-identical, exact-set (not superset).
// =================================================================================================
describe('G-10: no new action verb', () => {
  test('APPROVAL_ACTION_TYPES is EXACTLY the 9-member ratified union, in order', () => {
    expect([...APPROVAL_ACTION_TYPES]).toEqual([
      'approve',
      'reject',
      'transfer',
      'revoke',
      'comment',
      'return',
      'add_sign',
      'reduce_sign',
      'handle',
    ])
  })

  test('positive control: the union is not merely a SUPERSET check — a 10th member would fail the exact-set assertion above', () => {
    const withExtra = [...APPROVAL_ACTION_TYPES, 'attach']
    expect(withExtra).not.toEqual([...APPROVAL_ACTION_TYPES])
    expect(withExtra.length).toBe(APPROVAL_ACTION_TYPES.length + 1)
  })

  test('standing census: p26-approval-assignment-classification.cjs pins the SAME union verbatim and in order (cross-check)', () => {
    const src = read('scripts/attendance/w4c0-dml-inventory/p26-approval-assignment-classification.cjs')
    const match = /P26_GENERIC_ACTIONS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src)
    expect(match).toBeTruthy()
    const pinned9 = [...(match![1].matchAll(/'([a-z_]+)'/g))].map((m) => m[1])
    expect(pinned9).toEqual([...APPROVAL_ACTION_TYPES])
  })
})

// =================================================================================================
// G-3 — download hidden-gate skip is EXPLICIT (bind_kind-selected), not accidental.
// =================================================================================================
describe('G-3: authorizeAttachmentDownload hidden-gate skip is bind_kind-selected', () => {
  function makeChecks(hidden: boolean): DownloadAuthChecks & { hiddenCalls: number } {
    let hiddenCalls = 0
    return {
      isInstanceParticipant: async () => true,
      isFieldHiddenAtActiveNode: async () => {
        hiddenCalls += 1
        return hidden
      },
      get hiddenCalls() {
        return hiddenCalls
      },
    }
  }

  test('a process row (bind_kind="process") downloads with NO hidden-field evaluation at all', async () => {
    const checks = makeChecks(true) // even if the seam WOULD say hidden, it must never be asked
    const row: AttachmentRowForAuth = {
      status: 'bound',
      uploaderId: 'approver1',
      instanceId: 'inst1',
      fieldId: null,
      orgId: 'org1',
      bindKind: 'process',
    }
    const result = await authorizeAttachmentDownload(row, 'viewer1', 'org1', checks)
    expect(result).toEqual({ ok: true })
    expect(checks.hiddenCalls).toBe(0) // the skip is real, not a lucky pass
  })

  test('positive control: a form_field row at a HIDDEN node still serves NO bytes — gate 2 is intact for forms', async () => {
    const checks = makeChecks(true)
    const row: AttachmentRowForAuth = {
      status: 'bound',
      uploaderId: 'requester1',
      instanceId: 'inst1',
      fieldId: 'files',
      orgId: 'org1',
      bindKind: 'form_field',
    }
    const result = await authorizeAttachmentDownload(row, 'viewer1', 'org1', checks)
    expect(result).toEqual({ ok: false, code: 'hidden' })
    expect(checks.hiddenCalls).toBe(1) // the form path still asks
  })

  test('an un-widened row (bindKind absent) is treated as form_field — falls toward the EXISTING gate, never the skip', async () => {
    const checks = makeChecks(true)
    const row: AttachmentRowForAuth = {
      status: 'bound',
      uploaderId: 'requester1',
      instanceId: 'inst1',
      fieldId: 'files',
      orgId: 'org1',
      // bindKind intentionally omitted
    }
    const result = await authorizeAttachmentDownload(row, 'viewer1', 'org1', checks)
    expect(result).toEqual({ ok: false, code: 'hidden' })
    expect(checks.hiddenCalls).toBe(1)
  })
})

// =================================================================================================
// G-15 — /refs metadata skip is the SAME bind_kind branch, not a re-derived "hidden.has(null)" pass.
// =================================================================================================
describe('G-15: /refs bound-metadata skip is bind_kind-selected', () => {
  function makeRefsApp(rows: Array<{ id: string; field_id: string | null; file_name: string; size_bytes: number; mime_type: string; status: string; scan_state: string; bind_kind: string }>) {
    let hiddenCalls = 0
    const hiddenCallArgs: Array<{ instanceId: string; fieldId: string }> = []
    const db = {
      query: async (sql: string) => {
        if (sql.trim().startsWith('SELECT id, field_id')) {
          return { rows, rowCount: rows.length }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    const router = createApprovalAttachmentRouter({
      db,
      store: { put: async () => {}, get: async () => Buffer.alloc(0), delete: async () => false },
      authChecks: {
        isInstanceParticipant: async () => true,
        isFieldHiddenAtActiveNode: async (instanceId, fieldId) => {
          hiddenCalls += 1
          hiddenCallArgs.push({ instanceId, fieldId })
          return true // even if the seam says hidden, a process row must never even ask
        },
      },
      viewerId: () => 'viewer1',
      orgId: () => 'org1',
      hasApprovalsRead: () => true,
      hasApprovalsWrite: () => true,
      resolveAttachmentField: async () => true,
      templateVisible: async () => true,
      env: { APPROVAL_ATTACHMENTS_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv,
    })
    const app = express()
    if (router) app.use(router)
    return { app, get hiddenCalls() { return hiddenCalls }, hiddenCallArgs }
  }

  test('a bound process row renders fileName with NO hidden-field evaluation', async () => {
    // `hiddenCalls` is a live getter — read it after the request, never destructured early.
    const built = makeRefsApp([
      { id: 'att_p1', field_id: null, file_name: 'evidence.pdf', size_bytes: 100, mime_type: 'application/pdf', status: 'bound', scan_state: 'clean', bind_kind: 'process' },
    ])
    const res = await serve(built.app)
      .post('/api/approval/attachments/refs')
      .send({ instanceId: 'inst1', ids: ['att_p1'] })
    expect(res.status).toBe(200)
    expect(res.body.attachments).toEqual([
      { id: 'att_p1', tombstone: false, fieldId: null, fileName: 'evidence.pdf', sizeBytes: 100, mimeType: 'application/pdf', downloadUrl: '/api/approval/attachments/att_p1/download' },
    ])
    expect(built.hiddenCalls).toBe(0)
  })

  test('positive control: a form_field row at a hidden field renders NO metadata (absent, not tombstone) — gate 2 intact', async () => {
    // NOTE: `hiddenCalls` is a live getter — read it AFTER the request, never destructured early
    // (destructuring snapshots the getter's value at call time, before any request runs).
    const built = makeRefsApp([
      { id: 'att_f1', field_id: 'files', file_name: 'form.pdf', size_bytes: 50, mime_type: 'application/pdf', status: 'bound', scan_state: 'clean', bind_kind: 'form_field' },
    ])
    const res = await serve(built.app)
      .post('/api/approval/attachments/refs')
      .send({ instanceId: 'inst1', ids: ['att_f1'] })
    expect(res.status).toBe(200)
    expect(res.body.attachments).toEqual([]) // hidden ⇒ absent
    expect(built.hiddenCalls).toBe(1)
  })

  test('mixed batch: the process row skips while the sibling form_field row is still gated — one hidden call, keyed correctly', async () => {
    const built = makeRefsApp([
      { id: 'att_p1', field_id: null, file_name: 'evidence.pdf', size_bytes: 100, mime_type: 'application/pdf', status: 'bound', scan_state: 'clean', bind_kind: 'process' },
      { id: 'att_f1', field_id: 'files', file_name: 'form.pdf', size_bytes: 50, mime_type: 'application/pdf', status: 'bound', scan_state: 'clean', bind_kind: 'form_field' },
    ])
    const res = await serve(built.app)
      .post('/api/approval/attachments/refs')
      .send({ instanceId: 'inst1', ids: ['att_p1', 'att_f1'] })
    expect(res.status).toBe(200)
    expect(built.hiddenCalls).toBe(1)
    expect(built.hiddenCallArgs).toEqual([{ instanceId: 'inst1', fieldId: 'files' }])
  })
})

// =================================================================================================
// G-4 / G-16 absence leg — mechanical grep: no NEW participant/readability predicate function was
// minted anywhere in the attachment surfaces. The ONE real predicate is canReadApprovalInstance;
// the DI seam member NAME `isInstanceParticipant` is kept (OD-S1-16) but has no standalone function
// body of its own anywhere in these files — only interface declarations and the ONE wiring closure
// in approval-attachment-runtime.ts that forwards to canReadApprovalInstance.
// =================================================================================================
describe('G-4 / G-16 absence leg: no new participant predicate minted', () => {
  const SCOPED_FILES = [
    'packages/core-backend/src/services/approval-attachment-storage.ts',
    'packages/core-backend/src/services/approval-attachment-runtime.ts',
    'packages/core-backend/src/routes/approval-attachments.ts',
    'packages/core-backend/src/services/approval-instance-readability.ts',
  ]

  test('no standalone `function isInstanceParticipant(...)` / `function *Participant*(...)` exists — only the interface member and the ONE wiring closure', () => {
    for (const relPath of SCOPED_FILES) {
      const src = read(relPath)
      // A standalone function/const declaration (not an interface member, not a wiring closure calling
      // canReadApprovalInstance) would match this. The interface member is `isInstanceParticipant(...)`
      // with NO `function`/`const`/`=>` keyword immediately before it on the same construct.
      const standaloneFnDecl = /\b(?:function\s+isInstanceParticipant|const\s+isInstanceParticipant\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>\s*\{)/
      const matches = [...src.matchAll(new RegExp(standaloneFnDecl, 'g'))]
      // The ONE allowed wiring closure is a single-expression arrow (canReadApprovalInstance(...)),
      // never a `{ ... }` block body — a block body would be room to grow a second predicate.
      expect(matches, `${relPath}: unexpected standalone isInstanceParticipant function/const body`).toHaveLength(0)
    }
  })

  test('the ONE production wiring line binds isInstanceParticipant to canReadApprovalInstance, single-expression, no block body', () => {
    const src = read('packages/core-backend/src/services/approval-attachment-runtime.ts')
    expect(src).toMatch(/isInstanceParticipant:\s*\(viewerId,\s*instanceId\)\s*=>\s*canReadApprovalInstance\(db,\s*viewerId,\s*instanceId\)/)
  })

  test('exactly ONE readReadability-predicate export exists in approval-instance-readability.ts: canReadApprovalInstance', () => {
    const src = read('packages/core-backend/src/services/approval-instance-readability.ts')
    const exportedFns = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1])
    expect(exportedFns).toContain('canReadApprovalInstance')
    // No sibling export named like a second admission predicate (e.g. canReadApprovalProcessAttachment).
    const suspicious = exportedFns.filter((name) => name !== 'canReadApprovalInstance' && /read|participant|admission/i.test(name))
    expect(suspicious).toEqual([])
  })
})

// =================================================================================================
// Interface-widening safety: bindKind / fieldId widen SAFELY (optional/nullable), matching the D-5 /
// §5.9 disclosure — a mechanical proof that the six pre-existing literal-object test files this
// slice must not break still type-check (they run in this same suite / sibling suites; this test
// documents the CONTRACT directly rather than relying on tsc alone).
// =================================================================================================
describe('§5.9 interface widening safety', () => {
  test('AttachmentRowForAuth accepts a literal with NO bindKind (existing test shape) and a literal WITH it', () => {
    const legacy: AttachmentRowForAuth = { status: 'bound', uploaderId: 'u1', instanceId: 'i1', fieldId: 'f1', orgId: 'org1' }
    const widened: AttachmentRowForAuth = { status: 'bound', uploaderId: 'u1', instanceId: 'i1', fieldId: null, orgId: 'org1', bindKind: 'process' }
    expect(legacy.bindKind).toBeUndefined()
    expect(widened.fieldId).toBeNull()
  })

  test('createApprovalAttachmentRouter accepts deps WITHOUT hasApprovalsAct/actorHasActiveSeat (existing test literal shape) and treats their absence as DENY', async () => {
    const router = createApprovalAttachmentRouter({
      db: { query: async () => ({ rows: [], rowCount: 0 }) },
      store: { put: async () => {}, get: async () => Buffer.alloc(0), delete: async () => false },
      authChecks: { isInstanceParticipant: async () => true, isFieldHiddenAtActiveNode: async () => false },
      viewerId: () => 'u1',
      orgId: () => 'org1',
      hasApprovalsRead: () => true,
      hasApprovalsWrite: () => true,
      // hasApprovalsAct / actorHasActiveSeat intentionally OMITTED
      resolveAttachmentField: async () => true,
      templateVisible: async () => true,
      env: { APPROVAL_ATTACHMENTS_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv,
    })
    const app = express()
    if (router) app.use(router)
    const res = await serve(app)
      .post('/api/approval/attachments/process')
      .field('stagedInstanceId', 'inst1')
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(403) // absent dep ⇒ deny, fail-closed, never a widened allow
    expect(res.body).toEqual({ error: 'forbidden' })
  })
})

// Sanity: the migrations directory read by G-14 is non-empty and readdirSync resolves — a scan
// negative control mirroring approval-ci-coverage-enumeration.test.ts's own repo-root check.
describe('scan negative control', () => {
  test('migrations directory resolves and is non-empty', () => {
    const dir = join(repoRoot, 'packages/core-backend/src/db/migrations')
    expect(readdirSync(dir).length).toBeGreaterThan(100)
  })
})

// =================================================================================================
// G-9 — "The form-field refusal stays fenced": a handler writing an attachment-TYPED form field is
// STILL 400 APPROVAL_FIELD_WRITE_UNSUPPORTED_TYPE. Flag-independent (the fence sits in the
// fieldWrites/handle path, entirely separate from APPROVAL_ATTACHMENTS_ENABLED) — no env plumbing.
// Calls the REAL private method (TS privacy is compile-time only) with a fake client — mirrors the
// proven Lock-8 L8-A gate P2-2 pattern (approval-lock8-explanation-field.test.ts) exactly.
// =================================================================================================
describe('G-9: applyHandlerFieldWrites still refuses an attachment-typed field write', () => {
  const formSchema = {
    fields: [
      { id: 'files', type: 'attachment', label: '附件' },
      { id: 'reason', type: 'text', label: '事由' },
    ],
  }
  const runtimeGraph = { nodes: [{ key: 'h1', type: 'handler', config: {} }] } as never

  async function callApplyHandlerFieldWrites(fieldWrites: Record<string, unknown>) {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()
    const spy = { count: 0 }
    const wrappedClient = {
      query: async (): Promise<{ rows: unknown[]; rowCount: number }> => {
        spy.count += 1
        return { rows: [], rowCount: 0 }
      },
    }
    const result = (service as unknown as {
      applyHandlerFieldWrites(
        client: { query: typeof wrappedClient.query },
        instanceId: string,
        nodeKey: string,
        rawWrites: unknown,
        context: { runtimeGraph: unknown; formSchema: typeof formSchema; frozenSnapshot: Record<string, unknown> },
      ): Promise<{ changedFieldIds: string[]; revisions: unknown[] }>
    }).applyHandlerFieldWrites(wrappedClient, 'inst_1', 'h1', fieldWrites, { runtimeGraph, formSchema, frozenSnapshot: {} })
    return { result, spy }
  }

  test('an attachment-typed field write is refused 400 APPROVAL_FIELD_WRITE_UNSUPPORTED_TYPE, with ZERO UPDATE calls (the gap line at APS is untouched)', async () => {
    const { result, spy } = await callApplyHandlerFieldWrites({ files: ['att_x'] })
    await expect(result).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_FIELD_WRITE_UNSUPPORTED_TYPE' })
    expect(spy.count).toBe(0)
  })

  test('positive control (same fixture): an ORDINARY field write on the sibling node reaches the UPDATE — the fence is TYPE-selected, not a dead path', async () => {
    const { result, spy } = await callApplyHandlerFieldWrites({ reason: 'contrast case' })
    await expect(result).resolves.toMatchObject({ changedFieldIds: ['reason'] })
    expect(spy.count).toBe(1)
  })
})
