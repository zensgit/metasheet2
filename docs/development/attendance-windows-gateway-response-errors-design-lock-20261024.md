# Attendance Windows gateway response-error repair — design lock (2026-10-24)

## Problem and scope
An upstream HTTP response can close after headers or a partial body. The received gateway listens for errors on the upstream request, but only pipes the upstream response into the client response. A partial response then remains pending until the client cancels. Reuse the existing error handler for upstream response errors: keep the current502JSON before headers and destroy an incomplete downstream response after headers. Never retry a potentially mutating request.

This Draft adds the previously untracked gateway script as reviewable source. It does not wire the script into any package, service, start script or deployment. The complete base-to-head diff includes the source import; the attached zero-context patch isolates the small semantic repair relative to the received deployed-script text (apply to an isolated baseline copy with git apply --unidiff-zero). No new timeouts, method conversion, flags, logging or configuration.

## Provenance and older work
The operator supplied the original9797-byte file hash in the evidenceJSON. The received text is9799bytes and has a different separately recorded hash; original byte identity and the installed Windows module were not independently verified. The imported fixed source differs from the validated candidate only by normalizing trailing blank lines to one final newline; both hashes are recorded.

Open prototypes #4634(head66a980357078f9d243fd4b025b080ac9aca9fa21) and #4745(head043851d3db7bb8d4b4514af3b1354265f9b2cdf3) contain the older gateway, not current main. Compared with those prototypes, the received text already permits explicit0.0.0.0 listening while retaining default loopback and loopback-only HTTP backend. That pre-existing received behavior is retained, not newly enabled in an environment. No older PR commit stack, package lane or deployment workflow is imported. Future integration with either older Draft requires an explicit source UNION review.

## Reproduce and verify
Run on Node20:
```sh
node --test --test-reporter=tap scripts/ops/attendance-windows-native-gateway.test.mjs
```
Eight tests cover PUT method/path/body, OPTIONS forwarding, the existing502shape, upstream abort after headers, upstream abort after partial body, NUL-padded response passthrough, static GET/PUT behavior and loopback backend restriction. They execute explicitly in the requiredtest(20.x) workflow. No frontend capability is changed.

The matching failure can be reproduced by removing just
`proxyRes.on('error', onProxyError)` from an isolated module copy and selecting:
```sh
ATTENDANCE_WINDOWS_GATEWAY_MODULE=/absolute/path/to/isolated-module-copy.mjs   node --test --test-reporter=tap   --test-name-pattern '^closes a partial upstream response without waiting for the cutoff$'   scripts/ops/attendance-windows-native-gateway.test.mjs
```
The1500ms cutoff belongs to the test observer, not the gateway. The original source and the listener-removal copy each fail exactly the selected case;7filtered cases are excluded, not passes. The fixed whole file has8passes/0failures/0skips. Both red executions have OS exit1; fixed execution has OS exit0. Existing observation logs, TAP logs and OS exit receipts remain in the owned remote artifacts; the values-free evidenceJSON records exact counts and hashes.

| Gate | Result |
|---|---|
| Received source / fixed candidate provenance | Distinct original/received hashes recorded; candidate hash verified |
| Original partial-response failure | 1matching failure,0pass,7filtered exclusions |
| Whole regression file | 8pass,0fail,0skip; exit0 |
| Remove response-error listener | 1matching failure,0pass,7filtered exclusions |
| Required CI invocation | Explicit whole-file command in plugin-tests.yml; remote terminal result still pending |
| pnpm validate:all | exit0;13valid manifests,9pre-existing warnings; lint/type-check complete |
| Historical08:00request root cause | OPEN; this repair is not claimed causal |
| Windows installed runtime / real UAT | Not executed |
| Deployment / online config / R71 | Unchanged |

## Historical incident boundary and next evidence
The reported2026-10-23 morning incident ran run225 commit42984091d7fe0e4f81ac026243200840c314bb79. Its backend request log runs after CORS and JSON parsing: absence is not full ingress proof. Later diagnostic PUT arrivals do not identify the original browser request. The synthetic NUL-padded page can pass through this gateway unchanged; this does not identify the historical page source. In the original partial-abort observer, the client's eventualECONNRESET follows its own observation-cutoff cancellation; it is not evidence of the historical reset.

Need existing exact client time/tool/duration/error-phase data and whether the page/reset belong to the same request. Do not enable online logging, replay a real shift update, deploy or modify R71 to collect this evidence. Stream/lifecycle remainOFF; realUAT and business error50004 remain excluded.
