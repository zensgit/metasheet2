# Multitable Customer Delivery Sign-Off Template

Date: 2026-03-23  
Scope: customer or field delivery receipt for the multitable/platform package

## Delivery Metadata

- Customer:
- Delivery owner:
- Receiver:
- Delivered date:
- Package version:
- Release tag:
- On-prem gate stamp:
- Delivery bundle root:
- Verify reports attached:

## 1. Delivered Files

Confirm receipt of:

- [ ] `.tgz` package
- [ ] `.zip` package
- [ ] `.tgz.sha256`
- [ ] `.zip.sha256`
- [ ] `SHA256SUMS`
- [ ] package metadata `.json`
- [ ] verify reports

## 2. Delivered Docs

Confirm receipt of:

- [ ] Easy-start guide
- [ ] Package layout guide
- [ ] Customer delivery checklist
- [ ] Pilot quickstart
- [ ] UAT sign-off template

## 3. Environment Confirmation

| Item | Confirmed | Notes |
| --- | --- | --- |
| Target host or IP provided | [ ] |  |
| PostgreSQL available | [ ] |  |
| Redis available | [ ] |  |
| `JWT_SECRET` prepared | [ ] |  |
| Attachment storage path prepared | [ ] |  |
| Ubuntu or WSL operator available | [ ] |  |

## 4. Delivery Notes Read Back

Confirm these were explicitly communicated:

- [ ] Upload complete is not the same as save complete
- [ ] Multitable entry route is `/multitable`
- [ ] People import mismatches can be repaired with `Select person` or `Select people`
- [ ] This package is for controlled rollout first

## 5. Next Action

- Planned install date:
- Planned UAT date:
- UAT owner:
- Follow-up owner:

## 6. Signatures

- Customer receiver:
- Delivery owner:
- Date:
