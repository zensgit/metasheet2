import assert from 'node:assert/strict'
import {execFileSync,spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdtempSync,chmodSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {randomBytes} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import receipt from './staging-candidate-result.cjs'
import path from 'node:path'
import {SOURCE,TAG,verifyImage,PACKAGES} from './staging-directory-candidate.mjs'
const backend=`ghcr.io/zensgit/metasheet2-backend:${TAG}`,web=`ghcr.io/zensgit/metasheet2-web:${TAG}`
const docker=args=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:16*1024*1024,timeout:180000})
for(const ref of [backend,web])verifyImage(JSON.parse(docker(['image','inspect',ref]))[0])
const build=JSON.parse(docker(['run','--rm','--network','none','--entrypoint','cat',web,'/usr/share/nginx/html/build-info.json']))
assert.equal(build.commit,SOURCE);assert.equal(build.imageTag,TAG)
docker(['run','--rm','--network','none','--entrypoint','sh',web,'-c','test -s /usr/share/nginx/html/index.html && test -d /usr/share/nginx/html/assets'])
const providerCode="const {writeReceipt}=require('/candidate-scripts/staging-candidate-result.cjs');const p=require('/app/packages/core-backend/dist/src/db/migration-provider.js').createCoreBackendMigrationProvider({excludedNames:[]});p.getMigrations().then(m=>{writeReceipt(Object.keys(m).sort());process.exit(0)}).catch(()=>process.exit(1))"
const providerDir=mkdtempSync(path.join(tmpdir(),'candidate-provider-'));chmodSync(providerDir,0o700)
const nonce=randomBytes(16).toString('hex')
let names
try{
 docker(['run','--rm','--network','none','-e','NODE_ENV=test','-e','DATABASE_URL=postgres://invalid:invalid@127.0.0.1:1/unreachable',
  '-e','QA_RESULT_PATH=/candidate-results/result.json','-e','QA_RESULT_NONCE='+nonce,
  '-e','QA_RESULT_UID='+process.getuid(),'-e','QA_RESULT_GID='+process.getgid(),
  '--mount',`type=bind,source=${providerDir},target=/candidate-results`,
  '--mount',`type=bind,source=${path.dirname(fileURLToPath(import.meta.url))},target=/candidate-scripts,readonly`,
  '--entrypoint','node',backend,'-e',providerCode])
 names=receipt.readReceipt(path.join(providerDir,'result.json'),nonce)
}finally{rmSync(providerDir,{recursive:true,force:true})}
const expected=JSON.parse(readFileSync(new URL('./staging-directory-candidate-migrations.json',import.meta.url)))
assert.deepEqual(names,expected);assert.equal(names.length,460)
writeFileSync('candidate-provider-names.json',JSON.stringify(names,null,2))
docker(['run','--rm','--network','none','--entrypoint','node',backend,'-e',"const fs=require('fs');if(!fs.readFileSync('/app/packages/core-backend/dist/src/routes/admin-directory.js','utf8').includes('/integrations/:integrationId/identity'))process.exit(1)"])
const vitest=path.posix.join(path.posix.dirname(docker(['run','--rm','--network','none','--workdir','/app/packages/core-backend','--entrypoint','node',backend,'-p',"require.resolve('vitest/package.json')"]).trim()),'vitest.mjs')
function tests(role,files,expectedTests){
 const front=role==='frontend';const output=`${role}-candidate-tests.json`
 const privateDir=mkdtempSync(path.join(tmpdir(),'candidate-tests-'));chmodSync(privateDir,0o700)
 const args=['run','--rm','--network','none','-e','NODE_ENV=test','-e','CI=false','-e','DATABASE_URL=postgres://invalid:invalid@127.0.0.1:1/unreachable',
   '--mount',`type=bind,source=${privateDir},target=/receipts`,
   ...(front?['--mount',`type=bind,source=${path.resolve('source/apps/web')},target=/app/apps/web`]:[]),
   '--workdir',front?'/app/apps/web':'/app/packages/core-backend','--entrypoint','node',backend,vitest,'run',...files,'--reporter=json',`--outputFile=/receipts/${output}`]
 let p
 try{p=spawnSync('docker',args,{encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});writeFileSync(output,readFileSync(path.join(privateDir,output)))}finally{rmSync(privateDir,{recursive:true,force:true})}
 writeFileSync(`${role}-candidate-tests.log`,`${p.stdout||''}\n${p.stderr||''}`)
 assert.equal(p.status,0,`${role} candidate tests failed; inspect private job log`)
 const r=JSON.parse(readFileSync(output));assert.equal(r.success,true);assert.equal(r.numFailedTests,0);assert.equal(r.numPendingTests,0);assert.equal(r.numPassedTests,expectedTests)
 return {passed:r.numPassedTests,files:r.testResults.map(f=>path.basename(f.name))}
}
docker(['run','--rm','--network','none','--entrypoint','node',backend,'-e',"require('fs').accessSync('/app/packages/core-backend/dist/scripts/directory-controlled-handover.js')"])
const front=tests('frontend',['tests/DirectoryIntegrationIdentityPanel.spec.ts','tests/directoryManagementView.spec.ts','tests/run-required-web-tests-shape.spec.ts'],104)
const back=tests('backend',['tests/unit/directory-integration-identity.test.ts','tests/unit/directory-sync-corp-name.test.ts','tests/unit/admin-directory-routes.test.ts','tests/unit/automation-classb-dingtalk-approval-card.test.ts','tests/unit/directory-sync-run-lease.test.ts'],220)
writeFileSync('candidate-validation.json',JSON.stringify({source:SOURCE,tag:TAG,passed:true,imageIds:Object.fromEntries(PACKAGES.map(n=>[n,JSON.parse(docker(['image','inspect',`ghcr.io/zensgit/${n}:${TAG}`]))[0].Id])),providerCount:names.length,frontend:front,backend:back,network:'none',receiptProtocol:'atomic-private-file-v1',webBuildInfoVerified:true},null,2))
console.log('Candidate payloads: exact revision/platform, 460 migrations, 104 frontend and 220 backend tests passed.')
