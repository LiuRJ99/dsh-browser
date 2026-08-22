# Changelog

本仓库的变更记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.3] - 2026-08-23

### Added

- **Firefox 扩展支持**：新增 Firefox MV3 构建（`manifest.firefox.json`、`vite.shared.ts` 双目标输出 `dist/` 与 `dist-firefox/`，`scripts/build.mjs --firefox`），含 `browser_specific_settings`（Gecko ID、`strict_min_version: 140`）与数据收集权限声明（`browsingActivity` 等），并配套 Firefox 构建契约测试（`tests/firefox-build.spec.ts`）。
- **调试器工具（Chrome）**：新增 `browser_screenshot`、`browser_download_wait`、`browser_network_capture`、`browser_list_tabs` 四个后台工具（`src/background/debugger-tools.ts`），经 `chrome.debugger`（Page/Network 域）与 `chrome.downloads`、`chrome.tabs` 驱动受控标签页；manifest 增加 `debugger`、`downloads` 权限；配套 `tests/debugger-tools.spec.ts`。
- **点击文本工具**：内容脚本新增按可见文本定位元素的 `browser_click_text` 动作（`src/content/actions.ts`），覆盖未进入编号清单的元素；配套 `tests/new-browser-tools.spec.ts`。
- **桥接新工具**：bridge 插件新增 `browser_click_text`、`browser_wait_for`、`browser_get_table`、`browser_eval`、`browser_screenshot` 等工具的 RPC 通道，新增 `screenshotDir` 配置（默认写入 dsh home 的 `browser-screenshots/`，见 `src/index.ts`、`src/tools.ts`）；测试同步覆盖（`tests/tools.spec.ts`、`tests/index.spec.ts`）。

### Changed

- **面板会话与端口修复**：面板在会话启动失败时正确释放失败态（`fix(panel): release failed session transitions`）；后台端口重连不再中断进行中的调用（`fix(panel): reconnect background ports without dropping calls`）；相关回归测试 `tests/panel-session-transition.spec.ts`、`tests/panel-api.spec.ts`。
- **Firefox 认证契约加固**：`authorization.ts` 与桥接 `server.ts` 明确 moz-extension:// 起源因包含按安装生成的 UUID、不构成身份边界，非回环远端一律要求 bearer token；`tests/authorization.spec.ts`、`tests/server.spec.ts` 同步更新。
- **构建产物**：`dist/` 与 `dist-firefox/` 独立输出，manifest 与本地化、图标复制逻辑收敛至 `vite.shared.ts`。

### Docs

- README（中英）补充 Firefox 安全安装与构建流程说明（`72bac74 docs(firefox)`）。

## [0.1.2] - 2026-08-21

### Added

- 多模态对话支持：宿主声明图片能力时，侧栏可发送 PNG/JPEG/WebP/GIF 附件，并渲染会话中的持久图片附件（`feat/dsh-0.1.1-multimodal`）。
- 延迟创建的新会话只在宿主确实挂载附件服务时声明图片限制。

### Changed

- 版本号自 0.1.1 提升（root / bridge / extension manifest 同步）。

## [0.1.1] - 2026-08-21

### Added

- 首次发布：token 认证的 WebSocket 桥接插件（`@yuxianglin/dsh-bridge-browser`）与 Chrome MV3 侧栏扩展（dsh-browser-extension），提供文本化浏览器快照与受控标签页操作工具。

[0.1.3]: https://github.com/YuxiangLin/dsh-browser/releases/tag/v0.1.3
[0.1.2]: https://github.com/YuxiangLin/dsh-browser/releases/tag/v0.1.2
[0.1.1]: https://github.com/YuxiangLin/dsh-browser/releases/tag/v0.1.1
