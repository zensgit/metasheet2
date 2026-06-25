# Multitable On-Prem Windows First-Hop Bootstrap Follow-Up (2026-06-24)

## Context

#3137 changed the current Windows deploy launcher and apply helper so default
staging uses `C:\ms-tmp` and zip extraction uses `.NET ZipFile` instead of
`Expand-Archive`. The entity-machine retest showed a remaining upgrade gap:
when an already-installed root still has an old `deploy.bat` / launcher, that
old first hop runs before the new package can take over. The observed staging
root stayed under the user temp directory and the zip first hop still used
`Expand-Archive`.

This slice addresses only that first-hop bootstrap gap.

## Implementation

- The package build now emits release sidecar assets next to the `.zip` and
  `.tgz` archives:
  - `<package>-deploy-bootstrap.ps1`
  - `<package>-deploy-bootstrap.bat`
- The PowerShell sidecar reuses the current
  `scripts/ops/multitable-onprem-deploy-launcher.ps1` implementation, so it
  gets the same `C:\ms-tmp` default, marker-based package-root detection, and
  `.NET ZipFile` extraction.
- The batch sidecar is a thin Windows wrapper with a parseable
  `[multitable-onprem-deploy-bootstrap] apply exit=N` marker.
- Both sidecars get `.sha256` files and entries in `SHA256SUMS`.
- Package metadata records the sidecar names.

## Boundary

This is deploy tooling only. It does not touch FOS apply logic, Path 2 apply,
production/canonical writes, K3, external writes, plugin runtime, database
schema, or option-sync semantics.

## Entity-Machine Retest

Use the sidecar only when the installed first hop is too old to reach the new
package's launcher:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\<package>-deploy-bootstrap.ps1 `
  -RootDir C:\path\to\installed\metasheet `
  -PackageArchive .\<package>.zip
```

Expected values-free evidence:

```text
bootstrapSidecarUsed=true
observedStagingRoot=C:\ms-tmp
zipObservedExpandArchiveAbsent=true
zipBootstrapDeployExit=0
tgzBootstrapDeployExit=0
apiHealthStatus=200
productionApplyExecuted=false
path2ApplyExecuted=false
k3Save=false
k3Submit=false
k3Audit=false
k3BomWrite=false
valuesFreeEvidence=true
```
