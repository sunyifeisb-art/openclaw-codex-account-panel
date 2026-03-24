# Changelog

## 2026-03-24

### Added
- 账号软删除 / 恢复 / 彻底删除
- `openai-codex:default` 删除后的自动顶替逻辑
- 删除按钮二次确认交互
- 按真实 Team / Plus 空间分组
- 每日调用分析面板：
  - 历史归档 session 扫描
  - 近 14 天趋势
  - 按空间 / 渠道 / 账号分布图
  - 数据透视视图

### Fixed
- Tauri 桌面壳资源路径，修复应用打开即退出的问题
- 每日调用记录原先只显示空白的问题
- 旧 session / 新 session 历史读取不一致的问题

### Notes
- 源码仓库不提交 `.app` / `.dmg` 安装包
- 安装包建议通过 GitHub Releases 发布
