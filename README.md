# dsh-connect-dumate

将本机登录的 **百度搭子（DuMate）** 接入 **DeepSeek Harness (DSH)** 的官方架构插件（适配 DSH `0.2.x`）。

## 特性亮点

- **零额外依赖 & 不污染宿主**：全部 DSH 运行时接口严格声明在 `peerDependencies` 中，不携带任何旧版本 `@deepseek-ai/*` 覆盖依赖，不禁用宿主自带 `llm-pi-ai`。
- **免客户端直连（只读复用登录态）**：自动读取并 AES-256-GCM 解密本机 DuMate 桌面端 `auth.json` + `.cookie-key`（Windows / macOS / Linux 全路径支持），在请求时按需换取云端网关 Token；也支持在面板填写**手动 Cookie** 作为无客户端机器的兜底方案。
- **动态模型清单**：自动读取桌面端 `opencode.json` (`provider.QianfanPersonalQuota.models`) 中的对话模型元数据（支持 `qwen4-max`、`deepseek-v41-flash`、`glm-53`、`kimi-k31` 等），并原子保存快照至 `~/.dsh/dumate-models.snapshot.json` 兜底。
- **进程内 Loopback Shim + 官方 `PiAiAdapter`**：在插件内绑定 `127.0.0.1:0` 临时端口并校验 32 字节随机进程内 Bearer Secret，由 DSH 官方 `PiAiAdapter` 完整接管**真 SSE 流式、Tool Calling（函数/工具调用）、多模态图片输入、401 自动换票重试与断开即中止**。
- **V4.1 思考强度映射**：针对 `deepseek-v41-flash` 等 V4.1 后端模型正确映射 `off` / `low` / `high` / `max` 思考开关，其他模型安全剥离无效 `reasoning_effort`。
- **DSH 设置面板**：在 **设置 → 百度搭子** 及插件配置卡片中查看拆分后的 DuMate 独立积分池（过滤共享产品与未生效订阅期）、每日一键签到 / 启动自动签到、模型启用勾选与积分倍率显示开关（已按 `2026-11-18` 实测校准倍率表，如 `kimi-k31` 已从早期 `0.117 pt/k` 上调至 `31.19 pt/k` out、`kimi-k3` `6.235 pt/k` out、`glm-53` / `deepseek-v4-pro` / `qwen38-flash` 约 `0.1 pt/k`）。

---

## 架构概览

```text
DSH Agent / Model Picker
        │
        ▼ (PiAiAdapter + openAICompletionsApi)
In-Process Loopback Shim (127.0.0.1:0, per-process Bearer secret)
        │  ├─ 1. 读 auth.json (AES-256-GCM) 或手动 Cookie
        │  ├─ 2. 换取 / 缓存网关 Bearer Token (401 自动刷新重试)
        │  └─ 3. normalizeDumateRequestBody (保留 messages/tools，映射 V4.1 思考档位)
        ▼
https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions
```

---

## 安装方式

### 方式 1：DSH CLI Profile
```bash
# 从 npm（发布后）或 GitHub 安装
dsh plugin --profile <your-profile> add github:EricWang1358/dsh-connect-dumate
```
然后在对应 profile 的 `package.json` 的 `dsh.profile.bundles` 数组中添加 `"dsh-connect-dumate"`。

### 方式 2：DSH Desktop（桌面端源码打包安装）
```powershell
git clone https://github.com/EricWang1358/dsh-connect-dumate.git
cd dsh-connect-dumate
pnpm pack
```
然后在 DSH Desktop 的插件管理或桌面端 profile 目录（`~/.dsh/profiles/desktop`）中使用桌面端内置 `pnpm` 安装生成的 `.tgz` 包，并将 `"dsh-connect-dumate"` 加入 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`。

---

## 本地凭证与路径说明

插件仅以**只读方式**读取 DuMate 桌面端的登录态与模型元数据，不会修改 DuMate 的任何文件：

- **Windows**: `%APPDATA%\qianfan-desktop-app`
- **macOS**: `~/Library/Application Support/qianfan-desktop-app`
- **Linux**: `$XDG_CONFIG_HOME/qianfan-desktop-app`（默认 `~/.config/qianfan-desktop-app`）
- **环境变量覆盖**:
  - `DUMATE_USER_DATA_DIR`：自定义 DuMate 数据目录
  - `DUMATE_OPENCODE_CONFIG`：自定义 `opencode.json` 路径
  - `DUMATE_GATEWAY_URL`：自定义网关对话地址

插件自身的设置与模型快照保存在：
- `~/.dsh/dsh-connect-dumate.settings.json`
- `~/.dsh/dumate-models.snapshot.json`

---

## 开发与测试

要求 Node.js `>= 22.0.0`：

```bash
# 语法检查
npm run check

# 运行离线单元测试（零网络、零本机状态依赖）
npm test

# 可选：触发真机端到端流式测试（需本机已登录 DuMate 桌面端）
DUMATE_LIVE_TEST=1 npm test
```

---

## 致谢与参考

- [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) & [Wahwayhale/dsh-connect-doubao](https://github.com/Wahwayhale/dsh-connect-doubao)：DSH `0.2.x` 插件装配（`PiAiAdapter` + 进程内 Loopback Shim + 客户端设置卡片插槽）架构参考。
- [wearetheone777/dumate2api](https://github.com/wearetheone777/dumate2api)、[DuanZGit/dumate-duanz](https://github.com/DuanZGit/dumate-duanz)、[RanceLee233/dumate-rance](https://github.com/RanceLee233/dumate-rance)：百度搭子 `auth.json` 解密排布、`opencode.json` 模型清单过滤、实测积分倍率、积分分池口径及 `deepseek-v41-flash` 思考档位映射依据。

## 免责声明

本项目为社区开发的独立第三方兼容插件，与百度及 DeepSeek 官方无隶属或背书关系。请遵守相关平台的服务条款与频率限制，自行评估账号使用风险。
