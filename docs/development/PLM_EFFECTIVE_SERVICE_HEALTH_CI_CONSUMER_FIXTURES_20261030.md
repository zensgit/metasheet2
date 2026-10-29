# Existing deploy fixture receipt compatibility

Test-source commit: `3edf3e3d301e8000ab195e43503f629c01fab947`. Published parent: `952bb9218dd1eb8a44dcc72ae2c31c64e7a37e3f`. Product source remains `dcf2a81342cff2f6d3513a46850a9d0ef03ccbac`. This is a local follow-up closeout prepared before the next Draft update.

The first Node 20.20.2 readiness CI on Draft #6649 ran 101 tests: 94 PASS and 7 FAIL. The effective-service module's 26 methods and manager module's 67 methods passed. Two older tests supplied successful bootstrap substitutes without the new receipt, stopping seven cases before their intended login/logging or readiness assertions.

Both substitutes now emit the optional three-NUL-field receipt before their successful exit. All existing assertions, real curl calls, 30-attempt loop and 10-second timers are retained. The product scripts, workflow and 93 passing test-source methods remain unchanged.

The old transport method could record PASS when receipt refusal stopped the wrapper before readiness. The startup test now captures stderr and requires the exact readiness-exhaustion diagnosis for that mode. Reverting only the bootstrap receipt while retaining this assertion produces a meaningful RED at the new cause check; every older assertion passes first.

| Local Node 24.14.1 observation | Result |
|---|---|
| Old bootstrap with strengthened transport cause check | 1 target RED; exit 1; 2402.609 ms |
| Fixed private command-log methods | 3 PASS; exit 0; 4343.058 ms |
| Fixed startup methods, including the directly affected transport method | 5 PASS; exit 0; 5477.883 ms |

The three processes had empty stderr; the retained 10-second timers did not terminate these cases. Source hashes stayed fixed, and the owned launch HOME/TMPDIR were empty and removed. The earlier 93 passing methods were not manually replayed. The bounded direct-consumer audit covered 18 on-prem operations tests: four actual wrapper callers are handled, with one additional literal match only creating a package-path placeholder.

These tests use real curl against owned ephemeral loopback Node HTTP fixtures. Bootstrap, admin and health domain bodies remain substitutes. This qualifies the named transport and credential-output contracts; actual application HTTP/PG, service installation, browser and business acceptance remain separate open layers.

The [compact evidence](../../artifacts/plm-effective-service-health-20261030/ci-consumer-fixture-verification.json) records hashes, exact selected patterns and independent source/effect/result review. The [initial design and validation record](PLM_EFFECTIVE_SERVICE_HEALTH_HANDOFF_20261030.md) remains unchanged. Follow-up current-head Node 20 CI is pending the next Draft update; the whole engineering goal remains open.
