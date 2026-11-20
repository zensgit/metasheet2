export function withoutUnverifiedAttendance(permissions: string[]): string[] {
  return permissions.filter(code => typeof code === 'string' && !code.trim().startsWith('attendance:') && code.trim() !== '*:*')
}
