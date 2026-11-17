/**
 * DuMate model catalog discovery, metadata sanitization, and request normalization.
 *
 * Imports ONLY safe model metadata (never endpoints/keys/headers/plugins) from
 * `%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\<account>\config\opencode\opencode.json`
 * (`provider.QianfanPersonalQuota.models`), caches an atomic snapshot under
 * `~/.dsh/dumate-models.snapshot.json`, and falls back to the built-in roster.
 *
 * @module dsh-connect-dumate/catalog
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { desktopUserDataDir } from "./dumate-auth.js";

export const NAMES = {
  "qwen4-max": "Qwen4-Max",
  "qwen3.8-max": "Qwen3.8-Max",
  "qwen38-flash": "Qwen3.8-Flash",
  "qwen3.5-397b-a17b": "Qwen3.5-397B-A17B",
  "qwen3.5-35b-a3b": "Qwen3.5-35B-A3B",
  "qwen3.5-27b": "Qwen3.5-27B",
  "qwen2.5-vl-32b-instruct": "Qwen2.5-VL-32B",
  "deepseek-v41-flash": "DeepSeek-V4.1 Flash",
  "deepseek-v4-pro": "DeepSeek-V4 Pro",
  "deepseek-v4-flash-0731": "DeepSeek-V4-Flash-0731",
  "glm-53": "GLM-5.3",
  "glm-53-flash": "GLM-5.3 Flash",
  "glm-5": "GLM-5.2",
  "kimi-k31": "Kimi K3.1 Pro",
  "kimi-k3": "Kimi K3",
  "doubao-seed-2-0-pro": "豆包 Seed 2.0 Pro",
  "ernie-4.5-turbo-vl-32k": "文心 ERNIE-4.5 Turbo VL",
  "model-text": "自动路由 (默认)",
  "dm-auto-model/text.L0": "自动·文本 L0",
  "dm-auto-model/text.L1": "自动·文本 L1",
  "dm-auto-model/text.L2": "自动·文本 L2",
  "dm-auto-model/mm.L0": "自动·多模态 L0",
  "dm-auto-model/mm.L1": "自动·多模态 L1",
  "dm-auto-model/mm.L2": "自动·多模态 L2",
};

/** Measured output point rates (points per 1k output tokens). */
export const OUTPUT_RATES = {
  // 2026-11-18 live two-point measurement: 6.06 pt/k in, 31.19 pt/k out (= 5x kimi-k3)
  "kimi-k31": 31.19,
  "dm-auto-model/text.L1": 10.04,
  "kimi-k3": 6.235,
  "dm-auto-model/text.L2": 3.06,
  "qwen2.5-vl-32b-instruct": 2.024,
  "dm-auto-model/text.L0": 2.02,
  "dm-auto-model/mm.L0": 2.02,
  "model-text": 2.014,
  "deepseek-v4-flash-0731": 2.007,
  "deepseek-v41-flash": 2.0,
  "dm-auto-model/mm.L2": 2.0,
  "glm-5": 2.0,
  "ernie-4.5-turbo-vl-32k": 1.997,
  "dm-auto-model/mm.L1": 1.99,
  "qwen3.8-max": 1.905,
  "doubao-seed-2-0-pro": 0.193,
  "glm-53-flash": 0.122,
  "qwen38-flash": 0.1,
  "deepseek-v4-pro": 0.1,
  "qwen3.5-397b-a17b": 0.098,
  "glm-53": 0.087,
  "qwen3.5-27b": 0.067,
  "qwen3.5-35b-a3b": 0.05,
};

/** Models routed onto the deepseek-v4.1-flash-low-latency backend supporting 4-tier effort. */
export const V41_REASONING_MODELS = new Set([
  "deepseek-v41-flash",
  "model-text",
  "dm-auto-model/text.l0",
  "dm-auto-model/mm.l0",
  "dm-auto-model/mm.l2",
]);

const DEFAULT_MODEL_DEFS = [
  { id: "deepseek-v41-flash", contextWindow: 1000000, maxTokens: 384000, supportsImage: true },
  { id: "deepseek-v4-pro", contextWindow: 1000000, maxTokens: 384000, supportsImage: false },
  { id: "deepseek-v4-flash-0731", contextWindow: 200000, maxTokens: 32000, supportsImage: false },
  { id: "qwen4-max", contextWindow: 983000, maxTokens: 128000, supportsImage: true },
  { id: "qwen3.8-max", contextWindow: 983000, maxTokens: 128000, supportsImage: true },
  { id: "qwen38-flash", contextWindow: 983000, maxTokens: 128000, supportsImage: true },
  { id: "qwen3.5-397b-a17b", contextWindow: 200000, maxTokens: 32000, supportsImage: false },
  { id: "qwen3.5-27b", contextWindow: 200000, maxTokens: 32000, supportsImage: false },
  { id: "qwen3.5-35b-a3b", contextWindow: 200000, maxTokens: 32000, supportsImage: false },
  { id: "qwen2.5-vl-32b-instruct", contextWindow: 200000, maxTokens: 32000, supportsImage: false },
  { id: "glm-53", contextWindow: 1000000, maxTokens: 128000, supportsImage: false },
  { id: "glm-53-flash", contextWindow: 1000000, maxTokens: 128000, supportsImage: true },
  { id: "glm-5", contextWindow: 200000, maxTokens: 64000, supportsImage: false },
  { id: "kimi-k31", contextWindow: 1048576, maxTokens: 1048576, supportsImage: true },
  { id: "kimi-k3", contextWindow: 1048576, maxTokens: 1048576, supportsImage: true },
  { id: "doubao-seed-2-0-pro", contextWindow: 200000, maxTokens: 32000, supportsImage: false },
  { id: "ernie-4.5-turbo-vl-32k", contextWindow: 200000, maxTokens: 32000, supportsImage: false },
  { id: "model-text", contextWindow: 1000000, maxTokens: 384000, supportsImage: true },
  { id: "dm-auto-model/text.L0", contextWindow: 1000000, maxTokens: 384000, supportsImage: true },
  { id: "dm-auto-model/text.L1", contextWindow: 1048576, maxTokens: 1048576, supportsImage: true },
  { id: "dm-auto-model/text.L2", contextWindow: 983000, maxTokens: 128000, supportsImage: true },
  { id: "dm-auto-model/mm.L0", contextWindow: 1000000, maxTokens: 384000, supportsImage: true },
  { id: "dm-auto-model/mm.L1", contextWindow: 1000000, maxTokens: 384000, supportsImage: true },
  { id: "dm-auto-model/mm.L2", contextWindow: 1000000, maxTokens: 384000, supportsImage: true },
];

const EXCLUDE_RE = /(?:embedding|reranker|ocr|^llm-mock$|^dumate-image)/i;
const VALID_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

function isPosInt(n) {
  return Number.isSafeInteger(n) && n > 0;
}

function formatEntry(raw, showRateInModelName) {
  const id = raw.id;
  const readableName = NAMES[id] ?? raw.rawName ?? id;
  const pointsPer1kOut = OUTPUT_RATES[id] ?? null;
  const displayName =
    showRateInModelName && pointsPer1kOut != null
      ? `${readableName} · ${pointsPer1kOut}pt/k`
      : readableName;
  return {
    id,
    rawName: raw.rawName ?? id,
    displayName,
    contextWindow: raw.contextWindow,
    maxTokens: raw.maxTokens,
    supportsImage: Boolean(raw.supportsImage),
    reasoning: V41_REASONING_MODELS.has(id.toLowerCase()),
    pointsPer1kOut,
  };
}

export const DEFAULT_MODELS = DEFAULT_MODEL_DEFS.map((m) =>
  formatEntry({ ...m, rawName: NAMES[m.id] ?? m.id }, true)
);

function snapshotFilePath() {
  return join(homedir(), ".dsh", "dumate-models.snapshot.json");
}

function resolveOpencodeJsonPath(userDataDir) {
  const override =
    typeof process.env.DUMATE_OPENCODE_CONFIG === "string"
      ? process.env.DUMATE_OPENCODE_CONFIG.trim()
      : "";
  if (override) return override;

  const dir = desktopUserDataDir(userDataDir);
  let accountId = "";
  try {
    const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    const profiles = Array.isArray(auth.accountProfiles) ? auth.accountProfiles : [];
    const active =
      profiles.find((p) => p?.profileId && p.profileId === auth.activeProfileId) ||
      (profiles.length === 1 ? profiles[0] : null);
    if (active?.bceAccountId) accountId = String(active.bceAccountId);
  } catch {
    // Fall back to sole directory under qianfan_desk_xdg.
  }

  const root = join(dir, "qianfan_desk_xdg");
  const tail = join("config", "opencode", "opencode.json");
  if (accountId) return join(root, accountId, tail);

  try {
    const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (dirs.length === 1) return join(root, dirs[0].name, tail);
  } catch {
    // No desktop config directory available.
  }
  return "";
}

function importRawCatalog(modelsMap) {
  if (!modelsMap || typeof modelsMap !== "object" || Array.isArray(modelsMap)) {
    return [];
  }
  const entries = [];
  for (const [key, val] of Object.entries(modelsMap)) {
    if (!val || typeof val !== "object") continue;
    const id = typeof val.id === "string" && val.id.trim() ? val.id.trim() : key;
    if (!VALID_ID_RE.test(key) || !VALID_ID_RE.test(id)) continue;
    if ((key.startsWith("model-") && key !== "model-text") || EXCLUDE_RE.test(key)) continue;
    if (key !== id && Object.hasOwn(modelsMap, id)) continue;

    const contextWindow = val.limit?.context ?? val.limit?.input ?? val.contextWindow;
    const maxTokens = val.limit?.output ?? val.maxTokens;
    if (!isPosInt(contextWindow) || !isPosInt(maxTokens)) continue;

    const inputMods = Array.isArray(val.modalities?.input)
      ? val.modalities.input
      : val.supportsImage
        ? ["text", "image"]
        : ["text"];
    if (!inputMods.includes("text")) continue;

    entries.push({
      id,
      rawName: typeof val.name === "string" && val.name.trim() ? val.name.trim() : id,
      contextWindow,
      maxTokens,
      supportsImage: inputMods.includes("image"),
    });
  }
  return entries;
}

function writeSnapshotAtomic(rawEntries, path = snapshotFilePath()) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify({ schema: 1, updatedAt: Date.now(), models: rawEntries }, null, 2)}\n`;
  try {
    writeFileSync(temp, payload, "utf8");
    renameSync(temp, path);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

function readSnapshotRaw(path = snapshotFilePath()) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_CONFIG_BYTES) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.schema !== 1 || !Array.isArray(parsed.models)) return [];
    const map = {};
    for (const item of parsed.models) {
      if (item && typeof item.id === "string") map[item.id] = item;
    }
    return importRawCatalog(map);
  } catch {
    return [];
  }
}

export function discoverDumateModels({
  userDataDir,
  showRateInModelName = true,
  snapshotPath = snapshotFilePath(),
} = {}) {
  const ocPath = resolveOpencodeJsonPath(userDataDir);
  if (ocPath) {
    try {
      const st = statSync(ocPath);
      if (st.isFile() && st.size > 0 && st.size <= MAX_CONFIG_BYTES) {
        const parsed = JSON.parse(readFileSync(ocPath, "utf8"));
        const rawEntries = importRawCatalog(parsed?.provider?.QianfanPersonalQuota?.models);
        if (rawEntries.length > 0) {
          if (snapshotPath) writeSnapshotAtomic(rawEntries, snapshotPath);
          return rawEntries.map((entry) => formatEntry(entry, showRateInModelName));
        }
      }
    } catch {
      // Fall through to snapshot / built-in defaults.
    }
  }

  const fromSnapshot = snapshotPath ? readSnapshotRaw(snapshotPath) : [];
  if (fromSnapshot.length > 0) {
    return fromSnapshot.map((entry) => formatEntry(entry, showRateInModelName));
  }

  return DEFAULT_MODEL_DEFS.map((entry) =>
    formatEntry({ ...entry, rawName: NAMES[entry.id] ?? entry.id }, showRateInModelName)
  );
}

/**
 * Shallow-clones the outbound OpenAI request body and normalizes DuMate's
 * thinking-effort fields while keeping `messages` and `tools` untouched.
 */
export function normalizeDumateRequestBody(body) {
  if (!body || typeof body !== "object") return body;
  const out = { ...body };
  const isV41 = V41_REASONING_MODELS.has(String(out.model || "").trim().toLowerCase());
  const raw =
    typeof out.reasoning_effort === "string"
      ? out.reasoning_effort.trim().toLowerCase()
      : null;

  if (isV41) {
    if (raw === "none" || raw === "off") {
      delete out.reasoning_effort;
      out.thinking = {
        ...(out.thinking && typeof out.thinking === "object" ? out.thinking : {}),
        type: "disabled",
      };
      out.enable_thinking = false;
    } else if (raw === "low") {
      out.reasoning_effort = "high";
      out.thinking = {
        ...(out.thinking && typeof out.thinking === "object" ? out.thinking : {}),
        type: "enabled",
      };
      out.enable_thinking = true;
    } else if (raw === "high" || raw === "max") {
      out.reasoning_effort = raw;
      out.thinking = {
        ...(out.thinking && typeof out.thinking === "object" ? out.thinking : {}),
        type: "enabled",
      };
      out.enable_thinking = true;
    } else {
      delete out.reasoning_effort;
    }
  } else {
    delete out.reasoning_effort;
  }

  if (out.stream === true && !out.stream_options) {
    out.stream_options = { include_usage: true };
  }

  return out;
}
