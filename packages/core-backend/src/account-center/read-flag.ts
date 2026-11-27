export function isAccountCenterReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ACCOUNT_CENTER_READ_ENABLED === 'true'
}
