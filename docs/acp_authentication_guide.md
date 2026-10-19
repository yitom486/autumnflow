# Google Antigravity 官方 ACP 架构与认证排障指南

> 💡 **详细底层机制与进程生命周期解析请参阅**：[Antigravity 官方 ACP 认证机制与进程生命周期深度解析](file:///d:/project/js/Electron/antigravity-acp/docs/antigravity_acp_auth_and_lifecycle.md)。

## 一、系统架构升级概述

本项目已彻底重构，移除了旧版的 `agy.exe -p` 命令行包装与 SQLite 数据库轮询机制，全面切换至 Google LLC 官方发布的独立 **Agent Client Protocol (ACP)** 服务端：

* **核心执行体**：`agy_acp_server.exe`（在 Linux 下为 `agy_acp_server.par`，由 Python PAR 打包构建）
* **支持服务**：`localharness_external.exe`（Go 编译的官方本地线束服务）
* **来源**：ACP Registry 官方分发（Windows x64 位于 `~\\AppData\\Local\\Zed\\external_agents\\registry\\antigravity-acp\\...`）
* **通信协议**：基于标准 stdio 的 JSON-RPC 2.0 NDJSON（分帧行协议）
* **会话与权限**：由官方 Server 自身独立管理生命周期、会话创建、MCP 工具调用以及 Google 账号权限。

---

## 二、ACP 认证全流程与底层痛点分析

### 1. 为什么 ACP 认证比传统 CLI (`agy auth login`) 复杂？

| 对比维度 | 传统 CLI (`agy auth`) | 官方 ACP Server (`agy_acp_server`) |
| :--- | :--- | :--- |
| **交互模式** | 人机交互终端，支持前台直接输入、直接打印错误 | 面向 IDE（Zed / Studio）的**无头后台守护进程 (Headless Daemon)** |
| **通信机制** | 直接在标准 Shell 终端中打印交互提示 | 严格遵守 JSON-RPC 2.0，所有日志与回调走标准协议 |
| **OAuth 捕获** | 终端环境自动继承环境变量，甚至支持复制验证码 | 必须在后台动态向系统申请一个**一次性随机高位端口**（如 56834、51414）启动微型 Web 监听服务，捕获浏览器的重定向 |
| **排障可见性** | 哪一步断网，命令行直接报红字 | 运行在后台幕后，任何一环断掉前端通常只看到“未登录” |

---

### 2. OAuth 两阶段握手机制

Google OAuth 在 ACP 环境下的握手实际上严格分为两个阶段：

```
[阶段一: 浏览器授权与本地接收]
用户在浏览器点击同意 ──> Google 重定向至 http://127.0.0.1:<随机端口>/?code=...
                     └──> agy_acp_server 临时 HTTP 服务接收到 code
                     └──> 页面渲染: "Authentication successful. You can close this window..."

[阶段二: 本地子进程换取 Token 与 Google 服务端 Onboarding]
agy_acp_server 内部 ──(HTTPS POST)──> https://oauth2.googleapis.com/token
                     ├── 兑换 Access Token / Refresh Token
                     ├── 验证 Google AI Pro 订阅与 aicode-consumers 项目
                     └── 写入凭证到 ~/.gemini/antigravity-acp/settings.json
```

#### 痛点与陷阱剖析：
1. **子进程不继承 Windows 注册表代理**：
   * Chrome 浏览器走的是 Windows 系统代理（`127.0.0.1:7897`），能正常打开 Google 登录页完成【阶段一】；
   * 但后台被拉起的 `agy_acp_server.exe` 是控制台进程，Windows 默认不会给它注入环境变量；
   * 进入【阶段二】时，`agy_acp_server.exe` 尝试裸连 `oauth2.googleapis.com`，被国内网络阻断或超时，抛出：
     `Onboarding failed: The authentication flow did not complete successfully`。
2. **TUN 模式（虚拟网卡）与 Hyper-V / WSL 的路由冲突**：
   * 即使开启了 Clash Verge 的 TUN 模式，若系统中存在 `vEthernet (WSL (Hyper-V firewall))`，控制台子进程发出的流量极易被 Hyper-V 旁路，无法真正进入 TUN 网卡。
3. **一次性临时端口与刷新陷阱**：
   * 临时端口在收到一次请求或进程重启后立刻销毁。如果用户在浏览器中点击刷新（Reload）旧页面，Windows 会立刻报错：`127.0.0.1 拒绝了我们的连接请求 (ERR_CONNECTION_REFUSED)`。

---

## 三、关键代码修复方案

在 [`server/acp/client.ts`](file:///d:/project/js/Electron/antigravity-acp/server/acp/client.ts) 中，为官方子进程显式注入了代理与旁路环境变量：

```typescript
const defaultProxy = "http://127.0.0.1:7897";
const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy || defaultProxy;
const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || defaultProxy;
const allProxy = process.env.ALL_PROXY || process.env.all_proxy || "socks5://127.0.0.1:7897";

const env = {
  ...process.env,
  HTTP_PROXY: httpProxy,
  HTTPS_PROXY: httpsProxy,
  http_proxy: httpProxy,
  https_proxy: httpsProxy,
  ALL_PROXY: allProxy,
  all_proxy: allProxy,
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
};

// 启动官方 agy_acp_server
this.proc = Bun.spawn([this.options.executablePath, ...args], {
  cwd: this.options.cwd,
  env,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
```

注入后，【阶段二】的 Token 换取立刻通过 Clash 代理顺畅连通，成功输出：
```text
[Official ACP Log] User is already onboarded with project ID: 'aicode-consumers'
[Official ACP Log] paidTier: {'id': 'g1-pro-tier', 'name': 'Google AI Pro'}
[Official ACP Log] recorded auth.type='oauth-personal' in 'C:\Users\zheye\.gemini\antigravity-acp\settings.json'.
```

---

## 四、Zed 编辑器是否可以直接共享使用？

### 答案是：**完全可以！而且极大地解决了 Zed 之前的登录难题！**

#### 1. 凭证全局持久化共享
* Google 官方的 `agy_acp_server.exe` 会将用户的登录状态、OAuth Token 以及已绑定的 Project ID 存储在系统的用户全局目录：
  `C:\Users\<用户名>\.gemini\antigravity-acp\settings.json`
* **Zed 自身调用的也是同一个二进制文件与同一份全局配置**。
* 既然我们已经在 AutumnFlow 中走通了完整的 OAuth Onboarding 并把凭证写盘，**当你在 Zed 中打开 Antigravity 插件时，它会自动识别到该配置，无需再次跳转浏览器进行脆弱的 OAuth 登录！**

#### 2. 在 Zed 中顺畅使用模型的关键建议（避坑提示）
虽然登录凭据已经保存在本地，但在 Zed 中向模型发问（Session Prompt）时，`agy_acp_server.exe` 仍然需要访问 Google 的推理接口。为了确保 Zed 中的子进程不会再次因网络直连超时，建议：

* **方式 1（推荐）**：在 Windows 系统用户环境变量中添加：
  * `HTTP_PROXY` = `http://127.0.0.1:7897`
  * `HTTPS_PROXY` = `http://127.0.0.1:7897`
  * `NO_PROXY` = `localhost,127.0.0.1,::1`
  添加后重启 Zed，Zed 及其生成的所有子进程都会自动走代理。
* **方式 2**：在 Zed 的 `settings.json` 中配置代理支持。

---

## 五、认证方式总结对比

1. **OAuth 个人账号（已激活）**：
   * 自动享受 **Google AI Pro**（或 Ultra）订阅配额与项目上下文支持；
   * 适合深度开发、依赖官方 Pro 模型的开发者。
2. **Gemini API Key（备用方案）**：
   * 前端已支持 `gemini-api-key`；
   * 无需任何网页重定向与 Onboarding 审核，零配置门槛。
