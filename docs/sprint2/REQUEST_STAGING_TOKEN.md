# Request: Temporary Staging JWT Token for Sprint 2 Validation

Hello DevOps,

I need a short‑lived JWT (about 2 hours) for the Staging environment to perform Sprint 2 validation (Snapshot Protection).

Details
- Purpose: Run API validation and performance baseline against Staging
- Required permissions: admin (or minimal perms: safety:write, snapshots:write)
- Validity: 2 hours
- Requester: _[Fill: name/contact]_ 
- Staging base URL: _[Fill: https://staging.example.com]_ 

How to generate (do not share JWT_SECRET)
1) Using repository helper (preferred if repo is cloned on staging host with JWT_SECRET configured):
   JWT_SECRET=$JWT_SECRET \\
   USER_ID=staging-validator \\
   STAGING_ROLES=admin \\
   STAGING_PERMS="safety:write,snapshots:write" \\
   TOKEN_TTL_SEC=7200 \\
   node scripts/gen-staging-token.js

2) One‑liner (no repo dependency, requires Node installed):
   export JWT_SECRET='(staging secret)'
   node -e "const c=require('crypto');const b=s=>Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+/g,'');const h=b(JSON.stringify({alg:'HS256',typ:'JWT'}));const now=Math.floor(Date.now()/1000);const p=b(JSON.stringify({id:'staging-validator',roles:['admin'],perms:['safety:write','snapshots:write'],iat:now,exp:now+7200}));const s=c.createHmac('sha256',process.env.JWT_SECRET).update(h+'.'+p).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+/g,'');console.log(h+'.'+p+'.'+s);"

Please return only the JWT token via a secure channel (no secrets).

Post‑validation I will discard the token and proceed with PR submission.

Thank you!

