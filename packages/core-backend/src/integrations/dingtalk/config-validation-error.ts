/**
 * R-41: a developer-authored sentence about the caller's DingTalk admin-config input — an Agent ID that is not
 * 1-32 digits, an integration that does not exist, a public app URL that is not absolute http(s). Shaped like
 * the directory's DirectoryValidationError: the admin routes show its message as it is (it never carries
 * provider, transport or database-driver text), while every other failure on those routes is reduced to the
 * route's fixed sentence or to DingTalk's numeric code (directory/directory-failure-text.ts).
 *
 * Its own module, not a class inside work-notification-settings.ts / approval-card-config.ts, so a test that
 * replaces either of those modules with a factory still sees the real class the routes check with `instanceof`.
 */
export class DingTalkConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DingTalkConfigValidationError'
  }
}
