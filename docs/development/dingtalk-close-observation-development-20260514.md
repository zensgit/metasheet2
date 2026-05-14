# DingTalk Close Observation Development 2026-05-14

## Summary

This document records the development-side closeout decision for the DingTalk
integration line after the final runtime and documentation work landed on
`main`.

No runtime code, database schema, or DingTalk configuration is changed by this
close-observation package. The only repository change is to keep local generated
operator artifacts out of future worktree status noise.

## Current Mainline Evidence

- Current `origin/main`: `a921895333af7efbfabd5d75a3f210dde0adb7c3`
- Latest 142 backend image:
  `ghcr.io/zensgit/metasheet2-backend:a921895333af7efbfabd5d75a3f210dde0adb7c3`
- Latest 142 web image:
  `ghcr.io/zensgit/metasheet2-web:a921895333af7efbfabd5d75a3f210dde0adb7c3`
- Open PR count: `0`
- Latest DingTalk monitor signal:
  `DingTalk OAuth Stability Recording (Lite)` passed on `a921895333...`
- Latest DingTalk regression signal:
  `DingTalk P4 ops regression gate` passed in the latest mainline plugin test
  run.

## Closure Decision

DingTalk integration can move from active development to close observation.

Close observation means:

- no new DingTalk scope is accepted into the current delivery line;
- any new DingTalk issue must be triaged as production support or a separately
  planned enhancement;
- the current line can be formally archived if no P0/P1 DingTalk issue appears
  before the next business-day review.

Recommended formal archive time: `2026-05-15`, assuming the following remain
green:

- 142 `/api/health`;
- 142 web entry;
- DingTalk OAuth lite monitor;
- DingTalk P4 ops regression gate;
- no new failed group robot or work-notification delivery incident.

## Reopen Criteria

Reopen the DingTalk line only if one of these happens:

- DingTalk login or public-form auth regresses for a bound, enabled user;
- a valid group robot destination cannot be saved or tested;
- failure-alert delivery does not create audit/delivery evidence;
- rule creator work-notification fallback does not fire on a controlled failure;
- directory organization mirror cannot be opened by an admin after deployment;
- a real secret appears in Git, PR text, generated closeout docs, or chat logs.

## Non-Blocking Follow-Up

The following should stay outside the closed DingTalk delivery line unless a new
scope is explicitly opened:

- richer organization governance UI;
- shared organization-level robot directory;
- row/column-level task assignment;
- screenshot evidence archival beyond existing delivery/audit/API evidence.

## Repository Hygiene Change

The closeout package also adds ignore rules for generated local artifacts:

- `.claude/`
- `output/dingtalk-live-acceptance/`
- `output/delivery/multitable-onprem/`
- `output/releases/`

These paths are operator-local outputs, not source assets. Ignoring them keeps
future K3, Feishu, Attendance, and DingTalk branches from appearing dirty due to
generated bundles or local scratch state.
