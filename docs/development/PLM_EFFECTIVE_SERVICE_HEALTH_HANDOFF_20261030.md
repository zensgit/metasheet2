# Effective service identity for on-prem health verification

Source: `dcf2a81342cff2f6d3513a46850a9d0ef03ccbac`. Stacked parent: Draft #6575, `7a4e073fa6d256e6e8c015e74e8115d93f021641`. Local validation used Node 24.14.1 and Bash 3.2.57 on macOS; the existing CI job is configured for Node 20. Main integration remains pending.

## Problem and change

The update and bootstrap children load `ENV_FILE` after the existing build phases. That file can select a service manager and process name. The upgrade and deploy wrappers previously checked their caller-side identity, so successful service actions could be followed by a check of a different service.

Each wrapper now owns a private temporary receipt. The child captures its optional output path before the original single configuration load and writes the effective manager, PM2 name and systemd name after its original phases succeed. The format is exactly three NUL-terminated fields with EOF immediately afterward. Parsing never sources or evaluates the receipt. Health receives the raw triple and validates the selected name before probing. Direct health calls retain their existing defaults; upgrade health-off explicitly clears any inherited receipt option.

The loader phase and configuration precedence stay in the existing child. Parsed fields use private wrapper variables, preserving the original admin, login, readiness and token gates. Cleanup removes only the wrapper's own receipt and preserves an earlier failure; a cleanup failure after success returns nonzero. Both internal options are registered in the existing flag manifest. The existing readiness workflow gained the new test argument and its two path-filter entries.

Actual tests exposed a Bash 3.2 edge case: an input-open failure on a negated compound conditional can skip the refusal branch. Both parsers use a positive `if/else` conditional so a missing receipt reaches the same explicit rejection as malformed framing. The three reads, EOF rule and original error message remain intact.

## Actual verification

| Observation | Actual result |
|---|---|
| Original parent with actual loaders, env check and health under inert effects | Two identity equalities RED; two envgate controls PASS |
| First candidate, 23 selected methods | 19 PASS, 4 FAIL: three 8-second timeouts and an upgrade missing-receipt control returning zero |
| Added deploy missing-receipt control before the fix | One meaningful RED, no timeout; source and owned-removal trace assertions passed before the unexpected zero status |
| Pure Bash 3.2 controls | Negated missing-file case continued; positive conditional refused missing, empty and truncated inputs while accepting the valid three-field input |
| Final changed-source selection | 6 PASS, exit 0, 21364.744 ms; includes the four prior failures, added deploy control and a directly affected valid-receipt positive |
| Legacy wrapper selection, first run on this candidate | 12 PASS, exit 0, 19490.820 ms |

The final two runs had no timeout, cancellation, skip, stderr, source hash drift or residual owned HOME/TMPDIR entries. The original 8-second and legacy 5-second limits were retained. Eighteen earlier passing methods and the two unchanged envgate controls are reused under the independent applicability review. One earlier valid-receipt positive was rerun because its parser source changed. These are layered observations; the full new 26-method module and old 67-method module were not run as one local suite. Historical failures remain recorded.

The new fixture executes actual copied configuration loaders, env check and health scripts with inert service, migration and network commands. The legacy deploy fixture uses a cleared parent environment and a finite Node/host-utility fallback. Its child PATH is not fully private. Synthetic publish/admin substitutes and inline-parser stubs limit the conclusions to the named source contracts.

## Evidence and delivery boundary

The [compact verification record](../../artifacts/plm-effective-service-health-20261030/verification.json) pins the source inputs, selected patterns, counts, runtimes and independent report hashes. Source, effects, the three-line CI registration and actual result facts received separate independent review. Grok 4.7 xhigh was observed for the contract and fixture work. After that specific session became unavailable, implementation and review requested Sol 6.1 high; the tool did not separately return their actual profiles.

Current-head Node 20 CI remains pending publication. Real HTTP/PostgreSQL, builds, images, installed services, browser and business acceptance remain separate open layers. This change keeps the existing installation engine. The full engineering goal remains open, with all owner HOLDs preserved and delivery limited to Draft review.
