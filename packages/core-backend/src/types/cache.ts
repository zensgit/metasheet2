/**
 * Unified Cache interface
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error }

export interface Cache {
  get<T = any>(key: string): Promise<Result<T | null>>
  set(key: string, value: any, ttl?: number): Promise<Result<void>>
  del(key: string): Promise<Result<void>>
  tags?: {
    invalidate(tag: string): Promise<Result<void>>
  }
}

