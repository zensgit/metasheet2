// G-B2-16 (benchmark §7.2) — 金额大写回显. PURE util (no .vue / Element Plus import) so it runs
// under the approval-web-guard vitest gate. Words are ALWAYS derived from the same rounding the
// backend total-check uses (round-half-up at the field's declared scale via `numberFieldScale`'s
// contract — the caller passes the already-scale-rounded value); the words layer additionally
// rounds to 2 decimals (角/分 is inherently a 2-decimal vocabulary) — when the field scale
// exceeds 2 the caption is therefore an approximation of the stored value, which is why the view
// only renders it for the template-declared amount total (scale ≤ 2 in practice).

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'] as const
const UNIT_IN_GROUP = ['', '拾', '佰', '仟'] as const
const GROUP_UNITS = ['', '万', '亿', '万亿'] as const

/** 0..9999 → words within one 万-group; '' for 0. Collapses inner zero runs to a single 零. */
function groupToWords(group: number): string {
  let out = ''
  let pendingZero = false
  for (let pos = 3; pos >= 0; pos -= 1) {
    const digit = Math.floor(group / 10 ** pos) % 10
    if (digit === 0) {
      if (out) pendingZero = true
      continue
    }
    if (pendingZero) {
      out += '零'
      pendingZero = false
    }
    out += DIGITS[digit] + UNIT_IN_GROUP[pos]
  }
  return out
}

/**
 * Number → Chinese uppercase currency words（人民币大写）.
 * - NaN / non-finite / non-number → '' (caller renders nothing).
 * - |value| ≥ 1e13 → '' (beyond the supported 万亿 vocabulary; honest omission beats a wrong caption).
 * - Negatives carry a 负 prefix. 0 → 零圆整. Fraction rounds half-up to 角/分.
 */
export function amountToChineseWords(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  const negative = value < 0
  const abs = Math.abs(value)
  if (abs >= 1e13) return ''
  // Work in 分 (integer minor units) to dodge float artifacts: 10.10 → 1010分.
  const totalFen = Math.round(abs * 100)
  const yuan = Math.floor(totalFen / 100)
  const jiao = Math.floor((totalFen % 100) / 10)
  const fen = totalFen % 10

  let yuanWords = ''
  if (yuan > 0) {
    const groups: number[] = []
    let rest = yuan
    while (rest > 0) {
      groups.push(rest % 10000)
      rest = Math.floor(rest / 10000)
    }
    let needZeroJoin = false
    for (let gi = groups.length - 1; gi >= 0; gi -= 1) {
      const group = groups[gi]!
      if (group === 0) {
        // An all-zero middle group means the NEXT non-zero lower group needs a 零 join.
        if (yuanWords) needZeroJoin = true
        continue
      }
      const words = groupToWords(group)
      // A lower group starting under 仟 (i.e. < 1000) after content needs a 零 join: 1000500 →
      // 壹佰万零伍佰. So does any content after an all-zero group.
      if (yuanWords && (needZeroJoin || group < 1000)) yuanWords += '零'
      needZeroJoin = false
      yuanWords += words + GROUP_UNITS[gi]
    }
    yuanWords += '圆'
  }

  let fraction = ''
  if (jiao > 0) fraction += DIGITS[jiao] + '角'
  if (fen > 0) {
    // 角位为零但有分：零分 needs the explicit 零 only when 圆 exists (壹圆零伍分), not for 伍分 alone.
    if (jiao === 0 && yuan > 0) fraction += '零'
    fraction += DIGITS[fen] + '分'
  }

  let out: string
  if (yuan === 0 && !fraction) out = '零圆整'
  else if (!fraction) out = yuanWords + '整'
  else if (yuan === 0) out = fraction
  else out = yuanWords + fraction

  return (negative ? '负' : '') + out
}
