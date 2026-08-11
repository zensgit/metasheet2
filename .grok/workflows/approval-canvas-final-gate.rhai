let meta = #{
    name: "approval-canvas-final-gate",
    description: "Unattended gate for approval Canvas final-eligibility + residual parallel PLAN 6fa2fbf6 (form history / dual canvas / G5-C CI smoke): residual ledger, focused tests, flag defaults, no product-FINAL overclaim (post #4806 merge on main)",
    phases: [
        #{ title: "Scan", detail: "ledger + MD honesty + residual OPEN items" },
        #{ title: "Test", detail: "web authoring + backend flag/number canaries" },
        #{ title: "Structure", detail: "D0 edge+/palette/list structural pins" },
        #{ title: "Verify", detail: "flags OFF + docs do not overclaim FINAL" },
    ],
    when_to_use: "After approval canvas commits on main, before claiming ENGINEERING-READY, or when re-checking post-#4806 land",
};

let scan_schema = #{
    "type": "object",
    "required": ["summary", "blockers", "open_prs"],
    "properties": #{
        "summary": #{ "type": "string" },
        "blockers": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 12 },
        "open_prs": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 8 },
    },
};

let test_schema = #{
    "type": "object",
    "required": ["passed", "commands", "notes"],
    "properties": #{
        "passed": #{ "type": "boolean" },
        "commands": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 12 },
        "notes": #{ "type": "string" },
    },
};

let structure_schema = #{
    "type": "object",
    "required": ["ok", "checks"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "checks": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 16 },
    },
};

let verify_schema = #{
    "type": "object",
    "required": ["flags_default_off", "overclaims_product_final", "evidence"],
    "properties": #{
        "flags_default_off": #{ "type": "boolean" },
        "overclaims_product_final": #{ "type": "boolean" },
        "evidence": #{ "type": "string" },
    },
};

phase("Scan");
let scan = agent(
    "Read with read_file/grep only: "
        + "docs/development/approval-canvas-remaining-engineering-design-20260808.md (ledger table + PR Plan statuses), "
        + "docs/development/approval-canvas-data-closure-final-eligibility-development-20260808.md, "
        + "docs/development/approval-canvas-data-closure-final-eligibility-verification-20260808.md status lines. "
        + "Summarize DONE vs OPEN vs BLOCKED. "
        + "open_prs must list only OPEN execute-plan nodes (e.g. PR3, PR4) not DONE ones. "
        + "blockers = owner-only items that prevent product FINAL (G0, UAT, flags) plus any OPEN engineering still required for ENGINEERING-READY if regressions appear on main. "
        + "If #4806 is MERGED and ledger shows all engineering PRs DONE, open_prs must be empty. "
        + "Do not invent blockers.",
    #{
        label: "scan-residuals",
        capability_mode: "read-only",
        output_schema: scan_schema,
    },
);

phase("Test");
let test_panel = parallel([
    #{
        label: "web-authoring-tests",
        capability_mode: "execute",
        output_schema: test_schema,
        prompt: "From repo root run exactly (one command): "
            + "pnpm --filter @metasheet/web exec vitest run --watch=false "
            + "tests/approval-authoring-history.test.ts "
            + "tests/approval-g5c-authoring-scenarios.test.ts "
            + "tests/approval-canvas-commands.test.ts "
            + "tests/approval-form-commands.test.ts "
            + "tests/approval-template-authoring-canvas-inspector.spec.ts "
            + "tests/approval-graph-topology-edit.test.ts "
            + "tests/approvalTemplateAuthoring.spec.ts "
            + "tests/ui-foundation-style-guard.spec.ts. "
            + "Set passed=true only if exit code 0. Put the exact command in commands[]. Short result in notes.",
    },
    #{
        label: "backend-flag-number",
        capability_mode: "execute",
        output_schema: test_schema,
        prompt: "From repo root run exactly: "
            + "pnpm --filter @metasheet/core-backend exec vitest run --watch=false "
            + "tests/unit/approval-canvas-flag.test.ts "
            + "tests/unit/approval-fwb-number-mapping-gate.test.ts. "
            + "Set passed=true only if exit 0. Record command and notes.",
    },
]);

phase("Structure");
let structure = agent(
    "Structural pins via grep/read_file only on apps/web/src/views/approval/TemplateAuthoringView.vue: "
        + "(1) data-testid approval-canvas-edge-insert present; "
        + "(2) data-testid approval-field-palette present; "
        + "(3) data-testid approval-canvas-inspector-topology present; "
        + "(4) class template-authoring__canvas-node-actions must NOT appear as an active template class on canvas nodes "
        + "(absence of class=\"template-authoring__canvas-node-actions\" is required); "
        + "(5) 辅助编辑模式 present; "
        + "(6) canvasViewMode default 'canvas'. "
        + "Set ok=true only if all hold. checks[] one line per pin with pass/fail.",
    #{
        label: "structure-d0",
        capability_mode: "read-only",
        output_schema: structure_schema,
    },
);

phase("Verify");
let verify = agent(
    "Adversarially verify product claims. Use grep/read_file on: "
        + "apps/web/src/stores/featureFlags.ts DEFAULT_FEATURES, "
        + "packages/core-backend/src/services/approval-canvas-flag.ts, "
        + "docs/development/approval-canvas-data-closure-final-eligibility-verification-20260808.md, "
        + ".github/workflows/approval-web-guard.yml (must list approval-authoring-history and approval-g5c-authoring-scenarios), "
        + "apps/web/scripts/run-required-web-tests.sh (same tokens). "
        + "flags_default_off=true only if approvalCanvasV2/approvalFwbWriteback/approvalAttachments default false "
        + "and isApprovalCanvasV2Enabled requires env === 'true'. "
        + "overclaims_product_final=true if verification MD claims product FINAL without owner UAT/flags. "
        + "Otherwise overclaims_product_final=false. evidence must quote paths read.",
    #{
        label: "adversarial-verify",
        capability_mode: "read-only",
        output_schema: verify_schema,
    },
);

let web_ok = false;
let be_ok = false;
if test_panel.len() > 0 && test_panel[0] != () && test_panel[0].success {
    web_ok = test_panel[0].output.passed == true;
}
if test_panel.len() > 1 && test_panel[1] != () && test_panel[1].success {
    be_ok = test_panel[1].output.passed == true;
}
let structure_ok = structure != () && structure.success && structure.output.ok == true;
let flags_ok = verify != () && verify.success && verify.output.flags_default_off == true;
let honest = verify != () && verify.success && verify.output.overclaims_product_final == false;
let ready = web_ok && be_ok && structure_ok && flags_ok && honest;

let report = "approval-canvas-final-gate ready=" + ready.to_string()
    + " web_ok=" + web_ok.to_string()
    + " be_ok=" + be_ok.to_string()
    + " structure_ok=" + structure_ok.to_string()
    + " flags_ok=" + flags_ok.to_string()
    + " honest_docs=" + honest.to_string()
    + " product_final=false"
    + " tracking_pr=https://github.com/zensgit/metasheet2/pull/4806";
if scan != () && scan.success && scan.output.summary != () {
    report += " scan=" + scan.output.summary;
}
log(report);

let path = write_scratch_file("approval-canvas-final-gate-report.md", report);
complete(#{
    path: path,
    ready: ready,
    engineering_ready: ready,
    product_final: false,
    tracking_pr: "https://github.com/zensgit/metasheet2/pull/4806",
    report: report,
});
