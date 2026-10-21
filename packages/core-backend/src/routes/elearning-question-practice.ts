import { json, Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express'

import { ElearningPracticeError } from '../services/elearning-question-practice'
import {
  createElearningPracticeSet,
  isElearningPracticeSurfaceEnabled,
  listElearningPracticeSets,
  listElearningWrongQuestions,
  startElearningPracticeSession,
  submitElearningPracticeAnswer,
  type ElearningPracticeDb,
} from '../services/elearning-question-practice-postgres'

const CREATE_SET_KEYS = new Set(['paperId', 'requestId', 'title'])
const START_KEYS = new Set(['mode', 'practiceSetId', 'requestId'])
const ANSWER_KEYS = new Set(['questionRevisionId', 'requestId', 'selectedOptionIds'])
const jsonParser = json({ limit: 64 * 1024 })

const STATUS: Record<ElearningPracticeError['code'], number> = {
  disabled: 404,
  invalid_input: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  unavailable: 503,
}

export interface ElearningPracticeRouteDeps {
  db: ElearningPracticeDb
  env?: NodeJS.ProcessEnv
  adminGuard: RequestHandler
  readGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  createElearningPracticeSet?: typeof createElearningPracticeSet
  listElearningPracticeSets?: typeof listElearningPracticeSets
  startElearningPracticeSession?: typeof startElearningPracticeSession
  submitElearningPracticeAnswer?: typeof submitElearningPracticeAnswer
  listElearningWrongQuestions?: typeof listElearningWrongQuestions
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function parseJson(req: Request, res: Response, next: NextFunction): void {
  jsonParser(req, res, (error?: unknown) => {
    if (!error) return next()
    if (!req.readableEnded) req.resume()
    res.status(400).json({ error: 'invalid_input' })
  })
}

function uuidParam(req: Request, name: string): string | null {
  const raw = (req.params as Record<string, unknown>)[name]
  return typeof raw === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
    ? raw.toLowerCase()
    : null
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ElearningPracticeError) {
    res.status(STATUS[error.code]).json({ error: error.code })
    return
  }
  res.status(500).json({ error: 'internal_error' })
}

export function createElearningQuestionPracticeRouter(
  deps: ElearningPracticeRouteDeps,
): Router | null {
  const env = deps.env ?? process.env
  if (!isElearningPracticeSurfaceEnabled(env)) return null
  const router = Router()
  const createSet = deps.createElearningPracticeSet ?? createElearningPracticeSet
  const listSets = deps.listElearningPracticeSets ?? listElearningPracticeSets
  const startSession = deps.startElearningPracticeSession ?? startElearningPracticeSession
  const submitAnswer = deps.submitElearningPracticeAnswer ?? submitElearningPracticeAnswer
  const listWrong = deps.listElearningWrongQuestions ?? listElearningWrongQuestions

  const requireFlag = (_req: Request, res: Response, next: NextFunction): void => {
    if (!isElearningPracticeSurfaceEnabled(env)) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }
  const requireContext = (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.viewerId(req)) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    if (!deps.orgId(req)) {
      res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
      return
    }
    next()
  }
  const run = (
    handler: (req: Request, res: Response, ctx: { orgId: string; actorId: string }) => Promise<void>,
  ): RequestHandler => (req, res): void => {
    const orgId = deps.orgId(req)
    const actorId = deps.viewerId(req)
    if (!orgId || !actorId) {
      res.status(500).json({ error: 'internal_error' })
      return
    }
    void handler(req, res, { orgId, actorId }).catch((error) => sendError(res, error))
  }

  router.post(
    '/api/elearning/admin/practice-sets',
    requireFlag,
    requireContext,
    deps.adminGuard,
    parseJson,
    run(async (req, res, ctx) => {
      const body = readObject(req.body)
      if (!body || !exactKeys(body, CREATE_SET_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      const result = await createSet(deps.db, {
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        requestId: body.requestId,
        paperId: body.paperId,
        title: body.title,
      }, env)
      res.status(result.duplicate ? 200 : 201).json(result)
    }),
  )

  router.get(
    '/api/elearning/me/practice-sets',
    requireFlag,
    requireContext,
    deps.readGuard,
    run(async (_req, res, ctx) => {
      const sets = await listSets(deps.db, {
        orgId: ctx.orgId,
        userId: ctx.actorId,
      }, env)
      res.status(200).json({ practiceSets: sets })
    }),
  )

  router.post(
    '/api/elearning/me/practice-sessions',
    requireFlag,
    requireContext,
    deps.readGuard,
    parseJson,
    run(async (req, res, ctx) => {
      const body = readObject(req.body)
      if (!body || !exactKeys(body, START_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      const result = await startSession(deps.db, {
        orgId: ctx.orgId,
        userId: ctx.actorId,
        requestId: body.requestId,
        practiceSetId: body.practiceSetId,
        mode: body.mode,
      }, env)
      res.status(result.duplicate ? 200 : 201).json(result)
    }),
  )

  router.post(
    '/api/elearning/me/practice-sessions/:sessionId/answers',
    requireFlag,
    requireContext,
    deps.readGuard,
    parseJson,
    run(async (req, res, ctx) => {
      const sessionId = uuidParam(req, 'sessionId')
      const body = readObject(req.body)
      if (!sessionId || !body || !exactKeys(body, ANSWER_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      const result = await submitAnswer(deps.db, {
        orgId: ctx.orgId,
        userId: ctx.actorId,
        sessionId,
        requestId: body.requestId,
        questionRevisionId: body.questionRevisionId,
        selectedOptionIds: body.selectedOptionIds,
      }, env)
      res.status(200).json(result)
    }),
  )

  router.get(
    '/api/elearning/me/practice-sets/:practiceSetId/wrong-questions',
    requireFlag,
    requireContext,
    deps.readGuard,
    run(async (req, res, ctx) => {
      const practiceSetId = uuidParam(req, 'practiceSetId')
      if (!practiceSetId) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      res.status(200).json(await listWrong(deps.db, {
        orgId: ctx.orgId,
        userId: ctx.actorId,
        practiceSetId,
      }, env))
    }),
  )

  return router
}
