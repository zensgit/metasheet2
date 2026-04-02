# Run 27 Start PM2 Remote Path Hotfix Verification

## Commands

```bash
git diff --check
bash -n scripts/ops/attendance-onprem-package-build.sh
bash -n scripts/ops/attendance-onprem-package-verify.sh
rg -n --fixed-strings -- '-RootDir "%~dp0."' scripts/ops/attendance-onprem-package-build.sh
rg -n 'Resolve-RootDirPath|Trim\\(\\)\\.Trim' scripts/ops/attendance-onprem-start-pm2.ps1 scripts/ops/attendance-onprem-deploy-run.ps1
```

## Results

- `git diff --check`: pass
- `bash -n` on both packaging scripts: pass
- build template now emits `-RootDir "%~dp0."` for both `start-pm2.bat` and `deploy-run*.bat`
- both PowerShell entrypoints now normalize quoted `RootDir` input before path resolution

## Notes

- A synthetic package verify attempt exposed a local shell harness problem during ad hoc archive construction, not a repository script parse failure. I kept the recorded verification to deterministic checks that map directly to the issue's root cause and to the new packaging gate.
