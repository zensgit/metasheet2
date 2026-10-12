import { createRequire } from 'node:module'
import { describe,expect,it,vi } from 'vitest'
const require=createRequire(import.meta.url)
const {readTripContextTransitionDates:read}=require('../../../../plugins/plugin-attendance/lib/attendance-trip-context-transition-dates.cjs')
const input={orgId:'org-a',userId:'user-a',from:new Date('2030-01-01T00:00:00Z'),to:new Date('2230-01-01T00:00:00Z'),timezone:'Pacific/Kiritimati'}
const row={id:'a',org_id:'org-a',user_id:'user-a',start_date:'2030-01-01',end_date:'2229-12-31'}
function setup(direct:unknown[]=[],rotations:unknown[]=[],memberships:unknown[]=[],holidays:unknown[]=[],settings:unknown[]=[]){
  const query=vi.fn()
  for(const value of [direct,rotations,memberships,holidays,settings])query.mockResolvedValueOnce(value)
  return {query,run:()=>read({query},input)}
}
describe('trip actual source transition representatives',()=>{
  it('does not enumerate calendar days or impose a business duration limit',async()=>{
    const f=setup(),dates=await f.run()
    expect(dates).toEqual(['2029-12-29','2029-12-30','2029-12-31','2030-01-01','2030-01-02','2030-01-03','2030-01-04','2230-01-02'])
    expect(f.query).toHaveBeenCalledTimes(5)
    expect(f.query.mock.calls[0][1]).toEqual(['org-a','user-a','2230-01-02','2029-12-29'])
  })
  it('includes interior direct closed-DATE start, end, and following date',async()=>{
    const dates=await setup([{...row,start_date:'2100-06-12',end_date:'2100-06-14'}]).run()
    expect(dates).toEqual(expect.arrayContaining(['2100-06-11','2100-06-12','2100-06-14','2100-06-15']))
    expect(dates.length).toBeLessThan(30)
  })
  it('covers every rotation phase and weekly working-day pair',async()=>{
    const dates=await setup([], [{...row,shift_sequence:Array.from({length:31},(_,i)=>'shift-'+i)}]).run()
    const pairs=new Set(dates.filter((date:string)=>date>=row.start_date&&date<=row.end_date).map((date:string)=>{
      const at=new Date(date+'T00:00:00Z'),offset=(at.getTime()-input.from.getTime())/86400000
      return String(offset%31)+':'+at.getUTCDay()
    }))
    expect(pairs.size).toBe(31*7)
    expect(dates.length).toBeLessThan(230)
  })
  it('preserves a witness of multiple simultaneous atomic rotations without inventing a winner',async()=>{
    const f=setup([], [{...row,shift_sequence:Array(97).fill('a')},{...row,id:'b',shift_sequence:Array(101).fill('b')}])
    const dates=await f.run()
    expect(dates).toContain('2030-01-01')
    expect(dates.length).toBeLessThan(20)
    expect(f.query.mock.calls[1][0]).toContain('r.org_id=a.org_id')
    expect(f.query.mock.calls[1][0]).not.toContain('LIMIT')
  })
  it('splits closed membership bounds and every holiday or calendar-policy exception',async()=>{
    const dates=await setup([],[],[{...row,start_date:'2100-05-01',end_date:'2100-05-03'}],
      [{org_id:'org-a',holiday_date:'2110-05-08'}],
      [{value:{calendarPolicy:{overrides:[{date:'2120-01-05'},{from:'2130-06-05',to:'2130-06-11'}]}}}]).run()
    expect(dates).toEqual(expect.arrayContaining(['2100-05-01','2100-05-03','2100-05-04','2110-05-08','2110-05-09','2120-01-05','2120-01-06','2130-06-05','2130-06-11','2130-06-12']))
  })
  it('restarts phase coverage after an interior membership or holiday boundary',async()=>{
    const dates=await setup([], [{...row,shift_sequence:['a','b']}],[],[{org_id:'org-a',holiday_date:'2100-06-03'}]).run()
    const after=dates.filter((date:string)=>date>'2100-06-03'&&date<'2100-07-01')
    const pairs=new Set(after.map((date:string)=>{const at=new Date(date+'T00:00:00Z');return ((at.getTime()-input.from.getTime())/86400000%2)+':'+at.getUTCDay()}))
    expect(pairs.size).toBe(14)
  })
  it.each([[],[''],[null]])('refuses empty or invalid rotation sequence %j',async sequence=>{
    await expect(setup([],[{...row,shift_sequence:sequence}]).run()).rejects.toMatchObject({code:'ATTENDANCE_TRIP_TRANSITION_SOURCE_UNAVAILABLE',status:503})
  })
  it('refuses cross-organization source rows even from an adapter',async()=>{
    await expect(setup([{...row,org_id:'org-b'}]).run()).rejects.toMatchObject({code:'ATTENDANCE_TRIP_TRANSITION_SOURCE_UNAVAILABLE'})
  })
  it.each([0,1,2,3,4])('source read failure %i is values-free and never empty success',async failed=>{
    const query=vi.fn()
    for(let i=0;i<failed;i++)query.mockResolvedValueOnce([])
    query.mockRejectedValueOnce(new Error('synthetic private database payload'))
    await expect(read({query},input)).rejects.toMatchObject({message:'ATTENDANCE_TRIP_TRANSITION_SOURCE_UNAVAILABLE',status:503})
  })
  it('refuses malformed settings rather than removing a calendar exception',async()=>{
    await expect(setup([],[],[],[],[{value:'{broken'}]).run()).rejects.toMatchObject({code:'ATTENDANCE_TRIP_TRANSITION_SOURCE_UNAVAILABLE'})
  })
  it('refuses backwards intervals before reading sources',async()=>{
    const query=vi.fn()
    await expect(read({query},{...input,to:input.from})).rejects.toMatchObject({status:503})
    expect(query).not.toHaveBeenCalled()
  })
})
