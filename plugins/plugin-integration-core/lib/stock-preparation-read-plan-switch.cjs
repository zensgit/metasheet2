'use strict'

// THE OPERATOR SWITCH FOR ONLINE READ PLANS (SA-02). Default OFF; exact literal 'true' only (no trim, no case
// folding), read PER CALL by the route module (so a test that shadows the route module's `process` controls it).
// Off, the plugin behaves as if no online read plan exists anywhere:
// - the eight read-plan management routes answer 404 READ_PLAN_MANAGEMENT_DISABLED after the admin gate and
//   before any IO (list and get included, so the web can follow the read's answer);
// - execution never reads an activation pointer (the read-plan tables are not touched, so a build deployed
//   before migration 089 runs does not fail the pull path); work minted while the switch was on is refused
//   before any IO and left unconsumed: a dry-run token no longer matches the recomposed deployment action
//   (TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH), a stored large-BOM job stage still carries its read-plan execution
//   identity (READ_PLAN_ACTIVATION_MISSING);
// - the registration comparison is the deployment action's alone; the unconfigured source preflight skips its
//   pointer probe;
// - the source-binding read reports `onlineReadPlansEnabled: false`, and the web hides the management section.
// Turning it off deletes nothing: turned on again, the still-active pointer executes at once.
// Case-insensitive project comparison configured in the DEPLOYMENT action is unaffected: it is server config,
// not an online plan.
const ONLINE_READ_PLANS_ENABLED_ENV = 'MULTITABLE_STOCK_PREP_ONLINE_READ_PLANS_ENABLED'

function stockPreparationOnlineReadPlansEnabled(env = process.env) {
  return Boolean(env) && env[ONLINE_READ_PLANS_ENABLED_ENV] === 'true'
}

module.exports = { ONLINE_READ_PLANS_ENABLED_ENV, stockPreparationOnlineReadPlansEnabled }
