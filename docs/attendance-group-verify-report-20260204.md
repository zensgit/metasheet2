# Attendance Groups - Verification Report

Date: 2026-02-04

## Environment
- Web: `http://142.171.239.56:8081`
- API (external): `http://142.171.239.56:8081/api`
- API (internal): `http://127.0.0.1:8900/api`

## Verification Steps
1. Create a group via API.
2. List groups via API.
3. Update group description via API.
4. Delete the group via API.

## Results
- Create: ✅
- List: ✅
- Update: ✅
- Delete: ✅

## Sample Requests
```bash
# login
curl -s -X POST http://142.171.239.56:8081/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@metasheet.app","password":"***"}'

# create
curl -s -X POST http://142.171.239.56:8081/api/attendance/groups \
  -H "Authorization: Bearer <TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{"name":"单休车间","code":"workshop_single","timezone":"Asia/Shanghai","description":"import test group"}'

# list
curl -s http://142.171.239.56:8081/api/attendance/groups \
  -H "Authorization: Bearer <TOKEN>"

# update
curl -s -X PUT http://142.171.239.56:8081/api/attendance/groups/<GROUP_ID> \
  -H "Authorization: Bearer <TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{"name":"单休车间","code":"workshop_single","timezone":"Asia/Shanghai","description":"updated"}'

# delete
curl -s -X DELETE http://142.171.239.56:8081/api/attendance/groups/<GROUP_ID> \
  -H "Authorization: Bearer <TOKEN>"
```
