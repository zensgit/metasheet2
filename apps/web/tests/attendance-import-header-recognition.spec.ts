import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  IMPORT_HEADER_CONTEXT_KEYS,
  IMPORT_HEADER_DATE_KEYS,
  normalizeHeaderLookupKey,
  parseCsvHeaderFromText,
  recognizeImportHeader,
} from '../src/views/attendance/importHeaderRecognition'

const VOCAB = [
  { sourceField: '加班小时', targetField: 'overtimeHours' },
  { sourceField: '迟到分钟', targetField: 'lateMinutes' },
  { sourceField: 'plan_detail', targetField: 'shiftName' },
]

describe('importHeaderRecognition', () => {
  describe('parseCsvHeaderFromText', () => {
    it('parses the first non-empty line, stripping BOM and trimming cells', () => {
      expect(parseCsvHeaderFromText('﻿日期, 姓名 ,加班小时\n2026-06-01,张三,1\n'))
        .toEqual(['日期', '姓名', '加班小时'])
    })

    it('is quote-aware (embedded delimiter and escaped quotes)', () => {
      expect(parseCsvHeaderFromText('"姓名,备用",日期,"说 ""引"" 列"\nx,y,z\n'))
        .toEqual(['姓名,备用', '日期', '说 "引" 列'])
    })

    it('honors a custom delimiter', () => {
      expect(parseCsvHeaderFromText('日期;姓名;工号\n', { delimiter: ';' }))
        .toEqual(['日期', '姓名', '工号'])
    })

    it('honors an explicit header row index', () => {
      const text = '导出说明,,\n日期,姓名,工号\nx,y,z\n'
      expect(parseCsvHeaderFromText(text, { headerRowIndex: 1 })).toEqual(['日期', '姓名', '工号'])
    })

    it('skips leading all-empty rows when no explicit index is given', () => {
      expect(parseCsvHeaderFromText(',,\n\n日期,姓名\nx,y\n')).toEqual(['日期', '姓名'])
    })

    it('returns empty for empty/blank text', () => {
      expect(parseCsvHeaderFromText('')).toEqual([])
      expect(parseCsvHeaderFromText('   \n  ')).toEqual([])
    })
  })

  describe('recognizeImportHeader', () => {
    it('classifies mapping-alias, key-family, and unknown columns', () => {
      const result = recognizeImportHeader(['日期', '姓名', '加班小时', '自定义列'], VOCAB)
      expect(result).toEqual({
        recognized: ['日期', '姓名', '加班小时'],
        unknown: ['自定义列'],
        missingDate: false,
        missingContext: false,
      })
    })

    it('normalizes header lookups like the backend (case/space/underscore)', () => {
      const result = recognizeImportHeader(['Work_Date', ' PLAN-DETAIL '], VOCAB)
      expect(result?.recognized).toEqual(['Work_Date', 'PLAN-DETAIL'])
      expect(result?.missingDate).toBe(false)
    })

    it('flags a missing date column', () => {
      const result = recognizeImportHeader(['姓名', '加班小时'], VOCAB)
      expect(result?.missingDate).toBe(true)
      expect(result?.missingContext).toBe(false)
    })

    it('flags a missing people/context column', () => {
      const result = recognizeImportHeader(['日期', '自定义列'], VOCAB)
      expect(result?.missingDate).toBe(false)
      expect(result?.missingContext).toBe(true)
    })

    it('degrades to key families when the vocabulary is empty, keeping flags exact', () => {
      const result = recognizeImportHeader(['日期', '姓名', '加班小时'], [])
      expect(result?.recognized).toEqual(['日期', '姓名'])
      expect(result?.unknown).toEqual(['加班小时'])
      expect(result?.missingDate).toBe(false)
      expect(result?.missingContext).toBe(false)
    })

    it('returns null for an empty header', () => {
      expect(recognizeImportHeader([], VOCAB)).toBeNull()
      expect(recognizeImportHeader(['', '  '], VOCAB)).toBeNull()
    })
  })

  it('key families stay in sync with the backend constants (fixture-sync)', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../plugins/plugin-attendance/index.cjs'),
      'utf8',
    )
    const dateBlock = source.match(/IMPORT_HEADER_DATE_KEYS = new Set\(\[([^\]]+)\]\)/)?.[1]
    expect(dateBlock, 'expected IMPORT_HEADER_DATE_KEYS in plugin source').toBeTruthy()
    const backendDateKeys = Array.from(dateBlock!.matchAll(/'([^']+)'/g)).map(match => match[1])
    expect([...IMPORT_HEADER_DATE_KEYS].sort()).toEqual([...backendDateKeys].sort())

    const contextBlock = source.match(/IMPORT_HEADER_CONTEXT_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1]
    expect(contextBlock, 'expected IMPORT_HEADER_CONTEXT_KEYS in plugin source').toBeTruthy()
    const backendContextKeys = Array.from(contextBlock!.matchAll(/'([^']+)'/g)).map(match => match[1])
    expect([...IMPORT_HEADER_CONTEXT_KEYS].sort()).toEqual([...backendContextKeys].sort())

    // Backend normalizeImportHeaderLookupKey must keep the same shape our
    // normalizeHeaderLookupKey mirrors (trim → lowercase → strip [\s_-]+).
    expect(source).toContain(".replace(/[\\s_-]+/g, '')")
    expect(normalizeHeaderLookupKey(' Work_Date ')).toBe('workdate')
    expect(normalizeHeaderLookupKey('用户ID')).toBe('用户id')
    expect(normalizeHeaderLookupKey('PLAN-DETAIL')).toBe('plandetail')
  })
})
