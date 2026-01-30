# Attendance Import: DingTalk CSV

## Overview
This import path supports DingTalk CSV exports and CSV-derived JSON payloads. The import API now accepts:

- `entries`: event-style records (one row per punch) with `meta.column`/`meta.rawTime`.
- `userMap`: mapping from employee key (e.g. 工号 / empNo) to `userId`.
- `userMapKeyField` or `userMapSourceFields`: which field(s) in the row should be used to resolve `userId`.

When `entries` is provided, the backend groups them by `workDate` and (resolved) user, then applies the standard field mapping and rule engine.

## Example payload (DingTalk CSV entries)
```json
{
  "source": "dingtalk_csv",
  "ruleSetId": "<ruleSetId>",
  "userMapKeyField": "empNo",
  "userMap": {
    "A0054": { "userId": "tmp_9cf257fde42ac517bc769838", "name": "秦夫林", "empNo": "A0054" }
  },
  "entries": [
    {
      "userId": "tmp_9cf257fde42ac517bc769838",
      "occurredAt": "2026-01-20T07:51:00",
      "eventType": "check_in",
      "timezone": "Asia/Shanghai",
      "meta": {
        "workDate": "2026-01-20",
        "column": "上班1打卡时间",
        "rawTime": "07:51",
        "sourceUserKey": "A0054",
        "sourceUserName": "秦夫林"
      }
    },
    {
      "userId": "tmp_9cf257fde42ac517bc769838",
      "occurredAt": "2026-01-20T17:05:00",
      "eventType": "check_out",
      "timezone": "Asia/Shanghai",
      "meta": {
        "workDate": "2026-01-20",
        "column": "下班1打卡时间",
        "rawTime": "17:05",
        "sourceUserKey": "A0054",
        "sourceUserName": "秦夫林"
      }
    }
  ]
}
```

## CSV daily summary → rows
If you have a daily summary CSV, convert it into `rows`:
```json
{
  "rows": [
    {
      "workDate": "2026-01-20",
      "fields": {
        "姓名": "秦夫林",
        "工号": "A0054",
        "考勤组": "单休办公",
        "考勤结果": "正常",
        "上班1打卡时间": "07:51",
        "下班1打卡时间": "17:05",
        "实出勤工时": "8.0",
        "迟到分钟": "0"
      }
    }
  ]
}
```

You can generate this payload via the helper script:
```bash
node scripts/convert-dingtalk-csv-to-import.mjs <csvPath> <outputPath> <userMapPath>
```

Example:
```bash
node scripts/convert-dingtalk-csv-to-import.mjs \\
  \"/Users/huazhou/Downloads/核对(2).csv\" \\
  \"artifacts/attendance-import-rows-核对-20260120-20260127.json\" \\
  \"/Users/huazhou/Downloads/dingtalk-csv-userid-map-核对.json\"
```

## Key field mappings (source → target)
These are included in `/api/attendance/import/template`:

- `上班1打卡时间` → `firstInAt` (time)
- `下班1打卡时间` → `lastOutAt` (time)
- `考勤结果` / `当天考勤情况` → `status`
- `实出勤工时` → `workMinutes` (hours)
- `迟到分钟` / `迟到时长` → `lateMinutes`
- `早退分钟` / `早退时长` → `earlyLeaveMinutes`
- `请假小时` → `leaveHours`
- `加班小时` / `加班总时长` → `overtimeHours`
- `班次` → `shiftName`
- `出勤班次` → `attendanceClass`
- `考勤组` → `attendanceGroup`
- `部门` → `department`
- `职位` → `role` / `roleTags`

## Notes
- If `userId` is not provided per row, the import falls back to the request user. Use `userMap` + `userMapKeyField` to resolve per-row `userId`.
- `attendance_group` is used by rule engine `scope` and should map to `attendanceGroup` / `attendance_group`.
