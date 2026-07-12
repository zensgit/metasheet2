/**
 * Express-validator type definitions
 * Shared types for optional express-validator dependency
 */

import type { Request, Response, NextFunction } from 'express'

/**
 * Validator chain interface for express-validator compatibility
 * Used to create no-op validators when express-validator is not installed
 */
export interface ValidatorChain {
  isString: () => ValidatorChain
  isBoolean: () => ValidatorChain
  isUUID: () => ValidatorChain
  isInt: (options?: { min?: number; max?: number }) => ValidatorChain
  isIn: (values: string[]) => ValidatorChain
  isArray: () => ValidatorChain
  isObject: () => ValidatorChain
  isISO8601: () => ValidatorChain
  optional: () => ValidatorChain
  notEmpty: () => ValidatorChain
  // Express middleware compatibility
  (req: Request, res: Response, next: NextFunction): void
}

/**
 * Validator function type - creates a ValidatorChain for a field
 */
export type ValidatorFunction = (field: string) => ValidatorChain

/**
 * Create a no-op validator chain for use when express-validator is not installed
 */
export function createNoOpValidator(): ValidatorChain {
  const middleware = (_req: Request, _res: Response, next: NextFunction) => next()
  const chain = middleware as ValidatorChain
  chain.isString = () => chain
  chain.isBoolean = () => chain
  chain.isUUID = () => chain
  chain.isInt = () => chain
  chain.isIn = () => chain
  chain.isArray = () => chain
  chain.isObject = () => chain
  chain.isISO8601 = () => chain
  chain.optional = () => chain
  chain.notEmpty = () => chain
  return chain
}

/**
 * Load express-validator. FAIL-CLOSED (#4126 review): express-validator is a declared PRODUCTION
 * dependency, and the declarative validation chains on the workflow / workflow-designer / PLM
 * routes are a security control. The previous no-op fallback silently disabled every one of those
 * chains when the module was absent — and the module was never declared anywhere, so validation was
 * fail-OPEN in every environment. A missing module is now a loud boot failure, never a silent
 * downgrade to "no validation".
 */
export function loadValidators(): {
  body: ValidatorFunction
  param: ValidatorFunction
  query: ValidatorFunction
} {
  let validator: {
    body: ValidatorFunction
    param: ValidatorFunction
    query: ValidatorFunction
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    validator = require('express-validator')
  } catch (error) {
    throw new Error(
      'express-validator is a required production dependency (declarative request validation is a ' +
        'security control and must never silently degrade to no-op). Install dependencies and retry. ' +
        `Underlying: ${(error as Error)?.message ?? 'unknown'}`
    )
  }
  if (
    typeof validator?.body !== 'function' ||
    typeof validator?.param !== 'function' ||
    typeof validator?.query !== 'function'
  ) {
    throw new Error(
      'express-validator did not expose body/param/query — refusing to start with unvalidated routes'
    )
  }
  return {
    body: validator.body,
    param: validator.param,
    query: validator.query
  }
}
