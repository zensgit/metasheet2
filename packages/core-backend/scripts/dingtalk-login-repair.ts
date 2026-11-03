/**
 * Operator-only private-file workflow. No proof or credential is printed; only a fixed refusal code
 * leaves the process. This entry imports nothing that reaches the connection pool: the pool reads
 * DB_QUERY_TIMEOUT once when it is constructed, so the body is loaded only after the timeout gate.
 */
import { runRepairCli } from '../src/auth/dingtalk-identity-repair-cli'

runRepairCli(process.argv.slice(2), process.env, {
  load: () => import('./dingtalk-login-repair-main'),
  stdout: (s) => console.log(s),
  stderr: (s) => console.error(s),
}).then((code) => process.exit(code))
