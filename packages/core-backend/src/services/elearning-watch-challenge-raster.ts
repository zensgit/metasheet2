import { deflateSync } from 'node:zlib'

export const ELEARNING_WATCH_CHALLENGE_RASTER_WIDTH = 360 as const
export const ELEARNING_WATCH_CHALLENGE_RASTER_HEIGHT = 260 as const

export interface ElearningWatchChallengeRasterOption {
  optionId: string
  x: number
  y: number
  width: number
  height: number
}

interface SnapshotOption {
  optionId: string
  label: string
}

const SYMBOLS = ['●', '▲', '■', '◆', '★', '♥'] as const
const OPTION_RE = /^(●|▲|■|◆|★|♥)([1-9])$/u
const OPTION_WIDTH = 92
const OPTION_HEIGHT = 62
const OPTION_X = [24, 134, 244] as const
const OPTION_Y = [112, 186] as const

const SEGMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '1': ['b', 'c'],
  '2': ['a', 'b', 'g', 'e', 'd'],
  '3': ['a', 'b', 'g', 'c', 'd'],
  '4': ['f', 'g', 'b', 'c'],
  '5': ['a', 'f', 'g', 'c', 'd'],
  '6': ['a', 'f', 'g', 'e', 'c', 'd'],
  '7': ['a', 'b', 'c'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  '9': ['a', 'b', 'c', 'd', 'f', 'g'],
})

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  CRC_TABLE[index] = value >>> 0
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff
  for (const byte of value) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(kind: string, data: Buffer): Buffer {
  const type = Buffer.from(kind, 'ascii')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.allocUnsafe(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])))
  return Buffer.concat([length, type, data, checksum])
}

function setPixel(
  pixels: Buffer,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  if (x < 0 || y < 0 || x >= ELEARNING_WATCH_CHALLENGE_RASTER_WIDTH
    || y >= ELEARNING_WATCH_CHALLENGE_RASTER_HEIGHT) return
  const offset = (y * ELEARNING_WATCH_CHALLENGE_RASTER_WIDTH + x) * 4
  pixels[offset] = color[0]
  pixels[offset + 1] = color[1]
  pixels[offset + 2] = color[2]
  pixels[offset + 3] = color[3]
}

function fillRect(
  pixels: Buffer,
  x: number,
  y: number,
  width: number,
  height: number,
  color: readonly [number, number, number, number],
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) setPixel(pixels, column, row, color)
  }
}

function drawBorder(pixels: Buffer, x: number, y: number, width: number, height: number): void {
  const border = [94, 113, 142, 255] as const
  fillRect(pixels, x, y, width, 2, border)
  fillRect(pixels, x, y + height - 2, width, 2, border)
  fillRect(pixels, x, y, 2, height, border)
  fillRect(pixels, x + width - 2, y, 2, height, border)
}

function drawSymbol(pixels: Buffer, symbol: string, centerX: number, centerY: number, size: number): void {
  const ink = [19, 36, 61, 255] as const
  const radius = Math.floor(size / 2)
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      let draw = false
      if (symbol === '●') draw = x * x + y * y <= radius * radius
      else if (symbol === '▲') draw = y >= -radius && y <= radius && Math.abs(x) <= (y + radius) / 2
      else if (symbol === '■') draw = Math.abs(x) <= radius && Math.abs(y) <= radius
      else if (symbol === '◆') draw = Math.abs(x) + Math.abs(y) <= radius
      else if (symbol === '★') {
        const angle = Math.atan2(y, x) + Math.PI / 2
        const distance = Math.sqrt(x * x + y * y)
        const arm = Math.cos(5 * angle) >= 0 ? radius : radius * 0.45
        draw = distance <= arm
      } else if (symbol === '♥') {
        const nx = x / radius
        const ny = -y / radius
        const heart = (nx * nx + ny * ny - 0.75) ** 3 - nx * nx * ny * ny * ny
        draw = heart <= 0
      }
      if (draw) setPixel(pixels, centerX + x, centerY + y, ink)
    }
  }
}

function drawDigit(pixels: Buffer, digit: string, x: number, y: number, scale: number): void {
  const ink = [26, 103, 214, 255] as const
  const horizontal = 5 * scale
  const vertical = 6 * scale
  const thick = Math.max(2, scale)
  const segments: Record<string, [number, number, number, number]> = {
    a: [x, y, horizontal, thick],
    b: [x + horizontal - thick, y, thick, vertical],
    c: [x + horizontal - thick, y + vertical, thick, vertical],
    d: [x, y + 2 * vertical - thick, horizontal, thick],
    e: [x, y + vertical, thick, vertical],
    f: [x, y, thick, vertical],
    g: [x, y + vertical - Math.floor(thick / 2), horizontal, thick],
  }
  for (const name of SEGMENTS[digit] ?? []) {
    const [left, top, width, height] = segments[name]!
    fillRect(pixels, left, top, width, height, ink)
  }
}

function parseLabel(label: string): { symbol: string; digit: string } {
  const match = OPTION_RE.exec(label)
  if (!match || !SYMBOLS.includes(match[1] as (typeof SYMBOLS)[number])) {
    throw new Error('invalid_watch_challenge_raster_input')
  }
  return { symbol: match[1], digit: match[2] }
}

function drawLabel(pixels: Buffer, label: string, x: number, y: number, large: boolean): void {
  const parsed = parseLabel(label)
  drawSymbol(pixels, parsed.symbol, x, y, large ? 22 : 16)
  drawDigit(pixels, parsed.digit, x + (large ? 28 : 22), y - (large ? 14 : 10), large ? 3 : 2)
}

function encodePng(pixels: Buffer): Buffer {
  const rowBytes = ELEARNING_WATCH_CHALLENGE_RASTER_WIDTH * 4
  const raw = Buffer.allocUnsafe((rowBytes + 1) * ELEARNING_WATCH_CHALLENGE_RASTER_HEIGHT)
  for (let y = 0; y < ELEARNING_WATCH_CHALLENGE_RASTER_HEIGHT; y += 1) {
    const target = y * (rowBytes + 1)
    raw[target] = 0
    pixels.copy(raw, target + 1, y * rowBytes, (y + 1) * rowBytes)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(ELEARNING_WATCH_CHALLENGE_RASTER_WIDTH, 0)
  header.writeUInt32BE(ELEARNING_WATCH_CHALLENGE_RASTER_HEIGHT, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function renderElearningWatchChallengeRaster(input: {
  targets: readonly [string, string]
  options: readonly SnapshotOption[]
}): {
  imagePngBase64: string
  imageWidth: typeof ELEARNING_WATCH_CHALLENGE_RASTER_WIDTH
  imageHeight: typeof ELEARNING_WATCH_CHALLENGE_RASTER_HEIGHT
  options: ElearningWatchChallengeRasterOption[]
} {
  if (input.options.length !== 6 || new Set(input.options.map((option) => option.optionId)).size !== 6) {
    throw new Error('invalid_watch_challenge_raster_input')
  }
  const labels = input.options.map((option) => option.label)
  if (new Set(labels).size !== 6 || input.targets.some((target) => !labels.includes(target))) {
    throw new Error('invalid_watch_challenge_raster_input')
  }
  const pixels = Buffer.alloc(
    ELEARNING_WATCH_CHALLENGE_RASTER_WIDTH * ELEARNING_WATCH_CHALLENGE_RASTER_HEIGHT * 4,
    255,
  )
  drawLabel(pixels, input.targets[0], 115, 52, true)
  drawLabel(pixels, input.targets[1], 235, 52, true)
  fillRect(pixels, 176, 35, 8, 34, [120, 135, 158, 255])
  const options = input.options.map((option, index) => {
    const column = index % 3
    const row = Math.floor(index / 3)
    const x = OPTION_X[column]!
    const y = OPTION_Y[row]!
    drawBorder(pixels, x, y, OPTION_WIDTH, OPTION_HEIGHT)
    drawLabel(pixels, option.label, x + 34, y + 31, false)
    return { optionId: option.optionId, x, y, width: OPTION_WIDTH, height: OPTION_HEIGHT }
  })
  const png = encodePng(pixels)
  if (png.length > 64 * 1024) throw new Error('invalid_watch_challenge_raster_output')
  return {
    imagePngBase64: png.toString('base64'),
    imageWidth: ELEARNING_WATCH_CHALLENGE_RASTER_WIDTH,
    imageHeight: ELEARNING_WATCH_CHALLENGE_RASTER_HEIGHT,
    options,
  }
}
