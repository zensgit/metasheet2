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

export type DingTalkMessageConfigErrorCode =
  | 'integration_not_found'
  | 'integration_inactive'
  | 'integration_tuple_incomplete'

/**
 * Raised by the integration-scoped work-notification credential resolver (work-notification-settings.ts
 * resolveDingTalkMessageTuple, only reachable while DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED is
 * 'true'): the named integration row is missing, not active, or the source chosen for the credential
 * tuple is incomplete. The message names the integration id, the field names and the source — never a
 * key, secret or agent id value — so it can be recorded in delivery ledgers as it is.
 *
 * A subclass of DingTalkConfigValidationError so the admin routes keep showing its sentence unchanged,
 * and defined here (not inside the settings module) so a test that replaces that module with a factory
 * still sees the class the workers check with `instanceof`. The attendance delivery worker classifies it
 * as non-retryable by `instanceof`, not by matching words in the message.
 */
export class DingTalkMessageConfigError extends DingTalkConfigValidationError {
  readonly code: DingTalkMessageConfigErrorCode

  constructor(code: DingTalkMessageConfigErrorCode, message: string) {
    super(message)
    this.name = 'DingTalkMessageConfigError'
    this.code = code
  }
}
