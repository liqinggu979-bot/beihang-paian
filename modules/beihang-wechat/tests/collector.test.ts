import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { loadChecks } from "@aihot/backend/publication/checks";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { collectDueWechat, normalizeWechatItem, registerWechatSources, requestWechatRetry, wechatAccounts,
  WECHAT_COVERAGE, type CollectorClient, type CollectorItem, type CollectorResult, type WechatAccount } from "../server.ts";

const id="wechat-aviation";
const account=wechatAccounts().find(a=>a.id===id)!;
let sequence=0;
const item=(a:WechatAccount, overrides:Partial<CollectorItem>={}):CollectorItem=>({
  title:"校园竞赛报名通知",url:`https://mp.weixin.qq.com/s/test_${++sequence}`,
  publishedAt:new Date().toISOString(),bodyText:"面向北航学生的竞赛报名，原文明确列出了参加条件、截止时间以及报名方式。",
  author:a.name,publisherBiz:a.biz,publicationTimeEvidence:"original-page-ct",discovery:"public-web-search",...overrides,
});
const result=(a:WechatAccount, items:CollectorItem[], partial=false):CollectorResult=>({
  account:a.name,bookId:a.bookId,coverage:WECHAT_COVERAGE,headless:true,
  state:partial?"partial":"ok",issues:partial?[{stage:"latest-article",code:"login_required"}]:[],
  search:{state:"ok",pages:1,results:2,matchingResults:items.length},latest:partial?"failed":"ok",items,checkedAt:new Date().toISOString(),
});
const row=async()=> (await sql`SELECT * FROM sources WHERE id=${id}`)[0]!;

beforeEach(async()=>{
  await registerWechatSources();
  await sql`UPDATE sources SET enabled=false WHERE config->'wechat'->>'coverage'=${WECHAT_COVERAGE}`;
  await sql`DELETE FROM fetch_runs WHERE source_id=${id}`;
  await sql`UPDATE sources SET enabled=true,next_fetch_at=NULL,last_fetch_at=NULL,last_ok_at=NULL,health='ok',fail_count=0 WHERE id=${id}`;
});
after(async()=>{await stopBoss();await closeDb();});

test("48-hour reservation survives repeat invocations and collection never bills a model",async()=>{
  let calls=0;
  const [before]=await sql`SELECT count(*)::int AS n FROM receipt_attempts`;
  const client:CollectorClient=async a=>{calls++;return result(a,[item(a)]);};
  assert.equal((await collectDueWechat(client)).state,"ok");
  const s=await row();assert.equal(+s.next_fetch_at-+s.last_fetch_at,172800000);
  assert.equal((await collectDueWechat(client)).state,"not_due");assert.equal(calls,1);
  const [after]=await sql`SELECT count(*)::int AS n FROM receipt_attempts`;
  assert.equal(after!.n,before!.n);
});

test("concurrent ticks claim one due account once",async()=>{
  let calls=0;
  const client:CollectorClient=async a=>{calls++;return result(a,[]);};
  const runs=await Promise.all([collectDueWechat(client),collectDueWechat(client)]);
  assert.equal(calls,1);assert.equal(runs.filter(r=>r.state==="ok").length,1);
  assert.equal(runs.filter(r=>r.state==="not_due").length,1);
});

test("failure keeps the success watermark, waits 48 hours, and never logs authenticated errors",async()=>{
  const previous=new Date(Date.now()-96*3600000);
  await sql`UPDATE sources SET last_ok_at=${previous} WHERE id=${id}`;
  let calls=0;
  const client:CollectorClient=async()=>{calls++;throw new Error("https://example.invalid/?token=secret-login");};
  assert.equal((await collectDueWechat(client)).state,"failed");
  const s=await row();assert.equal(+s.last_ok_at,+previous);
  assert.equal(+s.next_fetch_at-+s.last_fetch_at,172800000);
  assert.ok(!s.last_error.includes("secret-login"));
  assert.equal((await collectDueWechat(client)).state,"not_due");assert.equal(calls,1);
  assert.equal((await loadChecks()).sources.find(s=>s.id===id)!.state,"failed");
});

test("partial results are retained and shown as incomplete, never zero-new success",async()=>{
  const previous=new Date(Date.now()-4*86400000);
  await sql`UPDATE sources SET last_ok_at=${previous} WHERE id=${id}`;
  const r=await collectDueWechat(async a=>result(a,[item(a)],true));
  assert.equal(r.state,"partial");assert.equal(r.created,1);
  assert.equal(+(await row()).last_ok_at,+previous);
  const status=(await loadChecks()).sources.find(s=>s.id===id)!;
  assert.equal(status.state,"partial");assert.equal(status.coverage,WECHAT_COVERAGE);
});

test("a genuine update after an outage uses the original publication time and polling watermark",async()=>{
  const previous=new Date(Date.now()-96*3600000);const published=new Date(Date.now()-72*3600000);
  await sql`UPDATE sources SET last_ok_at=${previous},last_fetch_at=${previous} WHERE id=${id}`;
  const m=item(account,{publishedAt:published.toISOString()});
  await collectDueWechat(async a=>result(a,[m]));
  const [a]=await sql`SELECT published_at,backfill,body_text FROM articles WHERE url=${m.url}`;
  assert.equal(+a!.published_at,+published);assert.equal(a!.backfill,false);assert.equal(a!.body_text,m.bodyText);
  await sql`UPDATE sources SET next_fetch_at=now() WHERE id=${id}`;
  assert.equal((await collectDueWechat(async a=>result(a,[m]))).created,0,"the next check deduplicates the article");
});

test("unverified publishers and future timestamps never enter the article queue",async()=>{
  const bad=item(account,{publisherBiz:"another-account"});
  const r=await collectDueWechat(async a=>result(a,[bad]));assert.equal(r.state,"partial");assert.equal(r.created,0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE url=${bad.url}`)[0]!.n,0);
  assert.throws(()=>normalizeWechatItem(item(account,{publishedAt:new Date(Date.now()+86400000).toISOString()}),account,new Date()),/invalid_publication_time/);
});

test("an interrupted check is marked failed without shortening its saved due time",async()=>{
  const at=new Date(Date.now()-20*60000);const next=new Date(+at+172800000);
  await sql`UPDATE sources SET last_fetch_at=${at},next_fetch_at=${next} WHERE id=${id}`;
  await sql`INSERT INTO fetch_runs(source_id,status,started_at) VALUES (${id},'running',${at})`;
  assert.equal((await collectDueWechat(async()=>{throw new Error("must not call");})).state,"not_due");
  assert.equal(+(await row()).next_fetch_at,+next);
  assert.equal((await sql`SELECT status FROM fetch_runs WHERE source_id=${id}`)[0]!.status,"failed");
});

test("setup preserves an operator's pause and material older than a calendar year is excluded",async()=>{
  await sql`UPDATE sources SET enabled=false WHERE id=${id}`;
  await registerWechatSources();assert.equal((await row()).enabled,false);
  const now=new Date();const old=new Date(now);old.setUTCFullYear(old.getUTCFullYear()-2);
  assert.equal(normalizeWechatItem(item(account,{publishedAt:old.toISOString()}),account,now),null);
});

test("manual retry queues a due check but cannot overlap an active check or reactivate a pause",async()=>{
  await sql`UPDATE sources SET next_fetch_at=now()+interval '48 hours' WHERE id=${id}`;
  const source={id,config:{wechat:{coverage:WECHAT_COVERAGE}}};
  assert.equal((await requestWechatRetry(source)).state,"queued");
  assert.equal((await collectDueWechat(async a=>result(a,[]))).state,"ok");
  await sql`INSERT INTO fetch_runs(source_id,status) VALUES (${id},'running')`;
  assert.equal((await requestWechatRetry(source)).state,"paused_or_already_checking");
  await sql`DELETE FROM fetch_runs WHERE source_id=${id} AND status='running'`;
  await sql`UPDATE sources SET enabled=false WHERE id=${id}`;
  assert.equal((await requestWechatRetry(source)).state,"paused_or_already_checking");
});

test("rotating search signatures deduplicate against a previously imported short link",async()=>{
  const mid="2651234567";const idx="2";const identityKey=`wechat:${account.biz}:${mid}:${idx}`;
  const short=item(account,{wechatMid:mid,wechatIdx:idx,identityKey});
  await upsertMaterial({sourceId:id,url:short.url,title:short.title,bodyText:short.bodyText,bodyStatus:"ok",publishedAt:new Date(short.publishedAt),via:"ingest"});
  assert.equal((await collectDueWechat(async a=>result(a,[{...short,aliases:[short.url]}]))).created,0);
  await sql`UPDATE sources SET next_fetch_at=now() WHERE id=${id}`;
  const signed={...short,url:"https://mp.weixin.qq.com/s?src=11&timestamp=1793766667&ver=7067&signature=public-index&new=1"};
  assert.equal((await collectDueWechat(async a=>result(a,[signed]))).created,0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${id} AND raw->>'wechatIdentity'=${identityKey}`)[0]!.n,1);
});
