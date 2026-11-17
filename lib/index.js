/**
 * DSH Connect DuMate — DeepSeek Harness plugin entrypoint.
 *
 * Bridges Baidu DuMate (百度搭子) into DSH using an in-process loopback OpenAI
 * shim + official `PiAiAdapter`, dynamic model discovery from local
 * `opencode.json`, product-isolated points quota reporting, daily check-in, and
 * a self-contained settings UI card.
 *
 * @module dsh-connect-dumate
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import {
  claimDailyBonus,
  fetchDumateQuota,
  invalidateGatewayToken,
  invalidateQuotaCache,
} from "./dumate-auth.js";
import { discoverDumateModels } from "./dumate-catalog.js";
import { createDumateShim } from "./dumate-shim.js";

export const PLUGIN_ID = "dsh-connect-dumate";
export const name = PLUGIN_ID;
export const inject = ["llm"];

const PROVIDER_ID = "dumate";
const PROVIDER_DISPLAY_NAME = "百度搭子 DuMate";
const STREAM_IDLE_TIMEOUT_MS = 300_000;

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
};

const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error("dsh-connect-dumate: no pi-ai credential lifecycle");
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    },
  },
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function asVolatile(schema) {
  return typeof schema.volatile === "function" ? schema.volatile() : schema;
}

export const Config = z.object({
  enabledModelIds: asVolatile(z.array(z.string()).default([])).description(
    "启用的 DuMate 模型 ID 列表；留空表示展示全部已发现模型。"
  ),
  showRateInModelName: asVolatile(z.boolean().default(true)).description(
    "在模型名称中显示每千 output token 积分消耗倍率。"
  ),
  autoCheckin: asVolatile(z.boolean().default(false)).description(
    "DSH 启动后自动尝试领取 DuMate 每日签到积分。"
  ),
  userDataDir: asVolatile(z.string().default("")).description(
    "DuMate 桌面端数据目录（留空则自动探测 %APPDATA%\\qianfan-desktop-app）。"
  ),
  manualCookie: asVolatile(z.string().default("")).description(
    "手动 Cookie 兜底（当本机未安装或未登录 DuMate 桌面端时使用）。"
  ),
});

function settingsFilePath() {
  return join(homedir(), ".dsh", "dsh-connect-dumate.settings.json");
}

function normalizeSettings(raw) {
  const out = {};
  if (Array.isArray(raw?.enabledModelIds)) {
    out.enabledModelIds = raw.enabledModelIds.filter((x) => typeof x === "string");
  }
  if (typeof raw?.showRateInModelName === "boolean") {
    out.showRateInModelName = raw.showRateInModelName;
  }
  if (typeof raw?.autoCheckin === "boolean") {
    out.autoCheckin = raw.autoCheckin;
  }
  if (typeof raw?.userDataDir === "string") {
    out.userDataDir = raw.userDataDir;
  }
  if (typeof raw?.manualCookie === "string") {
    out.manualCookie = raw.manualCookie;
  }
  return out;
}

function readStoredSettings(path = settingsFilePath()) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

function mergeSettings(loaderConfig, stored) {
  const base = normalizeSettings(loaderConfig);
  const file = stored ?? readStoredSettings();
  return {
    enabledModelIds: file.enabledModelIds ?? base.enabledModelIds ?? [],
    showRateInModelName: file.showRateInModelName ?? base.showRateInModelName ?? true,
    autoCheckin: file.autoCheckin ?? base.autoCheckin ?? false,
    userDataDir: file.userDataDir ?? base.userDataDir ?? "",
    manualCookie: file.manualCookie ?? base.manualCookie ?? "",
  };
}

function writeStoredSettings(patch, path = settingsFilePath()) {
  const next = { ...readStoredSettings(path), ...normalizeSettings(patch) };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Ignore temp cleanup failures.
    }
    throw err;
  }
  return next;
}

function toPiModel(info, baseUrl) {
  return {
    id: info.id,
    name: info.displayName,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    input: info.supportsImage ? ["text", "image"] : ["text"],
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    reasoning: info.reasoning,
    thinkingLevelMap: info.reasoning
      ? {
          off: "none",
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        }
      : {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: null,
        },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: info.reasoning,
      maxTokensField: "max_tokens",
    },
  };
}

function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== "string" || !hostHeader.trim()) return false;
  try {
    const { hostname } = new URL(`http://${hostHeader}`);
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function isLoopbackOrigin(originHeader) {
  if (typeof originHeader !== "string" || !originHeader.trim()) return true;
  try {
    const { hostname } = new URL(originHeader);
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function guardRoute(req, res, { write = false } = {}) {
  if (!isLoopbackHost(req.headers.host)) {
    sendJson(res, 403, { ok: false, error: "host-not-loopback" });
    return false;
  }
  if (req.headers["sec-fetch-site"] === "cross-site" || !isLoopbackOrigin(req.headers.origin)) {
    sendJson(res, 403, { ok: false, error: "origin-not-trusted" });
    return false;
  }
  if (write && req.headers["x-dsh-dumate-write"] !== "1") {
    sendJson(res, 403, { ok: false, error: "missing-write-header" });
    return false;
  }
  return true;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 262_144) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicSettingsOf(s) {
  return {
    enabledModelIds: s.enabledModelIds,
    showRateInModelName: s.showRateInModelName,
    autoCheckin: s.autoCheckin,
    userDataDir: s.userDataDir,
    hasManualCookie: Boolean(s.manualCookie && s.manualCookie.trim()),
  };
}

export function apply(ctx, config = {}) {
  let current = mergeSettings(config);
  let catalog = discoverDumateModels({
    userDataDir: current.userDataDir,
    showRateInModelName: current.showRateInModelName,
  });

  const refreshCatalog = () => {
    catalog = discoverDumateModels({
      userDataDir: current.userDataDir,
      showRateInModelName: current.showRateInModelName,
    });
    return catalog;
  };

  const activeModels = () => {
    const ids = Array.isArray(current.enabledModelIds) ? current.enabledModelIds : [];
    if (ids.length === 0) return catalog;
    const set = new Set(ids);
    const filtered = catalog.filter((m) => set.has(m.id));
    return filtered.length > 0 ? filtered : catalog;
  };

  const settingsNs = ctx.fiber?.entry?.options?.id ?? PLUGIN_ID;

  let shim;
  let adapterRelease;
  let directoryRelease;
  let discoveryRelease;
  let checkinTimer;
  let disposed = false;

  try {
    shim = createDumateShim({
      getModels: () => activeModels(),
      getSettings: () => current,
      logger: ctx.logger,
    });

    let syncBaseUrl = shim.baseUrlSync();

    const buildModels = () => {
      if (!syncBaseUrl) return [];
      const baseUrl = `${syncBaseUrl}/v1`;
      return activeModels().map((info) => toPiModel(info, baseUrl));
    };

    const piProvider = {
      ...createProvider({
        id: PROVIDER_ID,
        name: PROVIDER_DISPLAY_NAME,
        auth: {
          apiKey: {
            name: "DuMate loopback shim secret",
            async resolve({ credential }) {
              const apiKey = credential?.key;
              return apiKey && apiKey.length > 0
                ? { auth: { apiKey }, source: "DuMate" }
                : undefined;
            },
          },
        },
        models: buildModels(),
        api: openAICompletionsApi(),
      }),
      getModels: () => buildModels(),
    };

    const profile = {
      provider: PROVIDER_ID,
      displayName: PROVIDER_DISPLAY_NAME,
      streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(undefined, "dsh-connect-dumate retryPolicy"),
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      ...REQUEST_IMAGE_BUDGETS,
      piProvider,
    };

    let profiles = new Map([[PROVIDER_ID, profile]]);

    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
    });

    const notifyAdapters = () => {
      if (disposed) return;
      syncBaseUrl = syncBaseUrl ?? shim.baseUrlSync();
      profiles = new Map([[PROVIDER_ID, profile]]);
      try {
        adapterRelease?.replace?.([PROVIDER_ID]);
      } catch {
        // Ignore if host version lacks replace().
      }
      try {
        ctx.emit?.("llm/models-updated");
      } catch {
        // Ignore event emission errors.
      }
    };

    adapterRelease = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
    directoryRelease = ctx.llm.registerConfigurableProviders([
      {
        provider: PROVIDER_ID,
        displayName: PROVIDER_DISPLAY_NAME,
        settingsNs,
        settingsPath: [],
        declared: false,
      },
    ]);

    discoveryRelease = ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
      if (request.provider !== undefined && request.provider !== PROVIDER_ID) return [];
      return activeModels().map((m) => ({
        id: m.id,
        name: m.displayName,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        inputModalities: m.supportsImage ? ["text", "image"] : ["text"],
      }));
    });

    shim
      .baseUrl()
      .then((resolved) => {
        syncBaseUrl = resolved;
        notifyAdapters();
      })
      .catch((err) => {
        ctx.logger.error("dsh-connect-dumate: loopback shim failed to bind", err);
      });

    if (current.autoCheckin) {
      checkinTimer = setTimeout(() => {
        if (disposed) return;
        claimDailyBonus({
          userDataDir: current.userDataDir,
          manualCookie: current.manualCookie,
        }).catch(() => {});
      }, 8000);
      checkinTimer.unref?.();
    }

    ctx.effect(() => () => {
      disposed = true;
      if (checkinTimer) clearTimeout(checkinTimer);
      adapterRelease?.();
      directoryRelease?.();
      discoveryRelease?.();
      shim?.close();
      shim = undefined;
    });

    try {
      const presentationOwner = ctx.fiber;
      if (typeof ctx.inject === "function") {
        ctx.inject(["settings"], (settingsCtx) => {
          const settings = settingsCtx.settings;
          if (!settings || typeof settings.configure !== "function") return;
          const claim = () => settings.configure({ auto: false }, presentationOwner);
          if (typeof settingsCtx.effect === "function") {
            settingsCtx.effect.call(settingsCtx, claim);
          } else {
            claim();
          }
        });
      }
      ctx.on("loader/volatile-update", (next) => {
        if (!next) return;
        current = mergeSettings(next);
        refreshCatalog();
        notifyAdapters();
      });
    } catch {
      // Optional settings hooks may differ across host builds.
    }

    ctx.inject(["webServer"], (webCtx) => {
      try {
        const disposeStatus = webCtx.webServer.register({
          kind: "exact",
          path: "/plugins/dsh-connect-dumate/status",
          handler: async (req, res) => {
            if (req.method !== "GET") {
              sendJson(res, 405, { ok: false, error: "method-not-allowed" });
              return;
            }
            if (!guardRoute(req, res)) return;
            const url = new URL(req.url, "http://127.0.0.1");
            const force = url.searchParams.get("force") === "1";
            if (force) {
              invalidateQuotaCache();
              refreshCatalog();
              notifyAdapters();
            }
            const quota = await fetchDumateQuota({
              userDataDir: current.userDataDir,
              manualCookie: current.manualCookie,
              force,
            });
            sendJson(res, 200, {
              ok: true,
              quota,
              models: catalog,
              settings: publicSettingsOf(current),
            });
          },
        });

        const disposeCheckin = webCtx.webServer.register({
          kind: "exact",
          path: "/plugins/dsh-connect-dumate/checkin",
          handler: async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { ok: false, error: "method-not-allowed" });
              return;
            }
            if (!guardRoute(req, res, { write: true })) return;
            const result = await claimDailyBonus({
              userDataDir: current.userDataDir,
              manualCookie: current.manualCookie,
            });
            const quota = await fetchDumateQuota({
              userDataDir: current.userDataDir,
              manualCookie: current.manualCookie,
              force: true,
            });
            sendJson(res, 200, { ...result, quota });
          },
        });

        const disposeSave = webCtx.webServer.register({
          kind: "exact",
          path: "/plugins/dsh-connect-dumate/save",
          handler: async (req, res) => {
            if (req.method !== "POST") {
              sendJson(res, 405, { ok: false, error: "method-not-allowed" });
              return;
            }
            if (!guardRoute(req, res, { write: true })) return;
            try {
              const body = await readJsonBody(req);
              const patch = {};
              if (body.enabledModelIds !== undefined) {
                if (!Array.isArray(body.enabledModelIds) || !body.enabledModelIds.every((x) => typeof x === "string")) {
                  sendJson(res, 400, { ok: false, error: "enabledModelIds must be string[]" });
                  return;
                }
                patch.enabledModelIds = body.enabledModelIds;
              }
              if (body.showRateInModelName !== undefined) {
                if (typeof body.showRateInModelName !== "boolean") {
                  sendJson(res, 400, { ok: false, error: "showRateInModelName must be boolean" });
                  return;
                }
                patch.showRateInModelName = body.showRateInModelName;
              }
              if (body.autoCheckin !== undefined) {
                if (typeof body.autoCheckin !== "boolean") {
                  sendJson(res, 400, { ok: false, error: "autoCheckin must be boolean" });
                  return;
                }
                patch.autoCheckin = body.autoCheckin;
              }
              if (body.userDataDir !== undefined) {
                if (typeof body.userDataDir !== "string") {
                  sendJson(res, 400, { ok: false, error: "userDataDir must be string" });
                  return;
                }
                patch.userDataDir = body.userDataDir;
              }
              if (body.manualCookie !== undefined) {
                if (typeof body.manualCookie !== "string") {
                  sendJson(res, 400, { ok: false, error: "manualCookie must be string" });
                  return;
                }
                patch.manualCookie = body.manualCookie;
              }

              const saved = writeStoredSettings(patch);
              current = mergeSettings(config, saved);
              if (patch.userDataDir !== undefined || patch.manualCookie !== undefined) {
                invalidateGatewayToken();
                invalidateQuotaCache();
              }
              refreshCatalog();
              notifyAdapters();

              const quota = await fetchDumateQuota({
                userDataDir: current.userDataDir,
                manualCookie: current.manualCookie,
                force: patch.userDataDir !== undefined || patch.manualCookie !== undefined,
              });
              sendJson(res, 200, {
                ok: true,
                quota,
                models: catalog,
                settings: publicSettingsOf(current),
              });
            } catch (err) {
              sendJson(res, 500, { ok: false, error: err?.message || "保存失败" });
            }
          },
        });

        ctx.effect(() => () => {
          disposeStatus();
          disposeCheckin();
          disposeSave();
        });
      } catch (err) {
        ctx.logger.error("dsh-connect-dumate: web routes registration failed", err);
      }
    });
  } catch (err) {
    disposed = true;
    ctx.logger.error("dsh-connect-dumate: provider registration failed", err);
    adapterRelease?.();
    directoryRelease?.();
    discoveryRelease?.();
    shim?.close();
    shim = undefined;
  }
}

export default { name, inject, Config, apply };
