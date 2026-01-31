# Attendance Rule Template Library (2026-01-31)

## Goal
Build a **template library** for attendance rules so admins can quickly apply system defaults and then create **custom templates** per department/attendance group. This keeps the core engine stable while allowing business‑specific rules to evolve independently.

## System vs. Custom Rules
### System (built‑in templates)
These map to consistent, repeatable rules found in the DingTalk rules file and should remain available by default:
- **Group defaults**: rest‑day + business trip default overtime (单休车间)
- **General warnings**: overtime approvals without punches, travel/leave conflicts, low actual hours
- **Standard late/early warnings**
- **Missing punch checks**
- **Rest day overtime**
- **Role rules**: security/driver base hours and rest‑day overtime
- **Overtime verification**: late checkout without overtime, rest‑day punch without overtime

### Custom (user‑editable templates)
Business‑specific or exception rules that should be editable by admins:
- Special user fixed hours (VIP/driver/security overrides)
- Department‑only deviations (e.g. special sales rules)
- Adjusted overtime thresholds for specific shifts
- Any rule driven by company policy or local HR interpretation

## Templates Included
System templates now exposed via `/api/attendance/rule-sets/template`:
1. 单休车间规则
2. 通用提醒
3. 标准上下班提醒
4. 缺卡补卡核对
5. 休息日加班
6. 角色规则
7. 部门提醒
8. 加班单核对

A **custom starter** template is included as `用户自定义`.

## Admin Workflow (Recommended)
1. Load rule‑set template in UI.
2. Select a **system template** and apply with parameters.
3. Save the generated **custom template** (editable).
4. Keep system templates locked; iterate on custom rules only.

## Notes from DingTalk Rule File
Key behaviors reflected by templates:
- Overtime approval vs. punch mismatches
- Travel/leave conflicts and low‑hours warnings
- Rest‑day punch handling
- Driver/security default hours
- Holiday/entry/resign boundary checks (policy rules)

These remain in **system templates + policy rules**; business adjustments should be in **custom templates**.
