import { describe, expect, test } from 'vitest'

import {
  buildXlsxBuffer,
  type XlsxModule,
} from '../../src/multitable/xlsx-service'
import {
  ElearningAssessmentCatalogError,
  importElearningBankQuestions,
  type ElearningAssessmentCatalogDb,
  type ElearningAssessmentQuestionInput,
} from '../../src/services/elearning-assessment-catalog'
import {
  ELEARNING_ASSESSMENT_XLSX_MAX_EXPANDED_BYTES,
  parseElearningQuestionWorkbookWithModule,
} from '../../src/services/elearning-assessment-import'

const xlsx = await import('xlsx') as unknown as XlsxModule
const BANK_ID = '11111111-1111-4111-8111-111111111111'

const HEADERS = [
  'prompt',
  'question_type',
  'option_b',
  'option_a',
  'correct_options',
  'points',
  'explanation',
  'option_c',
]

function workbook(
  rows: Array<Array<string | number | boolean | null | undefined>>,
  headers = HEADERS,
): Buffer {
  return buildXlsxBuffer(xlsx, { sheetName: 'Questions', headers, rows })
}

function question(prompt: string): ElearningAssessmentQuestionInput {
  return {
    questionType: 'single_choice',
    prompt,
    options: [
      { id: 'a', text: 'Alpha' },
      { id: 'b', text: 'Beta' },
    ],
    correctOptionIds: ['a'],
    points: 5,
    explanation: null,
  }
}

function storedZip(entries: Array<{ name: string; data: string }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name)
    const dataBytes = Buffer.from(entry.data)
    const local = Buffer.alloc(30 + nameBytes.length + dataBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(dataBytes.length, 18)
    local.writeUInt32LE(dataBytes.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)
    dataBytes.copy(local, 30 + nameBytes.length)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(dataBytes.length, 20)
    central.writeUInt32LE(dataBytes.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(localOffset, 42)
    nameBytes.copy(central, 46)
    localParts.push(local)
    centralParts.push(central)
    localOffset += local.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(
    centralParts.reduce((total, part) => total + part.length, 0),
    12,
  )
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
}

describe('e-learning assessment XLSX import', () => {
  test('parses a reordered strict header contract and normalizes answer ids', () => {
    const parsed = parseElearningQuestionWorkbookWithModule(xlsx, workbook([
      ['Choose one', 'single_choice', 'Beta', 'Alpha', ' A ', '5', 'Why', ''],
      ['Choose two', 'multiple_choice', 'Beta', 'Alpha', 'A, C', '7', '', 'Gamma'],
    ]))

    expect(parsed).toEqual([
      {
        questionType: 'single_choice',
        prompt: 'Choose one',
        options: [
          { id: 'a', text: 'Alpha' },
          { id: 'b', text: 'Beta' },
        ],
        correctOptionIds: ['a'],
        points: 5,
        explanation: 'Why',
      },
      {
        questionType: 'multiple_choice',
        prompt: 'Choose two',
        options: [
          { id: 'a', text: 'Alpha' },
          { id: 'b', text: 'Beta' },
          { id: 'c', text: 'Gamma' },
        ],
        correctOptionIds: ['a', 'c'],
        points: 7,
        explanation: null,
      },
    ])
  })

  test('keeps duplicate rows as separate questions', () => {
    const row = ['Same prompt', 'single_choice', 'Beta', 'Alpha', 'a', '5', '', '']
    const parsed = parseElearningQuestionWorkbookWithModule(xlsx, workbook([row, row]))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual(parsed[1])
  })

  test.each([
    ['unknown header', () => workbook([
      ['Prompt', 'single_choice', 'Beta', 'Alpha', 'a', '5', '', ''],
    ], [...HEADERS, 'org_id'])],
    ['duplicate header', () => workbook([
      ['Prompt', 'single_choice', 'Beta', 'Alpha', 'a', '5', '', '', 'Again'],
    ], [...HEADERS, 'prompt'])],
    ['missing header', () => workbook([
      ['Prompt', 'single_choice', 'Beta', 'Alpha', 'a', ''],
    ], HEADERS.filter((header) => header !== 'points'))],
    ['data under blank header', () => workbook([
      ['Prompt', 'single_choice', 'Beta', 'Alpha', 'a', '5', '', '', 'hidden'],
    ], [...HEADERS, ''])],
    ['bad points', () => workbook([
      ['Prompt', 'single_choice', 'Beta', 'Alpha', 'a', '1.5', '', ''],
    ])],
    ['too many rows', () => workbook(Array.from({ length: 501 }, (_value, index) => [
      `Prompt ${index}`,
      'single_choice',
      'Beta',
      'Alpha',
      'a',
      '5',
      '',
      '',
    ]))],
    ['not xlsx', () => Buffer.from('not-an-xlsx')],
    ['truncated zip', () => Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ] as const)('rejects %s without returning workbook values', (_label, makeBuffer) => {
    expect(() => parseElearningQuestionWorkbookWithModule(xlsx, makeBuffer()))
      .toThrowError(ElearningAssessmentCatalogError)
    try {
      parseElearningQuestionWorkbookWithModule(xlsx, makeBuffer())
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_input', message: 'invalid_input' })
    }
  })

  test('rejects formulas and multiple worksheets', () => {
    const worksheet = xlsx.utils.aoa_to_sheet([
      HEADERS,
      ['Prompt', 'single_choice', 'Beta', 'Alpha', 'a', '5', '', ''],
    ]) as Record<string, unknown>
    worksheet.A2 = { t: 'n', f: '1+1', v: 2 }
    const formulaBook = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(formulaBook, worksheet, 'Questions')
    const formulaBuffer = Buffer.from(xlsx.write(formulaBook, {
      type: 'buffer',
      bookType: 'xlsx',
    }))
    expect(() => parseElearningQuestionWorkbookWithModule(xlsx, formulaBuffer))
      .toThrowError(ElearningAssessmentCatalogError)

    const multiple = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(multiple, xlsx.utils.aoa_to_sheet([HEADERS]), 'One')
    xlsx.utils.book_append_sheet(multiple, xlsx.utils.aoa_to_sheet([HEADERS]), 'Two')
    const multipleBuffer = Buffer.from(xlsx.write(multiple, {
      type: 'buffer',
      bookType: 'xlsx',
    }))
    expect(() => parseElearningQuestionWorkbookWithModule(xlsx, multipleBuffer))
      .toThrowError(ElearningAssessmentCatalogError)
  })

  test('rejects archive expansion metadata before workbook parsing', () => {
    const expanded = Buffer.from(workbook([
      ['Prompt', 'single_choice', 'Beta', 'Alpha', 'a', '5', '', ''],
    ]))
    const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
    const centralOffset = expanded.indexOf(centralSignature)
    expect(centralOffset).toBeGreaterThanOrEqual(0)
    expanded.writeUInt32LE(
      ELEARNING_ASSESSMENT_XLSX_MAX_EXPANDED_BYTES + 1,
      centralOffset + 24,
    )

    expect(() => parseElearningQuestionWorkbookWithModule(xlsx, expanded))
      .toThrowError(ElearningAssessmentCatalogError)
  })

  test('rejects a central-directory size lie before workbook parsing', () => {
    const lied = Buffer.from(workbook([
      ['Prompt', 'single_choice', 'Beta', 'Alpha', 'a', '5', '', ''],
    ]))
    const centralOffset = lied.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    expect(centralOffset).toBeGreaterThanOrEqual(0)
    lied.writeUInt32LE(1, centralOffset + 24)
    let readCalls = 0
    const guarded = {
      ...xlsx,
      read: (...args: Parameters<XlsxModule['read']>) => {
        readCalls += 1
        return xlsx.read(...args)
      },
    }

    expect(() => parseElearningQuestionWorkbookWithModule(guarded, lied))
      .toThrowError(ElearningAssessmentCatalogError)
    expect(readCalls).toBe(0)
  })

  test('rejects a relationship-path worksheet hidden behind a valid bait part', () => {
    const wide = storedZip([
      {
        name: 'xl/worksheets/bait.xml',
        data: '<worksheet><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>',
      },
      {
        name: 'custom/actual-sheet.payload',
        data: '<x:worksheet xmlns:x="urn:test"><x:sheetData><x:row r="1"><x:c r="Z1"/></x:row></x:sheetData></x:worksheet>',
      },
    ])
    let readCalls = 0
    const guarded = {
      ...xlsx,
      read: (...args: Parameters<XlsxModule['read']>) => {
        readCalls += 1
        return xlsx.read(...args)
      },
    }

    expect(() => parseElearningQuestionWorkbookWithModule(guarded, wide))
      .toThrowError(ElearningAssessmentCatalogError)
    expect(readCalls).toBe(0)
  })

  test('uses the real quoted r attribute rather than text inside another attribute', () => {
    const deceptive = storedZip([{
      name: 'xl/worksheets/sheet1.xml',
      data: '<worksheet><sheetData><row r="1"><c note=\'x r="A1"\' r="Z1"/></row></sheetData></worksheet>',
    }])
    let readCalls = 0
    const guarded = {
      ...xlsx,
      read: (...args: Parameters<XlsxModule['read']>) => {
        readCalls += 1
        return xlsx.read(...args)
      },
    }

    expect(() => parseElearningQuestionWorkbookWithModule(guarded, deceptive))
      .toThrowError(ElearningAssessmentCatalogError)
    expect(readCalls).toBe(0)
  })

  test('validates every row before opening one all-or-nothing transaction', async () => {
    let transactionCalls = 0
    const queries: string[] = []
    const db: ElearningAssessmentCatalogDb = {
      transaction: async (handler) => {
        transactionCalls += 1
        return handler({
          query: async (sql) => {
            queries.push(sql)
            if (sql.includes('load-import-bank')) {
              return { rows: [{ id: BANK_ID }], rowCount: 1 }
            }
            return { rows: [], rowCount: 1 }
          },
        })
      },
    }

    await expect(importElearningBankQuestions(db, {
      orgId: 'org-import',
      actorId: 'actor-import',
      bankId: BANK_ID,
      questions: [question('One'), { ...question('Invalid'), points: 0 }],
    })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(transactionCalls).toBe(0)

    await expect(importElearningBankQuestions(db, {
      orgId: 'org-import',
      actorId: 'actor-import',
      bankId: BANK_ID,
      questions: [question('Same'), question('Same')],
    })).resolves.toEqual({ importedCount: 2 })
    expect(transactionCalls).toBe(1)
    expect(queries.filter((sql) => sql.includes('load-import-bank'))).toHaveLength(1)
    expect(queries.filter((sql) => sql.includes('create-question'))).toHaveLength(2)
    expect(queries.filter((sql) => sql.includes('create-revision'))).toHaveLength(2)
  })
})
