/**
 * P3-3 (contract §4 test C): server ⟷ FE parity guard for the approval form-draft schema-drift
 * signature.
 *
 * Why this file exists (feedback_mock_is_not_the_contract.md — "client filter must mirror server
 * predicate, pin BOTH directions"; precedent: field-always-readonly-web-parity.test.ts /
 * formula-catalog-web-parity.test.ts in this same directory): the server's
 * `formSchemaSignature` (packages/core-backend/src/services/approval-form-draft-service.ts) is a
 * hand-written reimplementation of the client's `formSchemaSignature`
 * (apps/web/src/approvals/formDraft.ts). A same-PR mirror exercised only against ITS OWN hardcoded
 * case table (apps/web/tests/approval-form-draft.test.ts) is a wire-vs-fixture blind spot — this
 * test closes it from the side that CAN see both: packages/core-backend has no reason NOT to
 * import its own function live, and the FE module has ZERO runtime dependencies beyond a type-only
 * import, so it is a plain, side-effect-free TS module a Node/vitest environment can import
 * directly via a relative path (no @metasheet/core-backend -> apps/web workspace dependency
 * needed, no bundler). Both signature functions are therefore LIVE here, not copies — a change to
 * EITHER side that breaks byte-parity turns this test red. "Prove it against the real client
 * function, not a reimplementation" (contract §4 C) is exactly this import, not a copy of the
 * algorithm re-typed into this file's fixtures.
 *
 * This runs in the required `plugin-tests.yml` gate's "Run core-backend tests" step (default
 * `vitest` run, tests/unit/** is not in the DB-gated exclude list) — no hand-kept CI filter needed.
 */
import { describe, expect, it } from 'vitest'
import { formSchemaSignature as formSchemaSignatureServer } from '../../src/services/approval-form-draft-service'
// LIVE import of the FE function across the package boundary — see file header. Relative path, not
// a workspace package import: apps/web is not (and must not become) a runtime dependency of
// @metasheet/core-backend.
// eslint-disable-next-line import/no-relative-packages
import { formSchemaSignature as formSchemaSignatureFE } from '../../../../apps/web/src/approvals/formDraft'
import type { FormSchema } from '../../../../apps/web/src/types/approval'

describe('approval form-draft schema signature — server/FE byte-parity (P3-3 contract §4 C)', () => {
  it('canary: both live functions actually loaded (anti-vacuous-fixture guard)', () => {
    expect(typeof formSchemaSignatureServer).toBe('function')
    expect(typeof formSchemaSignatureFE).toBe('function')
  })

  it('empty schema: both produce the empty string', () => {
    const schema = { fields: [] } as FormSchema
    expect(formSchemaSignatureServer(schema)).toBe('')
    expect(formSchemaSignatureServer(schema)).toBe(formSchemaSignatureFE(schema))
  })

  it('simple schema: byte-identical output', () => {
    const schema: FormSchema = {
      fields: [
        { id: 'amount', type: 'number', label: '金额' },
        { id: 'reason', type: 'text', label: '事由' },
      ],
    } as FormSchema
    const server = formSchemaSignatureServer(schema)
    const fe = formSchemaSignatureFE(schema)
    expect(server).toBe(fe)
    expect(server).toBe('amount:number|reason:text')
  })

  it('field REORDER: still byte-identical on both sides (order-independence proven on the LIVE fns, not asserted in prose)', () => {
    const forward: FormSchema = {
      fields: [
        { id: 'a', type: 'text', label: 'A' },
        { id: 'b', type: 'number', label: 'B' },
        { id: 'c', type: 'select', label: 'C' },
      ],
    } as FormSchema
    const reversed: FormSchema = { fields: [...forward.fields].reverse() } as FormSchema
    expect(formSchemaSignatureServer(forward)).toBe(formSchemaSignatureServer(reversed))
    expect(formSchemaSignatureFE(forward)).toBe(formSchemaSignatureFE(reversed))
    expect(formSchemaSignatureServer(forward)).toBe(formSchemaSignatureFE(forward))
  })

  it('attachment fields EXCLUDED on both sides', () => {
    const schema: FormSchema = {
      fields: [
        { id: 'amount', type: 'number', label: '金额' },
        { id: 'files', type: 'attachment', label: '附件' },
      ],
    } as FormSchema
    const server = formSchemaSignatureServer(schema)
    const fe = formSchemaSignatureFE(schema)
    expect(server).not.toContain('attachment')
    expect(server).toBe(fe)
    expect(server).toBe('amount:number')
  })

  it('record-link pins baseId:sheetId identically on both sides', () => {
    const schema: FormSchema = {
      fields: [{
        id: 'linked',
        type: 'record-link',
        label: '关联',
        props: { baseId: 'base-a', sheetId: 'sheet-a' },
      }],
    } as FormSchema
    const server = formSchemaSignatureServer(schema)
    const fe = formSchemaSignatureFE(schema)
    expect(server).toBe('linked:record-link:base-a:sheet-a')
    expect(server).toBe(fe)
  })

  it('POSITIVE CONTROL — a genuine type change DOES change the signature (both sides), proving this is a real comparison, not a vacuously-passing one', () => {
    const before: FormSchema = { fields: [{ id: 'x', type: 'text', label: 'X' }] } as FormSchema
    const after: FormSchema = { fields: [{ id: 'x', type: 'number', label: 'X' }] } as FormSchema
    expect(formSchemaSignatureServer(before)).not.toBe(formSchemaSignatureServer(after))
    expect(formSchemaSignatureFE(before)).not.toBe(formSchemaSignatureFE(after))
    // Both sides still agree on EACH schema individually.
    expect(formSchemaSignatureServer(before)).toBe(formSchemaSignatureFE(before))
    expect(formSchemaSignatureServer(after)).toBe(formSchemaSignatureFE(after))
  })

  it('record-link REPIN (sheetId change) DOES change the signature on both sides', () => {
    const pinnedA: FormSchema = {
      fields: [{ id: 'linked', type: 'record-link', label: '关联', props: { baseId: 'base-a', sheetId: 'sheet-a' } }],
    } as FormSchema
    const pinnedB: FormSchema = {
      fields: [{ id: 'linked', type: 'record-link', label: '关联', props: { baseId: 'base-a', sheetId: 'sheet-b' } }],
    } as FormSchema
    expect(formSchemaSignatureServer(pinnedA)).not.toBe(formSchemaSignatureServer(pinnedB))
    expect(formSchemaSignatureServer(pinnedA)).toBe(formSchemaSignatureFE(pinnedA))
    expect(formSchemaSignatureServer(pinnedB)).toBe(formSchemaSignatureFE(pinnedB))
  })

  it('larger mixed schema (many fields, one record-link, one attachment): byte-identical end to end', () => {
    const schema: FormSchema = {
      fields: [
        { id: 'z_field', type: 'text', label: 'Z' },
        { id: 'a_field', type: 'number', label: 'A' },
        { id: 'files', type: 'attachment', label: '附件' },
        { id: 'm_field', type: 'select', label: 'M' },
        { id: 'linked', type: 'record-link', label: '关联', props: { baseId: '  base  ', sheetId: '  sheet  ' } },
      ],
    } as FormSchema
    const server = formSchemaSignatureServer(schema)
    const fe = formSchemaSignatureFE(schema)
    expect(server).toBe(fe)
    // Whitespace in baseId/sheetId is trimmed on both sides (same field-level behavior).
    expect(server).toContain('linked:record-link:base:sheet')
  })
})
