import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCookieHeader,
  extractCsrfToken,
  loadDumateCredentials,
} from "../lib/dumate-auth.js";
import {
  DEFAULT_MODELS,
  discoverDumateModels,
  normalizeDumateRequestBody,
} from "../lib/dumate-catalog.js";
import { createDumateShim } from "../lib/dumate-shim.js";

function encryptDesktopAuth(cookies, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(cookies), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

test("loadDumateCredentials decrypts AES-256-GCM auth.json and filters/quotes cookies", () => {
  const dir = mkdtempSync(join(tmpdir(), "dumate-auth-test-"));
  try {
    const key = randomBytes(32);
    const mockCookies = [
      { name: "session_token", value: "abc123", domain: ".baidu.com" },
      { name: "bce-user-info", value: "u1|role:admin", domain: "console.bce.baidu.com" },
      { name: "hm_track", value: "ignored", domain: ".hm.baidu.com" },
      { name: "other_site", value: "ignored", domain: "example.com" },
    ];
    writeFileSync(join(dir, ".cookie-key"), key);
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        activeProfileId: "p1",
        accountProfiles: [
          {
            profileId: "p1",
            bceAccountId: "acc-1",
            bceUserId: "uid-1",
            displayName: "TestUser",
          },
        ],
        cookies: encryptDesktopAuth(mockCookies, key),
      }),
      "utf8"
    );

    const creds = loadDumateCredentials({ userDataDir: dir });
    assert.equal(creds.ok, true, creds.error);
    assert.equal(creds.source, "desktop");
    assert.equal(creds.accountId, "acc-1");
    assert.equal(creds.userId, "uid-1");
    assert.equal(creds.accountName, "TestUser");
    assert.equal(creds.cookies.length, 4);

    const header = buildCookieHeader(creds.cookies, "console.bce.baidu.com");
    assert.equal(header, 'session_token=abc123; bce-user-info="u1|role:admin"');
    assert.equal(extractCsrfToken(creds.cookies, "console.bce.baidu.com"), "u1|role:admin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverDumateModels imports opencode.json, filters non-chat entries, and falls back to snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "dumate-catalog-test-"));
  try {
    const ocDir = join(dir, "qianfan_desk_xdg", "acc-1", "config", "opencode");
    const ocPath = join(ocDir, "opencode.json");
    const snapshotPath = join(dir, "models.snapshot.json");
    mkdirSync(ocDir, { recursive: true });
    writeFileSync(
      ocPath,
      JSON.stringify({
        provider: {
          QianfanPersonalQuota: {
            options: { apiKey: "secret-should-not-copy", baseURL: "http://127.0.0.1:9999" },
            models: {
              "qwen4-max": {
                id: "qwen4-max",
                limit: { input: 983000, output: 128000 },
                modalities: { input: ["text", "image", "video"] },
              },
              "deepseek-v41-flash": {
                id: "deepseek-v41-flash",
                limit: { input: 1000000, output: 384000 },
                modalities: { input: ["text", "image"] },
              },
              "model-text": {
                id: "model-text",
                limit: { input: 1000000, output: 384000 },
                modalities: { input: ["text", "image"] },
              },
              "model-routing": {
                id: "model-routing",
                limit: { input: 100000, output: 8192 },
                modalities: { input: ["text"] },
              },
              "qwen3-embedding-4b": {
                id: "qwen3-embedding-4b",
                limit: { input: 32000, output: 1024 },
                modalities: { input: ["text"] },
              },
              "llm-mock": {
                id: "llm-mock",
                limit: { input: 32000, output: 1024 },
                modalities: { input: ["text"] },
              },
            },
          },
        },
      }),
      "utf8"
    );

    const models = discoverDumateModels({
      userDataDir: dir,
      showRateInModelName: true,
      snapshotPath,
    });
    const ids = new Set(models.map((m) => m.id));
    assert.ok(ids.has("qwen4-max"));
    assert.ok(ids.has("deepseek-v41-flash"));
    assert.ok(ids.has("model-text"));
    assert.equal(ids.has("model-routing"), false);
    assert.equal(ids.has("qwen3-embedding-4b"), false);
    assert.equal(ids.has("llm-mock"), false);

    const v41 = models.find((m) => m.id === "deepseek-v41-flash");
    assert.equal(v41.reasoning, true);
    assert.equal(v41.supportsImage, true);
    assert.ok(v41.displayName.includes("2pt/k"));

    // Removing opencode.json should cleanly fall back to snapshot
    unlinkSync(ocPath);
    const fromSnapshot = discoverDumateModels({
      userDataDir: dir,
      showRateInModelName: false,
      snapshotPath,
    });
    assert.equal(fromSnapshot.length, 3);
    const qwenNoRate = fromSnapshot.find((m) => m.id === "qwen4-max");
    assert.equal(qwenNoRate.displayName, "Qwen4-Max");

    // Without source or snapshot, falls back to built-in catalog
    const fallback = discoverDumateModels({
      userDataDir: join(dir, "missing"),
      showRateInModelName: true,
      snapshotPath: join(dir, "missing-snapshot.json"),
    });
    assert.ok(fallback.length >= DEFAULT_MODELS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeDumateRequestBody handles V4.1 reasoning tiers and leaves messages/tools untouched", () => {
  const messages = [{ role: "user", content: "hi" }];
  const tools = [{ type: "function", function: { name: "read_file" } }];

  for (const offTier of ["none", "off"]) {
    const res = normalizeDumateRequestBody({
      model: "deepseek-v41-flash",
      reasoning_effort: offTier,
      messages,
      tools,
    });
    assert.equal("reasoning_effort" in res, false);
    assert.deepEqual(res.thinking, { type: "disabled" });
    assert.equal(res.enable_thinking, false);
    assert.equal(res.messages, messages);
    assert.equal(res.tools, tools);
  }

  const rLow = normalizeDumateRequestBody({
    model: "deepseek-v41-flash",
    reasoning_effort: "low",
    messages,
    tools,
  });
  assert.equal(rLow.reasoning_effort, "high");
  assert.deepEqual(rLow.thinking, { type: "enabled" });
  assert.equal(rLow.enable_thinking, true);

  for (const highTier of ["high", "max"]) {
    const res = normalizeDumateRequestBody({
      model: "deepseek-v41-flash",
      reasoning_effort: highTier,
      messages,
      tools,
    });
    assert.equal(res.reasoning_effort, highTier);
    assert.deepEqual(res.thinking, { type: "enabled" });
    assert.equal(res.enable_thinking, true);
  }

  const rMedium = normalizeDumateRequestBody({
    model: "deepseek-v41-flash",
    reasoning_effort: "medium",
    messages,
    tools,
  });
  assert.equal("reasoning_effort" in rMedium, false);
  assert.equal("enable_thinking" in rMedium, false);

  const rQwen = normalizeDumateRequestBody({
    model: "qwen4-max",
    reasoning_effort: "high",
    messages,
    tools,
  });
  assert.equal("reasoning_effort" in rQwen, false);
  assert.equal("enable_thinking" in rQwen, false);
  assert.equal(rQwen.messages, messages);
  assert.equal(rQwen.tools, tools);
});

test("loopback shim enforces bearer auth and serves /v1/models", async () => {
  const shim = createDumateShim({
    getModels: () => DEFAULT_MODELS,
    getSettings: () => ({}),
  });

  try {
    const baseUrl = await shim.baseUrl();
    const token = shim.token();

    const unauthRes = await fetch(`${baseUrl}/v1/models`);
    assert.equal(unauthRes.status, 401);

    const modelsRes = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(modelsRes.status, 200);
    const modelsBody = await modelsRes.json();
    assert.equal(modelsBody.object, "list");
    assert.equal(modelsBody.data.length, DEFAULT_MODELS.length);
  } finally {
    shim.close();
  }
});

test(
  "live streaming POST /v1/chat/completions through loopback shim (opt-in)",
  { skip: process.env.DUMATE_LIVE_TEST !== "1" },
  async () => {
    const shim = createDumateShim({
      getModels: () => DEFAULT_MODELS,
      getSettings: () => ({}),
    });

    try {
      const baseUrl = await shim.baseUrl();
      const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${shim.token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "qwen38-flash",
          max_tokens: 24,
          stream: true,
          messages: [{ role: "user", content: "只回复OK两个字母" }],
        }),
      });
      const rawStream = await chatRes.text();
      assert.equal(chatRes.status, 200, `expected 200, got ${chatRes.status}: ${rawStream}`);
      assert.ok(rawStream.includes("data:"), "expected SSE data chunks");
      assert.ok(rawStream.includes("[DONE]"), "expected SSE [DONE] sentinel");
    } finally {
      shim.close();
    }
  }
);
