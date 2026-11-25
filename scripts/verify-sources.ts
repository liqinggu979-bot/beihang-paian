// Read-only verification of public pages. No model, database, or ingest calls.
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchWebList, fetchDetail } from "@aihot/backend/sources/web-list";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { closeDb } from "@aihot/backend/db";
import sources from "../industry/sources.json" with { type: "json" };

const results: unknown[] = [];
const materials: unknown[] = [];
mkdirSync(".data/source-fixtures", { recursive: true });
for (const spec of sources.sources) {
  const source = { ...spec, first_party: true, cursor: null, fail_count: 0 } as SourceRow;
  try {
    assertSupportedConfig(source.kind, source.config);
    const items = await fetchWebList(source);
    const samples = [];
    const excluded: Array<{ url: string; reason: string }> = [];
    for (const item of items.slice(0, 30)) {
      if (samples.length >= 10) break;
      try {
      const res = await guardedFetch(item.url, { timeoutMs: 25000 });
      if (res.status !== 200) throw new Error(`detail HTTP ${res.status}`);
      const html = await res.text();
      // Use exactly the runtime date enrichment, not a made-up date parser.
      const detail = await fetchDetail(item.url, source, { date: !item.publishedAt, title: true, summary: false, body: true });
      const date = item.publishedAt ?? detail.publishedAt;
      const { readable } = await import("@aihot/backend/content/extract");
      const body = detail.body ?? readable(html, item.url);
      if (!date || !body || body.text.trim().length < 20) throw new Error(`missing trustworthy date/body: ${item.url}`);
      const sample = { title: detail.title ?? item.title, url: item.url, publishedAt: date.toISOString(), bodyChars: body.text.length, bodyPreview: body.text.slice(0, 150) };
      samples.push(sample);
      materials.push({ ...sample, sourceId: source.id, sourceName: source.name, body: body.text });
      writeFileSync(`.data/source-fixtures/${source.id}-${samples.length}.html`, html);
      } catch (error) { excluded.push({ url: item.url, reason: String(error) }); }
    }
    results.push({ id: source.id, name: source.name, url: source.config.url, state: samples.length >= 10 ? "verified" : "insufficient-samples", checkedAt: new Date().toISOString(), listItems: items.length, excluded, samples });
    console.log(`${source.id}: ${samples.length}/10 verified of ${items.length} listing items`);
  } catch (error) {
    results.push({ id: source.id, name: source.name, url: source.config.url, state: "failed", checkedAt: new Date().toISOString(), error: String(error) });
    console.error(`${source.id}: ${String(error)}`);
  }
}
writeFileSync("docs/source-validation.json", JSON.stringify(results, null, 2) + "\n");
writeFileSync(".data/source-materials.json", JSON.stringify(materials, null, 2) + "\n");
await closeDb();
if (results.some((r: any) => r.state !== "verified")) process.exitCode = 1;
