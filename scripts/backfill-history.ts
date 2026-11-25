import { config } from "@aihot/backend/config";
import path from "node:path";
// Explicit, resumable history import through the same authenticated API as external collectors.
// Run without --apply to save a manifest only. Never enables model calls or changes budgets.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fetchWebList, fetchDetail } from "@aihot/backend/sources/web-list";
import type { SourceRow } from "@aihot/backend/sources/types";
import { closeDb } from "@aihot/backend/db";
import { beijingDate } from "@aihot/contracts/time";
import sourceFile from "../industry/sources.json" with { type: "json" };

const { values } = parseArgs({ options: { manifest: { type: "string" }, apply: { type: "boolean", default: false }, base: { type: "string", default: "http://127.0.0.1:3000" }, limit: { type: "string", default: "100" }, source: { type: "string" }, pages: { type: "string", default: "100" } } });
const limit = Number(values.limit), pages = Number(values.pages);
if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(pages) || pages < 1 || pages > 100) throw new Error("Invalid limit/pages");
const now = new Date();
// Calendar-year cutoff at Beijing midnight, retained for the whole manifest; not 12*30 days.
const date = beijingDate(now), start = `${Number(date.slice(0, 4)) - 1}${date.slice(4)}T00:00:00+08:00`;
const lower = Date.parse(start);
const checkpoint = path.join(config.dataDir, "history-imported.json");
mkdirSync(config.dataDir, { recursive: true });
const imported = new Set<string>(existsSync(checkpoint) ? JSON.parse(readFileSync(checkpoint, "utf8")) : []);
const manifest: Array<{ sourceId: string; sourceName: string; title: string; url: string; publishedAt: string }> = [];
const seen = new Set<string>();
const errors: Array<{ sourceId: string; error: string }> = [];
if (values.manifest) {
  const rows = JSON.parse(readFileSync(values.manifest, "utf8")) as Array<{ sourceId: string; sourceName: string; title: string; url: string; publishedAt: string }>;
  for (const row of rows) {
    if (manifest.length >= limit) break;
    const spec = sourceFile.sources.find((s) => s.id === row.sourceId);
    const date = Date.parse(row.publishedAt);
    if (!spec || (values.source && values.source !== spec.id) || seen.has(row.url) || imported.has(row.url) || !Number.isFinite(date) || date < lower || date > now.getTime()) continue;
    const url = new URL(row.url);
    if (url.origin !== new URL(spec.config.url).origin || !url.pathname.startsWith("/info/")) continue;
    seen.add(row.url); manifest.push(row);
  }
}
for (const spec of (values.manifest ? [] : sourceFile.sources).filter((s) => !values.source || s.id === values.source)) {
  if (manifest.length >= limit) break;
  const source = { ...spec, first_party: true, fail_count: 0, cursor: null, config: { ...spec.config, maxPages: pages } } as SourceRow;
  try {
    const items = await fetchWebList(source);
    for (const item of items) {
      if (manifest.length >= limit) break;
      if (seen.has(item.url) || imported.has(item.url)) continue;
      let date = item.publishedAt;
      if (!date) date = (await fetchDetail(item.url, source, { date: true, title: false, summary: false, body: false })).publishedAt;
      if (!date || date.getTime() < lower || date > now) continue;
      seen.add(item.url);
      manifest.push({ sourceId: source.id, sourceName: source.name, title: item.title, url: item.url, publishedAt: date.toISOString() });
    }
  } catch (error) { errors.push({ sourceId: source.id, error: String(error) }); }
}
writeFileSync(path.join(config.dataDir, "history-manifest.json"), JSON.stringify({ start, end: now.toISOString(), items: manifest, errors }, null, 2) + "\n");
if (values.apply) {
  const token = process.env.INGEST_TOKEN;
  if (!token) throw new Error("Set INGEST_TOKEN locally before applying history");
  const base = new URL(values.base!);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("History apply is restricted to the local site");
  for (const source of sourceFile.sources) {
    const rows = manifest.filter((r) => r.sourceId === source.id);
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      const res = await fetch(new URL("/api/ingest/items", base), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ sourceId: source.id, items: chunk.map((r) => ({ title: r.title, url: r.url, publishedAt: r.publishedAt, raw: { _aihot: { backfill: true } } })) }) });
      if (!res.ok) throw new Error(`History ingest ${res.status}; manifest remains available for retry`);
      for (const row of chunk) imported.add(row.url);
      writeFileSync(checkpoint, JSON.stringify([...imported], null, 2) + "\n");
    }
  }
}
console.log(JSON.stringify({ start, count: manifest.length, applied: values.apply, errors: errors.length }));
await closeDb();
if (errors.length) process.exitCode = 1;
