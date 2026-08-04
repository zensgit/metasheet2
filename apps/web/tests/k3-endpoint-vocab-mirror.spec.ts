import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// P1 anti-drift tripwire for the K3 WISE endpoint vocabulary.
//
// The delivery-plan survey found FOUR independent declarations of the K3 API surface, and proved by import
// graph that they are separately maintained: k3WiseSetup.ts imports NOTHING from the plugin. The server
// templates are the source of truth; this file carries a full second copy of the endpoint defaults.
//
// Same discipline as composition-vocab-mirror.spec.ts: require the server's frozen export directly —
// require, never text-parse — and fail RED the moment the two diverge.
//
// WHY AN EXPLICIT CORRESPONDENCE MAP RATHER THAN A LOOP OVER ONE SIDE:
// iterating the client's keys would never notice a server path the client does not carry, and iterating the
// server's would just go red with no way to express "deliberately client-side-absent". The map below makes
// every server endpoint's client fate a written decision. Adding a server endpoint without deciding that
// fate is a RED, which is the property we actually want.
import { createDefaultK3WiseSetupForm } from '../src/services/integration/k3WiseSetup'

const require = createRequire(import.meta.url)
const pluginLib = path.resolve(__dirname, '../../../plugins/plugin-integration-core/lib')
const { K3_WISE_DOCUMENT_TEMPLATES, K3_WISE_MATERIAL_PROFILES, MATERIAL_CUSTOMER_PROFILE_ID } =
  require(path.join(pluginLib, 'adapters/k3-wise-document-templates.cjs'))

// server template id -> server field -> client field on K3WiseSetupForm, or null when the client
// deliberately does not carry it. `null` is a DECISION, not an omission — each one carries its reason.
const CORRESPONDENCE: ReadonlyArray<
  readonly [templateKey: string, serverField: string, clientField: string | null, note: string]
> = [
  ['material', 'savePath', 'materialSavePath', 'the only write this first version performs'],
  ['material', 'submitPath', 'materialSubmitPath', 'declared; Submit is OFF in the first version'],
  ['material', 'auditPath', 'materialAuditPath', 'declared; Audit is OFF in the first version'],
  // Documented gap, found by writing this test: the server declares a Material read path and the client
  // form has no counterpart. GetDetail is exactly what the first version's post-save read-back needs, so
  // this null is a KNOWN GAP to close in P3 — recorded here rather than left invisible.
  ['material', 'readPath', null, 'KNOWN GAP: no client field; P3 read-back needs it'],
  ['bom', 'savePath', 'bomSavePath', 'declared; BOM writes are OFF in the first version'],
  ['bom', 'submitPath', 'bomSubmitPath', 'declared; BOM Submit is OFF'],
  ['bom', 'auditPath', 'bomAuditPath', 'declared; BOM Audit is OFF'],
]

// The server keys templates by a SHORT key ('material'), while each carries a versioned `id`
// ('k3wise.material.v1'). Assert both: keying by the short name while pinning the id means a silent
// version bump of the id cannot pass unnoticed.
const EXPECTED_TEMPLATE_ID: Readonly<Record<string, string>> = {
  material: 'k3wise.material.v1',
  bom: 'k3wise.bom.v1',
}

const templateByKey = (key: string): Record<string, unknown> => {
  const all = K3_WISE_DOCUMENT_TEMPLATES as Record<string, Record<string, unknown>>
  const found = all[key]
  expect(found, `server template '${key}' must exist`).toBeTruthy()
  expect(found.id, `server template '${key}' id must be pinned`).toBe(EXPECTED_TEMPLATE_ID[key])
  return found
}

describe('K3 WISE endpoint vocabulary client/server mirror (tripwire)', () => {
  it('every client endpoint default equals the server template it mirrors', () => {
    const client = createDefaultK3WiseSetupForm() as unknown as Record<string, unknown>
    for (const [templateKey, serverField, clientField, note] of CORRESPONDENCE) {
      if (clientField === null) continue
      const serverValue = templateByKey(templateKey)[serverField]
      expect(typeof serverValue, `${templateKey}.${serverField} must be a string`).toBe('string')
      expect(client[clientField], `${clientField} must mirror ${templateKey}.${serverField} (${note})`)
        .toBe(serverValue)
    }
  })

  it('the correspondence map covers EVERY server endpoint field — a new one cannot slip in undecided', () => {
    // This is the load-bearing assertion. Without it, adding savePath to a third template would simply not
    // be mirrored anywhere and nothing would notice.
    const ENDPOINT_FIELD = /(Path)$/
    const mapped = new Set(CORRESPONDENCE.map(([t, f]) => `${t}.${f}`))
    const seen: string[] = []
    const allTemplates = K3_WISE_DOCUMENT_TEMPLATES as Record<string, Record<string, unknown>>
    for (const [templateKey, template] of Object.entries(allTemplates)) {
      for (const [field, value] of Object.entries(template)) {
        if (!ENDPOINT_FIELD.test(field)) continue
        if (typeof value !== 'string' || !value.startsWith('/K3API/')) continue
        seen.push(`${templateKey}.${field}`)
      }
    }
    expect(seen.length, 'server must declare at least the material+bom endpoints').toBeGreaterThanOrEqual(7)
    for (const key of seen) {
      expect(mapped.has(key), `${key} has no entry in CORRESPONDENCE — decide its client fate`).toBe(true)
    }
    // Pin the count so a same-size substitution still trips, exactly as the composition mirror does.
    expect(seen.length).toBe(CORRESPONDENCE.length)
  })

  it('the customer material profile mirrors the same Save endpoint', () => {
    const profiles = K3_WISE_MATERIAL_PROFILES as Record<string, Record<string, unknown>>
    const profile = profiles[MATERIAL_CUSTOMER_PROFILE_ID as string]
    expect(profile, 'customer material profile must exist').toBeTruthy()
    expect(profile.savePath, 'customer profile Save must mirror the material template')
      .toBe(templateByKey('material').savePath)
  })
})
