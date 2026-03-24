# OpenClaw Panel

一个给 OpenClaw / Codex OAuth 多账号轮换场景用的本地面板与桌面 App（原名 OpenClaw Codex Account Panel）。

它现在已经不是一个只看账号列表的小工具，而是一个完整的本地运维面板，覆盖：

- Codex 多账号列表与轮换顺序
- 账号额度查看（5h / 1周）
- 软删除 / 恢复 / 彻底删除
- `default` 槽位的安全替补
- 按真实 Team / Plus 空间分组
- 每日调用记录、趋势图、分布图、数据透视

## 当前版本亮点

### 1. 账号管理

- 查看当前 Codex 账号列表、轮换顺序、`lastGood`
- 普通账号支持：
  - `移出轮换`
  - `恢复`
  - `彻底删除`
- `openai-codex:default`：
  - 不支持软删除
  - 支持彻底删除
  - 删除后自动使用轮换顺序第一位顶替
  - 没有候选账号时明确警告

### 2. 按真实空间分组

面板不再只按邮箱表面分组，而是优先根据账号内真实的：

- `chatgpt_account_id`
- `chatgpt_plan_type`

来识别实际空间，所以能正确区分：

- 哪几个号属于同一个 Team 空间
- 哪几个号属于 Plus

### 3. 每日调用分析面板

调用记录面板支持：

- 按天查看 Codex 实际调用
- 自动扫描历史归档 session，不只看当天
- 概览卡：调用次数 / tokens / 粗略成本 / 账号数 / 空间数 / 渠道数
- 近 14 天趋势图
- 分布图：
  - 按空间
  - 按渠道
  - 按账号
- 数据透视：
  - 账号
  - 空间
  - 渠道
- 最近调用明细

## 面板预览

### 账号与额度主面板

![OpenClaw Codex Panel preview](./docs/panel-preview-redacted-v3.png)

### 调用分析仪表盘（2026-03-24 更新，邮箱已打码）

![OpenClaw Codex Panel analytics preview](./docs/panel-preview-analytics-redacted-20260324.png)

## 目录结构

- `panel/server.mjs`：本地 HTTP 面板服务
- `desktop/`：Tauri 桌面壳
- `scripts/openclaw_codex_add_profile.mjs`：新增 Codex OAuth 账号的辅助脚本

## 目标用户

这个项目当前的目标用户是：**已经在本机安装并使用 OpenClaw 的用户**。

它不是“完全零配置”的独立新手版；更准确地说，它是 OpenClaw / Codex 多账号场景的本地可视化面板。

## 运行前提

- macOS（当前 Release 提供 Apple Silicon 包）
- 已安装并登录 OpenClaw
- 已存在 `~/.openclaw/agents/main/agent/auth-profiles.json`
- 已在 OpenClaw 中登录过至少 1 个 Codex 账号
- Node.js 20+
- Rust / Cargo（如果要构建桌面 App）

默认工作区路径：

- `OPENCLAW_WORKSPACE` 已设置时：使用该路径
- 否则默认：`~/.openclaw/workspace`

## 启动本地面板服务

```bash
node panel/server.mjs
```

默认地址：`http://127.0.0.1:7071`

可选环境变量：

```bash
export OPENCLAW_WORKSPACE="$HOME/.openclaw/workspace"
export CODEX_PANEL_PORT=7071
export CODEX_PANEL_USAGE_TIMEOUT_MS=15000
```

## 启动桌面 App

```bash
cd desktop
npm install
npm run tauri:dev
```

## 新增 Codex OAuth 账号

```bash
node scripts/openclaw_codex_add_profile.mjs
```

脚本会：

1. 调起 `openclaw models auth login --provider openai-codex`
2. 用独立浏览器配置目录完成 OAuth 登录
3. 把新账号固化为独立 profile
4. 自动插到轮换顺序最前面

## 关于发布内容

这个 GitHub 仓库默认只放：

- 源码
- 文档
- 构建配置

**不直接提交安装包（`.app` / `.dmg`）到源码仓库。**
安装包建议放到 GitHub Releases。

## 隐私说明

本仓库**不包含**任何个人账号数据、auth token、调用历史、缓存、日志或本机运行状态。
这些数据均保存在本机 `~/.openclaw/` 目录，不应提交到仓库。

## License

MIT

## 下载

- 如果你已经是 OpenClaw 用户，优先下载 Releases 里的 `.dmg` 安装包。
- 第一次启动前，请先确认本机 `openclaw`、`node` 和 Codex 登录数据都已就绪。
- 如果系统拦截未签名应用，请在“系统设置 → 隐私与安全性”里允许打开，或右键应用选择“打开”。
