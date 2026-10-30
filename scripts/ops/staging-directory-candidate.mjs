import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
export const SOURCE='d5bc16c55b38609ff11481385d78aa9566a64b0a'
export const TAG='staging-directory-identity-d5bc16c55b'
export const PACKAGES=['metasheet2-backend','metasheet2-web']
export function authorize(c){
  assert.equal(c.event,'workflow_dispatch');assert.equal(c.repository,'zensgit/metasheet2')
  assert.equal(c.ref,'refs/heads/codex/staging-directory-candidate-d5-20261030')
  assert.match(c.expectedController,/^[0-9a-f]{40}$/);assert.equal(c.sha,c.expectedController)
  assert.equal(c.source,SOURCE);assert.equal(c.approved,'true')
}
export function verifyPackage(m,name){
  assert.equal(m.name,name);assert.equal(m.package_type,'container');assert.equal(m.owner?.login,'zensgit')
  assert.equal(m.repository?.full_name,'zensgit/metasheet2');assert.equal(m.visibility,'public')
}
export function verifyImage(i){assert.equal(i.Config.Labels['org.opencontainers.image.revision'],SOURCE);assert.equal(i.Os,'linux');assert.equal(i.Architecture,'amd64')}
const image=name=>`ghcr.io/zensgit/${name}:${TAG}`
const inspect=ref=>JSON.parse(execFileSync('docker',['image','inspect',ref],{encoding:'utf8'}))[0]
async function packages(){
  assert(process.env.GH_TOKEN)
  for(const name of PACKAGES){
    const r=await fetch(`https://api.github.com/users/zensgit/packages/container/${name}`,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:`Bearer ${process.env.GH_TOKEN}`}})
    assert.equal(r.status,200,`PACKAGE_METADATA_DENIED_${r.status}`);verifyPackage(await r.json(),name)
  }
}
async function digest(name,tag){
  const r=await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:zensgit/${name}:pull`);assert.equal(r.status,200)
  const {token}=await r.json();assert(token)
  const h=await fetch(`https://ghcr.io/v2/zensgit/${name}/manifests/${tag}`,{method:'HEAD',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json'}})
  if(h.status===404)return null
  assert.equal(h.status,200,`REGISTRY_READ_DENIED_${h.status}`)
  const result=h.headers.get('docker-content-digest');assert.match(result,/^sha256:[0-9a-f]{64}$/);return result
}
async function main(mode){
  authorize({event:process.env.GITHUB_EVENT_NAME,repository:process.env.GITHUB_REPOSITORY,ref:process.env.GITHUB_REF,sha:process.env.GITHUB_SHA,expectedController:process.env.EXPECTED_CONTROLLER_SHA,source:process.env.SOURCE_SHA,approved:process.env.PUBLISH_APPROVED})
  if(mode==='preflight'){
    await packages();const before={}
    for(const name of PACKAGES){assert.equal(await digest(name,TAG),null,'CANDIDATE_ALREADY_EXISTS_NO_OVERWRITE');before[name]={latest:await digest(name,'latest')}}
    writeFileSync('publication-before.json',JSON.stringify(before,null,2))
  }else if(mode==='publish'){
    const checks=JSON.parse(readFileSync('candidate-validation.json'));assert.equal(checks.source,SOURCE);assert.equal(checks.passed,true)
    await packages();const before=JSON.parse(readFileSync('publication-before.json'));const receipt={source:SOURCE,tag:TAG,images:[],complete:false}
    for(const name of PACKAGES){
      verifyImage(inspect(image(name)));assert.equal(await digest(name,TAG),null,'CANDIDATE_TAG_CHANGED_STOP')
      execFileSync('docker',['push',image(name)],{stdio:'inherit'})
      const actual=await digest(name,TAG);assert(actual)
      execFileSync('docker',['pull',`ghcr.io/zensgit/${name}@${actual}`],{stdio:'inherit'});verifyImage(inspect(`ghcr.io/zensgit/${name}@${actual}`))
      assert.equal(await digest(name,'latest'),before[name].latest,'LATEST_CHANGED_STOP_NO_ROLLBACK')
      receipt.images.push({name,digest:actual,imageId:inspect(image(name)).Id,visibility:'public',latestUnchanged:true});writeFileSync('publication-receipt.json',JSON.stringify(receipt,null,2))
    }
    await packages();receipt.complete=true;writeFileSync('publication-receipt.json',JSON.stringify(receipt,null,2))
  }else throw Error('INVALID_CANDIDATE_MODE')
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1})
