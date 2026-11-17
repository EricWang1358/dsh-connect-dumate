/**
 * In-process OpenAI-compatible loopback HTTP shim for DuMate.
 *
 * Binds `127.0.0.1:0` with a per-process 32-byte random Bearer secret, normalizes
 * outbound bodies via `normalizeDumateRequestBody`, exchanges cookies for gateway
 * tokens on demand, handles 401 token self-healing, and forwards SSE streams
 * with zero buffering.
 *
 * @module dsh-connect-dumate/shim
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  DUMATE_UA,
  fetchGatewayToken,
  invalidateGatewayToken,
} from "./dumate-auth.js";
import { normalizeDumateRequestBody } from "./dumate-catalog.js";

const UPSTREAM_CHAT_URL =
  process.env.DUMATE_GATEWAY_URL ||
  "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 600_000;

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function bearerMatches(authHeader, secretBuf) {
  if (typeof authHeader !== "string") return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const supplied = Buffer.from(match[1].trim(), "utf8");
  if (supplied.length !== secretBuf.length) return false;
  return timingSafeEqual(supplied, secretBuf);
}

async function readRequestJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error("request body exceeds 32MB limit");
      err.status = 413;
      throw err;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("invalid JSON request body");
    err.status = 400;
    throw err;
  }
}

export function createDumateShim({ getModels, getSettings, logger } = {}) {
  const secret = randomBytes(32).toString("hex");
  const secretBuf = Buffer.from(secret, "utf8");
  let resolvedUrl;
  let closed = false;

  const server = createServer(async (req, res) => {
    if (!bearerMatches(req.headers.authorization, secretBuf)) {
      sendJson(res, 401, {
        error: { message: "Unauthorized loopback request", type: "authentication_error" },
      });
      return;
    }

    const pathname = (req.url || "").split("?")[0];

    if (req.method === "GET" && pathname === "/v1/models") {
      const list = typeof getModels === "function" ? getModels() : [];
      sendJson(res, 200, {
        object: "list",
        data: list.map((m) => ({
          id: m.id,
          object: "model",
          created: 0,
          owned_by: "dumate",
        })),
      });
      return;
    }

    if (req.method !== "POST" || pathname !== "/v1/chat/completions") {
      sendJson(res, 404, {
        error: { message: `Unsupported route: ${req.method} ${pathname}`, type: "invalid_request_error" },
      });
      return;
    }

    let body;
    try {
      body = await readRequestJson(req);
    } catch (err) {
      sendJson(res, err.status || 400, {
        error: { message: err.message, type: "invalid_request_error" },
      });
      return;
    }

    const normalized = normalizeDumateRequestBody(body);
    const settings = typeof getSettings === "function" ? getSettings() : {};
    const credOpts = {
      userDataDir: settings?.userDataDir,
      manualCookie: settings?.manualCookie,
    };

    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(new Error("DuMate upstream timeout")), UPSTREAM_TIMEOUT_MS);
    const onClientClose = () => {
      if (!res.writableEnded) ac.abort(new Error("Client disconnected"));
    };
    res.on("close", onClientClose);

    try {
      let cred;
      try {
        cred = await fetchGatewayToken(credOpts);
      } catch (err) {
        sendJson(res, err?.status || 401, {
          error: {
            message: err?.message || "DuMate 未登录或登录态获取失败",
            type: "authentication_error",
          },
        });
        return;
      }

      const sendUpstream = (token) =>
        fetch(UPSTREAM_CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: normalized.stream ? "text/event-stream" : "application/json",
            "X-Dumate-Client-Type": "web",
            "X-Dumate-Account-Id": "global",
            "User-Agent": DUMATE_UA,
          },
          body: JSON.stringify(normalized),
          signal: ac.signal,
          redirect: "error",
        });

      let upstreamRes = await sendUpstream(cred.token);
      if (upstreamRes.status === 401) {
        try {
          await upstreamRes.body?.cancel?.();
        } catch {
          // Ignore stream cancellation error.
        }
        invalidateGatewayToken();
        try {
          cred = await fetchGatewayToken({ ...credOpts, force: true });
          upstreamRes = await sendUpstream(cred.token);
        } catch (err) {
          sendJson(res, 401, {
            error: {
              message: err?.message || "DuMate token 刷新失败，请检查桌面端或手动 Cookie 登录态",
              type: "authentication_error",
            },
          });
          return;
        }
      }

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => "");
        const contentType = upstreamRes.headers.get("content-type") || "application/json; charset=utf-8";
        if (!res.writableEnded) {
          if (errText && /json/i.test(contentType)) {
            res.writeHead(upstreamRes.status, {
              "content-type": contentType,
              "cache-control": "no-store",
            });
            res.end(errText);
          } else {
            sendJson(res, upstreamRes.status, {
              error: {
                message: errText || `DuMate upstream HTTP ${upstreamRes.status}`,
                type: upstreamRes.status === 401 ? "authentication_error" : "api_error",
              },
            });
          }
        }
        return;
      }

      if (normalized.stream && upstreamRes.body) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        for await (const chunk of upstreamRes.body) {
          if (res.writableEnded || ac.signal.aborted) break;
          res.write(chunk);
        }
        if (!res.writableEnded) res.end();
        return;
      }

      const rawText = await upstreamRes.text();
      if (!res.writableEnded) {
        res.writeHead(200, {
          "content-type": upstreamRes.headers.get("content-type") || "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(rawText);
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        logger?.warn?.("dsh-connect-dumate shim upstream error", err?.message || err);
        if (!res.headersSent) {
          sendJson(res, 502, {
            error: {
              message: `DuMate 上游请求失败: ${err?.message || String(err)}`,
              type: "api_error",
            },
          });
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    } finally {
      clearTimeout(timeoutId);
      res.off("close", onClientClose);
    }
  });

  const readyPromise = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvedUrl = `http://127.0.0.1:${port}`;
      resolve(resolvedUrl);
    });
  });

  return {
    baseUrlSync: () => resolvedUrl,
    baseUrl: () => readyPromise,
    token: () => secret,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        server.closeAllConnections?.();
      } catch {
        // Ignore on older runtimes.
      }
      server.close();
    },
  };
}
