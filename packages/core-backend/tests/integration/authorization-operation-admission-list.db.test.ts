import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url=process.env.PERMISSION_ADMISSION_LIST_DATABASE_URL
if (url) { const parsed=new URL(url); if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) || parsed.pathname!=='/permission_command_list_test' || parsed.search || parsed.hash) throw new Error('isolated synthetic list fixture required') }
const suite=url ? describe : describe.skip
suite('admin member admission filter on a fully migrated synthetic database',()=>{
  const actor=randomUUID(), ordinary=randomUUID(), nonce=randomUUID().replaceAll('-',''), tag=`list${nonce}`
  const namespace=`n${nonce}`, second=`other${nonce}`, users=Array.from({length:30},()=>randomUUID())
  let db:Client, app:express.Express, adminToken:string, ordinaryToken:string, close:()=>Promise<void>
  const path='/api/admin/users'
  const get=(query:Record<string,unknown>,token=adminToken)=>request(app).get(path).auth(token,{type:'bearer'}).query(query)
  beforeAll(async()=>{
    db=new Client({connectionString:url});await db.connect()
    await db.query("INSERT INTO users(id,email,name,password_hash,role,is_admin) VALUES ($1,$2,'actor','synthetic','admin',true),($3,$4,'ordinary','synthetic','user',false)",[actor,`${actor}@example.test`,ordinary,`${ordinary}@example.test`])
    await db.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'admin')",[actor])
    for(let i=0;i<users.length;i++) await db.query('INSERT INTO users(id,email,name,password_hash,role,is_admin,is_active) VALUES ($1,$2,$3,$4,$5,false,$6)',[users[i],`${users[i]}@example.test`,`${tag}-${String(i).padStart(2,'0')}`,'synthetic','user',i%5!==0])
    for(let i=0;i<27;i++) await db.query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled,source,updated_at) VALUES ($1,$2,$3,'platform_admin','2026-01-01T00:00:00Z')",[users[i],namespace,i<24])
    await db.query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled,source,updated_at) VALUES ($1,$2,true,'platform_admin','2026-01-02T00:00:00Z')",[users[0],second])
    process.env.DATABASE_URL=url;process.env.JWT_SECRET='synthetic-list-test-secret-only';process.env.PRODUCT_MODE='plm-workbench';process.env.RBAC_TOKEN_TRUST='false';process.env.RBAC_BYPASS='false';process.env.DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED='false'
    const [{adminUsersRouter},{authService},{poolManager}]=await Promise.all([import('../../src/routes/admin-users'),import('../../src/auth/AuthService'),import('../../src/integration/db/connection-pool')])
    app=express();app.use(express.json());app.use(adminUsersRouter())
    const jwt=(id:string)=>authService.createToken({id,email:`${id}@example.test`,name:'synthetic',role:'user',permissions:[],created_at:new Date(),updated_at:new Date()})
    adminToken=jwt(actor);ordinaryToken=jwt(ordinary);close=()=>poolManager.close()
  },60000)
  afterAll(async()=>{
    if(close)await close()
    const ids=[actor,ordinary,...users]
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id=ANY($1::text[])',[ids]);await db.query('DELETE FROM user_roles WHERE user_id=ANY($1::text[])',[ids]);await db.query('DELETE FROM users WHERE id=ANY($1::text[])',[ids]);await db.end()
  })
  it('combines namespace filter with search, account status and pagination beyond 20',async()=>{
    const options={q:tag,admissionNamespace:namespace,admissionStatus:'enabled',sort:'name',dir:'asc',pageSize:20}
    const first=await get({...options,page:1});const secondPage=await get({...options,page:2})
    expect(first.status,JSON.stringify(first.body)).toBe(200);expect(first.body.data.total).toBe(24);expect(first.body.data.appliedAdmissionFilter).toEqual({namespace,status:'enabled'});expect(first.body.data.items).toHaveLength(20)
    expect(secondPage.body.data.total).toBe(24);expect(secondPage.body.data.items.map((item:{id:string})=>item.id)).toEqual(users.slice(20,24))
    const meta=await get({...options,meta:1});expect(meta.status).toBe(200);expect(meta.body.data.summary.total).toBe(30);expect(meta.body.data.roleOptions).toContain('user')
    const active=await get({...options,accountStatus:'active',pageSize:10,page:2})
    expect(active.status).toBe(200);expect(active.body.data.total).toBe(19);expect(active.body.data.items).toHaveLength(9)
    expect(active.body.data.items.every((item:{is_active:boolean})=>item.is_active)).toBe(true)
    const normalized=await get({...options,admissionNamespace:`  ${namespace}  `});expect(normalized.body.data.appliedAdmissionFilter).toEqual({namespace,status:'enabled'})
    expect(Object.hasOwn(first.body.data.items[0],'enabledAdmissionNamespaces')).toBe(false)
  })
  it('treats explicit disabled and missing rows as disabled',async()=>{
    const result=await get({q:tag,admissionNamespace:namespace,admissionStatus:'disabled',includeAdmissionSummary:1,sort:'name',dir:'asc'})
    expect(result.status).toBe(200);expect(result.body.data.total).toBe(6)
    expect(result.body.data.items.map((item:{id:string})=>item.id)).toEqual(users.slice(24))
    const disabled=result.body.data.items[0], missing=result.body.data.items[3]
    expect(disabled.enabledAdmissionNamespaces).toEqual([]);expect(disabled.lastAdmissionChangedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(missing.enabledAdmissionNamespaces).toEqual([]);expect(missing.lastAdmissionChangedAt).toBeNull()
  })
  it('honors the admission filter for a pinned row but keeps legacy pin behavior otherwise',async()=>{
    const base={q:tag,admissionNamespace:namespace,admissionStatus:'enabled',sort:'name',dir:'asc',pageSize:20}
    const forbiddenPin=await get({...base,userId:users[24]});expect(forbiddenPin.body.data.pinUserIncluded).toBe(false)
    expect(forbiddenPin.body.data.items.some((item:{id:string})=>item.id===users[24])).toBe(false)
    const eligiblePin=await get({...base,userId:users[23],includeAdmissionSummary:1});expect(eligiblePin.body.data.pinUserIncluded).toBe(true)
    expect(eligiblePin.body.data.items[0]).toMatchObject({id:users[23],enabledAdmissionNamespaces:[namespace]})
    const legacy=await get({q:tag,sort:'name',dir:'asc',pageSize:20,userId:users[24]});expect(legacy.body.data.appliedAdmissionFilter).toBeNull();expect(legacy.body.data.pinUserIncluded).toBe(true);expect(legacy.body.data.items[0].id).toBe(users[24])
    const searchMiss=await get({q:`${tag}-not-present`,userId:users[0]});expect(searchMiss.body.data.total).toBe(0);expect(searchMiss.body.data.pinUserIncluded).toBe(true);expect(searchMiss.body.data.items[0].id).toBe(users[0])
    const filteredSearchMiss=await get({q:`${tag}-not-present`,userId:users[0],admissionNamespace:namespace,admissionStatus:'enabled'});expect(filteredSearchMiss.body.data.total).toBe(0);expect(filteredSearchMiss.body.data.pinUserIncluded).toBe(true);expect(filteredSearchMiss.body.data.items[0].id).toBe(users[0])
  })
  it('summarizes only requested page IDs and makes no permission writes',async()=>{
    const seen:unknown[][]=[],rowCounts:number[]=[];const proto=Client.prototype as unknown as {query:(...args:unknown[])=>unknown},original=proto.query
    const tables=['user_roles','user_permissions','user_namespace_admissions']
    const snapshot=async()=>{const result:Record<string,string>={};for(const table of tables)result[table]=JSON.stringify((await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE user_id=ANY($1::text[]) ORDER BY to_jsonb(t)::text`,[[actor,ordinary,...users]])).rows);return result}
    const before=await snapshot()
    proto.query=function(this:unknown,...args:unknown[]){const sql=typeof args[0]==='string'?args[0]:(args[0] as {text?:unknown}|undefined)?.text;if(typeof sql==='string' && sql.includes('AS enabled_namespaces')) {
      seen.push([...args]);const index=args.findIndex(item=>typeof item==='function')
      if(index>=0) {const callback=args[index] as (error:unknown,result:{rows:unknown[]})=>unknown;args[index]=(error:unknown,result:{rows:unknown[]})=>{if(!error)rowCounts.push(result.rows.length);return callback(error,result)};return original.apply(this,args)}
      return Promise.resolve(original.apply(this,args)).then((result:unknown)=>{rowCounts.push((result as {rows:unknown[]}).rows.length);return result})
    }return original.apply(this,args)}
    let response:request.Response, empty:request.Response
    try {response=await get({q:tag,includeAdmissionSummary:1,pageSize:10,sort:'name',dir:'asc'});empty=await get({q:`${tag}-not-present`,includeAdmissionSummary:1})} finally {proto.query=original}
    expect(empty.status).toBe(200);expect(empty.body.data.items).toEqual([])
    expect(response.status).toBe(200);expect(seen).toHaveLength(1)
    const config=seen[0][0] as {values?:unknown[]};const parameters=(seen[0][1] ?? config.values) as [string[]];const requested=parameters[0];expect(requested).toEqual(response.body.data.items.map((item:{id:string})=>item.id));expect(requested).toHaveLength(10);expect(rowCounts).toEqual([10])
    expect(response.body.data.items[0]).toMatchObject({id:users[0],enabledAdmissionNamespaces:[namespace,second].sort(),lastAdmissionChangedAt:'2026-01-02T00:00:00.000Z'})
    expect(await snapshot()).toEqual(before)
  })
  it('validates the filter and preserves the existing non-admin gate',async()=>{
    for(const query of [{admissionNamespace:namespace},{admissionStatus:'enabled'},{admissionNamespace:'admin',admissionStatus:'enabled'},{admissionNamespace:'*',admissionStatus:'enabled'},{admissionNamespace:'a'.repeat(256),admissionStatus:'enabled'},{admissionNamespace:namespace,admissionStatus:'other'}]){
      const result=await get(query);expect(result.status).toBe(400);expect(result.body.error.code).toBe('ADMISSION_FILTER_INVALID')
    }
    const repeated=await get({admissionNamespace:[namespace,second],admissionStatus:'enabled'});expect(repeated.status).toBe(400)
    const injection=await get({q:tag,admissionNamespace:"x' OR true --",admissionStatus:'enabled'});expect(injection.status).toBe(200);expect(injection.body.data.total).toBe(0)
    expect((await get({q:tag,admissionNamespace:namespace,admissionStatus:'enabled'},ordinaryToken)).status).toBe(403)
  })
})
