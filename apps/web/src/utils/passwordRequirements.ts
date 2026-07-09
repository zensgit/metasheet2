export type PasswordRequirementLocale = 'zh' | 'en'

export type PasswordRequirementCopy = {
  title: string
  items: string[]
}

const PASSWORD_REQUIREMENTS_ZH: PasswordRequirementCopy = {
  title: '密码要求',
  items: [
    '8-128 位字符',
    '至少包含 1 个小写字母',
    '至少包含 1 个大写字母',
    '至少包含 1 个数字',
    '不要包含 password、123456、qwerty、abc123、letmein、admin 等常见弱口令片段',
  ],
}

const PASSWORD_REQUIREMENTS_EN: PasswordRequirementCopy = {
  title: 'Password requirements',
  items: [
    '8-128 characters',
    'At least 1 lowercase letter',
    'At least 1 uppercase letter',
    'At least 1 number',
    'Do not include common weak patterns such as password, 123456, qwerty, abc123, letmein, or admin',
  ],
}

export function getPasswordRequirementCopy(locale: PasswordRequirementLocale): PasswordRequirementCopy {
  return locale === 'zh' ? PASSWORD_REQUIREMENTS_ZH : PASSWORD_REQUIREMENTS_EN
}
