# Collaboration hint public type — single source closeout

Source: `ddf18bbc99180e116656c1707fc46958e3577e79`.
Parent: `37516a0b3cd002c3d416e8f29f4415c2d2b539fc` (Draft #6531).

The panel's `PropType<unknown>` plus null default exposed a null-only public prop under vue-tsc 3.1.4. Workbench's validated `{bindingId, sourceKind}` hint therefore failed TS2322. One declaration now names that finite nullable shape. The runtime unknown-input validator, endpoints, authorization, pending-state comparisons and all other product files are unchanged.

Actual Grok 4.7 (xhigh) reproduced the full source type failure and implemented the one-line repair. Codex independently checked a complete current source copy with unchanged app compiler options: old bytes reproduced TS2322 (exit 2); repaired bytes passed (exit 0, empty output). Generated output paths stayed private, and Source plus shared generated-cache SHA/nanosecond mtimes were unchanged.

Codex independently reran the same 50 tests: 27 panel, 10 host, 13 adversarial controls; zero failures/errors/skips. Counts from overlapping historical runs are not added. Emitted ES2020 JavaScript, template and styles are byte-identical before/after the type declaration. All 14,099 protected paths match their baseline. No backend tests were rerun because no backend code changed.

Final evidence packet: `w23-entry-types-Root-final-qualified-20261024`, manifest SHA-256 `c6f8d7ac343f97bb0d1573c050df0583f224021e458dea62c5e38503235e83a7`.

Parent #6531 reached 22 terminal checks: 18 successful, three web-type failures with this same TS2322, and one existing private-Native checkout-token failure. Personal PostgreSQL steps skipped after types failed; missing JUnit upload is not PostgreSQL acceptance. No passed jobs were rerun or valuable runs cancelled.

Draft publication follows the parent terminal gate. New exact-head CI, real paired HTTP, browser, build/image/install provenance, original-frame hour and full engineering acceptance remain open. Native main/ECO coordination and Claude's RG/Stage A/#249 HOLD remain separate. No merge, deployment, production enablement, real business notification or issue closure is authorized by this source closeout.
