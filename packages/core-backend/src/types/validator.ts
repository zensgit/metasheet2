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
 * Load express-validator or return no-op validators
 */
export function loadValidators(): {
  body: ValidatorFunction
  param: ValidatorFunction
  query: ValidatorFunction
} {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const validator = require('express-validator') as {
      body: ValidatorFunction
      param: ValidatorFunction
      query: ValidatorFunction
    }
    return {
      body: validator.body,
      param: validator.param,
      query: validator.query
    }
  } catch {
    // express-validator not installed, use no-op validators
    return {
      body: () => createNoOpValidator(),
      param: () => createNoOpValidator(),
      query: () => createNoOpValidator()
    }
  }
}
