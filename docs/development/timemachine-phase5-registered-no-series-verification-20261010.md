# Time Machine Phase 5 registered-histogram diagnosis

Status: local diagnosis repair verified; exact-source remote CI, native
same-archive qualification and controlled staging acceptance remain open.

## Observed failure and current producer

The downloaded October 10 runs `38016567006`, `38016042926` and `38016184337`
each report five passing checks, no failed assertions, six unavailable latency
checks, empty percentiles and an overall failure. The validator deliberately
blocks on missing required latency samples; these results do not establish a
latency threshold breach or qualify the Time Machine archive worker.

A read-only investigation traced the configured metrics endpoint through its
Nginx web container, a literal Nginx variable and a unique shared-network backend
address. Both current containers declare revision
`d96ef4a6b8d7a82786a8a62237efff46442e3f38`; neither belongs to the staging project
identified for this Time Machine window. The web container's revision alone was
insufficient backend identity evidence and is superseded by this mapping.

Using the backend's dedicated metrics token inside that container produced an
HTTP 200 scrape without exporting the token or importing application modules.
The response contains both target histogram declarations but no bucket/count
series for snapshot create, snapshot restore or example-plugin reload. This
proves the current data source lacks those observations. It does not reconstruct
the historical second scrape or prove historical deployed identity. No business
traffic, snapshot mutation, plugin reload, deployment or flag change was used to
produce observations.

Private, values-free evidence is retained under
`artifacts/tm-staging-runtime-gap-preflight-20261010/`:

- `phase5-proxy-upstream-mapping-v2.private.json`: qualified current backend
  identity, proxy configuration digest and contained authenticated observation.
- `phase5-endpoint-container-role.private.json`: web/proxy role correction.
- Earlier unsuccessful contained commands targeted the proxy and are not
  authenticated-scrape or missing-metric evidence.

## Repair and verification

`scripts/phase5-metrics-percentiles.ts` now reports `family_no_series` when an
exact histogram TYPE declaration exists without bucket series. An undeclared
family retains `family_absent`; parsed zero-count histograms retain
`zero_samples`. The output still binds diagnosis to the second scrape digest.
No observation, percentile, threshold, assertion or exit policy is manufactured
or relaxed by this change.

The regression drives the full shell validator through two synthetic HTTP
scrapes. It checks the complete sampling shape and retains six unavailable
latency checks, five passing counter checks, empty percentiles and exit 1.

| Verification | Result |
| --- | --- |
| New regression before repair, targeted invocation | 1 failed; 13 other cases not selected |
| Entire required-samples and cache-counter contract files | 18 passed, 0 skipped |
| SSH host-key workflow contract, including the new workflow census | 12 passed, 0 skipped |
| Standalone percentile TypeScript check | PASS |
| `pnpm validate:all` | PASS; existing plugin warnings retained |
| Workflow YAML, test command and path wiring | PASS locally |
| Exact-source remote workflow execution | Not published or run |

The new `phase5-metrics-contract.yml` workflow runs the standalone typecheck and
both complete contract files on relevant pull-request and main changes. It does
not access deployment secrets or an external metrics endpoint.

## Remaining acceptance gates

The approved same-archive local lock still holds native retries pending the
historical platform review. The configuration window confirmed it has not
prepared an independently durable object-store test domain or staging KMS test
key. Concrete provider/custody selection and qualification, runtime injection,
exact-source remote CI, the owner-authorized staging flag/rollback window, and
actual staging and rollback evidence remain required. This diagnostic repair
does not complete the overall Time Machine goal.
