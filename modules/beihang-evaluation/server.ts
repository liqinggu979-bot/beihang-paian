// Resumable, low-priority calibration. Saved receipts and results survive worker restarts.
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { config, REPO_ROOT } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { subscriptionMode, subscriptionReady } from '@aihot/backend/providers/chatgpt-subscription';
import { MODELS } from '@aihot/backend/providers/llm';
import { sha256 } from '@aihot/backend/lib/ids';
import { defineServerModule } from "@aihot/backend/modules";
import { BudgetExceededError } from "@aihot/backend/providers/receipts";
import { SELECTION_PROMPT_VERSION, PROMPT_VERSIONS, runSelectionPrefilter, runSelectionScores, runUnderstand, normalizeAnalysis, type AnalyzeInputArticle, type AnalysisRun } from "@aihot/backend/editorial/analyze";

interface Sample {
 caseId: string;
 material: { title: string; originalTitle: string | null; publishedAt: string | null; sourceName: string; bodyOriginal: string | null; bodyZh: string | null };
 sourceFacts: { sourceKind: string; sourceTier?: string; firstParty?: boolean };
 gold: { decision: "select" | "reject" | "either"; labelStatus?: string };
}
interface Result { caseId: string; title: string; gold: string; prediction: string; score: number | null; summary: string | null; summaryReview: "pending" | "passed" | "failed"; reviewNote?: string; }
interface Progress { version: string; total: number; state: string; updatedAt: string; results: Result[]; error?: string; }
const KEY = "beihang.evaluation";


export async function evaluateBatch(limit = 1, opts: { allowHistoryWork?: boolean } = {}): Promise<Progress | { state: string }> {
 const version = `${SELECTION_PROMPT_VERSION}+${PROMPT_VERSIONS.understand}:${process.env.LLM_PROVIDER ?? "api"}:${MODELS.default!.model}`;
 if (!config.modelCallsEnabled) return { state: "models_disabled" };
 if (subscriptionMode() && !subscriptionReady()) return {state:"waiting_authorization"};
 const [live] = await sql`SELECT 1 FROM articles a JOIN sources s ON s.id=a.source_id
 WHERE s.enabled AND s.participation_mode='editorial' AND NOT a.backfill
 AND (a.processing_state IN ('new','failed') OR (a.processing_state='analyzed' AND a.grouping_status<>'complete')) LIMIT 1`;
 if (live) return { state: "live_news_first" };
 // Scheduled evaluation also yields to an in-flight article chain, so it does not fragment its budget.
 if (!opts.allowHistoryWork) {
  const [running] = await sql`SELECT 1 FROM pgboss.job WHERE name='content.analyze' AND state='active' LIMIT 1`;
  if (running) return { state: "processing_first" };
 }
 const samples = readFileSync(path.join(REPO_ROOT,"industry/gold.buaa.jsonl"),"utf8").trim().split("\n").map(s=>JSON.parse(s) as Sample);
 const [saved] = await sql<{value:Progress}[]>`SELECT value FROM settings WHERE key=${KEY}`;
 if (saved && saved.value.version !== version) await sql`INSERT INTO settings(key,value,updated_by) VALUES (${'beihang.evaluation.archived.' + sha256(saved.value.version).slice(0,16)},${sql.json(saved.value as never)},'beihang-evaluation') ON CONFLICT(key) DO NOTHING`;
 const progress: Progress = saved?.value.version === version ? saved.value : {version,total:samples.length,state:"pending",updatedAt:new Date().toISOString(),results:[]};
 const done = new Set(progress.results.map(r=>r.caseId));
 for (const sample of samples.filter(s=>!done.has(s.caseId)).slice(0,limit)) {
  const m=sample.material;
  const input:AnalyzeInputArticle={id:`gold-${sample.caseId}`,revision:1,title:m.originalTitle||m.title,url:`https://example.invalid/${sample.caseId}`,author:null,
   publishedAt:m.publishedAt?new Date(m.publishedAt):null,bodyStatus:"ok",bodyText:m.bodyOriginal||m.bodyZh,excerpt:null,xPost:null,media:[],
   source:{name:m.sourceName,kind:sample.sourceFacts.sourceKind,tier:sample.sourceFacts.sourceTier??"T1",firstParty:sample.sourceFacts.firstParty??true}};
  try {
   const prefilter=await runSelectionPrefilter(input);
   const scores=prefilter.label==="BLOCK"?null:await runSelectionScores(input);
   const run:AnalysisRun={prefilter,scores,writing:null,structure:null};
   const decision=normalizeAnalysis(run);
   const writing=prefilter.label==="BLOCK"?null:await runUnderstand(input);
   progress.results.push({caseId:sample.caseId,title:m.title,gold:sample.gold.decision,prediction:decision.selected?"select":"reject",score:decision.score,summary:writing?.summaryZh??null,summaryReview:"pending"});
   delete progress.error;
   progress.state=progress.results.length===progress.total?"awaiting_summary_review":"running";
  } catch(error) {
   progress.state=error instanceof BudgetExceededError?"waiting_budget":"waiting_retry";
   progress.error=String(error instanceof Error?error.message:error).slice(0,300);
   break;
  }
 }
 progress.updatedAt=new Date().toISOString();
 await sql`INSERT INTO settings (key,value,updated_by) VALUES (${KEY},${sql.json(progress as never)},'beihang-evaluation')
 ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now(),updated_by=EXCLUDED.updated_by`;
 mkdirSync(config.dataDir,{recursive:true});
 const output=path.join(config.dataDir,"beihang-evaluation.json");
 writeFileSync(output+".tmp",JSON.stringify(progress,null,2)+"\n");renameSync(output+".tmp",output);
 return progress;
}

export const beihangEvaluation = defineServerModule({name:"beihang-evaluation",schedules:[{
 name:"beihang.evaluation",cron:"25 * * * *",when:()=>config.modelCallsEnabled,run:()=>evaluateBatch(),
}]});
