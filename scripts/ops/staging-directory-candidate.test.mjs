import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import {authorize,verifyPackage,verifyImage,SOURCE,TAG,PACKAGES} from './staging-directory-candidate.mjs'
const base={event:'workflow_dispatch',repository:'zensgit/metasheet2',ref:'refs/heads/codex/staging-directory-candidate-d5-20261030',sha:'a'.repeat(40),expectedController:'a'.repeat(40),source:SOURCE,approved:'true'}
test('exact owner-approved controller/source accepted',()=>authorize(base))
for(const [field,value] of Object.entries({event:'push',repository:'other/repo',ref:'refs/heads/main',sha:'b'.repeat(40),expectedController:'invalid',source:'b'.repeat(40),approved:'false'}))test(`reject changed ${field}`,()=>assert.throws(()=>authorize({...base,[field]:value})))
test('closed candidate tag and package list, no mutable pushes',()=>{assert.deepEqual(PACKAGES,['metasheet2-backend','metasheet2-web']);assert.equal(TAG,'staging-directory-identity-d5bc16c55b');const s=readFileSync(new URL('./staging-directory-candidate.mjs',import.meta.url),'utf8');assert.equal((s.match(/\['push',image\(name\)\]/g)||[]).length,1);assert(!/\['push',[^\n]*(?:latest|onprem)/.test(s))})
test('package identity and visibility enforced',()=>{const m={name:PACKAGES[0],package_type:'container',owner:{login:'zensgit'},repository:{full_name:'zensgit/metasheet2'},visibility:'public'};verifyPackage(m,PACKAGES[0]);for(const x of [{...m,visibility:'private'},{...m,name:'new-package'},{...m,repository:null},{...m,owner:{login:'other'}}])assert.throws(()=>verifyPackage(x,PACKAGES[0]))})
test('candidate revision/platform enforced',()=>{const i={Config:{Labels:{'org.opencontainers.image.revision':SOURCE}},Os:'linux',Architecture:'amd64'};verifyImage(i);assert.throws(()=>verifyImage({...i,Architecture:'arm64'}));assert.throws(()=>verifyImage({...i,Config:{Labels:{}}}))})
