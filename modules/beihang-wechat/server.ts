import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config, REPO_ROOT } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { defineServerModule } from "@aihot/backend/modules";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { sanitizeBody } from "@aihot/backend/content/sanitize";
import { stripTags } from "@aihot/backend/lib/text";
import { publishArticle } from "@aihot/backend/publication/publish";

export interface WechatAccount { id: string; name: string; alias: string; biz: string; bookId: string; tier: string; firstParty: boolean; }
export interface CollectorItem {
  title: string; url: string; publishedAt: string; bodyText: string; author: string;
  publisherBiz: string; publicationTimeEvidence: string; discovery: string;
  wechatMid?: string; wechatIdx?: string; identityKey?: string; aliases?: string[];
}
export interface CollectorResult {
  account: string; bookId: string; coverage: string; headless: boolean;
  state: "ok" | "partial" | "failed"; issues: Array<{ stage: string; code: string }>;
  search: { state: string; pages: number; results: number; matchingResults: number };
  latest: string; items: CollectorItem[]; checkedAt: string;
}
export type CollectorClient = (account: WechatAccount, since: Date | null) => Promise<CollectorResult>;
export const WECHAT_INTERVAL_MINUTES = 2880;
export const WECHAT_COVERAGE = "public-search-and-latest";
const credentialFile = () => path.join(config.dataDir, "beihang-wechat.json");

export function wechatAccounts(): WechatAccount[] {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/wechat-accounts.json"), "utf8"));
}

/** One-time setup is explicit; subsequent scheduler ticks never re-enable a paused source. */
export async function registerWechatSources() {
  for (const a of wechatAccounts()) {
    await sql`INSERT INTO sources (id,name,kind,config,tier,first_party,participation_mode,interval_minutes,enabled,health,tags)
      VALUES (${a.id},${"微信·" + a.name},'external',${sql.json({wechat: {bookId:a.bookId, coverage:WECHAT_COVERAGE}})},
        ${a.tier},${a.firstParty},'editorial',${WECHAT_INTERVAL_MINUTES},true,'ok',${["微信公众号", a.id === "wechat-wall" ? "非官方" : "校园信息"]})
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,config=EXCLUDED.config,tier=EXCLUDED.tier,
        first_party=EXCLUDED.first_party,interval_minutes=EXCLUDED.interval_minutes,updated_at=now()`;
  }
}

export async function requestWechatRetry(source: {id:string;config:Record<string,unknown>}) {
  const own=source.config.wechat as {coverage?:string}|undefined;
  if(own?.coverage!==WECHAT_COVERAGE)return {state:"external_source_has_no_active_collector"};
  const rows=await sql`UPDATE sources SET next_fetch_at=now() WHERE id=${source.id} AND enabled
    AND NOT EXISTS (SELECT 1 FROM fetch_runs WHERE source_id=${source.id} AND status='running') RETURNING id`;
  return {state:rows.length?"queued":"paused_or_already_checking"};
}

async function localJson(url: string, init: RequestInit): Promise<unknown> {
  // This fixed loopback service is a deployment component, never an article-controlled URL.
  const res = await fetch(`http://127.0.0.1:3002/api/v1/wx/${url}`, {
    ...init, redirect: "error", signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`local_collector_http_${res.status}`);
  let bytes = 0;
  const parts: Uint8Array[] = [];
  for await (const part of res.body ?? []) {
    bytes += part.length;
    if (bytes > 4 * 1024 * 1024) throw new Error("local_collector_response_too_large");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

export const localCollector: CollectorClient = async (account, since) => {
  const credentials = JSON.parse(readFileSync(credentialFile(), "utf8")) as { username: string; password: string };
  const login = await localJson("auth/login", {method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({username:credentials.username,password:credentials.password}).toString()}) as {data?:{access_token?:string}};
  const token = login.data?.access_token;
  if (!token) throw new Error("local_collector_login_failed");
  return await localJson("paian/collect", {method:"POST", headers:{"content-type":"application/json",authorization:`Bearer ${token}`},
    body:JSON.stringify({bookId:account.bookId,since:since?.toISOString()??null})}) as CollectorResult;
};

export function normalizeWechatItem(item: CollectorItem, account: WechatAccount, now: Date) {
  if (!item || item.publisherBiz !== account.biz || item.publicationTimeEvidence !== "original-page-ct") throw new Error("unverified_publisher_or_time");
  const u = new URL(item.url);
  if (u.protocol !== "https:" || u.hostname !== "mp.weixin.qq.com" || !(u.pathname === "/s" || u.pathname.startsWith("/s/"))) throw new Error("invalid_original_url");
  const claimedBiz = u.searchParams.get("__biz");
  const identityKey=item.wechatMid&&item.wechatIdx&&/^\d+$/.test(item.wechatMid)&&/^\d+$/.test(item.wechatIdx)
    ?`wechat:${account.biz}:${item.wechatMid}:${item.wechatIdx}`:undefined;
  if(item.identityKey&&item.identityKey!==identityKey)throw new Error("conflicting_article_identity");
  if(identityKey&&((u.searchParams.has("mid")&&u.searchParams.get("mid")!==item.wechatMid)||
    (u.searchParams.has("idx")&&u.searchParams.get("idx")!==item.wechatIdx)))throw new Error("conflicting_article_identity");
  if(u.pathname==="/s"&&(!identityKey||!(claimedBiz&&u.searchParams.get("mid")&&u.searchParams.get("idx")&&u.searchParams.get("sn"))&&
    !["src","timestamp","ver","signature"].every(k=>u.searchParams.get(k))))throw new Error("missing_original_identity");
  if (claimedBiz && claimedBiz !== account.biz) throw new Error("conflicting_publisher");
  const date = new Date(item.publishedAt);
  if (!Number.isFinite(date.getTime()) || date.getTime() > now.getTime() + 3_600_000) throw new Error("invalid_publication_time");
  const cutoff = new Date(now); cutoff.setUTCFullYear(cutoff.getUTCFullYear()-1);
  if (date < cutoff) return null;
  // Collector sends plain text. Preserve text punctuation, but never import executable markup.
  const bodyText = stripTags(sanitizeBody(item.bodyText.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")));
  if (!item.title?.trim() || bodyText.trim().length < 20) throw new Error("insufficient_article");
  return {url:item.url,identityKey,title:item.title.trim(),publishedAt:date,bodyText,bodyStatus:"ok" as const,
    author:account.name,language:"zh",raw:{collector:"beihang-wechat",coverage:WECHAT_COVERAGE,
      publisherBiz:account.biz,wechatIdentity:identityKey,publicationTimeEvidence:item.publicationTimeEvidence,discovery:item.discovery}};
}

/** Due time is reserved before I/O: failures and restarts wait the same persisted 48 hours. */
export async function collectDueWechat(client: CollectorClient = localCollector) {
  await sql`UPDATE fetch_runs f SET status='failed',finished_at=now(),error='上次公众号检查被中断；保留原定下次检查时间。'
    FROM sources s WHERE f.source_id=s.id AND s.config->'wechat'->>'coverage'=${WECHAT_COVERAGE}
    AND f.status='running' AND f.started_at<now()-interval '10 minutes'`;
  const [source] = await sql<{id:string;last_ok_at:Date|null;previous_fetch_at:Date|null;started_at:Date}[]>`
    WITH due AS (SELECT id,last_fetch_at FROM sources WHERE enabled AND participation_mode='editorial' AND kind='external'
      AND config->'wechat'->>'coverage'=${WECHAT_COVERAGE}
      AND (next_fetch_at IS NULL OR next_fetch_at<=now())
      ORDER BY next_fetch_at NULLS FIRST,id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE sources s SET last_fetch_at=now(),next_fetch_at=now()+make_interval(mins=>${WECHAT_INTERVAL_MINUTES})
    FROM due WHERE s.id=due.id RETURNING s.id,s.last_ok_at,due.last_fetch_at AS previous_fetch_at,s.last_fetch_at AS started_at`;
  if (!source) return {state:"not_due"};
  const account = wechatAccounts().find(a=>a.id===source.id);
  const [run] = await sql<{id:number}[]>`INSERT INTO fetch_runs(source_id,status,started_at) VALUES (${source.id},'running',${source.started_at}) RETURNING id`;
  let created=0,found=0;
  try {
    if (!account) throw new Error("unknown_configured_account");
    const result = await client(account,source.last_ok_at);
    if (result.account!==account.name || result.bookId!==account.bookId || result.coverage!==WECHAT_COVERAGE || result.headless!==true || !Array.isArray(result.items)) throw new Error("invalid_collector_response");
    if (result.items.length>100) throw new Error("collector_batch_exceeds_100");
    found=result.items.length;
    const now=new Date(); const rejected:string[]=[];
    for (const item of result.items) {
      try {
        const m=normalizeWechatItem(item,account,now); if(!m)continue;
        const aliases=(item.aliases??[]).slice(0,5).filter(value=>{
          try {const u=new URL(value);return u.protocol==="https:"&&u.hostname==="mp.weixin.qq.com"&&u.pathname.startsWith("/s/");}catch{return false;}
        });
        const [existing]=await sql<{identity_key:string}[]>`SELECT identity_key FROM articles WHERE source_id=${source.id}
          AND (identity_key=${m.identityKey??""} OR raw->>'wechatIdentity'=${m.identityKey??""}
          OR url=ANY(${[m.url,...aliases]}::text[])) LIMIT 1`;
        const stored=await upsertMaterial({...m,identityKey:existing?.identity_key??m.identityKey,sourceId:source.id,via:"beihang-wechat",observedAfter:source.last_ok_at,
          backfill:source.previous_fetch_at?null:"initial-source-import"});
        // Existing material keeps its identity and editorial receipts; discovery evidence is metadata.
        await sql`UPDATE articles SET raw=coalesce(raw,'{}'::jsonb)||${sql.json(m.raw)}
          WHERE id=${stored.articleId} AND source_id=${source.id}`;
        // Refresh an expiring public-search link, preferring a stable short link when available.
        const refreshed=await sql`UPDATE articles SET url=${m.url},updated_at=now() WHERE id=${stored.articleId} AND source_id=${source.id}
          AND url<>${m.url} AND url LIKE '%/s?src=%' RETURNING id`;
        if(refreshed.length)await publishArticle(stored.articleId);
        if(stored.created)created++;
        if(stored.created||stored.revised||stored.processingNeeded)await queueProcessing(stored.articleId);
      } catch(error) { rejected.push(error instanceof Error?error.message:"article_rejected"); }
    }
    const partial=result.state!=="ok"||rejected.length>0;
    const detail={coverage:WECHAT_COVERAGE,headless:true,partial,search:result.search,latest:result.latest,
      issues:result.issues.map(i=>({stage:i.stage,code:i.code})),rejected};
    const error=partial?"公众号公开搜索未完整完成；已取得的合格资料仍会整理，下一轮再检查。":null;
    await sql`UPDATE sources SET last_ok_at=CASE WHEN ${partial} THEN last_ok_at ELSE now() END,
      health=${partial?"degraded":"ok"},last_error=${error},fail_count=CASE WHEN ${partial} THEN fail_count+1 ELSE 0 END,updated_at=now()
      WHERE id=${source.id}`;
    await sql`UPDATE fetch_runs SET status=${partial?"failed":"ok"},finished_at=now(),found_count=${found},new_count=${created},
      error=${error},detail=${sql.json(detail)} WHERE id=${run.id}`;
    return {state:partial?"partial":"ok",sourceId:source.id,found,created};
  } catch {
    // No exception text from an authenticated upstream URL is written to public status.
    const error="本机公众号采集服务不可用或返回内容未通过核验；下一轮再检查。";
    await sql`UPDATE sources SET health='degraded',last_error=${error},fail_count=fail_count+1 WHERE id=${source.id}`;
    await sql`UPDATE fetch_runs SET status='failed',finished_at=now(),found_count=${found},new_count=${created},error=${error} WHERE id=${run.id}`;
    return {state:"failed",sourceId:source.id,found,created};
  }
}

export const beihangWechat=defineServerModule({name:"beihang-wechat",schedules:[{
  name:"beihang.wechat",cron:"* * * * *",missed:"once",
  when:()=>process.env.COLLECT_ENABLED==="true"&&existsSync(credentialFile()),run:()=>collectDueWechat(),
}],sourceKinds:{external:{fetchNow:requestWechatRetry,resumed:async(id,tx)=>{
  await tx`UPDATE sources SET next_fetch_at=now() WHERE id=${id} AND config->'wechat'->>'coverage'=${WECHAT_COVERAGE}`;
}}}});
