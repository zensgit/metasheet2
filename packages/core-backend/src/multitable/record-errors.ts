export class MultitableRecordValidationError extends Error {
  code = 'VALIDATION_ERROR'
}

export class MultitableRecordNotFoundError extends Error {
  code = 'NOT_FOUND'
}
