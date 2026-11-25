import { stub, tag, Reply } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { collectSource, adaptIntervals } from "@aihot/backend/sources/collect";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { decideTimeline } from "@aihot/backend/content/materials";
import { ingestItems } from "@aihot/backend/ingest/items";
import { loadChecks } from "@aihot/backend/publication/checks";
import { assertPublicUrl, trustedSourceAddress } from "@aihot/backend/lib/url";
import { boundModelRequest, conservativeLimit } from "@aihot/backend/providers/model-budget";
import type { ModelSpec } from "@aihot/backend/providers/llm";
import { paidRequest, BudgetExceededError, ProviderRejectedError } from "@aihot/backend/providers/receipts";
import { composeDueReports } from "@aihot/backend/reports/compose";
import { translatePending } from "@aihot/backend/editorial/translate";

const id = `beihang-${tag()}`;
let items: Array<{title:string;url:string;date:string;summary:string}> = [];
let fail = false;
const server = await stub(() => { if (fail) return new Reply(503, {error:"fixture outage"}); return items; });
config.allowPrivateNetworkFetch = true;
config.modelCallsEnabled = false;
after(async () => { await server.close(); await stopBoss(); await closeDb(); });

async function source(name:string,cursor:object={}) {
 await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,interval_minutes,config,cursor,next_fetch_at)
 VALUES (${name},${name},'json_list','T1','editorial',2880,${sql.json({url:server.url,titlePaths:['title'],urlTemplate:'{raw:url}',publishedAtPath:'date',summaryPaths:['summary'],summaryIsBody:true})},${sql.json(cursor as never)},now())`;
}
const row=async(name:string)=>(await sql`SELECT * FROM sources WHERE id=${name}`)[0]!;

test("48-hour due times persist, cross month boundaries and survive adaptive updates",async()=>{
 await source(id);
 assert.equal((await collectSource(id)).status,'ok');
 const first=await row(id);
 assert.equal(+first.next_fetch_at - +first.last_fetch_at,172800000);
 assert.equal((await adaptIntervals()).updated,0);
 assert.equal(+(await row(id)).next_fetch_at,+first.next_fetch_at);
 const [month]=await sql`SELECT '2026-10-31T08:00:00+08:00'::timestamptz + make_interval(mins => ${(await row(id)).interval_minutes}) AS due`;
 assert.equal(month!.due.toISOString(),'2026-11-02T00:00:00.000Z');
 assert.equal((await loadChecks()).sources.find(s=>s.id===id)!.state,'unchanged');
});

test("one and several new items need no quota; failed collection waits another 48 hours",async()=>{
 items=[{title:'一个真实通知',url:server.url+'/one',date:new Date().toISOString(),summary:'通知的原文说明了具体时间与对象。'}];
 assert.equal((await collectSource(id)).created,1);
 items.push(...[2,3,4].map(n=>({title:`通知 ${n}`,url:server.url+'/'+n,date:new Date().toISOString(),summary:'新的独立通知。'})));
 assert.equal((await collectSource(id)).created,3);
 assert.equal((await collectSource(id)).created,0,'unchanged input is idempotent');
 const success=await row(id);fail=true;
 assert.equal((await collectSource(id)).status,'failed');fail=false;
 const failed=await row(id);
 assert.equal(+failed.next_fetch_at - +failed.last_fetch_at,172800000);
 assert.equal(+failed.last_ok_at,+success.last_ok_at);
 assert.equal((await loadChecks()).sources.find(s=>s.id===id)!.state,'failed');
 assert.equal((await sql`SELECT count(*)::int AS n FROM reports`)[0]!.n,0);
 assert.ok((await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${id} AND processing_state='new'`)[0]!.n>=4,'model-off material remains queued for later');
});

test("polling watermark retains genuine updates after an outage; first import and explicit history stay archived",async()=>{
 const discovered=new Date('2026-10-08T08:00:00+08:00');
 const published=new Date('2026-10-05T08:00:00+08:00');
 const last=new Date('2026-10-04T08:00:00+08:00');
 assert.equal(decideTimeline(published,discovered,null,last).backfill,false);
 assert.equal(decideTimeline(published,discovered).backfill,true);
 assert.equal(decideTimeline(published,discovered,'reported-backfill',last).backfill,true);
 assert.equal(decideTimeline(null,discovered,null,last).backfill,true);
 const name=id+'watermark';await source(name,{initializedAt:last.toISOString(),lastOkAt:last.toISOString()});
 items=[{title:'较上次成功检查新发布的通知',url:server.url+'/watermark',date:published.toISOString(),summary:'期间的确新增了政策条目。'}];
 // Runtime discovery uses the real current time; this date is newer than the saved success watermark.
 await collectSource(name);
 const [material]=await sql`SELECT backfill FROM articles WHERE source_id=${name}`;
 assert.equal(material!.backfill,false);
 const old=await row(name);
 const push={sourceId:name,items:[{title:'历史回灌资料',url:server.url+'/backfill',publishedAt:new Date().toISOString(),raw:{_aihot:{backfill:true},collectionObservedAfter:new Date().toISOString()}}]};
 assert.equal((await ingestItems(push)).created,1);
 assert.equal((await ingestItems(push)).created,0);
 assert.equal(+(await row(name)).last_ok_at,+old.last_ok_at,'history is not a successful poll');
 const [history]=await sql`SELECT backfill,raw FROM articles WHERE url=${server.url+'/backfill'}`;
 assert.equal(history!.backfill,true);assert.equal(history!.raw.collectionObservedAfter,undefined);
});

test("the audited text model enforces bytes, output, provider and tariff limits",()=>{
 const spec={key:'default',service:'llm',model:'deepseek-flash',baseUrlEnv:"LLM_BASE_URL",apiKeyEnv:"LLM_API_KEY",jsonMode:true,extra:{thinking:{type:'disabled'}}} satisfies ModelSpec;
 const bound=boundModelRequest(spec,'https://api.deepseek.com','说明','资料',8000,Date.parse('2026-10-08T00:00:00Z'));
 assert.deepEqual(bound,{maxTokens:3000,dailyLimit:13});
 assert.equal(conservativeLimit(24000,3000,256,2,8,1),13);
 assert.ok(13*((24000+256)*2+3000*8)/1000000<=1);
 assert.throws(()=>boundModelRequest(spec,'https://api.deepseek.com','x'.repeat(24001),'',1000,Date.parse('2026-10-08T00:00:00Z')),/byte limit/);
 assert.throws(()=>boundModelRequest({...spec,extra:{thinking:{type:'enabled'}}},'https://api.deepseek.com','a','b',1000),/not verified/);
 assert.throws(()=>boundModelRequest(spec,'https://api.deepseek.com','a','b',1000,Date.parse('2026-11-09T00:00:00Z')),/expired/);
 assert.throws(()=>boundModelRequest(spec,'https://unknown.example','a','b',1000),/not verified/);
});

test("concurrent requests, retries and evaluations share the conservative cap without a budget row",async()=>{
 const service=id+'budget';let sent=0;
 const asks=await Promise.allSettled(Array.from({length:20},(_,n)=>paidRequest({service,purpose:n%2?'selection_eval':'new_message',identity:{n},dailyLimit:13},async()=>{sent++;return{response:{ok:true}}})));
 assert.equal(sent,13);assert.equal(asks.filter(r=>r.status==='fulfilled').length,13);
 assert.ok(asks.filter(r=>r.status==='rejected').every(r=>r.status==='rejected'&&r.reason instanceof BudgetExceededError));
 const attempts=await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE service=${service}`;assert.equal(attempts[0]!.n,13);
 const retryService=id+'retry';const req={service:retryService,purpose:'retry',identity:{id:1},dailyLimit:1};
 await assert.rejects(paidRequest(req,async()=>{throw new ProviderRejectedError('provider unavailable',503,true);}));
 await assert.rejects(paidRequest(req,async()=>({response:{ok:true}})),BudgetExceededError);
 await sql`UPDATE receipt_attempts SET started_at=now()-interval '25 hours' WHERE service=${retryService}`;
 assert.equal((await paidRequest(req,async()=>({response:{ok:true}}))).reused,false,'next budget window resumes');
});

test("campus exceptions cannot authorize other private hosts, addresses, protocols or ports",async()=>{
 process.env.TRUSTED_SOURCE_ADDRESSES_JSON=JSON.stringify({'news.buaa.edu.cn':['10.212.30.215','127.0.0.1']});
 assert.equal(trustedSourceAddress('news.buaa.edu.cn','10.212.30.215'),true);
 assert.equal(trustedSourceAddress('news.buaa.edu.cn','127.0.0.1'),false);
 const resolve=async()=>['10.212.30.215'];
 await assertPublicUrl('https://news.buaa.edu.cn/',false,resolve);
 for(const url of ['http://news.buaa.edu.cn/','https://news.buaa.edu.cn:8443/','https://other.buaa.edu.cn/','https://10.212.30.215/'])await assert.rejects(assertPublicUrl(url,false,resolve));
 await assert.rejects(assertPublicUrl('https://news.buaa.edu.cn/',false,async()=>['10.212.30.216']));
 delete process.env.TRUSTED_SOURCE_ADDRESSES_JSON;
});

test("the first edition generates no automatic report or full-text translation",async()=>{
 assert.deepEqual(await composeDueReports(),{generated:[],failed:[]});
 assert.deepEqual(await translatePending(),{done:[],quotes:0});
});
