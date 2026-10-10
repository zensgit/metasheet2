import { apiPathHasPrefix } from '../auth/api-path-policy'

/** Shared router/observation boundary. This policy conveys no authorization. */
export const YIDA_OWNER_HTTP_PREFIX = '/api/integration/yida-owner-send'

/** Cover the whole owner subtree, including requests refused before routing. */
export function isYidaOwnerHttpObservationPath(path: string): boolean {
  return apiPathHasPrefix(path, YIDA_OWNER_HTTP_PREFIX)
}
