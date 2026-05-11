# DingTalk Screenshot Handoff Development

## Summary

Integrated the DingTalk screenshot archive helper into the final DingTalk P4 handoff chain. The final packet can now include a redaction-safe screenshot archive and optionally require it to pass strict validation before release handoff.

## Scope

- `scripts/ops/export-dingtalk-staging-evidence-packet.mjs`
- `scripts/ops/validate-dingtalk-staging-evidence-packet.mjs`
- `scripts/ops/dingtalk-p4-final-handoff.mjs`
- Direct tests for exporter, validator, final handoff, and screenshot archive.

## Behavior

The packet exporter now supports:

```bash
--include-screenshot-archive <dir>
--require-screenshot-archive-pass
```

The final handoff command forwards the same options:

```bash
node scripts/ops/dingtalk-p4-final-handoff.mjs \
  --session-dir <session-dir> \
  --output-dir <packet-dir> \
  --include-screenshot-archive <screenshot-archive-dir> \
  --require-screenshot-archive-pass
```

When enabled, the exporter copies the screenshot archive to:

```text
screenshot-archive/NN-<archive-name>
```

The packet manifest records:

- `requireScreenshotArchivePass`
- `includedScreenshotArchive`
- `screenshotArchiveStatus.status`
- `screenshotArchiveStatus.screenshotCount`
- archive `manifest.json` and `README.md` references

## Strict Gate

Strict screenshot archive validation requires:

- Archive directory exists.
- `manifest.json` exists and has `tool = dingtalk-screenshot-archive`.
- `manifest.status = pass`.
- `screenshotCount > 0`.
- `README.md` exists.
- `copiedScreenshots.length` matches `screenshotCount`.
- Every screenshot `archivePath` stays inside the archive directory.
- Every referenced screenshot file exists.
- Every screenshot has a SHA-256 digest that matches the copied file.

## Security Notes

- Existing secret scanning still runs over the full packet.
- Screenshot archive metadata must stay redacted; raw screenshots remain restricted artifacts because image pixels can contain personal or operational data.
- The new gate validates archive structure and file hashes; it does not OCR screenshot content.
