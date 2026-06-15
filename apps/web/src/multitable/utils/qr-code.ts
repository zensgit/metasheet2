/**
 * Typed, app-facing adapter over the vendored Nayuki QR encoder.
 *
 * The multitable `qrcode` field type is render-only: the stored cell value is a
 * plain string (a URL/text), and the UI renders that string as a QR image. This
 * module is the single place the rest of the frontend talks to the encoder, so
 * the vendored file (./vendor/qrcodegen.ts) stays pristine.
 *
 * Output is an SVG string (jsdom-testable, zero runtime deps) built from the
 * encoder's boolean module matrix — never a <canvas> (no canvas in jsdom).
 */
import { qrcodegen } from './vendor/qrcodegen'

export type QrErrorCorrection = 'low' | 'medium' | 'quartile' | 'high'

const ECC = {
  low: qrcodegen.QrCode.Ecc.LOW,
  medium: qrcodegen.QrCode.Ecc.MEDIUM,
  quartile: qrcodegen.QrCode.Ecc.QUARTILE,
  high: qrcodegen.QrCode.Ecc.HIGH,
} as const

export interface QrSvgOptions {
  /** Error-correction level. Defaults to 'medium' (~15% recovery). */
  ecc?: QrErrorCorrection
  /** Quiet-zone width in modules around the symbol. QR spec recommends 4. */
  border?: number
  /** Rendered edge length of the <svg> in pixels (width === height). */
  size?: number
  /** Foreground (dark module) colour. */
  dark?: string
  /** Background colour. */
  light?: string
}

/**
 * Encode `text` and return the QR symbol as a square boolean matrix where
 * `matrix[y][x] === true` marks a dark module. Throws if `text` is too long to
 * encode at the highest version for the chosen ECC level (matches the encoder).
 */
export function qrMatrixFromText(text: string, ecc: QrErrorCorrection = 'medium'): boolean[][] {
  const qr = qrcodegen.QrCode.encodeText(text, ECC[ecc])
  const size = qr.size
  const matrix: boolean[][] = []
  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = []
    for (let x = 0; x < size; x += 1) {
      row.push(qr.getModule(x, y))
    }
    matrix.push(row)
  }
  return matrix
}

/**
 * Render `text` as an SVG string sized to fill `options.size` pixels. Dark
 * modules are emitted as a single `<path>` so the markup stays compact. Returns
 * `null` for an empty/whitespace-only value (render-only fields show nothing).
 */
export function qrSvgFromText(text: string, options: QrSvgOptions = {}): string | null {
  const value = text.trim()
  if (value === '') return null

  const ecc = options.ecc ?? 'medium'
  const border = Math.max(0, options.border ?? 4)
  const pixelSize = Math.max(1, options.size ?? 120)
  const dark = options.dark ?? '#000000'
  const light = options.light ?? '#ffffff'

  const matrix = qrMatrixFromText(value, ecc)
  const moduleCount = matrix.length
  const dimension = moduleCount + border * 2

  const parts: string[] = []
  for (let y = 0; y < moduleCount; y += 1) {
    for (let x = 0; x < moduleCount; x += 1) {
      if (matrix[y][x]) {
        parts.push(`M${x + border},${y + border}h1v1h-1z`)
      }
    }
  }
  const pathData = parts.join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" ` +
    `width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges" ` +
    `role="img" class="meta-qr">` +
    `<rect width="${dimension}" height="${dimension}" fill="${light}"/>` +
    `<path d="${pathData}" fill="${dark}"/>` +
    `</svg>`
  )
}
