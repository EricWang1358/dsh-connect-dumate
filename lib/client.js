window.__ModuleLoader__.load({
  id: "dsh-connect-dumate",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    const STATUS_PATH = "/plugins/dsh-connect-dumate/status";
    const CHECKIN_PATH = "/plugins/dsh-connect-dumate/checkin";
    const SAVE_PATH = "/plugins/dsh-connect-dumate/save";
    const NAMESPACE = "settings.dumate";

    const STYLE_ID = "dsh-connect-dumate-styles";
    const CARD_CSS = `
.dmq-card { display: flex; flex-direction: column; gap: 16px; padding: 16px 18px;
  border: 1px solid #262b33; border-radius: 14px; color: #e8eaed;
  background: radial-gradient(120% 150% at 0% 0%, rgba(56, 189, 248, .10), transparent 58%),
    linear-gradient(180deg, #191c22 0%, #14161b 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .04), 0 12px 30px -14px rgba(0, 0, 0, .8);
  font-size: 13px; line-height: 1.55; font-variant-numeric: tabular-nums; }
.dmq-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dmq-title { font-weight: 600; font-size: 15px; }
.dmq-sub { color: #9aa0a6; font-size: 12px; }
.dmq-section { display: flex; flex-direction: column; gap: 10px; }
.dmq-section + .dmq-section { padding-top: 14px; border-top: 1px solid #21252c; }
.dmq-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dmq-sec-title { font-weight: 600; font-size: 12px; letter-spacing: .04em; color: #b6bdc7; }
.dmq-pill { font-size: 11px; color: #a8bdd4; background: #1e242c; border: 1px solid #2b323c;
  border-radius: 999px; padding: 1px 8px; }
.dmq-row { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
  border: 1px solid #232830; border-radius: 10px; background: #161a20; }
.dmq-row-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dmq-figure { font-weight: 600; color: #f1f3f4; font-size: 13px; }
.dmq-bar { height: 7px; border-radius: 999px; background: #232832; overflow: hidden; }
.dmq-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #38bdf8, #60a5fa); transition: width .25s ease; }
.dmq-fill.warn { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
.dmq-fill.empty { background: #ef4444; }
.dmq-meta { color: #9aa0a6; font-size: 12px; display: flex; gap: 10px; flex-wrap: wrap; }
.dmq-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dmq-btn { appearance: none; border: 1px solid #333a44; background: #20242b; color: #e8eaed;
  border-radius: 8px; padding: 6px 11px; font-size: 12px; font-weight: 500; cursor: pointer; }
.dmq-btn:hover:not(:disabled) { background: #272d36; border-color: #3f4956; }
.dmq-btn:disabled { opacity: .5; cursor: not-allowed; }
.dmq-btn.primary { border-color: #2563eb; background: #1d4ed8; color: #fff; }
.dmq-btn.primary:hover:not(:disabled) { background: #2563eb; }
.dmq-switch { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12.5px; color: #d7dce2; }
.dmq-switch input { accent-color: #38bdf8; }
.dmq-input, .dmq-textarea { width: 100%; box-sizing: border-box; border: 1px solid #2f3641;
  background: #12151a; color: #e8eaed; border-radius: 8px; padding: 7px 10px; font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.dmq-models { display: flex; flex-direction: column; gap: 6px; max-height: 360px; overflow-y: auto; padding-right: 4px; }
.dmq-model { display: flex; align-items: flex-start; gap: 9px; padding: 7px 10px; cursor: pointer;
  border: 1px solid #20242b; border-radius: 8px; background: #13161b; }
.dmq-model:hover { background: #161a20; border-color: #2b323c; }
.dmq-model input[type=checkbox] { margin: 3px 0 0; flex: none; accent-color: #38bdf8; }
.dmq-model-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dmq-model-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 500; }
.dmq-tag { font-size: 11px; color: #9fb2c8; background: #1e242c; border: 1px solid #2f3641; border-radius: 999px; padding: 0 7px; }
.dmq-tag.rate { color: #ffcf7a; background: #2a2418; border-color: #4a3c22; }
.dmq-tag.vision { color: #7dd3fc; background: #152532; border-color: #24455c; }
.dmq-tag.reason { color: #c4b5fd; background: #221c33; border-color: #3b3058; }
.dmq-note { color: #9aa0a6; font-size: 12px; }
.dmq-ok { color: #7fd18a; font-size: 12px; }
.dmq-err { color: #ff9d99; font-size: 12px; }
.dmq-dot { display: inline-block; width: 8px; height: 8px; border-radius: 999px; margin-right: 6px; background: #38bdf8; }
.dmq-dot.bad { background: #ef4444; }
`;

    const zh = {
      "card.navLabel": "百度搭子",
      "card.title": "百度搭子 DuMate",
      "card.subtitle": "直读本机 DuMate 桌面端登录态与模型清单（或手动 Cookie 兜底），通过进程内 OpenAI Loopback Shim 驱动完整工具调用与思考档位。",
    };

    const en = {
      "card.navLabel": "Baidu DuMate",
      "card.title": "Baidu DuMate",
      "card.subtitle": "Reads local DuMate desktop credentials & model catalog (with manual Cookie fallback) over an in-process OpenAI loopback shim.",
    };

    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CARD_CSS;
      (document.head || document.documentElement).appendChild(el);
    }

    function formatTokens(n) {
      if (!Number.isFinite(n) || n <= 0) return "--";
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.00$/, "")}M`;
      return `${Math.round(n / 1000)}K`;
    }

    function formatExpiry(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "到期时间未知";
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function DumateSettingsCard() {
      ensureStyles();

      const [loading, setLoading] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [quota, setQuota] = React.useState(null);
      const [models, setModels] = React.useState([]);
      const [settings, setSettings] = React.useState({
        enabledModelIds: [],
        showRateInModelName: true,
        autoCheckin: false,
        userDataDir: "",
        hasManualCookie: false,
      });
      const [feedback, setFeedback] = React.useState(null);
      const [showFallback, setShowFallback] = React.useState(false);
      const [cookieDraft, setCookieDraft] = React.useState("");
      const [dirDraft, setDirDraft] = React.useState("");

      const loadStatus = React.useCallback(async (force = false) => {
        setLoading(true);
        try {
          const res = await fetch(force ? `${STATUS_PATH}?force=1` : STATUS_PATH, {
            credentials: "same-origin",
            headers: { accept: "application/json" },
          });
          const data = await res.json();
          if (data?.ok) {
            setQuota(data.quota ?? null);
            setModels(Array.isArray(data.models) ? data.models : []);
            if (data.settings) {
              setSettings(data.settings);
              setDirDraft(data.settings.userDataDir || "");
            }
          } else {
            setFeedback({ type: "err", text: data?.error || "读取状态失败" });
          }
        } catch (err) {
          setFeedback({ type: "err", text: `读取状态失败：${err?.message || err}` });
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        loadStatus(false);
      }, [loadStatus]);

      const savePatch = React.useCallback(async (patch, okMessage) => {
        setBusy(true);
        setFeedback(null);
        try {
          const res = await fetch(SAVE_PATH, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              "x-dsh-dumate-write": "1",
            },
            body: JSON.stringify(patch),
          });
          const data = await res.json();
          if (!res.ok || !data?.ok) {
            setFeedback({ type: "err", text: data?.error || "保存失败" });
            return;
          }
          if (data.quota) setQuota(data.quota);
          if (Array.isArray(data.models)) setModels(data.models);
          if (data.settings) setSettings(data.settings);
          if (okMessage) setFeedback({ type: "ok", text: okMessage });
        } catch (err) {
          setFeedback({ type: "err", text: `保存失败：${err?.message || err}` });
        } finally {
          setBusy(false);
        }
      }, []);

      const handleCheckin = async () => {
        setBusy(true);
        setFeedback(null);
        try {
          const res = await fetch(CHECKIN_PATH, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              "x-dsh-dumate-write": "1",
            },
            body: "{}",
          });
          const data = await res.json();
          if (data?.quota) setQuota(data.quota);
          setFeedback({
            type: data?.ok ? "ok" : "err",
            text: data?.message || (data?.ok ? "签到完成" : "签到失败"),
          });
        } catch (err) {
          setFeedback({ type: "err", text: `签到失败：${err?.message || err}` });
        } finally {
          setBusy(false);
        }
      };

      const enabledList = Array.isArray(settings.enabledModelIds) ? settings.enabledModelIds : [];
      const usingAll = enabledList.length === 0;
      const enabledSet = usingAll ? new Set(models.map((m) => m.id)) : new Set(enabledList);

      const toggleModel = (id) => {
        const nextSet = new Set(enabledSet);
        if (nextSet.has(id)) nextSet.delete(id);
        else nextSet.add(id);
        if (nextSet.size === 0 || nextSet.size === models.length) {
          savePatch({ enabledModelIds: [] }, "模型选择已更新（全部模型）");
        } else {
          savePatch({ enabledModelIds: Array.from(nextSet) }, `已保存 ${nextSet.size} 个启用模型`);
        }
      };

      const remainPct = quota?.duTotal > 0 ? Math.max(0, Math.min(100, 100 - (quota.usedPercent || 0))) : 0;
      const barTone = remainPct <= 0 ? "empty" : remainPct <= 20 ? "warn" : "";

      return h(
        "div",
        { className: "dmq-card" },
        h(
          "div",
          { className: "dmq-head" },
          h("div", null,
            h("div", { className: "dmq-title" }, zh["card.title"]),
            h("div", { className: "dmq-sub" }, zh["card.subtitle"])
          ),
          h(
            "div",
            { className: "dmq-actions" },
            h(
              "button",
              {
                className: "dmq-btn primary",
                disabled: busy || loading,
                onClick: handleCheckin,
              },
              quota?.hasCheckedInToday ? "今日已签到" : "立即签到"
            ),
            h(
              "button",
              {
                className: "dmq-btn",
                disabled: busy || loading,
                onClick: () => loadStatus(true),
              },
              loading ? "刷新中…" : "刷新额度与模型"
            )
          )
        ),

        feedback &&
          h(
            "div",
            { className: feedback.type === "ok" ? "dmq-ok" : "dmq-err" },
            feedback.text
          ),

        // Account & Quota section
        h(
          "div",
          { className: "dmq-section" },
          h(
            "div",
            { className: "dmq-sec-head" },
            h("span", { className: "dmq-sec-title" }, "账号与积分池"),
            quota?.ok &&
              h(
                "span",
                { className: "dmq-pill" },
                [
                  quota.plan,
                  quota.period,
                  quota.checkinDays ? `累计签到 ${quota.checkinDays} 天` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              )
          ),
          h(
            "div",
            { className: "dmq-row" },
            h(
              "div",
              { className: "dmq-row-top" },
              h(
                "span",
                null,
                h("span", { className: `dmq-dot ${quota?.ok ? "" : "bad"}` }),
                quota?.ok
                  ? `${quota.accountName || "DuMate"} (${quota.source === "manual" ? "手动 Cookie" : "桌面端 auth.json"})`
                  : quota?.error || (loading ? "正在读取账号状态…" : "未检测到有效登录态")
              ),
              quota?.ok &&
                h(
                  "span",
                  { className: "dmq-figure" },
                  `剩 ${quota.remainingPoints} / ${quota.duTotal} 积分`
                )
            ),
            quota?.ok &&
              h(
                "div",
                { className: "dmq-bar" },
                h("div", {
                  className: `dmq-fill ${barTone}`,
                  style: { width: `${remainPct.toFixed(1)}%` },
                })
              ),
            quota?.ok &&
              h(
                "div",
                { className: "dmq-meta" },
                h("span", null, `已用 ${quota.duUsed}`),
                h("span", null, `最近到期 ${formatExpiry(quota.earliestExpiryMs)}`),
                Array.isArray(quota.otherPools) &&
                  quota.otherPools.map((p) =>
                    h(
                      "span",
                      { key: p.product },
                      `[${p.product} 共享池: ${p.remaining}/${p.total}]`
                    )
                  )
              )
          )
        ),

        // Preferences section
        h(
          "div",
          { className: "dmq-section" },
          h("span", { className: "dmq-sec-title" }, "偏好与兜底凭证"),
          h(
            "label",
            { className: "dmq-switch" },
            h("input", {
              type: "checkbox",
              checked: Boolean(settings.autoCheckin),
              disabled: busy,
              onChange: (e) =>
                savePatch(
                  { autoCheckin: e.target.checked },
                  e.target.checked ? "已开启启动自动签到" : "已关闭启动自动签到"
                ),
            }),
            "启动 DSH 时自动签到"
          ),
          h(
            "label",
            { className: "dmq-switch" },
            h("input", {
              type: "checkbox",
              checked: settings.showRateInModelName !== false,
              disabled: busy,
              onChange: (e) =>
                savePatch(
                  { showRateInModelName: e.target.checked },
                  "模型名称倍率显示已更新"
                ),
            }),
            "在模型名称中显示积分倍率（pt/k output）"
          ),
          h(
            "div",
            { className: "dmq-actions" },
            h(
              "button",
              {
                className: "dmq-btn",
                onClick: () => setShowFallback((v) => !v),
              },
              showFallback
                ? "收起手动凭证 / 目录设置"
                : settings.hasManualCookie
                  ? "手动 Cookie 已启用（点击修改）"
                  : "配置自定义桌面目录 / 手动 Cookie 兜底"
            )
          ),
          showFallback &&
            h(
              "div",
              { className: "dmq-row" },
              h("div", { className: "dmq-note" }, "DuMate 桌面端数据目录（留空则自动探测 %APPDATA%\\qianfan-desktop-app）："),
              h("input", {
                className: "dmq-input",
                value: dirDraft,
                placeholder: "%APPDATA%\\qianfan-desktop-app",
                onChange: (e) => setDirDraft(e.target.value),
              }),
              h("div", { className: "dmq-note" }, "手动 Cookie（可选，填写后将优先于桌面端 auth.json；留空不变，点击清空则恢复桌面端读取）："),
              h("textarea", {
                className: "dmq-textarea",
                rows: 3,
                value: cookieDraft,
                placeholder: settings.hasManualCookie ? "当前已保存手动 Cookie（粘贴新值覆盖，或点击下方按钮清空）" : "粘贴 console.bce.baidu.com 请求头中的完整 Cookie（需含 bce-sessionid）",
                onChange: (e) => setCookieDraft(e.target.value),
              }),
              h(
                "div",
                { className: "dmq-actions" },
                h(
                  "button",
                  {
                    className: "dmq-btn primary",
                    disabled: busy,
                    onClick: () => {
                      const patch = { userDataDir: dirDraft.trim() };
                      if (cookieDraft.trim()) patch.manualCookie = cookieDraft.trim();
                      savePatch(patch, "目录/手动凭证已保存");
                      setCookieDraft("");
                    },
                  },
                  "保存目录与 Cookie"
                ),
                settings.hasManualCookie &&
                  h(
                    "button",
                    {
                      className: "dmq-btn",
                      disabled: busy,
                      onClick: () => {
                        setCookieDraft("");
                        savePatch({ manualCookie: "" }, "已清空手动 Cookie，恢复桌面端自动读取");
                      },
                    },
                    "清空手动 Cookie"
                  )
              )
            )
        ),

        // Models section
        h(
          "div",
          { className: "dmq-section" },
          h(
            "div",
            { className: "dmq-sec-head" },
            h(
              "span",
              { className: "dmq-sec-title" },
              `可用模型 (${enabledSet.size} / ${models.length})`
            ),
            h(
              "div",
              { className: "dmq-actions" },
              h(
                "button",
                {
                  className: "dmq-btn",
                  disabled: busy || models.length === 0,
                  onClick: () => savePatch({ enabledModelIds: models.map((m) => m.id) }, "已勾选全部模型"),
                },
                "全选"
              ),
              h(
                "button",
                {
                  className: "dmq-btn",
                  disabled: busy || models.length === 0,
                  onClick: () => savePatch({ enabledModelIds: [] }, "已重置为默认全部模型"),
                },
                "清空重置"
              )
            )
          ),
          h(
            "div",
            { className: "dmq-models" },
            models.map((m) =>
              h(
                "label",
                { key: m.id, className: "dmq-model" },
                h("input", {
                  type: "checkbox",
                  checked: enabledSet.has(m.id),
                  disabled: busy,
                  onChange: () => toggleModel(m.id),
                }),
                h(
                  "div",
                  { className: "dmq-model-main" },
                  h(
                    "div",
                    { className: "dmq-model-name" },
                    h("span", null, m.displayName),
                    m.pointsPer1kOut != null &&
                      h("span", { className: "dmq-tag rate" }, `${m.pointsPer1kOut} pt/k`),
                    m.supportsImage &&
                      h("span", { className: "dmq-tag vision" }, "Vision"),
                    m.reasoning &&
                      h("span", { className: "dmq-tag reason" }, "Reasoning")
                  ),
                  h(
                    "div",
                    { className: "dmq-note" },
                    `${m.id} · 上下文 ${formatTokens(m.contextWindow)} / 输出 ${formatTokens(m.maxTokens)}`
                  )
                )
              )
            )
          )
        )
      );
    }

    const name = "dsh-connect-dumate-client";
    const inject = ["slots", "locale"];

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), "dsh-connect-dumate: card copy");
        const t = ctx.locale.bind(NAMESPACE);

        try {
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: "dsh-connect-dumate",
                order: 42,
                label: () => t("card.navLabel"),
                inject: () => ({ t }),
              },
              DumateSettingsCard
            )
          );
        } catch (err) {
          console.error("[dsh-connect-dumate] settings.section register failed:", err);
        }

        for (const [slotName, key] of [
          ["plugins.bundle.config", "dsh-connect-dumate"],
          ["plugins.row.config", "dsh-connect-dumate#dsh-connect-dumate"],
        ]) {
          try {
            ctx.slots.inject(slotName, () =>
              ctx.slots.register(
                {
                  name: slotName,
                  key,
                  priority: 30,
                  inject: () => ({ t }),
                },
                DumateSettingsCard
              )
            );
          } catch (err) {
            console.error(`[dsh-connect-dumate] ${slotName} register failed:`, err);
          }
        }
      } catch (err) {
        console.error("[dsh-connect-dumate] client card failed to load:", err);
      }
    }

    exports.DumateSettingsCard = DumateSettingsCard;
    exports.apply = apply;
    exports.en = en;
    exports.inject = inject;
    exports.name = name;
    exports.zh = zh;
    return module.exports;
  },
});
