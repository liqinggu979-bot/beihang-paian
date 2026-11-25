import { subscriptionPauseUntil, subscriptionMode, subscriptionReady, SUBSCRIPTION_SERVICE, SUBSCRIPTION_DAILY_LIMIT } from '../providers/chatgpt-subscription.ts';
import { conservativeLimit, VERIFIED_TARIFF } from "../providers/model-budget.ts";
import type { CheckStatus } from "@aihot/contracts/site";
import { WORKFLOW } from "@aihot/site/workflow";
import { REFERENCES } from "@aihot/site/references";
import { sql } from "../db.ts";
import { publicSourceName } from "./rules.ts";

export async function loadChecks(): Promise<CheckStatus> {
  const service = subscriptionMode() ? SUBSCRIPTION_SERVICE : 'llm';
  const [rows, [pending], [usage], resumeAt] = await Promise.all([
    sql<{ id: string; name: string; last_fetch_at: Date | null; last_ok_at: Date | null; next_fetch_at: Date | null; status: string | null; new_count: number | null; coverage: string | null; detail: {partial?:boolean} | null }[]>`
      SELECT s.id, s.name, s.last_fetch_at, s.last_ok_at, s.next_fetch_at, f.status, f.new_count, f.detail, s.config->'wechat'->>'coverage' AS coverage
      FROM sources s LEFT JOIN LATERAL (SELECT status, new_count, detail FROM fetch_runs WHERE source_id = s.id ORDER BY started_at DESC, id DESC LIMIT 1) f ON true
      WHERE s.enabled AND s.participation_mode = 'editorial' ORDER BY s.name`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles a JOIN sources s ON s.id = a.source_id WHERE s.enabled AND s.participation_mode = 'editorial' AND (a.processing_state IN ('new', 'queued', 'processing', 'failed') OR (a.processing_state = 'analyzed' AND a.grouping_status <> 'complete'))`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts WHERE service=${service} AND origin='live' AND started_at > now()-interval '24 hours'`,
    subscriptionMode() ? subscriptionPauseUntil() : Promise.resolve(null),
  ]);
  const checked = rows.map((r) => r.last_fetch_at?.getTime() ?? 0);
  const latest = Math.max(0, ...checked);
  const budget = WORKFLOW.models;
  const cap = subscriptionMode() ? SUBSCRIPTION_DAILY_LIMIT : budget ? conservativeLimit(budget.inputByteLimit, budget.outputTokenLimit, budget.envelopeTokens, VERIFIED_TARIFF.inputPerMillionCny, VERIFIED_TARIFF.outputPerMillionCny, budget.dailyCny) : Infinity;
  return {
    modelProvider: subscriptionMode() ? 'chatgpt_subscription' : 'api', modelReady: !subscriptionMode() || subscriptionReady(),
    budgetPaused: Number(usage?.n ?? 0) >= cap || !!resumeAt, modelResumeAt: resumeAt?.toISOString() ?? null,
    intervalMinutes: WORKFLOW.collection?.intervalMinutes ?? null,
    checkedAt: latest ? new Date(latest).toISOString() : null,
    pending: pending?.n ?? 0, modelsEnabled: process.env.MODEL_CALLS_ENABLED === "true",
    sources: rows.map((r) => ({ id: r.id, name: publicSourceName(r.name), checkedAt: r.last_fetch_at?.toISOString() ?? null,
      lastSuccessAt: r.last_ok_at?.toISOString() ?? null, nextCheckAt: r.next_fetch_at?.toISOString() ?? null,
      state: r.status === 'running' ? 'checking' : r.status === 'failed' ? r.detail?.partial ? 'partial' : 'failed' : !r.last_fetch_at ? 'unchecked' : Number(r.new_count) > 0 ? 'updated' : 'unchanged',
      ...(r.coverage === 'public-search-and-latest' ? {coverage: 'public-search-and-latest' as const} : {}),
      newItems: r.new_count ?? 0 })),
  };
}

export function referenceLibrary(tag?: string, q?: string) {
  const query = q?.trim().toLowerCase();
  return REFERENCES.filter((r) => (!tag || r.tags.includes(tag)) && (!query || `${r.title} ${r.source} ${r.tags.join(' ')}`.toLowerCase().includes(query)));
}
