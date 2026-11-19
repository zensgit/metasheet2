// Test-only load hook. It rewrites one bcryptjs ESM file. The increment runs
// later, on the main thread, inside that rewritten source.

import { fileURLToPath, pathToFileURL } from 'node:url'

const NEEDLE = 'export function compare('
const SAVED = 'function __saAuditSavedCompare('

const TAIL = `
function compare(password, hashValue, callback, progressCallback) {
  var observe = globalThis[Symbol.for('metasheet.security-action-audit-bcrypt-observe')];
  if (typeof observe !== 'function') throw new Error('compare observer missing');
  observe();
  return Reflect.apply(__saAuditSavedCompare, this, arguments);
}
export { compare };
`

let targetUrl = ''

function bareFileUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return ''
    parsed.search = ''
    parsed.hash = ''
    return pathToFileURL(fileURLToPath(parsed)).href
  } catch {
    return ''
  }
}

function sourceText(result) {
  const source = result && result.source
  if (typeof source === 'string') return source
  if (source instanceof ArrayBuffer) return new TextDecoder().decode(source)
  if (ArrayBuffer.isView(source)) {
    return new TextDecoder().decode(new Uint8Array(source.buffer, source.byteOffset, source.byteLength))
  }
  return ''
}

export function initialize(data) {
  const candidate = data && typeof data.esmUrl === 'string' ? data.esmUrl : ''
  const bare = bareFileUrl(candidate)
  if (bare.length === 0) throw new Error('compare observer missing')
  targetUrl = bare
}

export async function load(url, context, nextLoad) {
  if (targetUrl.length === 0) throw new Error('compare observer missing')
  const loaded = await nextLoad(url, context)
  if (bareFileUrl(url) !== targetUrl) return loaded
  const source = sourceText(loaded)
  if (source.includes(SAVED)) return loaded
  if (!loaded || loaded.format !== 'module' || source.indexOf(NEEDLE) < 0 || source.indexOf(NEEDLE) !== source.lastIndexOf(NEEDLE)) {
    throw new Error('bcrypt compare export was not observed')
  }
  return {
    format: 'module',
    shortCircuit: true,
    source: source.replace(NEEDLE, SAVED) + TAIL,
  }
}
