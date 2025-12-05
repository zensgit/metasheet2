/**
 * Global Express type extensions
 *
 * This file extends the Express Request interface to include common
 * properties added by middleware (e.g., authentication, user info).
 *
 * Note: The user type is intentionally flexible to accommodate various
 * auth middleware implementations across the codebase.
 */

declare global {
  namespace Express {
    interface Request {
      /**
       * Authenticated user information, populated by auth middleware.
       * This property is optional as not all routes require authentication.
       * The type is flexible to support different auth implementations.
       */
      user?: {
        id?: string | number
        sub?: string // JWT subject claim (user ID)
        userId?: string // Alternative user ID field
        email?: string
        name?: string
        role?: string
        roles?: string[]
        department?: string
        permissions?: string[]
        [key: string]: unknown
      }

      /**
       * Request ID for tracing/logging purposes.
       */
      requestId?: string

      /**
       * Timestamp when the request was received.
       */
      startTime?: number
    }
  }
}

// This export is required to make this a module
export {}
