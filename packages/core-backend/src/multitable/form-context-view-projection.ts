/**
 * #2730 — form-context view projection.
 *
 * `GET /api/multitable/form-context` echoes the view to callers that include ANONYMOUS
 * public-form submitters. `view.config` is freeform (`Record<string, unknown>`) and carries
 * `publicForm` secrets (`publicToken` / `allowedUserIds` / `allowedMemberGroupIds`), so echoing
 * it leaks those to anonymous callers.
 *
 * A key blacklist (strip only `publicForm`) is forward-UNSAFE: any future secret-bearing
 * config key would silently leak. Instead this projects to a top-level whitelist and DROPS
 * `config` entirely.
 *
 * This is safe because NO form-context consumer reads `view.config`:
 *  - the public form (`PublicMultitableFormView`) reads only `view.name` + `view.id`;
 *  - the authenticated standalone form (`MultitableWorkbench.loadStandaloneForm`) reads only
 *    `fields` / `fieldPermissions` / `viewPermissions` / `rowActions` / `record` / etc.;
 *  - the DingTalk public-form link-warnings read `publicForm` from the views LIST
 *    (`/views`), NOT from form-context.
 *
 * Scope: applied ONLY to the form-context echo. The `/views`, `/view`, create, and update
 * routes intentionally keep echoing `config` — that is where admins (and the link-warnings)
 * legitimately read `publicForm`.
 */
export function projectFormContextView<T extends { config?: unknown }>(view: T): Omit<T, 'config'> {
  // Drop `config` wholesale (whitelist of config keys needed by form-context consumers = none).
  const { config: _omittedConfig, ...rest } = view
  return rest
}
