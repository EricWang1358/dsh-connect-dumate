#!/usr/bin/env node
/**
 * Live two-point billing slope calibration script for all discovered DuMate models.
 *
 * Usage:
 *   node scripts/measure-rates.mjs                 # Measure all discovered models
 *   node scripts/measure-rates.mjs kimi-k31 glm-5  # Re-measure specific model IDs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DUMATE_UA,
  fetchDumateQuota,
  fetchGatewayToken,
  invalidateGatewayToken,
} from "../lib/dumate-auth.js";
import { discoverDumateModels } from "../lib/dumate-catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(__dirname, "..", "rates-report.json");
const CHAT_ENDPOINT = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions";

const SHORT_PROMPT =
  "请严格按要求执行不要输出多余解释或前后缀：现在请只回复收到这两个汉字即可";
const LONG_200 =
  "请严格按要求执行不要输出多余解释或前后缀：从1连续数到120用英文逗号分隔";
const LONG_500 =
  "请严格按要求执行不要输出多余解释或前后缀：从1连续数到260用英文逗号分隔";
const LONG_1200 =
  "请严格按要求执行不要输出多余解释或前后缀：从1连续数到600用英文逗号分隔";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimited(status, text) {
  if (status === 429) return true;
  return /rate_limit|too many requests|限流|频繁/i.test(String(text || ""));
}

/**
 * Invoke DuMate chat completions once with pre/post forced quota sampling on every attempt.
 */
async function callChatWithPreQuota(model, prompt, maxTokens) {
  let tokenInfo = await fetchGatewayToken();
  if (!tokenInfo?.token) {
    return { ok: false, status: 0, error: "failed to acquire gateway token" };
  }
  let refreshedOn401 = false;

  for (let attempt = 0; attempt < 5; attempt++) {
    const qBefore = await fetchDumateQuota({ force: true });
    if (!qBefore?.ok || typeof qBefore.duUsed !== "number") {
      return {
        ok: false,
        status: 0,
        error: `quota before failed: ${qBefore?.error || "missing duUsed"}`,
      };
    }

    let res;
    let rawText = "";
    try {
      res = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenInfo.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Dumate-Client-Type": "web",
          "X-Dumate-Account-Id": "global",
          "User-Agent": DUMATE_UA,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          stream: false,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      rawText = await res.text();
    } catch (err) {
      return { ok: false, status: 0, error: `fetch error: ${err?.message || String(err)}` };
    }

    if (res.status === 401 && !refreshedOn401) {
      refreshedOn401 = true;
      invalidateGatewayToken();
      tokenInfo = await fetchGatewayToken({ force: true });
      if (!tokenInfo?.token) {
        return { ok: false, status: 401, error: "401 and token force refresh failed" };
      }
      continue;
    }

    if (isRateLimited(res.status, rawText)) {
      const waitMs = 15_000 * (attempt + 1);
      console.error(`  [${model}] rate limited (${res.status}), sleeping ${waitMs}ms...`);
      await sleep(waitMs);
      continue;
    }

    if (res.status !== 200) {
      return {
        ok: false,
        status: res.status,
        error: rawText.slice(0, 300),
      };
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return { ok: false, status: 200, error: `invalid JSON response: ${rawText.slice(0, 200)}` };
    }

    const usage = payload?.usage || {};
    if (typeof usage.completion_tokens !== "number" || typeof usage.prompt_tokens !== "number") {
      return {
        ok: false,
        status: 200,
        error: `missing usage tokens: ${JSON.stringify(usage)}`,
      };
    }

    // Allow DuMate quota accounting to settle before sampling duUsed.
    await sleep(2000);
    const qAfter = await fetchDumateQuota({ force: true });
    if (!qAfter?.ok || typeof qAfter.duUsed !== "number") {
      return {
        ok: false,
        status: 200,
        error: `quota after failed: ${qAfter?.error || "missing duUsed"}`,
      };
    }

    const realModel = res.headers.get("x-dumate-gw-realmodel") || null;
    const delta = Number((qAfter.duUsed - qBefore.duUsed).toFixed(4));
    return {
      ok: true,
      status: 200,
      realModel,
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
      },
      finishReason: payload?.choices?.[0]?.finish_reason || null,
      delta,
    };
  }

  return { ok: false, status: 429, error: "exhausted 5 rate-limit retry attempts" };
}

function selectLongTier(dShort) {
  if (dShort >= 0.5) return { prompt: LONG_200, maxTokens: 200, tier: "200" };
  if (dShort >= 0.04) return { prompt: LONG_500, maxTokens: 500, tier: "500" };
  return { prompt: LONG_1200, maxTokens: 1200, tier: "1200" };
}

function roundRate(value) {
  if (!Number.isFinite(value)) return null;
  return value >= 1 ? Number(value.toFixed(2)) : Number(value.toFixed(3));
}

async function measureModel(modelMeta) {
  const modelId = modelMeta.id;
  const shortRes = await callChatWithPreQuota(modelId, SHORT_PROMPT, 24);
  if (!shortRes.ok) {
    console.log(
      `[FAIL] ${modelId} (${modelMeta.rawName}): short failed HTTP ${shortRes.status} - ${shortRes.error}`,
    );
    return {
      id: modelId,
      rawName: modelMeta.rawName,
      ok: false,
      stage: "short",
      status: shortRes.status,
      error: shortRes.error,
      existingRate: modelMeta.pointsPer1kOut ?? null,
    };
  }

  const dShort = shortRes.delta;
  const { prompt: longPrompt, maxTokens: longMax, tier } = selectLongTier(dShort);
  const longRes = await callChatWithPreQuota(modelId, longPrompt, longMax);
  if (!longRes.ok) {
    console.log(
      `[FAIL] ${modelId} (${modelMeta.rawName}): long(${tier}) failed HTTP ${longRes.status} - ${longRes.error}`,
    );
    return {
      id: modelId,
      rawName: modelMeta.rawName,
      ok: false,
      stage: `long(${tier})`,
      realModel: shortRes.realModel,
      status: longRes.status,
      error: longRes.error,
      short: { usage: shortRes.usage, delta: dShort, finishReason: shortRes.finishReason },
      existingRate: modelMeta.pointsPer1kOut ?? null,
    };
  }

  const dLong = longRes.delta;
  const dTokens = longRes.usage.completion_tokens - shortRes.usage.completion_tokens;
  const dPrompt = longRes.usage.prompt_tokens - shortRes.usage.prompt_tokens;
  const realModel = longRes.realModel || shortRes.realModel;

  if (dTokens < 40) {
    const err = `dTokens=${dTokens} < 40 (short=${shortRes.usage.completion_tokens}, long=${longRes.usage.completion_tokens})`;
    console.log(`[WARN] ${modelId} (${modelMeta.rawName}) real=${realModel}: ${err}`);
    return {
      id: modelId,
      rawName: modelMeta.rawName,
      ok: false,
      stage: "slope",
      realModel,
      tier,
      error: err,
      dTokens,
      short: { usage: shortRes.usage, delta: dShort, finishReason: shortRes.finishReason },
      long: { usage: longRes.usage, delta: dLong, finishReason: longRes.finishReason },
      existingRate: modelMeta.pointsPer1kOut ?? null,
    };
  }

  const out0 = ((dLong - dShort) / dTokens) * 1000;
  const in0 = Math.min(
    out0,
    Math.max(
      0,
      ((dShort - shortRes.usage.completion_tokens * (out0 / 1000)) /
        Math.max(1, shortRes.usage.prompt_tokens)) *
        1000,
    ),
  );
  const outRefined = ((dLong - dShort - dPrompt * (in0 / 1000)) / dTokens) * 1000;
  const recommendedRate = roundRate(outRefined);

  console.log(
    `[OK] ${modelId} | real=${realModel || "-"} | tier=${tier} | dShort=${dShort} (${shortRes.usage.completion_tokens}t) | dLong=${dLong} (${longRes.usage.completion_tokens}t) | outRefined=${recommendedRate} (old=${modelMeta.pointsPer1kOut ?? "none"})`,
  );

  return {
    id: modelId,
    rawName: modelMeta.rawName,
    ok: true,
    realModel,
    tier,
    dShort,
    dLong,
    dTokens,
    dPrompt,
    out0: Number(out0.toFixed(4)),
    in0: Number(in0.toFixed(4)),
    outRefined: Number(outRefined.toFixed(4)),
    recommendedRate,
    existingRate: modelMeta.pointsPer1kOut ?? null,
    short: { usage: shortRes.usage, delta: dShort, finishReason: shortRes.finishReason },
    long: { usage: longRes.usage, delta: dLong, finishReason: longRes.finishReason },
  };
}

async function main() {
  const cliTargets = process.argv.slice(2).filter(Boolean);
  const discovered = discoverDumateModels({ showRateInModelName: false });
  const byId = new Map(discovered.map((m) => [m.id, m]));

  const targets = cliTargets.length
    ? cliTargets.map((id) => byId.get(id) || { id, rawName: id, pointsPer1kOut: undefined })
    : discovered;

  console.log(`Measuring ${targets.length} DuMate model(s) against ${CHAT_ENDPOINT}...`);
  const freshResults = [];
  for (let i = 0; i < targets.length; i++) {
    const result = await measureModel(targets[i]);
    freshResults.push(result);
    if (i < targets.length - 1) {
      await sleep(1500);
    }
  }

  let finalResults = freshResults;
  if (cliTargets.length && fs.existsSync(REPORT_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
      if (Array.isArray(prev?.results)) {
        const updatedMap = new Map(freshResults.map((r) => [r.id, r]));
        const seen = new Set();
        finalResults = prev.results.map((r) => {
          if (updatedMap.has(r.id)) {
            seen.add(r.id);
            return updatedMap.get(r.id);
          }
          return r;
        });
        for (const r of freshResults) {
          if (!seen.has(r.id)) finalResults.push(r);
        }
      }
    } catch {
      // Ignore malformed previous report when merging partial retries.
    }
  }

  const okCount = finalResults.filter((r) => r.ok).length;
  const failCount = finalResults.length - okCount;
  const report = {
    measuredAt: new Date().toISOString(),
    endpoint: CHAT_ENDPOINT,
    totalModels: finalResults.length,
    succeeded: okCount,
    failed: failCount,
    results: finalResults,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`Done: ${okCount} succeeded, ${failCount} failed. Report saved to ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
