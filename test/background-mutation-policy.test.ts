import { test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { TTL_NOTICE_SHOWN_KEY } from '../src/core/minions/admission.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { MinionSupervisor, probeQueueState } from '../src/core/minions/supervisor.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async()=>{engine=new PGLiteEngine();await engine.connect({});await engine.initSchema();});
afterAll(async()=>{await engine.disconnect();});
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>boolean|Promise<boolean>) {
  const deadline=Date.now()+3000;
  while(!await check()){if(Date.now()>deadline)throw new Error('fixture timed out');await sleep(10);}
}
async function fixture(run:(policy:(allow:boolean)=>void)=>Promise<void>) {
  const home=mkdtempSync(join(tmpdir(),'background-policy-'));
  const path=join(home,'policy.json');
  const policy=(allow:boolean)=>writeFileSync(path,JSON.stringify({version:1,mutations:allow?'allow':'deny'}));
  try {
    await engine.executeRaw('TRUNCATE minion_jobs CASCADE');
    await withEnv({GBRAIN_HOME:home,GBRAIN_MUTATION_POLICY_FILE:path,GBRAIN_SUPERVISED:undefined},async()=>{policy(false);await run(policy);});
  } finally {rmSync(home,{recursive:true,force:true});}
}
function worker(extra:Record<string,unknown>={}) {
  return new MinionWorker(engine,{concurrency:1,pollInterval:10,maxRssMb:0,healthCheckInterval:0,...extra});
}
test('denied ticks leave delayed and waiting rows untouched; allowing resumes real execution',async()=>{
  await fixture(async(policy)=>{
    const q=new MinionQueue(engine);await q.ensureSchema();
    const job=await q.add('fixture',{}, {delay:1});
    await sleep(5);
    const w=worker();let ran=0;
    w.register('fixture',async()=>{ran++;});
    const actual=(w as any).queue;let promotions=0,claims=0;
    const promote=actual.promoteDelayed.bind(actual),claim=actual.claim.bind(actual);
    actual.promoteDelayed=async()=>{promotions++;return promote();};
    actual.claim=async(...args:unknown[])=>{claims++;return claim(...args);};
    const running=w.start();
    try {
      await sleep(80);expect(promotions).toBe(0);expect(claims).toBe(0);expect(ran).toBe(0);
      const rows=await engine.executeRaw<any>('SELECT status,attempts_started FROM minion_jobs WHERE id=$1',[job.id]);
      expect(rows[0]).toMatchObject({status:'delayed',attempts_started:0});
      policy(true);await until(()=>ran===1);expect(promotions).toBeGreaterThan(0);
    } finally {w.stop();await running;}
  });
},10000);
test('policy transition during promotion prevents the following claim',async()=>{
  await fixture(async(policy)=>{
    const w=worker();w.register('fixture',async()=>{throw new Error('must not launch');});
    const q=(w as any).queue;let promoted=false,claims=0;
    q.promoteDelayed=async()=>{promoted=true;policy(false);};
    q.claim=async()=>{claims++;return null;};
    policy(true);const running=w.start();
    try{await until(()=>promoted);await sleep(30);expect(claims).toBe(0);}
    finally{w.stop();await running;}
  });
});
test('post-claim denial releases without handler, timeout or spending the first attempt',async()=>{
  await fixture(async(policy)=>{
    const q=new MinionQueue(engine);await q.ensureSchema();const job=await q.add('fixture',{}, {timeout_ms:60000});
    const w=worker();let ran=0;w.register('fixture',async()=>{ran++;});
    const wq=(w as any).queue,claim=wq.claim.bind(wq);let claimed=false;
    wq.claim=async(...args:unknown[])=>{const row=await claim(...args);if(row){policy(false);claimed=true;}return row;};
    policy(true);const running=w.start();
    try {
      await until(async()=>claimed && (await engine.executeRaw<any>('SELECT status FROM minion_jobs WHERE id=$1',[job.id]))[0].status==='delayed');
      const row=(await engine.executeRaw<any>('SELECT * FROM minion_jobs WHERE id=$1',[job.id]))[0];
      expect(row).toMatchObject({attempts_started:0,attempts_made:0,started_at:null,timeout_at:null,lock_token:null});
      expect(ran).toBe(0);
    }finally{w.stop();await running;}
  });
});
test('conditional release preserves prior retry history and is idempotent',async()=>{
  await fixture(async()=>{
    const q=new MinionQueue(engine);await q.ensureSchema();const job=await q.add('fixture',{},{timeout_ms:60000});
    await engine.executeRaw("UPDATE minion_jobs SET attempts_started=3,attempts_made=2,started_at='2026-01-01T00:00:00Z' WHERE id=$1",[job.id]);
    const row=await q.claim('fixture-lock',60000,'default',['fixture']);expect(row).not.toBeNull();
    const w=worker();await (w as any).releaseClaimForPause(row,'fixture-lock',true);
    await (w as any).releaseClaimForPause(row,'fixture-lock',true);
    const result=(await engine.executeRaw<any>('SELECT * FROM minion_jobs WHERE id=$1',[job.id]))[0];
    expect(result.attempts_started).toBe(3);expect(result.attempts_made).toBe(2);
    expect(new Date(result.started_at).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(result.timeout_at).toBeNull();expect(result.status).toBe('delayed');
  });
});
test('failed post-claim release stays visible and never launches the denied handler',async()=>{
  await fixture(async(policy)=>{
    const q=new MinionQueue(engine);await q.ensureSchema();await q.add('fixture',{});
    const w=worker();let ran=0;w.register('fixture',async()=>{ran++;});
    const wq=(w as any).queue,claim=wq.claim.bind(wq);
    wq.claim=async(...args:unknown[])=>{const row=await claim(...args);if(row)policy(false);return row;};
    const real=engine.executeRaw.bind(engine);const errors:string[]=[];
    const stderr=spyOn(console,'error').mockImplementation((...args)=>{errors.push(args.join(' '));});
    (engine as any).executeRaw=async(sql:string,...args:any[])=>{
      if(sql.includes('CASE WHEN $3 THEN GREATEST'))throw new Error('synthetic release failure');
      return real(sql,...args as []);
    };
    policy(true);const running=w.start();
    try{await until(()=>errors.some(x=>x.includes('pause release failed')));expect(ran).toBe(0);}
    finally{w.stop();await running;delete (engine as any).executeRaw;stderr.mockRestore();}
  });
});
test('worker pause suppresses idle restart and resume grants a fresh progress window',async()=>{
  await fixture(async(policy)=>{
    const q=new MinionQueue(engine);await q.ensureSchema();await q.add('fixture',{});
    const w=worker({healthCheckInterval:10,stallWarnAfterMs:100,stallExitAfterMs:200,dbProbeTimeoutMs:200});
    w.register('fixture',async()=>{});
    (w as any).queue.claim=async()=>null; // simulate a genuinely wedged idle worker after resumption
    const unhealthy:any[]=[];w.on('unhealthy',x=>unhealthy.push(x));
    const running=w.start();
    try{
      await sleep(300);expect(unhealthy).toEqual([]);
      policy(true);await sleep(70);expect(unhealthy).toEqual([]);
      await until(()=>unhealthy.length>0);expect(unhealthy[0].reason).toBe('stalled');
    }finally{w.stop();await running;}
  });
},10000);
test('worker DB liveness failure remains actionable during policy pause',async()=>{
  await fixture(async()=>{
    const real=engine.executeRaw.bind(engine);
    (engine as any).executeRaw=async(sql:string,...args:any[])=>{
      if(sql.trim()==='SELECT 1')throw new Error('fixture dead pool');
      return real(sql,...args as []);
    };
    const w=worker({healthCheckInterval:10,dbFailExitAfter:2,dbProbeTimeoutMs:100});
    w.register('fixture',async()=>{});
    const unhealthy:any[]=[];w.on('unhealthy',x=>unhealthy.push(x));
    const running=w.start();
    try{await until(()=>unhealthy.length>0);expect(unhealthy[0].reason).toBe('db_dead');}
    finally{w.stop();await running;delete (engine as any).executeRaw;}
  });
});
test('supervisor keeps stalled/DB diagnostics, suppresses paused progress and gives resume grace',async()=>{
  await fixture(async(policy)=>{
    let now=Date.now();const time=spyOn(Date,'now').mockImplementation(()=>now);
    let fail=false,reconnects=0,restarts=0;const events:any[]=[];
    const stale=new Date(now-60*60000).toISOString();
    const stub={kind:'postgres',executeRaw:async()=>{
      if(fail)throw new Error('fixture DB failure');
      return [{stalled:'11',active_healthy:'0',waiting:'5',waiting_claimable:'5',last_completed:stale,last_completed_claimable:stale}];
    },reconnect:async()=>{reconnects++;}};
    const sup=new MinionSupervisor(stub as any,{cliPath:'/bin/true',maxRssMb:0,
      wedgeRestartMinutes:15,wedgeRestartChecks:1,startupGraceMs:120000,onEvent:e=>events.push(e)});
    sup._setChildSupervisorForTests({childAlive:true,inBackoff:false,restartCurrentChild:async()=>{restarts++;}} as any);
    sup._setWedgeStateForTests({handlerNames:['fixture'],childStartedAt:now-600000});
    try{
      for(let i=0;i<3;i++)await sup._healthCheckOnceForTests();
      expect(restarts).toBe(0);expect(events.some(e=>e.reason==='stalled_jobs')).toBe(true);
      expect(events.some(e=>e.reason==='no_recent_completions')).toBe(false);
      fail=true;for(let i=0;i<3;i++)await sup._healthCheckOnceForTests();
      expect(reconnects).toBe(1);expect(events.some(e=>e.reason==='db_connection_degraded')).toBe(true);fail=false;
      policy(true);await sup._healthCheckOnceForTests();expect(restarts).toBe(0);
      now+=3*60000;await sup._healthCheckOnceForTests();expect(restarts).toBe(0);
      now+=14*60000;await sup._healthCheckOnceForTests();expect(restarts).toBe(1);
    }finally{time.mockRestore();}
  });
});
test('submission diagnostics identify host policy separately from migration',async()=>{
  await fixture(async()=>{
    const state=await probeQueueState(engine,'default',['fixture']);
    expect(state.paused).toBe(true);expect(state.warning).toContain('host policy');
    expect(state.warning).not.toContain('paused for migration');
  });
});

test('waiting TTL neither stamps a notice nor cancels work while paused; normal expiry resumes',async()=>{
  await fixture(async(policy)=>{
    const q=new MinionQueue(engine);await q.ensureSchema();
    const job=await q.add('subagent',{prompt:'synthetic expired job'},{},{allowProtectedSubmit:true});
    await engine.executeRaw("UPDATE minion_jobs SET created_at=now()-interval '72 hours',updated_at=now()-interval '72 hours' WHERE id=$1",[job.id]);
    await engine.setConfig(TTL_NOTICE_SHOWN_KEY,'');
    const w=worker({stalledInterval:15});w.register('subagent',async()=>{throw new Error('must not launch');});
    (w as any).queue.claim=async()=>null;
    const running=w.start();
    try{
      await sleep(100);
      expect((await q.getJob(job.id))?.status).toBe('waiting');
      expect(await engine.getConfig(TTL_NOTICE_SHOWN_KEY)).toBe('');
      await engine.setConfig(TTL_NOTICE_SHOWN_KEY,'true');
      await sleep(100);expect((await q.getJob(job.id))?.status).toBe('waiting');
      policy(true);
      await until(async()=>(await q.getJob(job.id))?.status==='cancelled');
      expect((await q.getJob(job.id))?.error_text).toStartWith('waiting_ttl_expired');
    }finally{w.stop();await running;await engine.setConfig(TTL_NOTICE_SHOWN_KEY,'');}
  });
});

test('supervisor defers private-queue cancellation during pause and retries on a later spawn',async()=>{
  await fixture(async(policy)=>{
    let queries=0;
    const stub={kind:'postgres',executeRaw:async()=>{queries++;throw new Error('synthetic recovery boundary');}};
    const sup=new MinionSupervisor(stub as any,{cliPath:'/bin/true',maxRssMb:0,onEvent:()=>{}});
    await (sup as any).reconcileOrphanedPrivateQueuesBeforeWorkerSpawn();expect(queries).toBe(0);
    policy(true);await (sup as any).reconcileOrphanedPrivateQueuesBeforeWorkerSpawn();
    expect(queries).toBeGreaterThan(0);
  });
});
