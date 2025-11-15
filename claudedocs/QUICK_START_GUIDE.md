# MetaSheet v2 Quick Start Guide

**🚀 Get MetaSheet v2 running in 5 minutes**

Version: 2.4.0  
Last Updated: 2025-11-16

---

## 📋 Prerequisites

Before starting, ensure you have:

- **Node.js**: v18.0.0 or higher
- **pnpm**: v8.0.0 or higher
- **PostgreSQL**: v14.0 or higher
- **Redis**: v6.0 or higher (optional, for caching)

---

## ⚡ Quick Installation

### 1. Clone and Install

```bash
# Clone the repository
git clone https://github.com/zensgit/metasheet2.git
cd metasheet2

# Install dependencies
pnpm install

# Build packages
pnpm run build
```

### 2. Database Setup

```bash
# Create database
createdb metasheet_dev

# Run migrations
cd packages/core-backend
pnpm run migrate

# (Optional) Seed demo data
pnpm run seed
```

### 3. Environment Configuration

Create `.env` file in `packages/core-backend/`:

```bash
# Database
DATABASE_URL=postgresql://localhost:5432/metasheet_dev

# Server
PORT=8900
NODE_ENV=development

# JWT Authentication
JWT_SECRET=your-secret-key-here

# Redis (Optional)
REDIS_URL=redis://localhost:6379

# Observability (Optional)
METRICS_URL=http://localhost:9090
```

### 4. Start Development Server

```bash
# Start backend server
cd packages/core-backend
pnpm run dev

# In another terminal, start frontend (if needed)
cd apps/web
pnpm run dev
```

Server will be available at: `http://localhost:8900`

---

## ✅ Verification

### Quick Health Check

```bash
# Server health
curl http://localhost:8900/health

# Expected response:
# {"ok":true,"status":"healthy","version":"2.4.0"}
```

### Comprehensive Feature Verification

```bash
# Run automated verification suite
bash scripts/verify-features.sh all

# Or test individual features:
bash scripts/verify-features.sh approval
bash scripts/verify-features.sh cache
bash scripts/verify-features.sh rbac
```

### Generate Development Token

```bash
# Generate JWT token for API testing
TOKEN=$(node scripts/gen-dev-token.js)
echo $TOKEN

# Use in API requests
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8900/api/approvals
```

---

## 🔧 Development Workflows

### Running Tests

```bash
# Unit tests
pnpm run test

# Integration tests
pnpm run test:integration

# E2E tests
pnpm run test:e2e
```

### Building for Production

```bash
# Build all packages
pnpm run build

# Build specific package
cd packages/core-backend
pnpm run build
```

### Database Migrations

```bash
# Create new migration
cd packages/core-backend
pnpm run migrate:create migration_name

# Run pending migrations
pnpm run migrate

# Rollback last migration
pnpm run migrate:rollback
```

### Code Quality

```bash
# Lint code
pnpm run lint

# Format code
pnpm run format

# Type check
pnpm run typecheck
```

---

## 🐛 Troubleshooting

### Port Already in Use

```bash
# Error: Port 8900 already in use
# Solution: Kill existing process or use different port
lsof -ti:8900 | xargs kill -9
# Or change PORT in .env
```

### Database Connection Failed

```bash
# Error: Connection refused to PostgreSQL
# Solution: Ensure PostgreSQL is running
brew services start postgresql
# Or on Linux:
sudo systemctl start postgresql
```

### pnpm Install Failures

```bash
# Error: Lockfile out of sync
# Solution: Clear cache and reinstall
rm -rf node_modules .pnpm-store
pnpm install --force
```

### Migration Errors

```bash
# Error: Migration already applied
# Solution: Check migration status
cd packages/core-backend
pnpm run migrate:status

# Reset database (⚠️ DESTRUCTIVE)
pnpm run migrate:reset
```

### Build Errors

```bash
# Error: TypeScript compilation failed
# Solution: Clean and rebuild
pnpm run clean
pnpm run build
```

---

## 📚 Core Features Overview

### 1. Approval System
- Automated workflow approvals
- Multi-level approval chains
- IM platform integration (Feishu, DingTalk, WeCom)
- Version conflict handling

**Quick Test**:
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8900/api/approvals?status=pending
```

### 2. Cache System
- Redis-backed caching
- Prometheus metrics integration
- Cache hit/miss tracking
- Multi-tier cache strategy

**Quick Test**:
```bash
curl http://localhost:8900/api/cache/health
```

### 3. RBAC Permission System
- Role-based access control
- Fine-grained permissions
- Permission caching
- Real-time permission checks

**Quick Test**:
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8900/api/permissions/check?userId=u1&resource=spreadsheet&resourceId=sheet-001&action=read"
```

### 4. API Gateway
- Rate limiting
- Circuit breaker
- Load balancing
- Request validation

### 5. Event Bus
- Pub/Sub messaging
- Inter-plugin communication
- Async event processing
- Event history tracking

### 6. Notification System
- Multi-channel notifications (Email, SMS, Push)
- IM platform support (Feishu, DingTalk, WeCom)
- Template management
- Delivery tracking

---

## 🎯 Next Steps

### Essential Documentation
- [API Documentation](API_DOCUMENTATION.md) - Complete API reference
- [Feature Assessment](FEATURE_MIGRATION_ASSESSMENT.md) - Feature completeness analysis
- [Phase 5 Guide](PHASE5_COMPLETION_GUIDE.md) - Production baseline completion

### Development Resources
- [Architecture Overview](../README.md) - System architecture
- [Contributing Guidelines](../CONTRIBUTING.md) - Development guidelines
- [Testing Guide](../TESTING.md) - Testing strategies

### Production Deployment
1. Wait for Phase 5 METRICS_URL configuration
2. Complete 24-hour observability validation
3. Archive baseline metrics
4. Deploy to production environment

---

## 🔗 Useful Commands

```bash
# Development
pnpm dev              # Start dev server
pnpm build            # Build all packages
pnpm test             # Run tests
pnpm lint             # Lint code

# Database
pnpm migrate          # Run migrations
pnpm migrate:rollback # Rollback migration
pnpm seed             # Seed demo data

# Verification
bash scripts/verify-features.sh all  # Verify all features

# Git
git status            # Check status
git checkout -b feat/your-feature  # Create feature branch
```

---

## 💡 Tips for New Developers

1. **Always use feature branches**: Never work directly on `main`
2. **Run verification before commit**: Ensure all tests pass
3. **Check existing patterns**: Follow project conventions
4. **Use type checking**: TypeScript types are your friends
5. **Test API changes**: Use Postman or curl to verify endpoints

---

## 🆘 Getting Help

- **Documentation**: Check `claudedocs/` directory
- **Issues**: Report bugs on GitHub Issues
- **API Reference**: See [API_DOCUMENTATION.md](API_DOCUMENTATION.md)
- **Architecture Questions**: Review system design documents

---

**🤖 Generated with [Claude Code](https://claude.com/claude-code)**

**Last Updated**: 2025-11-16
