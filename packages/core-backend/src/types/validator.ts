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
 * Resolves a module by id. The seam exists so the missing-module branch can be driven by a test:
 * express-validator is installed in every environment that runs the suite, which makes the `catch`
 * unreachable in-process. Without this seam the fail-closed behaviour can only be asserted against
 * source text — and a regex on the source cannot tell a `throw` from a `next()` (#4126 review P2).
 */
export type ModuleResolver = (id: string) => unknown

/**
 * Load express-validator. FAIL-CLOSED (#4126 review): express-validator is a declared PRODUCTION
 * dependency, and the declarative validation chains on the workflow / workflow-designer / PLM
 * routes are a security control. The previous no-op fallback silently disabled every one of those
 * chains when the module was absent — and the module was never declared anywhere, so validation was
 * fail-OPEN in every environment. A missing module is now a loud boot failure, never a silent
 * downgrade to "no validation".
 */
export function loadValidators(
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  resolve: ModuleResolver = require
): {
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
    validator = resolve('express-validator') as typeof validator
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
