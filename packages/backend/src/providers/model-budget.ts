// A conservative request-count cap. Prices use peak, uncached CNY rates, never assumed cache discounts.
import { WORKFLOW } from "@aihot/site/workflow";
import type { ModelSpec, ContentPart } from "./llm.ts";

export const VERIFIED_TARIFF = {
  model: "deepseek-flash", origin: "https://api.deepseek.com", inputPerMillionCny: 2, outputPerMillionCny: 8,
  verifiedAt: "2026-10-08", validUntil: "2026-11-08T00:00:00+08:00",
  source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
};

export function conservativeLimit(inputBytes: number, outputTokens: number, envelopeTokens: number, inputRate: number, outputRate: number, dailyCny: number): number {
  const values = [inputBytes, outputTokens, envelopeTokens, inputRate, outputRate, dailyCny];
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) throw new Error("Missing or invalid CNY billing bounds");
  // Byte-level tokenization cannot emit more content tokens than UTF-8 bytes. Reserve 256 tokens for
  // the two-message envelope. Only this audited text-only provider/request shape is permitted.
  const maximum = ((inputBytes + envelopeTokens) * inputRate + outputTokens * outputRate) / 1_000_000;
  return Math.floor(dailyCny / maximum);
}

export function boundModelRequest(spec: ModelSpec, baseUrl: string, system: string, user: string | ContentPart[], requestedOutput: number, now = Date.now()): { maxTokens: number; dailyLimit?: number } {
  const policy = WORKFLOW.models;
  if (!policy) return { maxTokens: requestedOutput };
  const url = new URL(baseUrl);
  // Existing invariants use local fake providers. This escape cannot run in a production process,
  // and accepts only literal loopback hosts (no remote DNS name).
  if (process.env.AIHOT_TEST_MODEL === "true" && process.env.NODE_ENV !== "production" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return { maxTokens: requestedOutput };
  const extra = spec.extra ?? {};
  if (spec.key !== "default" || spec.service !== "llm" || spec.model !== VERIFIED_TARIFF.model || url.origin !== VERIFIED_TARIFF.origin || !["", "/", "/v1", "/v1/"].includes(url.pathname)
      || url.username || url.password || url.search || url.hash || spec.vision || spec.reasoningTokens
      || Object.keys(extra).some((k) => k !== "thinking") || JSON.stringify(extra.thinking) !== '{"type":"disabled"}') {
    throw new Error("Model billing bounds are not verified: use default deepseek-flash, official endpoint, text-only and thinking disabled");
  }
  if (now >= Date.parse(VERIFIED_TARIFF.validUntil)) throw new Error("Verified model tariff expired; recheck official CNY prices before sending paid calls");
  if (typeof user !== "string") throw new Error("The 1 CNY budget supports text input only");
  if (Buffer.byteLength(system, "utf8") + Buffer.byteLength(user, "utf8") > policy.inputByteLimit) throw new Error("Model input exceeds verified billing byte limit; shorten the source material before retrying");
  const maxTokens = Math.min(requestedOutput, policy.outputTokenLimit);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("Invalid model output bound");
  const dailyLimit = conservativeLimit(policy.inputByteLimit, policy.outputTokenLimit, policy.envelopeTokens, VERIFIED_TARIFF.inputPerMillionCny, VERIFIED_TARIFF.outputPerMillionCny, policy.dailyCny);
  if (dailyLimit < 1) throw new Error("The daily CNY budget cannot fund even one bounded request");
  return { maxTokens, dailyLimit };
}
