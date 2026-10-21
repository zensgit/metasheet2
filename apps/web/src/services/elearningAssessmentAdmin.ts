import { apiFetch } from '../utils/api'
import {
  ElearningApiError,
  type ElearningCapabilities,
  type ElearningQuestionType,
} from './elearning'

export const ELEARNING_ASSESSMENT_XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const ELEARNING_ASSESSMENT_ADMIN_PAGE_SIZE_MAX = 100

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STABLE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,62}$/
const PAGE_MAX = 1_000_000
const DISCLOSURE_POLICIES = [
  'no_review',
  'correctness_after_submit',
  'wrong_items_after_submit',
  'correctness_after_window',
] as const

export type ElearningExamDisclosurePolicy = (typeof DISCLOSURE_POLICIES)[number]

export interface ElearningQuestionBankListItem {
  bankId: string
  title: string
  questionCount: number
  createdAt: string
  updatedAt: string
}

export interface ElearningQuestionBankListResult {
  items: ElearningQuestionBankListItem[]
  page: number
  pageSize: number
  total: number
}

export interface ElearningAdminQuestionOption {
  id: string
  text: string
}

export interface ElearningAdminQuestionRevision {
  questionId: string
  questionRevisionId: string
  revision: number
  questionType: ElearningQuestionType
  prompt: string
  options: ElearningAdminQuestionOption[]
  correctOptionIds: string[]
  points: number
  explanation: string | null
  createdAt: string
}

export interface ElearningQuestionBankQuestionsResult {
  bank: { bankId: string; title: string }
  items: ElearningAdminQuestionRevision[]
  page: number
  pageSize: number
  total: number
}

export interface ElearningFixedPaperPublishRequest {
  title: string
  items: Array<{ questionRevisionId: string; points: number }>
}

export interface ElearningFixedPaperResult {
  paperId: string
  status: 'published'
  itemCount: number
  totalPoints: number
}

export interface ElearningPaperExamPublishRequest {
  paperId: string
  title: string
  passScore: number
  maxAttempts: number
  windowStartsAt: string | null
  windowEndsAt: string | null
  durationSeconds: number | null
  shuffleQuestions: boolean
  shuffleOptions: boolean
  disclosurePolicy: ElearningExamDisclosurePolicy
}

export interface ElearningPaperExamResult {
  examId: string
  paperId: string
  status: 'published'
  totalPoints: number
}

function fail(code: string, status: number): never {
  throw new ElearningApiError(code, status)
}

function failShape(status: number): never {
  fail('invalid_response', status)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function requireUuid(value: unknown, status: number): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) failShape(status)
  return value.toLowerCase()
}

function requireInputUuid(value: string): string {
  if (!UUID_RE.test(value)) fail('invalid_input', 400)
  return value.toLowerCase()
}

function requireText(value: unknown, status: number): string {
  if (typeof value !== 'string' || value.trim() === '') failShape(status)
  return value
}

function requireNullableText(value: unknown, status: number): string | null {
  if (value === null) return null
  return requireText(value, status)
}

function requireSafeInt(value: unknown, status: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    failShape(status)
  }
  return value
}

function requireIsoTimestamp(value: unknown, status: number): string {
  const text = requireText(value, status)
  if (!Number.isFinite(Date.parse(text))) failShape(status)
  return text
}

function requireQuestionType(value: unknown, status: number): ElearningQuestionType {
  if (value !== 'single_choice' && value !== 'multiple_choice' && value !== 'true_false') {
    failShape(status)
  }
  return value
}

function requirePage(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    fail('invalid_input', 400)
  }
  return value
}

function readErrorCode(payload: unknown): string {
  if (!isPlainObject(payload) || typeof payload.error !== 'string') return 'request_failed'
  const code = payload.error.trim()
  if (code === 'ORG_CONTEXT_REQUIRED') return code
  return STABLE_ERROR_CODE_RE.test(code) ? code : 'request_failed'
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

async function requestJson(
  path: string,
  expectedStatus: number,
  init: RequestInit,
): Promise<unknown> {
  let response: Response
  try {
    response = await apiFetch(path, init)
  } catch {
    fail('network_error', 0)
  }
  const payload = await readPayload(response)
  if (response.status !== expectedStatus) {
    fail(readErrorCode(payload), response.status)
  }
  return payload
}

function postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  return requestJson(path, 201, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function parseOption(value: unknown, status: number): ElearningAdminQuestionOption {
  if (!isPlainObject(value) || !exactKeys(value, ['id', 'text'])) failShape(status)
  return {
    id: requireText(value.id, status),
    text: requireText(value.text, status),
  }
}

function parseQuestion(value: unknown, status: number): ElearningAdminQuestionRevision {
  const keys = [
    'questionId',
    'questionRevisionId',
    'revision',
    'questionType',
    'prompt',
    'options',
    'correctOptionIds',
    'points',
    'explanation',
    'createdAt',
  ] as const
  if (!isPlainObject(value) || !exactKeys(value, keys)) failShape(status)
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 20) {
    failShape(status)
  }
  const options = value.options.map((option) => parseOption(option, status))
  if (new Set(options.map((option) => option.id)).size !== options.length) failShape(status)
  if (!Array.isArray(value.correctOptionIds) || value.correctOptionIds.length < 1) {
    failShape(status)
  }
  const correctOptionIds = value.correctOptionIds.map((id) => requireText(id, status))
  if (
    new Set(correctOptionIds).size !== correctOptionIds.length
    || correctOptionIds.some((id) => !options.some((option) => option.id === id))
  ) {
    failShape(status)
  }
  const questionType = requireQuestionType(value.questionType, status)
  if (questionType !== 'multiple_choice' && correctOptionIds.length !== 1) failShape(status)
  return {
    questionId: requireUuid(value.questionId, status),
    questionRevisionId: requireUuid(value.questionRevisionId, status),
    revision: requireSafeInt(value.revision, status, 1),
    questionType,
    prompt: requireText(value.prompt, status),
    options,
    correctOptionIds,
    points: requireSafeInt(value.points, status, 1),
    explanation: requireNullableText(value.explanation, status),
    createdAt: requireIsoTimestamp(value.createdAt, status),
  }
}

function parseBankList(payload: unknown, status: number): ElearningQuestionBankListResult {
  if (!isPlainObject(payload) || !exactKeys(payload, ['items', 'page', 'pageSize', 'total'])) {
    failShape(status)
  }
  if (!Array.isArray(payload.items)) failShape(status)
  return {
    items: payload.items.map((item) => {
      if (!isPlainObject(item) || !exactKeys(item, [
        'bankId',
        'title',
        'questionCount',
        'createdAt',
        'updatedAt',
      ])) {
        failShape(status)
      }
      return {
        bankId: requireUuid(item.bankId, status),
        title: requireText(item.title, status),
        questionCount: requireSafeInt(item.questionCount, status),
        createdAt: requireIsoTimestamp(item.createdAt, status),
        updatedAt: requireIsoTimestamp(item.updatedAt, status),
      }
    }),
    page: requireSafeInt(payload.page, status, 1),
    pageSize: requireSafeInt(payload.pageSize, status, 1),
    total: requireSafeInt(payload.total, status),
  }
}

function parseBankQuestions(
  payload: unknown,
  status: number,
): ElearningQuestionBankQuestionsResult {
  if (!isPlainObject(payload) || !exactKeys(payload, ['bank', 'items', 'page', 'pageSize', 'total'])) {
    failShape(status)
  }
  if (!isPlainObject(payload.bank) || !exactKeys(payload.bank, ['bankId', 'title'])) {
    failShape(status)
  }
  if (!Array.isArray(payload.items)) failShape(status)
  return {
    bank: {
      bankId: requireUuid(payload.bank.bankId, status),
      title: requireText(payload.bank.title, status),
    },
    items: payload.items.map((item) => parseQuestion(item, status)),
    page: requireSafeInt(payload.page, status, 1),
    pageSize: requireSafeInt(payload.pageSize, status, 1),
    total: requireSafeInt(payload.total, status),
  }
}

export function isElearningAssessmentAdminReady(value: ElearningCapabilities): boolean {
  return value.enabled && value.capabilities.content && value.capabilities.assessment
}

export async function createElearningQuestionBank(title: string): Promise<{ bankId: string }> {
  const payload = await postJson('/api/elearning/assessment/question-banks', { title })
  if (!isPlainObject(payload) || !exactKeys(payload, ['bankId'])) failShape(201)
  return { bankId: requireUuid(payload.bankId, 201) }
}

export async function listElearningQuestionBanks(
  page = 1,
  pageSize = 50,
): Promise<ElearningQuestionBankListResult> {
  const query = new URLSearchParams({
    page: String(requirePage(page, PAGE_MAX)),
    pageSize: String(requirePage(pageSize, ELEARNING_ASSESSMENT_ADMIN_PAGE_SIZE_MAX)),
  })
  const payload = await requestJson(
    `/api/elearning/assessment/question-banks?${query.toString()}`,
    200,
    { method: 'GET' },
  )
  return parseBankList(payload, 200)
}

export async function listElearningBankQuestions(
  bankId: string,
  page = 1,
  pageSize = ELEARNING_ASSESSMENT_ADMIN_PAGE_SIZE_MAX,
): Promise<ElearningQuestionBankQuestionsResult> {
  const query = new URLSearchParams({
    page: String(requirePage(page, PAGE_MAX)),
    pageSize: String(requirePage(pageSize, ELEARNING_ASSESSMENT_ADMIN_PAGE_SIZE_MAX)),
  })
  const id = encodeURIComponent(requireInputUuid(bankId))
  const payload = await requestJson(
    `/api/elearning/assessment/question-banks/${id}/questions?${query.toString()}`,
    200,
    { method: 'GET' },
  )
  return parseBankQuestions(payload, 200)
}

export async function importElearningQuestionBankXlsx(
  bankId: string,
  file: File,
): Promise<{ importedCount: number }> {
  const id = encodeURIComponent(requireInputUuid(bankId))
  const payload = await requestJson(
    `/api/elearning/assessment/question-banks/${id}/import`,
    201,
    {
      method: 'POST',
      headers: { 'Content-Type': ELEARNING_ASSESSMENT_XLSX_MIME },
      body: file,
    },
  )
  if (!isPlainObject(payload) || !exactKeys(payload, ['importedCount'])) failShape(201)
  return { importedCount: requireSafeInt(payload.importedCount, 201, 1) }
}

export async function publishElearningFixedPaper(
  input: ElearningFixedPaperPublishRequest,
): Promise<ElearningFixedPaperResult> {
  const payload = await postJson('/api/elearning/assessment/papers', {
    title: input.title,
    items: input.items.map((item) => ({
      questionRevisionId: item.questionRevisionId,
      points: item.points,
    })),
  })
  if (!isPlainObject(payload) || !exactKeys(payload, [
    'paperId',
    'status',
    'itemCount',
    'totalPoints',
  ])) {
    failShape(201)
  }
  if (payload.status !== 'published') failShape(201)
  return {
    paperId: requireUuid(payload.paperId, 201),
    status: 'published',
    itemCount: requireSafeInt(payload.itemCount, 201, 1),
    totalPoints: requireSafeInt(payload.totalPoints, 201, 1),
  }
}

export async function publishElearningPaperExam(
  input: ElearningPaperExamPublishRequest,
): Promise<ElearningPaperExamResult> {
  const payload = await postJson('/api/elearning/assessment/exams', {
    paperId: input.paperId,
    title: input.title,
    passScore: input.passScore,
    maxAttempts: input.maxAttempts,
    windowStartsAt: input.windowStartsAt,
    windowEndsAt: input.windowEndsAt,
    durationSeconds: input.durationSeconds,
    shuffleQuestions: input.shuffleQuestions,
    shuffleOptions: input.shuffleOptions,
    disclosurePolicy: input.disclosurePolicy,
  })
  if (!isPlainObject(payload) || !exactKeys(payload, [
    'examId',
    'paperId',
    'status',
    'totalPoints',
  ])) {
    failShape(201)
  }
  if (payload.status !== 'published') failShape(201)
  return {
    examId: requireUuid(payload.examId, 201),
    paperId: requireUuid(payload.paperId, 201),
    status: 'published',
    totalPoints: requireSafeInt(payload.totalPoints, 201, 1),
  }
}

export const ELEARNING_EXAM_DISCLOSURE_POLICIES = DISCLOSURE_POLICIES
