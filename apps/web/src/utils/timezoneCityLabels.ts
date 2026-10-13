/**
 * Display names for IANA zones when the attendance UI is Chinese.
 * The submitted value stays the IANA id. Unlisted zones keep the id
 * rather than a guessed translation.
 * Asia/Shanghai is 北京 (中国标准时间), not the city in the identifier.
 */
const TIMEZONE_CITY_LABELS_ZH: Record<string, string> = {
  'Africa/Cairo': '开罗',
  'Africa/Johannesburg': '约翰内斯堡',
  'Africa/Lagos': '拉各斯',
  'Africa/Nairobi': '内罗毕',
  'America/Anchorage': '安克雷奇',
  'America/Argentina/Buenos_Aires': '布宜诺斯艾利斯',
  'America/Bogota': '波哥大',
  'America/Chicago': '芝加哥',
  'America/Denver': '丹佛',
  'America/Los_Angeles': '洛杉矶',
  'America/Mexico_City': '墨西哥城',
  'America/New_York': '纽约',
  'America/Phoenix': '凤凰城',
  'America/Sao_Paulo': '圣保罗',
  'America/Toronto': '多伦多',
  'America/Vancouver': '温哥华',
  'Asia/Bangkok': '曼谷',
  'Asia/Chongqing': '北京',
  'Asia/Colombo': '科伦坡',
  'Asia/Dhaka': '达卡',
  'Asia/Dubai': '迪拜',
  'Asia/Harbin': '北京',
  'Asia/Hong_Kong': '香港',
  'Asia/Ho_Chi_Minh': '胡志明市',
  'Asia/Jakarta': '雅加达',
  'Asia/Jerusalem': '耶路撒冷',
  'Asia/Karachi': '卡拉奇',
  'Asia/Kolkata': '加尔各答',
  'Asia/Kuala_Lumpur': '吉隆坡',
  'Asia/Macau': '澳门',
  'Asia/Manila': '马尼拉',
  'Asia/Seoul': '首尔',
  'Asia/Shanghai': '北京',
  'Asia/Singapore': '新加坡',
  'Asia/Taipei': '台北',
  'Asia/Tokyo': '东京',
  'Asia/Urumqi': '乌鲁木齐',
  'Australia/Melbourne': '墨尔本',
  'Australia/Perth': '珀斯',
  'Australia/Sydney': '悉尼',
  'Europe/Amsterdam': '阿姆斯特丹',
  'Europe/Berlin': '柏林',
  'Europe/London': '伦敦',
  'Europe/Madrid': '马德里',
  'Europe/Moscow': '莫斯科',
  'Europe/Paris': '巴黎',
  'Europe/Rome': '罗马',
  'Europe/Stockholm': '斯德哥尔摩',
  'Pacific/Auckland': '奥克兰',
  'Pacific/Honolulu': '檀香山',
}

export function timezoneCityLabel(timeZone: string | null | undefined): string | null {
  const normalized = String(timeZone || '').trim()
  if (!normalized) return null
  return TIMEZONE_CITY_LABELS_ZH[normalized] || null
}
