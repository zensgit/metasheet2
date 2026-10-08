/**
 * Structural OpenAPI contract checks for FWB-0 Layer 2 record-link FormField schemas.
 * Parses generated dist/openapi.json (not source alone) so SDK regen drift is caught.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
// dist-sdk/tests → packages/openapi/dist/openapi.json
const openapiJsonPath = join(here, '..', '..', 'dist', 'openapi.json')

describe('OpenAPI record-link FormField schemas (generated JSON)', () => {
  const doc = JSON.parse(readFileSync(openapiJsonPath, 'utf8')) as {
    components?: {
      schemas?: Record<string, {
        additionalProperties?: unknown
        properties?: Record<string, {
          type?: string
          minLength?: number
          pattern?: string
          enum?: string[]
          $ref?: string
        }>
        required?: string[]
        oneOf?: Array<{ $ref?: string }>
        discriminator?: { propertyName?: string; mapping?: Record<string, string> }
      }>
    }
  }
  const schemas = doc.components?.schemas ?? {}

  it('RecordLinkFieldProps: closed object; baseId/sheetId pattern rejects whitespace-only', () => {
    const props = schemas.RecordLinkFieldProps
    expect(props).toBeDefined()
    expect(props?.additionalProperties).toBe(false)
    expect(props?.required).toEqual(expect.arrayContaining(['baseId', 'sheetId']))

    for (const pin of ['baseId', 'sheetId'] as const) {
      const p = props?.properties?.[pin]
      expect(p?.type, pin).toBe('string')
      expect(p?.minLength, pin).toBeGreaterThanOrEqual(1)
      expect(typeof p?.pattern, pin).toBe('string')
      const re = new RegExp(p!.pattern!)
      expect(re.test('   '), `${pin} rejects spaces`).toBe(false)
      expect(re.test('\t\n'), `${pin} rejects ws-only`).toBe(false)
      expect(re.test(''), `${pin} rejects empty`).toBe(false)
      expect(re.test('base-1'), `${pin} accepts id`).toBe(true)
      expect(re.test('a'), `${pin} accepts single non-ws`).toBe(true)
    }
  })

  it('FormFieldRecordLink: additionalProperties false; no columns; props ref RecordLinkFieldProps', () => {
    const rl = schemas.FormFieldRecordLink
    expect(rl).toBeDefined()
    expect(rl?.additionalProperties).toBe(false)
    expect(rl?.properties?.type?.enum).toEqual(['record-link'])
    expect(rl?.required).toEqual(expect.arrayContaining(['id', 'type', 'label', 'props']))
    expect(String(rl?.properties?.props?.$ref || '')).toContain('RecordLinkFieldProps')
    expect(rl?.properties?.columns).toBeUndefined()
    expect(rl?.properties?.minRows).toBeUndefined()
    expect(rl?.properties?.maxRows).toBeUndefined()

    const allowed = new Set([
      'id',
      'type',
      'label',
      'required',
      'placeholder',
      'defaultValue',
      'options',
      'props',
      'visibilityRule',
    ])
    for (const key of Object.keys(rl?.properties || {})) {
      expect(allowed.has(key), `unexpected FormFieldRecordLink property: ${key}`).toBe(true)
    }
  })

  it('FormField is discriminated oneOf including FormFieldRecordLink', () => {
    const ff = schemas.FormField
    const refs = (ff?.oneOf || []).map((e) => String(e.$ref || ''))
    expect(refs.some((r) => r.includes('FormFieldRecordLink'))).toBe(true)
    expect(refs.some((r) => r.includes('FormFieldGeneric'))).toBe(true)
    expect(ff?.discriminator?.propertyName).toBe('type')
    expect(String(ff?.discriminator?.mapping?.['record-link'] || '')).toContain('FormFieldRecordLink')
  })
})
