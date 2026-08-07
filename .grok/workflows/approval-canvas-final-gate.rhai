let meta = #{
    name: "approval-canvas-final-gate",
    description: "Unattended regression gate for approval Canvas final-eligibility engineering: tests, flag defaults, no product-FINAL overclaim",
    phases: [
        #{ title: "Scan", detail: "inventory residuals and MD claims" },
        #{ title: "Test", detail: "focused web + backend unit gates" },
        #{ title: "Verify", detail: "adversarial check flags OFF and docs honesty" },
    ],
    when_to_use: "After approval canvas commits or before claiming ENGINEERING-READY / FINAL eligibility",
};

let scan_schema = #{
    "type": "object",
    "required": ["summary", "blockers"],
    "properties": #{
        "summary": #{ "type": "string" },
        "blockers": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 12 },
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
    "Read docs/development/approval-canvas-data-closure-final-eligibility-development-20260808.md "
        + "and docs/development/approval-canvas-remaining-engineering-design-20260808.md and "
        + "docs/development/approval-canvas-v2-interaction-design-lock-20260721.md status lines. "
        + "Use read_file/grep only. Summarize remaining engineering vs owner-only gates. "
        + "List blockers that prevent product FINAL (UAT, flags, G0). Do not invent blockers.",
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
        prompt: "From repo root run exactly: "
            + "pnpm --filter @metasheet/web exec vitest run --watch=false "
            + "tests/approval-authoring-history.test.ts "
            + "tests/approval-g5c-authoring-scenarios.test.ts "
            + "tests/approval-canvas-commands.test.ts "
            + "tests/approval-form-commands.test.ts "
            + "tests/approval-template-authoring-canvas-inspector.spec.ts "
            + "tests/approval-graph-topology-edit.test.ts. "
            + "Set passed=true only if exit code 0 and report said tests passed. "
            + "Put the exact command in commands[]. Put a short result summary in notes.",
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

phase("Verify");
let verify = agent(
    "Adversarially verify product claims. Use grep/read_file on: "
        + "apps/web/src/stores/featureFlags.ts DEFAULT_FEATURES, "
        + "packages/core-backend/src/services/approval-canvas-flag.ts, "
        + "docs/development/approval-canvas-data-closure-final-eligibility-verification-20260808.md. "
        + "flags_default_off=true only if approvalCanvasV2/approvalFwbWriteback/approvalAttachments default false "
        + "and isApprovalCanvasV2Enabled requires env === 'true'. "
        + "overclaims_product_final=true if any verification MD claims product FINAL without owner UAT/flags. "
        + "Otherwise overclaims_product_final=false. evidence must quote file paths you read.",
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
let flags_ok = verify != () && verify.success && verify.output.flags_default_off == true;
let honest = verify != () && verify.success && verify.output.overclaims_product_final == false;
let ready = web_ok && be_ok && flags_ok && honest;

let report = "approval-canvas-final-gate ready=" + ready.to_string()
    + " web_ok=" + web_ok.to_string()
    + " be_ok=" + be_ok.to_string()
    + " flags_ok=" + flags_ok.to_string()
    + " honest_docs=" + honest.to_string();
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
    report: report,
});
