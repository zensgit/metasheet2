/** Logical creation identity: the server-read row unique key (`idempotencyKey`) and the single split project number. */
export interface YidaMaterialCodeInput {
  readonly keyValue: string
  readonly projectNo: string
}
export type YidaMaterialCodeErrorCode =
  | 'YIDA_MATERIAL_CODE_INPUT'
  | 'YIDA_MATERIAL_CODE_KEY_VALUE'
  | 'YIDA_MATERIAL_CODE_PROJECT_NO'
export class YidaMaterialCodeError extends Error {
  constructor(kind?: 'INPUT' | 'KEY_VALUE' | 'PROJECT_NO')
  code: YidaMaterialCodeErrorCode
}
export const YIDA_MATERIAL_CODE_GENERATOR: 'material-code-v1'
export const YIDA_MATERIAL_CODE_PREFIX: 'WLBH-'
export const YIDA_MATERIAL_CODE_NAME_TAG: 'metasheet.stock-prep.yida-material-code'
export const YIDA_MATERIAL_CODE_NAME_VERSION: 'v1'
export const YIDA_MATERIAL_CODE_NAMESPACE_V1: '6d37f698-e75c-4b5e-8eef-b702478a1cfb'
export const YIDA_MATERIAL_CODE_LENGTH: 41
export const YIDA_MATERIAL_CODE_INPUT_MAX_UNITS: 4096
export function yidaMaterialCodeSha1(bytes: Uint8Array): Uint8Array
export function yidaMaterialCodeUuidV5(namespace: string, nameBytes: Uint8Array): string
export function yidaMaterialCodeName(input: YidaMaterialCodeInput): Uint8Array
export function generateYidaMaterialCode(input: YidaMaterialCodeInput): string
export function isYidaMaterialCodeFormat(value: unknown): value is string
