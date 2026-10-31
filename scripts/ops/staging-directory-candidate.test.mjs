import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import {authorize,verifyPackage,verifyImage,verifyPublication,publishValidatedPair,SOURCE,TAG,PACKAGES} from './staging-directory-candidate.mjs'
const base={event:'workflow_dispatch',repository:'zensgit/metasheet2',ref:'refs/heads/codex/staging-handover-candidate-e94-20261101',sha:'a'.repeat(40),expectedController:'a'.repeat(40),source:SOURCE,approved:'true'}
test('exact owner-approved controller/source accepted',()=>authorize(base))
for(const [field,value] of Object.entries({event:'push',repository:'other/repo',ref:'refs/heads/main',sha:'b'.repeat(40),expectedController:'invalid',source:'b'.repeat(40),approved:'false'}))test(`reject changed ${field}`,()=>assert.throws(()=>authorize({...base,[field]:value})))
test('closed candidate tag and package list, no mutable pushes',()=>{assert.deepEqual(PACKAGES,['metasheet2-backend','metasheet2-web']);assert.equal(TAG,'staging-directory-handover-e94c982b66');const s=readFileSync(new URL('./staging-directory-candidate.mjs',import.meta.url),'utf8');assert.equal((s.match(/\['push',image\(name\)\]/g)||[]).length,1);assert(!/\['push',[^\n]*(?:latest|onprem)/.test(s))})
test('package identity and visibility enforced',()=>{const m={name:PACKAGES[0],package_type:'container',owner:{login:'zensgit'},repository:{full_name:'zensgit/metasheet2'},visibility:'public'};verifyPackage(m,PACKAGES[0]);for(const x of [{...m,visibility:'private'},{...m,name:'new-package'},{...m,repository:null},{...m,owner:{login:'other'}}])assert.throws(()=>verifyPackage(x,PACKAGES[0]))})
test('candidate revision/platform enforced',()=>{const i={Config:{Labels:{'org.opencontainers.image.revision':SOURCE}},Os:'linux',Architecture:'amd64'};verifyImage(i);assert.throws(()=>verifyImage({...i,Architecture:'arm64'}));assert.throws(()=>verifyImage({...i,Config:{Labels:{}}}))})

const payload={source:SOURCE,passed:true,imageIds:{[PACKAGES[0]]:'sha256:synthetic'}}
const joint={source:SOURCE,passed:true,publicationAllowed:true,ownedContainersRemaining:0}
test('only the validated immutable payload can publish after owned resources are removed',()=>verifyPublication(payload,joint,PACKAGES[0],'sha256:synthetic'))
for(const [key,value] of Object.entries({source:'changed',passed:false,publicationAllowed:false,ownedContainersRemaining:1}))test(`reject incomplete rehearsal ${key}`,()=>assert.throws(()=>verifyPublication(payload,{...joint,[key]:value},PACKAGES[0],'sha256:synthetic')))
test('reject replaced image or invalid payload receipt',()=>{assert.throws(()=>verifyPublication(payload,joint,PACKAGES[0],'sha256:changed'));assert.throws(()=>verifyPublication({...payload,passed:false},joint,PACKAGES[0],'sha256:synthetic'))})

function pairHarness(){
 const calls=[];const checks={source:SOURCE,passed:true,imageIds:Object.fromEntries(PACKAGES.map(n=>[n,'sha256:'+n]))};
 const hooks={image:n=>({Id:'sha256:'+n,Config:{Labels:{'org.opencontainers.image.revision':SOURCE}},Os:'linux',Architecture:'amd64'}),tagDigest:async()=>null,publish:async n=>{calls.push(n)}};
 return {calls,checks,hooks}
}
test('second payload failure prevents the first registry write',async()=>{const h=pairHarness();h.checks.imageIds[PACKAGES[1]]='changed';await assert.rejects(publishValidatedPair(h.checks,joint,h.hooks));assert.deepEqual(h.calls,[])})
test('second occupied candidate tag prevents the first registry write',async()=>{const h=pairHarness();h.hooks.tagDigest=async n=>n===PACKAGES[1]?'sha256:existing':null;await assert.rejects(publishValidatedPair(h.checks,joint,h.hooks));assert.deepEqual(h.calls,[])})
test('both validated payloads publish in the reviewed order',async()=>{const h=pairHarness();await publishValidatedPair(h.checks,joint,h.hooks);assert.deepEqual(h.calls,PACKAGES)})
test('manual-only controller freezes source and orders every validation before publication',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/docker-build.yml',import.meta.url),'utf8')
 assert(workflow.includes('  workflow_dispatch:'))
 assert(!/\n  (?:push|pull_request|schedule):/.test(workflow))
 assert(workflow.includes('ref: '+SOURCE))
 assert(!/:latest\b|continue-on-error|ssh /.test(workflow))
 const stages=['Controller safety tests','Frozen source and publication preflight','Build candidate images without latest','Validate actual candidate payloads','Isolated image upgrade, backup, restore and rollback','Publish only approved candidate tags']
 let previous=-1
 for(const stage of stages){const at=workflow.indexOf('name: '+stage);assert(at>previous);previous=at}
})
