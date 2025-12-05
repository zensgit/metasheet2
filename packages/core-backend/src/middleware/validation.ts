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

// Dynamic import for optional express-validator
let validationResult: ((req: Request) => Result) | null = null

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const expressValidator = require('express-validator')
  validationResult = expressValidator.validationResult
} catch {
  // express-validator not installed - validation will be skipped
}

/**
 * Validation middleware that checks for express-validator errors
 */
export const validate = (req: Request, res: Response, next: NextFunction) => {
  if (!validationResult) {
    // express-validator not installed, skip validation
    next()
    return
  }

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
