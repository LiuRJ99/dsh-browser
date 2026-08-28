# Changelog

本仓库的变更记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.4] - 2026-08-28

### Added

- **自动跟随当前标签页（autoFollowActiveTab）**：新增面板设置项，开启后切换标签页不再询问交接，浏览器操作自动跟随活动标签页；受控标签页关闭后，只要有活动标签页也会自动恢复绑定（`src/background/index.ts` 的 `automaticallyFollowActiveTab`、`src/background/tab-affinity.ts`、`src/panel/App.tsx`、`src/panel/strings.ts` 中英文文案）；配套测试 `tests/background-tab-affinity-auto-follow.spec.ts`、`tests/tab-affinity.spec.ts`。
- **DHS Desktop 固定端口自动发现**：桥地址自动探测列表新增 DSH Desktop 固定端口 `43189`（`8ae8b56 feat(extension): auto-discover DSH Desktop's fixed port 43189`，`src/panel/strings.ts` 中英文占位文案同步）。
- **`browser` 授权 skill**：bridge 插件在技能注册表存在时注册用户专属的 `browser` 授权 skill（`modelInvocable: false`，仅用户 `/browser` 手势可唤起，与 `dsh-tool-lazy-gate` 解锁信号配合），见 `packages/browser/bridge-browser/src/index.ts`。
- **工作期间可新建/切换会话**：面板在代理工作（working）状态下允许新建会话与切换会话，不再强制等待（`336a681 feat(panel): allow starting new session and switching sessions while agent is working`）；配套 `tests/panel-session-transition.spec.ts`。

### Changed

- **每会话标签页亲和（per-session tab affinity）**：后台为并发会话分别维护受控标签页映射并持久化，Worker 重启后恢复；审批取消仅作用于聚焦会话（`8a1604d`、`1570f47`、`0506e78`），`src/background/tab-affinity.ts`、`src/background/index.ts` 重构，配套 `tests/tab-affinity.spec.ts`、`tests/approval-coordinator.spec.ts`。
- **工具目标解析语义**：`resolveTarget` 对缺失会话的返回由 `lost` 调整为 `initial`，允许在解析阶段重新绑定（`src/background/tab-affinity.ts`）；工具调用前在 `autoFollowActiveTab` 开启时主动同步活动标签页（未提交工作区改动）。
- **面板设置项防挤压**：设置卡片不再被压缩（`c2c098e fix(panel): prevent settings cards from shrinking`、`86fb18d test(panel): guard settings section sizing`），`src/panel/styles.css` 与 `tests/panel-styles.spec.ts`。
- **授权契约加固**：桥接 `authorization.ts` 明确 moz-extension:// 起源不构成身份边界，非回环远端一律要求 bearer token（`src/background/authorization.ts`），配套 `tests/authorization.spec.ts`。
- **上传与工具通道**：`feat(browser): improve uploads and tab affinity` 合并后，桥接 `tools.ts` 新增上传/等待/表格/求值等 RPC 通道（`packages/browser/bridge-browser/src/tools.ts`），配套 `tests/tools.spec.ts`。

### Docs

- README（中英）同步自动跟随、端口自动发现与每会话亲和说明。

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
