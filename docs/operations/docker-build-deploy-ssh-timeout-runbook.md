# Docker Build deploy-job SSH timeout runbook

## Symptom this runbook addresses

The main-push workflow **Build and Push Docker Images**
(`.github/workflows/docker-build.yml`) finishes the `build` job cleanly
(backend image build + frontend image build + "Set packages to private"
all succeed), but the downstream `deploy` job fails at the very first
step:

- failing step: `Sync deploy host files`
  (`.github/workflows/docker-build.yml:71`)
- failing command: the first `ssh` inside that step
  (`.github/workflows/docker-build.yml:86`)
- failing error shape:

  ```text
  ssh: connect to host <redacted> port 22: Connection timed out
  deploy_rc missing; failing deploy job.
  ```

This is a **TCP-level reachability failure on port 22 from the GitHub
Actions runner to the deploy host**. It is not an authentication failure,
not a sshd config failure, not a key rotation failure. The TCP handshake
itself does not complete.

Tracking issue: #1772
(first observed on workflow run `26293551077`, after PR #1771 merged at
`d23472167`).

## Prerequisites for the operator

- Read access to the GitHub Actions run log for the failing
  `Sync deploy host files` step.
- Network / firewall access to the side that controls the deploy host's
  inbound rules (cloud security group, on-prem firewall, NAT router).
- A control workstation (or any host you control) from which you can
  run `ssh -v` against the deploy host - used as a sanity check before
  declaring "host reachable".
- Permission to **Re-run failed jobs** on the workflow run.

You do **not** need to rotate the deploy SSH key for a connection
timeout; rotating mid-incident only confuses the diagnosis.

## Discipline: do not echo secrets while debugging

When following this runbook, do NOT:

- copy / paste / Slack the literal `DEPLOY_HOST`, `DEPLOY_USER`,
  `DEPLOY_PATH`, or the decoded deploy SSH key,
- attach the base64'd SSH key to any ticket,
- log into the deploy host with the deploy key and then
  `cat ~/.ssh/authorized_keys` into chat,
- screenshot a terminal that has the host or user value in the prompt.

Use placeholders (`<deploy-host>`, `<deploy-user>`, `<deploy-path>`) in
written notes. The `ssh: connect to host <redacted> port 22: Connection
timed out` line that the workflow already emits is the canonical
sanitized form - copy that, not your terminal.

## Operator checklist

Run these in order. The first one that fails is the cause; do not move
on. Each item names the value to check and how to check it without
disclosing the value.

### 1. DNS / IP resolution

The workflow uses `DEPLOY_HOST` as supplied. If `DEPLOY_HOST` is a name
(not a literal IP), confirm it resolves to the **current** address of
the deploy host - a stale A record points the runner at an IP that no
longer answers.

- On any workstation: `host <deploy-host>` or `dig +short <deploy-host>`.
- Compare the resolved IP with the deploy host's current public IP as
  shown in the cloud console / on-prem inventory. They must match. Do
  not paste either value into chat - just confirm equality.
- If `DEPLOY_HOST` is a literal IP, skip this step.

If the answer is wrong: update DNS, wait TTL, then move to step 8
(rerun).

### 2. Deploy host is up

The deploy host must be powered on and the OS must be reachable on a
non-SSH path you control (cloud console serial console, vendor web
console, ICMP from a peer).

- Cloud: confirm the instance state is `running` and the boot has
  completed.
- On-prem: confirm the box is on, NIC is up.
- If the host is down: bring it up, then go to step 6.

### 3. TCP/22 reachability from outside the deploy host's network

The GitHub-hosted runner reaches the host from a public address.
Confirm port 22 is reachable from outside the deploy host's own LAN
**before** doing any auth check.

- From a workstation that is on the **public Internet**
  (not the same LAN, not the same VPN): run
  `nc -vz -w 5 <deploy-host> 22`. Expect `succeeded` / `connected`.
  Do not print the host value in chat.
- `timed out` here means the port is firewalled or the host's NIC
  drops the SYN. Move to step 4.
- `refused` here means SSHd is not listening on 22. Move to step 6.

### 4. Cloud security group / on-prem firewall / NAT

Port 22/TCP from the runner to the host must be allowed end to end.
This is the most common cause of the timeout shape this runbook
addresses.

- Cloud security group / network ACL: confirm an inbound rule allows
  TCP/22 from the runner-side address space (see step 5).
- On-prem firewall (router / pf / iptables): confirm a corresponding
  allow rule on the WAN-facing interface and that connection tracking
  is healthy.
- NAT / port-forward: confirm port 22 still forwards to the deploy
  host's private IP, and the deploy host's private IP has not changed.
- Recent change: scan the deploy host's security group / firewall
  change log for any change in the last 24h. A timeout right after a
  group/policy edit is almost always the edit.

### 5. GitHub runner outbound IP ranges

GitHub-hosted runners egress from a published CIDR set. If the deploy
host's inbound is **allowlisted to specific source IPs**, the runner's
current outbound range must be in the allowlist.

- Pull the current CIDR set:

  ```bash
  curl -s https://api.github.com/meta | jq -r '.actions[]' | head
  ```

- Confirm the deploy host's security group / firewall allowlists at
  least the CIDRs the workflow's runners egress from (the published
  `actions` list).
- The published list changes; do not cache it. Re-pull whenever the
  workflow starts failing right after a GitHub Actions IP roll.
- If the deploy host's inbound is open to `0.0.0.0/0` on port 22,
  this step is not the cause - move to step 6.

### 6. SSH service on the deploy host

If TCP/22 reaches the host but the deploy job still times out, sshd may
be reachable but not responsive. (`refused` is sshd-not-listening;
`timed out` is sshd-blocked or sshd-hung.)

- From a console session on the deploy host (cloud console / serial /
  out-of-band - **not** SSH): `systemctl status sshd` (or `ssh` on
  systems using that unit name). Expect `active (running)` and a
  recent successful start.
- Confirm sshd is bound to the expected port (`grep -E '^Port' /etc/ssh/sshd_config`).
  If `Port 22` is commented and a different port is configured, the
  workflow times out because it dials `:22`.
- If sshd is hung: restart it (`systemctl restart sshd`).

### 7. Deploy user / deploy key (only if steps 1-6 are clean)

A timeout shape **does not** indicate a key or user problem - those
return `Permission denied (publickey)` or `Permission denied (publickey,password)`
instead. If you have already verified 1-6 and the timeout persists,
spot-check these anyway:

- Deploy user account exists on the host and has not been locked
  (`getent passwd <deploy-user>` on the host - run inside an out-of-band
  console; do not paste the username back).
- The deploy user's `~/.ssh/authorized_keys` has not been truncated or
  rewritten. Compare its size / mtime against your last known-good
  snapshot. Do not paste the file content.
- The deploy key in the GitHub secret has not been rotated without
  updating `authorized_keys`. If the workflow log shows `Permission
  denied` instead of `Connection timed out`, that is the case - use a
  different runbook for key rotation.

### 8. Manual `ssh -v` verification

This is the single most useful step once you believe steps 1-7 are
green. Reproduce the workflow's connection shape from a workstation
that egresses from approximately the same address space as a
GitHub-hosted runner, or from a runner-local sanity workflow.

From a control workstation (placeholders only - do not paste real
values):

```bash
ssh -vv -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=no \
    -o IdentitiesOnly=yes \
    -i ~/.ssh/<deploy-key-file> \
    <deploy-user>@<deploy-host> 'echo ok'
```

Read the `-vv` lines:

- `OpenSSH ...` / `Reading configuration data ...` - sanity, ignore.
- `Connecting to <deploy-host> port 22.` then nothing for ~30s
  followed by `Connection timed out` - this matches the workflow
  failure shape. Network is the cause; loop back to steps 3-5.
- `Connection established. ... Server signature` - host reachable;
  the workflow's earlier timeout was transient. Move to step 9.
- `Permission denied (publickey)` - host reachable, key/user wrong;
  not this runbook's failure mode.

If you need to reproduce from a GitHub-hosted runner exactly (because
your workstation has different egress), use a small sanity workflow
that runs the same `ssh -o ConnectTimeout=10 ...` against the host
**after** decoding the same deploy key, and inspect its log. Do not
add a debug step to `docker-build.yml` itself.

### 9. When to rerun failed jobs

Only rerun after you have **identified the cause** (one of steps 1-8
returned a definitive answer) and the cause is fixed.

- In the GitHub UI for the failing run, click **Re-run failed jobs**.
  This re-uses the `build` job's already-pushed images (no rebuild) and
  only re-runs the `deploy` job - cheap.
- For the run cited in #1772: `26293551077`.
- If the rerun fails at the same `Sync deploy host files` step with
  the same `Connection timed out` text, the cause was **not** fixed -
  loop back to step 3.

Do not rerun more than twice for the same root cause; further reruns
add noise without information.

## Out of scope

This runbook covers **TCP/22 reachability from the runner to the
deploy host**. Out of scope:

- workflow file changes (the workflow itself is fine when the host is
  reachable),
- deploy SSH key rotation (a separate runbook),
- application runtime / DB / API behavior,
- Bridge Agent / Data Factory / K3 WISE / SQL Server work,
- customer GATE state.

This runbook does not touch `plugins/plugin-integration-core`,
`packages/core-backend`, `apps/web`, any DB migration, or any external
system API. It is operator documentation only.

## Related workflows and runs

- Workflow: `Build and Push Docker Images` -
  `.github/workflows/docker-build.yml` (`name:` on line 1, `deploy:`
  job starts at line 64, `Sync deploy host files` step at line 71).
- Tracking issue: #1772.
- First failing run: workflow run `26293551077` after the
  `d23472167` main commit (`fix(multitable): hint when calendar
  holidays are unsynced`, PR #1771). The PR itself did not change
  deploy-host infrastructure.
