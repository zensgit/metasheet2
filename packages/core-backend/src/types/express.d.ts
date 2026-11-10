/**
 * Global Express type extensions
 *
 * This file extends the Express Request interface to include common
 * properties added by middleware (e.g., authentication, user info).
 *
 * Note: The user type is intentionally flexible to accommodate various
 * auth middleware implementations across the codebase.
 */

import type { VerifiedTenantClaim } from '../auth/verified-tenant-claim'

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
        tenantId?: string
        email?: string
        name?: string
        role?: string
        roles?: string[]
        department?: string
        permissions?: string[]
        [key: string]: unknown
      }

      /** Tenant claim carried by the verified session token, before header fallback. */
      authenticatedTenantId?: string

      /**
       * Claim-presence of the signature-verified JWT tenant field.
       * A missing field is not legacy-private admission. Header backfill of `user.tenantId`
       * does not change this value.
       */
      verifiedTenantClaim?: VerifiedTenantClaim

      /**
       * Request ID for tracing/logging purposes.
       */
      requestId?: string

      /**
       * End-to-end correlation id populated by the correlation middleware.
       * Echoed back to callers via the `X-Correlation-ID` response header.
       */
      correlationId?: string

      /**
       * Timestamp when the request was received.
       */
      startTime?: number
    }
  }
}

// This export is required to make this a module
export {}
