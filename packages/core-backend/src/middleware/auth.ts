/**
 * Authentication Middleware
 * Re-exports authentication middleware from jwt-middleware
 */

import { jwtAuthMiddleware } from '../auth/jwt-middleware'

/**
 * Authentication middleware - alias for jwtAuthMiddleware
 */
export const authenticate = jwtAuthMiddleware

/**
 * Auth middleware - alias for jwtAuthMiddleware (used in some routes)
 */
export const authMiddleware = jwtAuthMiddleware

export default authenticate
