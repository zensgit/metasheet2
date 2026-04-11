# Delivery Method Standardization

Date: 2026-04-08

## Goal

Turn the delivery pattern already exercised on the DingTalk rollout and the multitable pilot into a reusable standard method instead of repeating the process ad hoc per line.

## Scope

Standardize these four layers:

1. verification stages
2. handoff artifact layout
3. on-prem rollout / evidence return contract
4. publish targets

This design does not change product runtime behavior. It defines the repeatable delivery process around runtime changes.

## Standard Stages

Every release-bound business slice should move through the same checkpoints:

1. local readiness
2. release-bound gate
3. real staging verification
4. on-prem rollout
5. handoff bundle publication
6. field preflight evidence return

Required meanings:

- `local readiness`
  proves the code path, focused smoke, and local operator contract.
- `release-bound gate`
  proves build, test, package, and canonical gate artifacts.
- `real staging verification`
  proves the actual public staging URL and real environment behavior.
- `on-prem rollout`
  proves the target host is actually running the intended build.
- `handoff publication`
  makes the package available through GitHub Release and the remote delivery directory.
- `field preflight evidence return`
  is the final boundary before checkpoint / expansion / UAT closeout / customer closeout.

## Standard Artifact Layout

Each final delivery bundle should contain:

- `README.md`
- `HANDOFF-SUMMARY.md`
- `pilot-ready/`
- `release-bound/`
- `onprem-gate/`
- `handoff/`
- `staging-verify/`

Required meanings:

- `README.md`
  quick entry for test / implementation / UAT.
- `HANDOFF-SUMMARY.md`
  canonical top-level decision and remaining boundary.
- `pilot-ready/`
  local readiness evidence.
- `release-bound/`
  release-bound gate evidence.
- `onprem-gate/`
  deployable package validation evidence.
- `handoff/`
  operator-facing combined packet.
- `staging-verify/`
  real staging rerun evidence, including smoke and any policy gates such as profile thresholds.

## Standard Publish Targets

Every final handoff line should publish to both:

1. GitHub Release
2. on-prem delivery directory

Required targets:

- GitHub Release
  for versioned download, traceability, and checksum distribution.
- remote delivery directory
  for field/operator access without requiring GitHub credentials on the target host.

Recommended remote path:

- `~/delivery/<package-name>`

## Standard Evidence Contract

No line should be called customer-complete until both field preflight artifacts are returned:

- `/opt/metasheet/output/preflight/<line>-preflight.json`
- `/opt/metasheet/output/preflight/<line>-preflight.md`

This contract should be repeated in:

- `HANDOFF-SUMMARY.md`
- `handoff/handoff.md`
- GitHub Release notes
- field/operator runbook

## Standard Status Vocabulary

To avoid ambiguous handoff language, use these fixed labels:

- `READY FOR HANDOFF`
- `functional staging verified`
- `staging release-bound verified`
- `customer sign-off pending returned preflight evidence`
- `customer sign-off complete`

Do not use `done` or `released` without saying which boundary has actually been crossed.

## Standard Follow-Up Handling

If functionally correct staging passes but policy gates fail, split the result:

- handoff can proceed when functional staging is green and the remaining blocker is explicitly scoped
- final release-bound status stays open until the gate is resolved

Once the remaining gate is closed, the same bundle should be updated in place instead of creating a second ambiguous handoff package.

## Immediate Next Step

Apply this standard method to future cross-system integrations, including DingTalk interoperability work, so each line is delivered with the same checkpoints, artifacts, rollout proof, and returned-evidence contract.
