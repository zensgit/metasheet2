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
  | 'env_agent_id_invalid'

/**
 * Raised by the integration-scoped work-notification credential resolver (work-notification-settings.ts
 * resolveDingTalkMessageTuple, reached by readDingTalkMessageConfigFromRuntime while
 * DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED is 'true', and by the admin verification route through
 * readDingTalkIntegrationScopedMessageTuple whatever the switch says): the named integration row is missing
 * or not active, the source chosen for the credential tuple is incomplete, or the environment Agent ID that
 * would be sent is not 1-32 digits. The message names the integration id, the field / variable names and
 * the source — never a key, secret or agent id value — so it can be recorded in delivery ledgers as it is.
 *
 * That contract is GUARDED, not merely intended: the verification module (work-notification-verify.ts)
 * lists this class in an inline fixed-sentence allow-list of classifyDirectoryFailureText, which puts every
 * construction of it under tests/unit/directory-fixed-sentence-constructors.guard.test.ts — an argument that
 * reads a caught error's message / stack / cause, or a catch binding, reds that guard. The message reaches
 * the verification report body (a 200 report, not a 400) only through that classifier.
 *
 * A plain Error subclass, deliberately NOT a DingTalkConfigValidationError: the 400 responders of the admin
 * config routes list that class, and this one must never pass as "the caller's input was wrong" there —
 * on those routes it is reduced to the fixed sentence like any other failure. Defined here (not inside the
 * settings module) so a test that replaces that module with a factory still sees the class the workers and
 * the verification module check with `instanceof`. The attendance delivery worker classifies it as
 * non-retryable by `instanceof`, not by matching words in the message.
 */
export class DingTalkMessageConfigError extends Error {
  readonly code: DingTalkMessageConfigErrorCode

  constructor(code: DingTalkMessageConfigErrorCode, message: string) {
    super(message)
    this.name = 'DingTalkMessageConfigError'
    this.code = code
  }
}
