import { readFileSync } from "node:fs";
// Only imported by the backend publication layer; no database or credentials here.
export interface ReferenceEntry { title: string; url: string; publishedAt: string | null; checkedAt: string; source: string; tags: string[]; note?: string }
export const REFERENCES: ReferenceEntry[] = JSON.parse(readFileSync(new URL("./reference-data.json", import.meta.url), "utf8"));
