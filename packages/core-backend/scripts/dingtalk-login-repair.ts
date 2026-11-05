/**
 * Operator-only private-file workflow. No proof or credential is printed; only a fixed refusal code
 * leaves the process. This entry imports nothing that reaches the connection pool: the pool reads
 * DB_QUERY_TIMEOUT once when it is constructed, so the body is loaded only after the timeout gate.
 * The output guard is installed first: the application logger (stdout), library warnings and Node's
 * uncaught-exception trace never reach the operator's streams.
 */
import { guardRepairProcess, runRepairCli } from '../src/auth/dingtalk-identity-repair-cli'

const io = guardRepairProcess(process)
runRepairCli(process.argv.slice(2), process.env, {
  load: () => import('./dingtalk-login-repair-main'),
  stdout: io.stdout,
  stderr: io.stderr,
}).then(io.exit, io.crash)
