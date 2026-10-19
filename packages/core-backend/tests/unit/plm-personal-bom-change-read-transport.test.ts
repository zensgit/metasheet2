import { afterEach, expect, it, vi } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import { snapshotShareTargetSchema } from '../../src/services/plm-managed-snapshot-share-wire'
import { preparePersonalChangeRead, parsePersonalChangeRead } from '../../src/services/plm-personal-bom-change-read-wire'
const grant=`yue_${'a'.repeat(32)}_${'b'.repeat(43)}`
const binding='b279b64a-63dc-4af0-854e-a08044ba62a0',eventId='a279b64a-63dc-4af0-854e-a08044ba62a0'
const target={tenant_id:'meta-t',org_id:'meta-o',user_id:'meta-user',base_id:'base',sheet_id:'sheet',source_id:'source',binding_id:'link',binding_generation:2,session_id:'session',audience:'aud'}
const authority={origin:'https://provider.invalid',connectionId:'native-connection',tenantId:'native-t',orgId:'native-o',authUserId:'42',rootPartId:'part',target,reviewBindingId:binding,reviewBindingVersion:3}
const source={type:'plm',connection:{url:'https://provider.invalid/prefix',headers:{'x-tenant-id':'native-t','x-org-id':'native-o'}},options:{apiMode:'yuantus',tenantId:'native-t',orgId:'native-o'}}
const verified={schema:'yuantus.plm-bom-change-read-binding.v1',grant_id:'a'.repeat(32),connection_id:'native-connection',tenant_id:'native-t',org_id:'native-o',auth_user_id:'42',expires_at:'2099-01-01T00:00:00.000000Z',purpose:'bom_change_read',root_part_id:'part',target,review_binding_id:binding,review_binding_version:3,confirmed_scope:'bom_change_read.v1'}
const event={schema:'yuantus.plm-change-event.v1',event_type:'bom.plm_change.applied',event_id:eventId,binding_id:binding,binding_version:3,source:{connection_id:'source',tenant_id:'native-t',org_id:'native-o',part_id:'part'},change:{kind:'bom_line_writeback',audit_id:'c279b64a-63dc-4af0-854e-a08044ba62a0',bom_line_id:'line'},occurred_at:'2026-10-20T01:00:00.000000Z'}
function adapter(){return new PLMAdapter({get:async()=>undefined} as never,{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()} as never,{id:'source',name:'source',...source,connection:{url:'https://cached-foreign.invalid',headers:{Authorization:'Bearer shared-account','X-Api-Key':'shared-key'}},credentials:{token:'shared-account',password:'service-secret'}} as never)}
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()})
function enabled(){vi.stubEnv('PLM_PERSONAL_BOM_CHANGE_READ_ENABLED','true')}
it('freezes management URL to persisted authority and exact target, not adapter cache',()=>{
 enabled();const url=new URL(adapter().personalBomChangeReadManagementUrl(source,authority))
 expect(url.origin).toBe(authority.origin);expect(url.pathname).toBe('/personal-approval-grants')
 expect(JSON.parse(new URLSearchParams(url.hash.slice('#bom-change-read?'.length)).get('request')!)).toEqual({connection_id:'native-connection',root_part_id:'part',target,review_binding_id:binding,review_binding_version:3})
 expect(()=>adapter().personalBomChangeReadManagementUrl(source,{...authority,orgId:'foreign'})).toThrow('PLM_CHANGE_READ_FORBIDDEN')
})
it.each(['false','TRUE','1',''])('does not borrow approval/write flags for read gate %s',async flag=>{
 vi.stubEnv('PLM_PERSONAL_BOM_CHANGE_READ_ENABLED',flag);vi.stubEnv('PLM_APPROVAL_CARD_ENABLED','true');vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED','true')
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
 await expect(adapter().personalBomChangeReadRequest({operation:'verify'},grant,authority)).rejects.toMatchObject({status:404});expect(fetch).not.toHaveBeenCalled()
})
it('sends one yue-only request, explicit Native headers, no shared interceptor/credentials/redirect/retry',async()=>{
 enabled();const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(verified)));vi.stubGlobal('fetch',fetch)
 expect(await adapter().personalBomChangeReadRequest({operation:'verify'},grant,authority)).toEqual(verified)
 const [url,init]=fetch.mock.calls[0];expect(String(url)).toBe('https://provider.invalid/api/v1/plm-bom-change-read-grant/verify')
 expect(init.headers).toEqual({Authorization:`Bearer ${grant}`,'Content-Type':'application/json','x-tenant-id':'native-t','x-org-id':'native-o'})
 expect(init.redirect).toBe('error');expect(JSON.parse(init.body)).toEqual({connection_id:'native-connection'})
 expect(JSON.stringify(fetch.mock.calls)).not.toMatch(/shared-account|shared-key|service-secret|cached-foreign/)
 for(const prefix of ['yua','yuw','yur'])await expect(adapter().personalBomChangeReadRequest({operation:'verify'},grant.replace('yue_',prefix+'_'),authority)).rejects.toMatchObject({status:403})
 expect(fetch).toHaveBeenCalledTimes(1)
})
it('checks every verify identity/scope field and expiry against the frozen authority',()=>{
 enabled();const p=preparePersonalChangeRead({operation:'verify'},grant,authority)
 for(const changed of [{auth_user_id:'meta-user'},{tenant_id:'meta-t'},{org_id:'meta-o'},{connection_id:'source'},{grant_id:'c'.repeat(32)},{root_part_id:'other'},{review_binding_version:4},{purpose:'approval'},{target:{...target,binding_generation:3}},{expires_at:'2000-01-01T00:00:00Z'},{confirmed_scope:'bom_write.v1'}])expect(()=>parsePersonalChangeRead(p,200,JSON.stringify({...verified,...changed}))).toThrow('PLM_CHANGE_READ_INVALID_RESPONSE')
})
it('uses existing exact baseline/page/fact source, binding and cursor parsers',()=>{
 enabled();const p=preparePersonalChangeRead({operation:'page'},grant,authority);expect(p.url.search).toBe('')
 const page={schema:'yuantus.plm-change-page.v1',source:event.source,head_sequence:1,next_sequence:1,events:[]}
 expect(parsePersonalChangeRead(p,200,JSON.stringify(page))).toEqual(page)
 const next=preparePersonalChangeRead({operation:'page',afterSequence:0},grant,authority);expect(next.url.search).toBe('?after_sequence=0')
 expect(parsePersonalChangeRead(next,200,JSON.stringify({...page,events:[{sequence:1,event}]}))).toMatchObject({next_sequence:1})
 const fact=preparePersonalChangeRead({operation:'fact',eventId},grant,authority);expect(parsePersonalChangeRead(fact,200,JSON.stringify(event))).toEqual(event)
 expect(()=>parsePersonalChangeRead(fact,200,JSON.stringify({...event,source:{...event.source,connection_id:'native-connection'}}))).toThrow('PLM_CHANGE_READ_INVALID_RESPONSE')
 expect(()=>parsePersonalChangeRead(next,200,JSON.stringify({...page,events:[{sequence:2,event}]}))).toThrow('PLM_CHANGE_READ_INVALID_RESPONSE')
 for(const call of [{operation:'page',afterSequence:-1},{operation:'page',binding_id:binding}])expect(()=>preparePersonalChangeRead(call as never,grant,authority)).toThrow('PLM_CHANGE_READ_INVALID')
})
it('self-revokes with flags off; sanitizes provider errors once and refuses non-origin URLs',async()=>{
 vi.stubEnv('PLM_PERSONAL_BOM_CHANGE_READ_ENABLED','false');const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:204})).mockResolvedValueOnce(new Response(grant,{status:403}));vi.stubGlobal('fetch',fetch)
 expect(await adapter().personalBomChangeReadRequest({operation:'revoke'},grant,authority)).toBeNull();expect(fetch.mock.calls[0][1].method).toBe('DELETE')
 enabled();await expect(adapter().personalBomChangeReadRequest({operation:'verify'},grant,authority)).rejects.toMatchObject({status:403,code:'PLM_CHANGE_READ_UNAVAILABLE'})
 await expect(adapter().personalBomChangeReadRequest({operation:'verify'},grant,{...authority,origin:'https://provider.invalid/path'})).rejects.toMatchObject({status:403});expect(fetch).toHaveBeenCalledTimes(2)
})
it('preserves Native code-point limits and rejects invalid UTF-8 target strings',()=>{
 expect(snapshotShareTargetSchema.parse({...target,base_id:'😀'.repeat(128),audience:'😀'.repeat(1000)}).audience).toHaveLength(2000)
 for(const value of [{audience:'a'.repeat(1001)},{base_id:'😀'.repeat(129)},{audience:'\ud800'}])expect(snapshotShareTargetSchema.safeParse({...target,...value}).success).toBe(false)
})
