export interface AttendanceWallTimeChoice {
  instant: string
  offsetLabel: string
}

export interface AttendanceWallTimeResult {
  kind: 'unique' | 'fold' | 'gap' | 'invalid'
  choices: AttendanceWallTimeChoice[]
}

// Same offset probes and exact round-trip discipline as W4 strict time.
// Unlike the multitable editor, attendance never picks a fold or repairs a gap.
export function resolveAttendanceWallTime(local: string, timezone: string): AttendanceWallTimeResult {
  const invalid: AttendanceWallTimeResult = { kind: 'invalid', choices: [] }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(local)
  if (!match || !timezone || /\s/.test(timezone) || /^[+-]/.test(timezone)) return invalid
  const fields = match.slice(1, 6).map(Number).concat(Number(match[6] ?? '0'))
  const milliseconds = Number((match[7] ?? '').padEnd(3, '0'))
  const epoch = (parts: number[]) => {
    const date = new Date(0)
    date.setUTCFullYear(parts[0], parts[1] - 1, parts[2])
    date.setUTCHours(parts[3], parts[4], parts[5], 0)
    return date.getTime()
  }
  const wholeSecondWall = epoch(fields)
  const wall = wholeSecondWall + milliseconds
  const check = new Date(wall)
  if (fields[0] < 1 || check.getUTCFullYear() !== fields[0] || check.getUTCMonth() + 1 !== fields[1]
    || check.getUTCDate() !== fields[2] || check.getUTCHours() !== fields[3]
    || check.getUTCMinutes() !== fields[4] || check.getUTCSeconds() !== fields[5]) return invalid
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
  } catch { return invalid }
  const partsAt = (instant: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]))
    return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key => Number(parts[key]))
  }
  const offsets = new Set<number>()
  for (const probe of [wholeSecondWall - 26 * 3600000, wholeSecondWall, wholeSecondWall + 26 * 3600000]) {
    const offset = epoch(partsAt(probe)) - probe
    if (Math.abs(offset) < 24 * 3600000) offsets.add(offset)
  }
  const choices = [...offsets].flatMap(offset => {
    const instant = wall - offset
    if (!partsAt(instant).every((part, index) => part === fields[index])) return []
    const seconds = Math.abs(offset) / 1000
    const pad = (value: number) => String(value).padStart(2, '0')
    const offsetLabel = 'UTC' + (offset < 0 ? '-' : '+')
      + pad(Math.floor(seconds / 3600)) + ':' + pad(Math.floor(seconds % 3600 / 60))
      + (seconds % 60 ? ':' + pad(seconds % 60) : '')
    return [{ instant: new Date(instant).toISOString(), offsetLabel }]
  }).sort((a, b) => a.instant.localeCompare(b.instant))
  if (choices.length > 2) return invalid
  return { kind: choices.length === 0 ? 'gap' : choices.length === 1 ? 'unique' : 'fold', choices }
}
