# Credential Rotation Guide
**Date**: 2025-10-23
**Purpose**: Step-by-step guide for rotating exposed credentials
**Status**: READY FOR EXECUTION

---

## Overview

This guide provides detailed instructions for rotating all credentials that were exposed in the `secrets-20250905-103848.conf` file discovered on 2025-10-21.

**Exposed Credentials** (from 2025-09-05):
- JWT_SECRET
- DB_PASSWORD (DATABASE_URL)
- REDIS_PASSWORD (REDIS_URL)
- ADMIN_PASSWORD

**Risk Assessment**:
- 🟡 MEDIUM (if private repository + credentials already rotated)
- 🔴 HIGH (if credentials NOT rotated or repository accessible)

---

## Prerequisites Checklist

Before starting credential rotation:

- [ ] Backup current environment configurations
- [ ] Access to production database
- [ ] Access to Redis instance
- [ ] Admin access to application
- [ ] Ability to restart services
- [ ] Communication plan for team (if multi-developer)

---

## Part 1: JWT_SECRET Rotation

### Current Exposed Value
```
Bs0OqehIsJ9Lvrw7ilrchb4x4nAx9ImkDqSD9DtNoUM4B9EiTZn4xvYuHtQm9UORGehsMtN53XRqlv1OCGQsmw==
```

### Step 1.1: Generate New JWT Secret

```bash
# Generate new 64-byte secret (base64 encoded)
openssl rand -base64 64

# Example output (DO NOT use this - generate your own):
# qX8NmK... (your unique secret)
```

### Step 1.2: Update Environment Configuration

**Development** (`.env.development` - local only, not committed):
```bash
JWT_SECRET=your_new_secret_here
```

**Production** (depends on deployment method):

**Option A: Environment Variables** (Kubernetes/Cloud):
```yaml
# Kubernetes Secret
apiVersion: v1
kind: Secret
metadata:
  name: metasheet-secrets
type: Opaque
data:
  jwt-secret: <base64 encoded new secret>
```

**Option B: .env file** (VM/Docker Compose):
```bash
# /etc/metasheet/.env.production (secure file permissions: 600)
JWT_SECRET=your_new_secret_here
```

**Option C: Environment variable** (systemd/PM2):
```bash
export JWT_SECRET=your_new_secret_here
```

### Step 1.3: Invalidate All Existing Tokens

**⚠️ Impact**: All users will be logged out

**Method 1: Restart Application** (simple, immediate invalidation)
```bash
# All existing JWT tokens will be invalid with new secret
pnpm -F @metasheet/core-backend start
```

**Method 2: Database Token Revocation** (if using token storage):
```sql
-- If you store active sessions in database
DELETE FROM user_sessions WHERE created_at < NOW();
```

**Method 3: Redis Session Flush** (if using Redis for sessions):
```bash
redis-cli FLUSHDB
```

### Step 1.4: Verify JWT Rotation

```bash
# Test with old token (should fail)
curl -H "Authorization: Bearer <old_token>" http://localhost:8900/api/protected

# Expected: 401 Unauthorized or "Invalid token"

# Test login and new token generation
curl -X POST http://localhost:8900/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your_password"}'

# Expected: New JWT token in response
```

---

## Part 2: DATABASE_URL / DB_PASSWORD Rotation

### Current Exposed Value
```
postgresql://metasheet:3LZJxr9mlMIjrj9IYpulDb@928@localhost:5432/metasheet_v2
```

### Step 2.1: Generate New Database Password

```bash
# Generate strong password (32 characters)
openssl rand -base64 32

# Example output (DO NOT use this - generate your own):
# kL9pM... (your unique password)
```

### Step 2.2: Update PostgreSQL User Password

```bash
# Connect to PostgreSQL as superuser
psql -U postgres

# Change password for metasheet user
ALTER USER metasheet WITH PASSWORD 'your_new_password_here';

# Verify password change
\du metasheet
```

### Step 2.3: Update Environment Configuration

**New DATABASE_URL format**:
```bash
DATABASE_URL=postgresql://metasheet:your_new_password_here@localhost:5432/metasheet_v2
```

**Update locations**:
1. **Development**: `.env.development` (local)
2. **Production**: Environment variables or secrets management
3. **Docker Compose**: `docker-compose.yml` or `.env` file
4. **Kubernetes**: Update Secret

### Step 2.4: Test Database Connection

```bash
# Test connection with new credentials
psql "postgresql://metasheet:your_new_password_here@localhost:5432/metasheet_v2"

# Expected: Successfully connected

# Or test via application
pnpm -F @metasheet/core-backend validate:env:prod

# Expected: ✅ Environment validation passed
```

### Step 2.5: Restart Application

```bash
# Restart with new DATABASE_URL
pnpm -F @metasheet/core-backend start
```

---

## Part 3: REDIS_PASSWORD Rotation

### Current Exposed Value
```
pjmMJ0d3IJxvOx4UF2Bq
```

### Step 3.1: Generate New Redis Password

```bash
# Generate Redis password (24 characters sufficient)
openssl rand -base64 24

# Example output (DO NOT use this - generate your own):
# mN7pQ... (your unique password)
```

### Step 3.2: Update Redis Configuration

**Method 1: Via redis-cli** (temporary, until restart):
```bash
redis-cli
CONFIG SET requirepass "your_new_redis_password"
SAVE
```

**Method 2: Update redis.conf** (permanent):
```bash
# Edit /etc/redis/redis.conf or /usr/local/etc/redis/redis.conf
requirepass your_new_redis_password

# Restart Redis
sudo systemctl restart redis
# or
brew services restart redis  # macOS Homebrew
```

**Method 3: Docker Compose** (if using containerized Redis):
```yaml
# docker-compose.yml
redis:
  image: redis:7-alpine
  command: redis-server --requirepass your_new_redis_password
```

### Step 3.3: Update Environment Configuration

**New REDIS_URL format**:
```bash
REDIS_URL=redis://:your_new_redis_password@localhost:6379
```

**Update locations**:
1. `.env.development` (local)
2. Production environment variables
3. Docker Compose configuration
4. Kubernetes Secrets

### Step 3.4: Test Redis Connection

```bash
# Test connection with new password
redis-cli -a your_new_redis_password PING

# Expected: PONG

# Or test via application
pnpm -F @metasheet/core-backend dev
# Check logs for successful Redis connection
```

---

## Part 4: ADMIN_PASSWORD Rotation

### Current Exposed Value
```
11af33a821604cd918f5dab7fbd1e57a
```

### Step 4.1: Generate New Admin Password

```bash
# Generate strong admin password
openssl rand -base64 24 | tr -d "=+/" | cut -c1-20

# Or use a password manager to generate a strong password
```

### Step 4.2: Update Admin User Password

**Method 1: Via Admin UI** (if accessible):
1. Login with current password
2. Navigate to Profile/Settings
3. Change Password
4. Confirm new password

**Method 2: Direct Database Update**:
```sql
-- Connect to database
psql "postgresql://metasheet:password@localhost:5432/metasheet_v2"

-- Update admin password (using bcrypt hashing)
UPDATE users
SET password = crypt('your_new_admin_password', gen_salt('bf'))
WHERE username = 'admin' OR role = 'admin';

-- Verify update
SELECT username, role, updated_at FROM users WHERE username = 'admin';
```

**Method 3: Via API** (if password reset endpoint exists):
```bash
curl -X POST http://localhost:8900/api/auth/reset-password \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin_token>" \
  -d '{
    "currentPassword": "old_password",
    "newPassword": "your_new_admin_password"
  }'
```

### Step 4.3: Test Admin Login

```bash
# Test login via API
curl -X POST http://localhost:8900/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "your_new_admin_password"
  }'

# Expected: 200 OK with JWT token

# Or login via web interface
# Navigate to: http://localhost:8899/login
```

---

## Part 5: Verification & Cleanup

### Step 5.1: Comprehensive Verification Checklist

**Application Health**:
- [ ] Application starts successfully
- [ ] No authentication errors in logs
- [ ] Database connection stable
- [ ] Redis connection stable

**Authentication**:
- [ ] Can login with new admin password
- [ ] Old JWT tokens rejected (401 Unauthorized)
- [ ] New JWT tokens generated successfully
- [ ] Session management working

**Database**:
- [ ] Database queries executing normally
- [ ] No connection pool errors
- [ ] Migrations apply successfully
- [ ] Data integrity maintained

**Redis**:
- [ ] Cache operations working
- [ ] Session storage functioning
- [ ] No connection errors

### Step 5.2: Update Documentation

**Update the following files** (ensure they reference NEW credentials in examples):
- `.env.*.example` files (already updated with placeholders)
- Team documentation
- Deployment guides
- Runbooks

### Step 5.3: Secure Old Credentials

**Immediately revoke old credentials**:
- [ ] Confirm old JWT_SECRET can't validate tokens
- [ ] Confirm old DB password rejected
- [ ] Confirm old Redis password rejected
- [ ] Confirm old admin password rejected

### Step 5.4: Monitor for Issues

**First 24 hours after rotation**:
```bash
# Monitor application logs
tail -f /var/log/metasheet/app.log

# Watch for:
# - Authentication errors
# - Database connection errors
# - Redis connection errors
# - Unusual login attempts with old credentials
```

### Step 5.5: Team Communication

**Notify team members**:
```
Subject: [ACTION REQUIRED] Credentials Rotated - Update Required

Team,

Security credentials have been rotated as part of our security hardening.

REQUIRED ACTIONS:
1. Pull latest .env.*.example files
2. Update your local .env.development with new credentials
   (Request from team lead or secrets manager)
3. Restart your development environment
4. Test login functionality

TIMELINE:
- Effective: Immediately
- Deadline: Within 24 hours

Questions? Contact: [security team contact]
```

---

## Part 6: Prevention Measures

### Step 6.1: Update .gitignore (Already Done ✅)

Verified patterns in `.gitignore`:
```gitignore
# Prevent real environment files
.env
.env.local
.env.*.local
.env.*
!.env.example
!.env.*.example

# Prevent secrets files
*secrets*.conf
*secrets*.txt
credentials.*
```

### Step 6.2: Enable Pre-Commit Hooks (Optional)

Create `.git/hooks/pre-commit`:
```bash
#!/bin/bash
# Pre-commit hook to block secrets

# Check for environment files with real credentials
SECRETS=$(git diff --cached --name-only | grep -E '\.env$|\.env\.[^e].*$|secrets.*\.conf$' || true)

if [ -n "$SECRETS" ]; then
    echo "❌ ERROR: Attempting to commit files with potential secrets!"
    echo ""
    echo "Blocked files:"
    echo "$SECRETS" | sed 's/^/  - /'
    echo ""
    echo "Only commit .env.*.example files with placeholders."
    exit 1
fi

# Check for hardcoded secrets in staged files
if git diff --cached | grep -iE 'jwt_secret.*=.*[A-Za-z0-9]{32,}|password.*=.*[^ ]{8,}'; then
    echo "❌ ERROR: Potential hardcoded secrets detected!"
    echo "Please use environment variables instead."
    exit 1
fi

exit 0
```

```bash
chmod +x .git/hooks/pre-commit
```

### Step 6.3: Use Secrets Management (Recommended for Production)

**Option A: HashiCorp Vault**
```bash
# Store secrets in Vault
vault kv put secret/metasheet \
  jwt_secret="your_secret" \
  db_password="your_password"

# Retrieve in application startup
vault kv get -field=jwt_secret secret/metasheet
```

**Option B: Kubernetes Secrets**
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: metasheet-secrets
type: Opaque
stringData:
  JWT_SECRET: your_secret_here
  DATABASE_URL: postgresql://...
```

**Option C: AWS Secrets Manager**
```bash
# Store secret
aws secretsmanager create-secret \
  --name metasheet/jwt-secret \
  --secret-string "your_secret_here"

# Retrieve in application
aws secretsmanager get-secret-value \
  --secret-id metasheet/jwt-secret
```

### Step 6.4: Regular Rotation Schedule

**Recommended rotation intervals**:
- **JWT_SECRET**: Every 90 days
- **Database passwords**: Every 90 days
- **Redis passwords**: Every 90 days
- **Admin passwords**: Every 30-60 days

**Set calendar reminders**:
```
Next rotation due: 2026-01-21 (90 days from 2025-10-23)
```

---

## Troubleshooting

### Issue 1: Application Won't Start After Rotation

**Symptoms**: Application crashes immediately after updating credentials

**Solution**:
```bash
# 1. Verify environment variables are set
echo $JWT_SECRET
echo $DATABASE_URL
echo $REDIS_URL

# 2. Run validation script
pnpm -F @metasheet/core-backend validate:env:prod

# 3. Check for typos in credentials
# 4. Verify credentials work independently:
psql "$DATABASE_URL"
redis-cli -a "$REDIS_PASSWORD" PING
```

### Issue 2: Users Can't Login After Rotation

**Symptoms**: Valid credentials rejected, "Invalid credentials" error

**Possible Causes**:
1. JWT_SECRET not updated in all instances
2. Old tokens cached in browser
3. Password hash mismatch

**Solution**:
```bash
# Clear browser localStorage/cookies
# Verify JWT_SECRET matches across all app instances
# Check database password hash is correct

# Test direct login
curl -X POST http://localhost:8900/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"new_password"}'
```

### Issue 3: Database Connection Errors

**Symptoms**: "Connection refused" or "Authentication failed"

**Solution**:
```bash
# 1. Test database connection directly
psql -h localhost -U metasheet -d metasheet_v2

# 2. Verify password in PostgreSQL
sudo -u postgres psql
\du metasheet

# 3. Check pg_hba.conf authentication method
cat /etc/postgresql/14/main/pg_hba.conf
# Should have: host all metasheet 127.0.0.1/32 md5
```

### Issue 4: Redis Connection Errors

**Symptoms**: "NOAUTH Authentication required" or connection timeout

**Solution**:
```bash
# 1. Verify Redis is running and has password set
redis-cli CONFIG GET requirepass

# 2. Test authentication
redis-cli -a your_new_password PING

# 3. Check Redis logs
tail -f /var/log/redis/redis-server.log

# 4. Verify firewall not blocking port 6379
sudo netstat -tuln | grep 6379
```

---

## Rollback Plan

**If critical issues occur**, rollback to previous credentials:

### Emergency Rollback Steps

1. **Stop application**
   ```bash
   pkill -f metasheet
   ```

2. **Restore old environment variables** (from backup)
   ```bash
   export JWT_SECRET=Bs0OqehIsJ9Lvrw7ilrchb4x4nAx9ImkDqSD9DtNoUM4B9EiTZn4xvYuHtQm9UORGehsMtN53XRqlv1OCGQsmw==
   export DATABASE_URL=postgresql://metasheet:3LZJxr9mlMIjrj9IYpulDb@928@localhost:5432/metasheet_v2
   export REDIS_URL=redis://:pjmMJ0d3IJxvOx4UF2Bq@localhost:6379
   ```

3. **Rollback database password**
   ```sql
   ALTER USER metasheet WITH PASSWORD '3LZJxr9mlMIjrj9IYpulDb@928';
   ```

4. **Rollback Redis password**
   ```bash
   redis-cli CONFIG SET requirepass "pjmMJ0d3IJxvOx4UF2Bq"
   ```

5. **Restart application**
   ```bash
   pnpm -F @metasheet/core-backend start
   ```

6. **Schedule retry** of credential rotation after investigating issues

---

## Completion Checklist

**After completing all rotations**:

- [ ] JWT_SECRET rotated and validated
- [ ] DATABASE_URL password rotated and validated
- [ ] REDIS_URL password rotated and validated
- [ ] ADMIN_PASSWORD rotated and validated
- [ ] All services restarted successfully
- [ ] Application health checks passing
- [ ] Users can login with new credentials
- [ ] Old credentials confirmed invalid
- [ ] Team members notified
- [ ] Documentation updated
- [ ] Monitoring enabled for 24 hours
- [ ] Next rotation scheduled (90 days)

**Record completion**:
```
Rotation Date: ______________
Completed By: ______________
Next Rotation Due: ______________ (2026-01-21)
Issues Encountered: ______________
```

---

## Related Documentation

### Documentation Files
- [README.md](./README.md) - MetaSheet V2 documentation index
- [METRICS_ROLLOUT_PLAN.md](./METRICS_ROLLOUT_PLAN.md) - Metrics & monitoring rollout plan

### Environment Validation Scripts
- `../../scripts/validate-env.sh` - Main environment validation script (integrated into package.json)
- `../../scripts/docker-entrypoint-validate.sh` - Docker container startup validation

### Package Configuration
- `../../packages/core-backend/package.json` - Backend service with pre-hooks for automatic validation

---

**END OF CREDENTIAL ROTATION GUIDE**
