/**
 * DuMate credential decryption, gateway token exchange, points quota, and daily check-in.
 *
 * Reads `%APPDATA%\qianfan-desktop-app\auth.json` + `.cookie-key` read-only
 * (`aes-256-gcm` with `[12B iv][16B authTag][ciphertext]`), or accepts a
 * user-supplied manual Cookie header fallback.
 *
 * @module dsh-connect-dumate/auth
 */

import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DUMATE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DuMate/1.0.92 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36";

const CONSOLE_HOSTS = [
  "https://console.bce.baidu.com",
  "https://www.dumate.cn",
];

const SKIP_DOMAINS = new Set([
  ".hm.baidu.com",
  "hao123.com",
  ".hao123.com",
  "yoojia.com",
  ".yoojia.com",
  "xlab.baidu.com",
]);

const MAX_AUTH_BYTES = 2 * 1024 * 1024;
const TOKEN_TTL_FALLBACK_MS = 50 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const QUOTA_TTL_MS = 15 * 1000;

let desktopCache = null; // { key: string, mtimeMs: number, result: object }
const tokenCache = new Map(); // cookieHash -> { token, expiresAt }
const tokenPending = new Map(); // cookieHash -> Promise
let quotaCache = null; // { key: string, at: number, value: object }

export function desktopUserDataDir(overrideDir) {
  const manual = typeof overrideDir === "string" ? overrideDir.trim() : "";
  if (manual) return manual;
  const fromEnv = typeof process.env.DUMATE_USER_DATA_DIR === "string"
    ? process.env.DUMATE_USER_DATA_DIR.trim()
    : "";
  if (fromEnv) return fromEnv;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "qianfan-desktop-app");
  }
  if (process.platform === "linux") {
    return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "qianfan-desktop-app");
  }
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appData, "qianfan-desktop-app");
}

export function parseCookieString(raw) {
  const out = [];
  for (const part of String(raw ?? "").split(/;\s*/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (!name) continue;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out.push({ name, value, domain: ".baidu.com" });
  }
  return out;
}

function domainMatches(cookieDomain, hostname) {
  if (!hostname) return true;
  if (!cookieDomain) return true;
  const normalized = String(cookieDomain).startsWith(".")
    ? String(cookieDomain).slice(1)
    : String(cookieDomain);
  return hostname === normalized || hostname.endsWith("." + normalized);
}

export function buildCookieHeader(cookies, hostname) {
  const list = Array.isArray(cookies) ? cookies : [];
  const parts = [];
  for (const c of list) {
    if (!c || !c.name || c.value == null) continue;
    const rawDomain = c.domain ? String(c.domain) : "";
    if (rawDomain && SKIP_DOMAINS.has(rawDomain.toLowerCase())) continue;
    if (hostname && !domainMatches(rawDomain, hostname)) continue;
    let val = String(c.value).replace(/^["']+|["']+$/g, "");
    if (/[:|;=\s]/.test(val)) val = `"${val}"`;
    parts.push(`${c.name}=${val}`);
  }
  return parts.join("; ");
}

export function extractCsrfToken(cookies, hostname = "console.bce.baidu.com") {
  const list = Array.isArray(cookies) ? cookies : [];
  const hit = list.find(
    (c) => c?.name === "bce-user-info" && domainMatches(c.domain, hostname)
  );
  return hit ? String(hit.value ?? "").replace(/^["']+|["']+$/g, "") : "";
}

function cookieHashOf(cookies) {
  const canonical = buildCookieHeader(cookies, "console.bce.baidu.com") || buildCookieHeader(cookies);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export function loadDumateCredentials({ userDataDir, manualCookie } = {}) {
  const manual = typeof manualCookie === "string" ? manualCookie.trim() : "";
  if (manual) {
    const cookies = parseCookieString(manual);
    if (cookies.length < 2) {
      return { ok: false, error: "手动 Cookie 格式无效（至少需要两个键值对，且需包含 bce-sessionid）" };
    }
    return {
      ok: true,
      source: "manual",
      cookies,
      accountId: "manual",
      userId: "",
      accountName: "手动 Cookie",
    };
  }

  const dir = desktopUserDataDir(userDataDir);
  const authPath = join(dir, "auth.json");
  const keyPath = join(dir, ".cookie-key");

  let st;
  try {
    st = statSync(authPath);
  } catch {
    return {
      ok: false,
      error: `未找到 DuMate 桌面端登录文件（${authPath}），请先登录百度搭子桌面端或填写手动 Cookie`,
    };
  }
  if (!st.isFile() || st.size <= 0 || st.size > MAX_AUTH_BYTES) {
    return { ok: false, error: `DuMate auth.json 大小异常（${st.size} 字节）` };
  }

  if (desktopCache && desktopCache.key === dir && desktopCache.mtimeMs === st.mtimeMs) {
    return desktopCache.result;
  }

  let auth;
  let key;
  try {
    auth = JSON.parse(readFileSync(authPath, "utf8"));
    key = readFileSync(keyPath);
  } catch (err) {
    return { ok: false, error: `读取 DuMate 凭证失败：${err.message}` };
  }

  if (!Buffer.isBuffer(key) || key.length !== 32) {
    return { ok: false, error: ".cookie-key 不是有效的 32 字节密钥" };
  }
  if (typeof auth?.cookies !== "string" || !auth.cookies) {
    return { ok: false, error: "auth.json 中缺少加密 cookies，请先在 DuMate 桌面端登录" };
  }

  const raw = Buffer.from(auth.cookies, "base64");
  if (raw.length < 29) {
    return { ok: false, error: `auth.json cookies 密文长度不足（${raw.length}B）` };
  }

  let cookies;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    cookies = JSON.parse(plain);
  } catch (err) {
    return { ok: false, error: `解密 DuMate cookies 失败：${err.message}` };
  }

  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { ok: false, error: "DuMate cookies 解密为空" };
  }

  const profiles = Array.isArray(auth.accountProfiles) ? auth.accountProfiles : [];
  const active =
    profiles.find((p) => p?.profileId && p.profileId === auth.activeProfileId) ||
    profiles[0] ||
    {};

  const result = {
    ok: true,
    source: "desktop",
    cookies,
    accountId: String(active.bceAccountId || ""),
    userId: String(active.bceUserId || ""),
    accountName: String(active.displayName || "DuMate Desktop"),
  };

  desktopCache = { key: dir, mtimeMs: st.mtimeMs, result };
  return result;
}

function isDomainDownStatus(status, json, text) {
  if (status === 0) return true;
  if (status >= 500 && status < 600) return true;
  if (status >= 200 && status < 300 && json === null && !/登录|login/i.test(text.slice(0, 400))) {
    return true;
  }
  return false;
}

async function consoleRequest(path, { method = "GET", body, cookies } = {}) {
  let lastErr = null;
  for (const base of CONSOLE_HOSTS) {
    const hostUrl = new URL(base);
    const hostname = hostUrl.hostname;
    const cookieHeader =
      buildCookieHeader(cookies, hostname) || buildCookieHeader(cookies);

    const headers = {
      Cookie: cookieHeader,
      "User-Agent": DUMATE_UA,
      Accept: "application/json",
      Referer: `${base}/`,
    };
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      headers["X-Requested-With"] = "XMLHttpRequest";
      headers.Origin = base;
      const csrf = extractCsrfToken(cookies, hostname) || extractCsrfToken(cookies);
      if (csrf) headers.csrftoken = csrf;
    }

    let res;
    let text = "";
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const err = new Error("DuMate 登录态已过期（触发登录跳转），请重新登录桌面端或更新 Cookie");
        err.status = 401;
        throw err;
      }
      text = await res.text();
    } catch (err) {
      if (err?.status === 401) throw err;
      lastErr = err;
      continue;
    }

    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }

    if (isDomainDownStatus(res.status, payload, text)) {
      lastErr = new Error(`DuMate console ${hostname} HTTP ${res.status}`);
      continue;
    }

    if (payload === null || typeof payload !== "object") {
      if (/登录|login|<!DOCTYPE|<html/i.test(text.slice(0, 500))) {
        const err = new Error("DuMate 登录态已失效（返回登录页），请重新登录");
        err.status = 401;
        throw err;
      }
      throw new Error(`DuMate console HTTP ${res.status} 非 JSON 响应`);
    }

    if (!res.ok) {
      const err = new Error(`DuMate console HTTP ${res.status}: ${payload.message || ""}`.trim());
      err.status = res.status;
      throw err;
    }

    if (payload.code !== 0 || payload.success === false) {
      const msg = String(payload.message || `code=${payload.code}`);
      const err = new Error(`DuMate 接口错误：${msg}`);
      if (/登录凭证|重新登录|login/i.test(msg)) err.status = 401;
      throw err;
    }

    return payload.result;
  }

  throw lastErr || new Error("无法连接 DuMate 控制台");
}

export function invalidateGatewayToken() {
  tokenCache.clear();
}

export function invalidateQuotaCache() {
  quotaCache = null;
}

export async function fetchGatewayToken({ userDataDir, manualCookie, force = false } = {}) {
  const creds = loadDumateCredentials({ userDataDir, manualCookie });
  if (!creds.ok) {
    const err = new Error(creds.error);
    err.status = 401;
    throw err;
  }

  const key = cookieHashOf(creds.cookies);
  const now = Date.now();
  const cached = tokenCache.get(key);
  if (!force && cached && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
    return {
      token: cached.token,
      expiresAt: cached.expiresAt,
      accountName: creds.accountName,
      accountId: creds.accountId,
      source: creds.source,
    };
  }

  if (tokenPending.has(key) && !force) {
    return tokenPending.get(key);
  }

  const job = (async () => {
    const result = await consoleRequest("/api/dumate/app/token/get", {
      method: "GET",
      cookies: creds.cookies,
    });
    const token = typeof result?.token === "string" ? result.token.trim() : "";
    if (!token) {
      throw new Error("DuMate 未返回有效的 gateway token");
    }
    const parsedExp = result?.expired_at ? Date.parse(result.expired_at) : NaN;
    const expiresAt =
      Number.isFinite(parsedExp) && parsedExp > Date.now()
        ? parsedExp
        : Date.now() + TOKEN_TTL_FALLBACK_MS;
    tokenCache.set(key, { token, expiresAt });
    return {
      token,
      expiresAt,
      accountName: creds.accountName,
      accountId: creds.accountId,
      source: creds.source,
    };
  })().finally(() => {
    tokenPending.delete(key);
  });

  tokenPending.set(key, job);
  return job;
}

function parseTimestampSec(val) {
  if (val == null) return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
}

export async function fetchDumateQuota({ userDataDir, manualCookie, force = false } = {}) {
  const creds = loadDumateCredentials({ userDataDir, manualCookie });
  if (!creds.ok) {
    return {
      ok: false,
      signedIn: false,
      source: null,
      accountName: null,
      error: creds.error,
    };
  }

  const key = cookieHashOf(creds.cookies);
  if (!force && quotaCache && quotaCache.key === key && Date.now() - quotaCache.at < QUOTA_TTL_MS) {
    return quotaCache.value;
  }

  try {
    let overviewErr = null;
    const [overview, bonusInfo] = await Promise.all([
      consoleRequest(
        "/api/dumate/points/quota_overview?timezone=Asia%2FShanghai&clientType=desktop&ignoreLoginBonus=true",
        { method: "GET", cookies: creds.cookies }
      ).catch((e) => {
        overviewErr = e;
        return null;
      }),
      consoleRequest("/api/dumate/points/loginBonusInfo", {
        method: "GET",
        cookies: creds.cookies,
      }).catch(() => null),
    ]);

    if (!overview) {
      throw overviewErr || new Error("quota_overview 接口不可用");
    }

    const totalAll = Number.parseFloat(overview.totalPoints) || 0;
    const usedAll = Number.parseFloat(overview.usedPoints) || 0;

    const subs = Array.isArray(overview.subscription) ? overview.subscription : [];
    const incs = Array.isArray(overview.incremental) ? overview.incremental : [];
    const allPacks = [...subs, ...incs];
    const isDuMate = (p) => (p?.product ?? "dumate") === "dumate";
    const duPacks = allPacks.filter(isDuMate);
    const otherPacks = allPacks.filter((p) => !isDuMate(p));
    const activeDu = duPacks.filter((p) => p?.status === "active");

    const sumPts = (list, field) =>
      list.reduce((sum, p) => sum + (Number.parseFloat(p?.[field]) || 0), 0);

    const duTotal = activeDu.length > 0 ? sumPts(activeDu, "totalPoints") : totalAll;
    const packUsed = sumPts(activeDu, "usedPoints");
    const duUsed = packUsed > 0 ? packUsed : Math.min(usedAll, duTotal);
    const remainingPoints = Math.max(0, Math.round((duTotal - duUsed) * 100) / 100);

    const duSubs = subs.filter(isDuMate);
    const activeSub = duSubs.find((p) => p?.status === "active");
    const activeIdx = activeSub ? duSubs.indexOf(activeSub) : -1;
    const period =
      activeSub && duSubs.length > 1 ? `第 ${activeIdx + 1}/${duSubs.length} 期` : null;

    let earliestExpiryMs = null;
    for (const p of activeDu) {
      const ms = parseTimestampSec(p.pointsExpireDate ?? p.expireDate);
      if (ms !== null && (earliestExpiryMs === null || ms < earliestExpiryMs)) {
        earliestExpiryMs = ms;
      }
    }

    const otherPools = otherPacks
      .map((p) => {
        const total = Number.parseFloat(p?.totalPoints) || 0;
        const used = Number.parseFloat(p?.usedPoints) || 0;
        return {
          product: String(p?.product || "other"),
          total: Math.round(total * 100) / 100,
          used: Math.round(used * 100) / 100,
          remaining: Math.max(0, Math.round((total - used) * 100) / 100),
          status: String(p?.status || "unknown"),
        };
      })
      .filter((p) => p.total > 0);

    const value = {
      ok: true,
      signedIn: true,
      source: creds.source,
      accountName: creds.accountName,
      accountId: creds.accountId || null,
      plan: overview.isSubscribed === false ? "免费版" : "Pro",
      period,
      duTotal: Math.round(duTotal * 100) / 100,
      duUsed: Math.round(duUsed * 100) / 100,
      remainingPoints,
      usedPercent: duTotal > 0 ? Math.min(100, Math.max(0, (duUsed / duTotal) * 100)) : 0,
      earliestExpiryMs,
      hasCheckedInToday: Boolean(bonusInfo?.hasIssued),
      checkinDays: Number(bonusInfo?.totalTimes) || 0,
      otherPools,
      fetchedAt: Date.now(),
      error: null,
    };

    quotaCache = { key, at: Date.now(), value };
    return value;
  } catch (err) {
    return {
      ok: false,
      signedIn: err?.status !== 401,
      source: creds.source,
      accountName: creds.accountName,
      accountId: creds.accountId || null,
      error: err?.message || "额度查询失败",
      fetchedAt: Date.now(),
    };
  }
}

export async function claimDailyBonus({ userDataDir, manualCookie } = {}) {
  const creds = loadDumateCredentials({ userDataDir, manualCookie });
  if (!creds.ok) {
    return { ok: false, outcome: "failed", message: creds.error };
  }

  try {
    const before = await consoleRequest("/api/dumate/points/loginBonusInfo", {
      method: "GET",
      cookies: creds.cookies,
    }).catch((err) => {
      if (err?.status === 401) throw err;
      return null;
    });

    if (before?.hasIssued === true) {
      return {
        ok: true,
        outcome: "done",
        delta: 0,
        message: `今日已签到（累计 ${Number(before.totalTimes) || "?"} 天）`,
      };
    }

    const beforePoints = Number.parseFloat(before?.totalPoints ?? "0") || 0;
    await consoleRequest("/api/dumate/points/loginBonus", {
      method: "POST",
      body: {},
      cookies: creds.cookies,
    });

    invalidateQuotaCache();
    const after = await consoleRequest("/api/dumate/points/loginBonusInfo", {
      method: "GET",
      cookies: creds.cookies,
    }).catch(() => null);

    if (after?.hasIssued === true) {
      const afterPoints = Number.parseFloat(after.totalPoints ?? "0") || 0;
      const delta = Math.max(0, Math.round(afterPoints - beforePoints));
      return {
        ok: true,
        outcome: "claimed",
        delta,
        message: `签到成功${delta > 0 ? ` +${delta} 积分` : ""}（累计 ${Number(after.totalTimes) || "?"} 天）`,
      };
    }

    return {
      ok: true,
      outcome: "inactive",
      delta: 0,
      message: "签到请求已提交，等待积分入账",
    };
  } catch (err) {
    return {
      ok: false,
      outcome: "failed",
      delta: 0,
      message: err?.message || "签到失败",
    };
  }
}
