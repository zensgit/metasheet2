import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { json, raw, Router } from 'express'

import { isElearningAssessmentSurfaceEnabled } from '../elearning/feature-flags'
import {
  appendElearningQuestionRevision,
  createElearningBankQuestion,
  createElearningQuestionBank,
  ElearningAssessmentCatalogError,
  importElearningBankQuestions,
  publishElearningFixedPaper,
  type ElearningAssessmentCatalogDb,
  type ElearningAssessmentQuestionInput,
  type PublishElearningFixedPaperItem,
} from '../services/elearning-assessment-catalog'
import {
  ELEARNING_ASSESSMENT_XLSX_MAX_BYTES,
  ELEARNING_ASSESSMENT_XLSX_MIME,
  parseElearningQuestionWorkbook,
} from '../services/elearning-assessment-import'
import {
  ElearningPaperExamError,
  publishElearningPaperExam,
  type ElearningExamDisclosurePolicy,
  type ElearningPaperExamDb,
} from '../services/elearning-paper-exam'
import {
  ELEARNING_ASSESSMENT_PAGE_DEFAULT,
  ELEARNING_ASSESSMENT_PAGE_SIZE_DEFAULT,
  ELEARNING_ASSESSMENT_PAGE_SIZE_MAX,
  listElearningBankQuestions,
  listElearningQuestionBanks,
} from '../services/elearning-assessment-catalog-read'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CREATE_BANK_KEYS = new Set(['title'])
const CREATE_QUESTION_KEYS = new Set(['question'])
const PUBLISH_PAPER_KEYS = new Set(['title', 'items'])
const PUBLISH_EXAM_KEYS = new Set([
  'paperId',
  'title',
  'passScore',
  'maxAttempts',
  'windowStartsAt',
  'windowEndsAt',
  'durationSeconds',
  'shuffleQuestions',
  'shuffleOptions',
  'disclosurePolicy',
])
const PAGE_QUERY_KEYS = new Set(['page', 'pageSize'])
const jsonParser = json({ limit: 1024 * 1024 })
const xlsxParser = raw({
  limit: ELEARNING_ASSESSMENT_XLSX_MAX_BYTES,
  type: ELEARNING_ASSESSMENT_XLSX_MIME,
})

const CATALOG_ERROR_STATUS: Record<
  ElearningAssessmentCatalogError['code'],
  number
> = {
  invalid_input: 400,
  not_found: 404,
  unavailable: 503,
}

const PAPER_EXAM_ERROR_STATUS: Record<ElearningPaperExamError['code'], number> = {
  invalid_input: 400,
  not_found: 404,
  unavailable: 503,
}

export interface ElearningAssessmentAdminRouteDeps {
  db: ElearningAssessmentCatalogDb & ElearningPaperExamDb
  env?: NodeJS.ProcessEnv
  adminGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  listElearningQuestionBanks?: typeof listElearningQuestionBanks
  listElearningBankQuestions?: typeof listElearningBankQuestions
  createElearningQuestionBank?: typeof createElearningQuestionBank
  createElearningBankQuestion?: typeof createElearningBankQuestion
  importElearningBankQuestions?: typeof importElearningBankQuestions
  parseElearningQuestionWorkbook?: typeof parseElearningQuestionWorkbook
  appendElearningQuestionRevision?: typeof appendElearningQuestionRevision
  publishElearningFixedPaper?: typeof publishElearningFixedPaper
  publishElearningPaperExam?: typeof publishElearningPaperExam
}

function parseJson(req: Request, res: Response, next: NextFunction): void {
  jsonParser(req, res, (error?: unknown) => {
    if (!error) return next()
    if (!req.readableEnded) req.resume()
    const parseError = error as { status?: unknown; type?: unknown }
    if (parseError.status === 413 || parseError.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' })
      return
    }
    res.status(400).json({ error: 'invalid_input' })
  })
}

function requireXlsx(req: Request, res: Response, next: NextFunction): void {
  if (!req.is(ELEARNING_ASSESSMENT_XLSX_MIME)) {
    res.status(415).json({ error: 'unsupported_media_type' })
    return
  }
  next()
}

function parseXlsx(req: Request, res: Response, next: NextFunction): void {
  xlsxParser(req, res, (error?: unknown) => {
    if (!error) return next()
    if (!req.readableEnded) req.resume()
    const parseError = error as { status?: unknown; type?: unknown }
    if (parseError.status === 413 || parseError.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' })
      return
    }
    res.status(400).json({ error: 'invalid_input' })
  })
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function hasExactKeys(
  body: Record<string, unknown>,
  required: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(body)
  return keys.length === required.size && keys.every((key) => required.has(key))
}

function uuidParam(req: Request, name: string): string | null {
  const value = (req.params as Record<string, unknown>)[name]
  return typeof value === 'string' && UUID_RE.test(value)
    ? value.toLowerCase()
    : null
}

function positiveQueryInt(
  value: unknown,
  fallback: number,
  max: number,
): number | null {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null
}

function paginationParams(req: Request): { page: number; pageSize: number } | null {
  const query = req.query as Record<string, unknown>
  const keys = Object.keys(query)
  if (keys.some((key) => !PAGE_QUERY_KEYS.has(key))) return null
  const page = positiveQueryInt(
    query.page,
    ELEARNING_ASSESSMENT_PAGE_DEFAULT,
    1_000_000,
  )
  const pageSize = positiveQueryInt(
    query.pageSize,
    ELEARNING_ASSESSMENT_PAGE_SIZE_DEFAULT,
    ELEARNING_ASSESSMENT_PAGE_SIZE_MAX,
  )
  return page === null || pageSize === null ? null : { page, pageSize }
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ElearningAssessmentCatalogError) {
    res.status(CATALOG_ERROR_STATUS[error.code]).json({ error: error.code })
    return
  }
  if (error instanceof ElearningPaperExamError) {
    res.status(PAPER_EXAM_ERROR_STATUS[error.code]).json({ error: error.code })
    return
  }
  res.status(500).json({ error: 'internal_error' })
}

export function createElearningAssessmentAdminRouter(
  deps: ElearningAssessmentAdminRouteDeps,
): Router | null {
  if (!isElearningAssessmentSurfaceEnabled(deps.env ?? process.env)) return null

  const createBank =
    deps.createElearningQuestionBank ?? createElearningQuestionBank
  const listBanks =
    deps.listElearningQuestionBanks ?? listElearningQuestionBanks
  const listQuestions =
    deps.listElearningBankQuestions ?? listElearningBankQuestions
  const createQuestion =
    deps.createElearningBankQuestion ?? createElearningBankQuestion
  const importQuestions =
    deps.importElearningBankQuestions ?? importElearningBankQuestions
  const parseQuestionWorkbook =
    deps.parseElearningQuestionWorkbook ?? parseElearningQuestionWorkbook
  const appendRevision =
    deps.appendElearningQuestionRevision ?? appendElearningQuestionRevision
  const publishPaper =
    deps.publishElearningFixedPaper ?? publishElearningFixedPaper
  const publishExam = deps.publishElearningPaperExam ?? publishElearningPaperExam
  const router = Router()

  const requireAssessment = (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!isElearningAssessmentSurfaceEnabled(deps.env ?? process.env)) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }

  const requireIdentity = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!deps.viewerId(req)) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    next()
  }

  const requireOrg = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!deps.orgId(req)) {
      res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
      return
    }
    next()
  }

  const context = (
    req: Request,
    res: Response,
  ): { actorId: string; orgId: string } | null => {
    if (!isElearningAssessmentSurfaceEnabled(deps.env ?? process.env)) {
      res.status(404).json({ error: 'not_found' })
      return null
    }
    const actorId = deps.viewerId(req)
    if (!actorId) {
      res.status(401).json({ error: 'unauthenticated' })
      return null
    }
    const orgId = deps.orgId(req)
    if (!orgId) {
      res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
      return null
    }
    return { actorId, orgId }
  }

  const run = (
    handler: (req: Request, res: Response) => Promise<void>,
  ): RequestHandler => (req, res): void => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
    })
  }

  const authGate = [
    requireAssessment,
    requireIdentity,
    requireOrg,
    deps.adminGuard,
  ] as const

  const gate = [
    ...authGate,
    parseJson,
  ] as const

  const xlsxGate = [
    ...authGate,
    requireXlsx,
    parseXlsx,
  ] as const

  router.get(
    '/api/elearning/assessment/question-banks',
    ...authGate,
    run(async (req, res) => {
      const ctx = context(req, res)
      if (!ctx) return
      const paging = paginationParams(req)
      if (!paging) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const value = await listBanks(deps.db, {
          orgId: ctx.orgId,
          ...paging,
        })
        res.status(200).json({
          items: value.items.map((item) => ({
            bankId: item.bankId,
            title: item.title,
            questionCount: item.questionCount,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          })),
          page: value.page,
          pageSize: value.pageSize,
          total: value.total,
        })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  router.get(
    '/api/elearning/assessment/question-banks/:bankId/questions',
    ...authGate,
    run(async (req, res) => {
      const ctx = context(req, res)
      if (!ctx) return
      const bankId = uuidParam(req, 'bankId')
      const paging = paginationParams(req)
      if (!bankId || !paging) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const value = await listQuestions(deps.db, {
          orgId: ctx.orgId,
          bankId,
          ...paging,
        })
        res.status(200).json({
          bank: {
            bankId: value.bank.bankId,
            title: value.bank.title,
          },
          items: value.items.map((item) => ({
            questionId: item.questionId,
            questionRevisionId: item.questionRevisionId,
            revision: item.revision,
            questionType: item.questionType,
            prompt: item.prompt,
            options: item.options.map((option) => ({ ...option })),
            correctOptionIds: [...item.correctOptionIds],
            points: item.points,
            explanation: item.explanation,
            createdAt: item.createdAt,
          })),
          page: value.page,
          pageSize: value.pageSize,
          total: value.total,
        })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  router.post(
    '/api/elearning/assessment/question-banks',
    ...gate,
    run(async (req, res) => {
      const ctx = context(req, res)
      if (!ctx) return
      const body = readObject(req.body)
      if (!body || !hasExactKeys(body, CREATE_BANK_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const value = await createBank(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          title: body.title as string,
        })
        res.status(201).json({ bankId: value.bankId })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  router.post(
    '/api/elearning/assessment/question-banks/:bankId/questions',
    ...gate,
    run(async (req, res) => {
      const ctx = context(req, res)
      if (!ctx) return
      const bankId = uuidParam(req, 'bankId')
      const body = readObject(req.body)
      if (!body || !bankId || !hasExactKeys(body, CREATE_QUESTION_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const value = await createQuestion(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          bankId,
          question: body.question as ElearningAssessmentQuestionInput,
        })
        res.status(201).json({
          questionId: value.questionId,
          questionRevisionId: value.questionRevisionId,
          revision: value.revision,
        })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  router.post(
    '/api/elearning/assessment/question-banks/:bankId/import',
    ...xlsxGate,
    run(async (req, res) => {
      const ctx = context(req, res)
      if (!ctx) return
      const bankId = uuidParam(req, 'bankId')
      if (!bankId || !Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const questions = await parseQuestionWorkbook(req.body)
        const value = await importQuestions(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          bankId,
          questions,
        })
        res.status(201).json({ importedCount: value.importedCount })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  router.post(
    '/api/elearning/assessment/questions/:questionId/revisions',
    ...gate,
    run(async (req, res) => {
      const ctx = context(req, res)
      if (!ctx) return
      const questionId = uuidParam(req, 'questionId')
      const body = readObject(req.body)
      if (!body || !questionId || !hasExactKeys(body, CREATE_QUESTION_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const value = await appendRevision(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          questionId,
          question: body.question as ElearningAssessmentQuestionInput,
        })
        res.status(201).json({
          questionId: value.questionId,
          questionRevisionId: value.questionRevisionId,
          revision: value.revision,
        })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  router.post(
    '/api/elearning/assessment/papers',
    ...gate,
    run(async (req, res) => {
      const ctx = context(req, res)
      if (!ctx) return
      const body = readObject(req.body)
      if (!body || !hasExactKeys(body, PUBLISH_PAPER_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const value = await publishPaper(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          title: body.title as string,
          items: body.items as PublishElearningFixedPaperItem[],
        })
        res.status(201).json({
          paperId: value.paperId,
          status: value.status,
          itemCount: value.itemCount,
          totalPoints: value.totalPoints,
        })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  router.post(
    '/api/elearning/assessment/exams',
    ...gate,
    run(async (req, res) => {
      const ctx = context(req, res)
      if (!ctx) return
      const body = readObject(req.body)
      if (!body || !hasExactKeys(body, PUBLISH_EXAM_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      try {
        const value = await publishExam(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          paperId: body.paperId as string,
          title: body.title as string,
          passScore: body.passScore as number,
          maxAttempts: body.maxAttempts as number,
          windowStartsAt: body.windowStartsAt as string | null,
          windowEndsAt: body.windowEndsAt as string | null,
          durationSeconds: body.durationSeconds as number | null,
          shuffleQuestions: body.shuffleQuestions as boolean,
          shuffleOptions: body.shuffleOptions as boolean,
          disclosurePolicy:
            body.disclosurePolicy as ElearningExamDisclosurePolicy,
        })
        res.status(201).json({
          examId: value.examId,
          paperId: value.paperId,
          status: value.status,
          totalPoints: value.totalPoints,
        })
      } catch (error) {
        sendError(res, error)
      }
    }),
  )

  return router
}
