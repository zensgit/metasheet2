/**
 * Validation Middleware
 * Express-validator based request validation
 */

import type { Request, Response, NextFunction } from 'express'

// Optional express-validator dependency - type declaration for soft dependency
interface ValidationError {
  type: string
  value?: unknown
  msg: string
  path: string
  location: string
}

interface Result {
  isEmpty(): boolean
  array(): ValidationError[]
}

// express-validator is a declared PRODUCTION dependency and request validation is a security
// control — load it FAIL-CLOSED (#4126 review). The previous try/catch fallback left
// `validationResult` null when the module was absent and `validate` then called next() unchecked,
// so every declarative chain on the workflow / workflow-designer / PLM routes was silently
// disabled. A missing module is now a loud boot failure, never a silent open door.
//
// `resolve` is a seam so the missing-module branch is reachable from a test — the module is
// installed wherever the suite runs, so without it this behaviour could only be asserted against
// source text, and a regex cannot tell a `throw` from a `next()` (#4126 review P2).
export type ModuleResolver = (id: string) => unknown

export function loadValidationResult(
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  resolve: ModuleResolver = require
): (req: Request) => Result {
  let loaded: unknown
  try {
    loaded = (resolve('express-validator') as { validationResult?: unknown })?.validationResult
  } catch (error) {
    throw new Error(
      'express-validator is a required production dependency (request validation must never silently ' +
        `degrade to pass-through). Install dependencies and retry. Underlying: ${(error as Error)?.message ?? 'unknown'}`
    )
  }
  if (typeof loaded !== 'function') {
    throw new Error(
      'express-validator did not expose validationResult — refusing to start with unvalidated routes'
    )
  }
  return loaded as (req: Request) => Result
}

const validationResult = loadValidationResult()

/**
 * Validation middleware that checks for express-validator errors
 */
export const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    })
  }
  next()
}

export default validate
