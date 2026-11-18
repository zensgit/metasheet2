# Phase 5 histogram declaration whitespace verification — 2026-10-01

Status: local synthetic PASS; actual scheduled-target attribution remains OPEN.
Code commit: `d3b356f1e6033c6afd6471ee57a673dee772080e`; tree: `b9861c9dc64be0f806f624a05964922ea621f99a`. The parent `9d1fbdd1adeb8660aa3ebb67f846e35c931f393b` keeps its original four-test CI evidence; those checks do not cover this new code.

The histogram declaration census previously required fixed single spaces. A tab-separated declaration and an indented declaration with multiple/trailing spaces were reported as `absent_family`, although the [Prometheus text format](https://prometheus.io/docs/instrumenting/exposition_formats/#line-format) accepts that horizontal whitespace. The bounded recognizer now classifies all six required latency entries as `declared_empty`. It does not alter histogram samples, percentile calculation, selectors, thresholds, request count or the failure verdict when samples are missing.

The new regression first failed on the old parser (one selected test, exit 1), with all six entries wrongly undeclared. After the fix, `node --test scripts/ops/phase5-required-samples-contract.test.mjs` passed 5 tests, zero failed/skipped, exit 0. `node --test scripts/ops/phase5-cache-hit-rate-contract.test.mjs` passed 4 neighbor tests, zero failed/skipped, exit 0. The parser's targeted NodeNext TypeScript check and `git diff --check` passed. The existing unconditional `synthetic-contract` CI job already executes this entire test file. Repository ESLint configs cover application/package code; no root-script lint lane is claimed.

An independent read-only review bound to the immutable code commit passed, independently reran the new regression (1 passed, zero failed/skipped), and confirmed acceptance of horizontal whitespace/CRLF plus refusal of cross-line and extra-token declarations. No source was changed during that review.

Ignored evidence is retained in `artifacts/timemachine-phase5-type-whitespace-20261001/`, including the failed reproduction, full focused/neighbor logs, commands, source hashes and manifest. No raw live scrape, URL, authentication material or customer values are in the new diagnostic field.

This fixes a format edge; current prom-client output normally uses canonical spaces, so it is not attributed as the cause of the existing scheduled failures. Their actual target, deployed SHA, registration, labels and sample state still require authorized same-scrape evidence. New exact-head CI is pending publication. Draft/HOLD, owner-selected staging assurance and separate deployment/flag boundaries remain in force.
