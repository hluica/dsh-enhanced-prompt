# 合并外部 PR #1–#3

## 目的与范围

- 目的：审查远程仓库收到的 3 个外部 PR，确认其内容与当前运行中的 DSH 一致，合并已验证的改动。
- 范围：`client.js` 的渲染健壮性、secret chip 的 tooltip、`README.md` 的三处事实修正。
- 边界：保留 PR 作者的提交；维护者只修正与运行版本不符的文档，合并后的补测试与安全修复记录在下一个顶层章节。
- 合并后的插件版本：`3.1.1` → `3.1.2`。

## 可行性

- 运行版本为 `@deepseek-ai/dsh` `0.2.2-rc.3`（`app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json`）。
- 三个 PR 均从 `main` 的 `91a9e36` 切出，各 1 个提交；GitHub 报告 `MERGEABLE` / `CLEAN`，仓库没有配置 PR 检查。
- `conversation.chat.node` 的 owner props 由 `ChatNodeOwnerProps` 给出，只含 `openFile`，不含 `openSkill` / `openSession`（`dsh-client-ui-chat/src/client/contract/slots.ts:ChatNodeOwnerProps`、`ChatNodeSeat.tsx:owner`）。
- `conversation.user.text.node` 的 `secret` 渲染器在运行中的 Client 里是 active 的；该节点由 `dsh-client-ui-secret-mask` 通过 `uiConversation.userText.register()` 注册的凭据扫描规则产生，`data` 为 `{ masked }`。
- `UserTextRegistry.createEvaluator()` 每次调用读取当前规则（`dsh-client-ui-conversation/src/client/conversation/user-text-registry.ts:createEvaluator`），所以插件的 evaluator 能拿到 secret 规则。
- `writeClipboard` 是 `async`；对 `navigator.clipboard.writeText` 的拒绝在内部 `catch` 后返回 `false`（安装包前端 bundle 内的实现；上游 `packages/client/ui-primitives/src/clipboard.ts` 同义）。PR #2 描述的三种触发条件不会 reject。

## 核心进路

- PR #1：`restoreChips` 保留 React 拥有的文本节点（`textNode.nodeValue = ''` + `parent.insertBefore(fragment, textNode)`），并对普通文本切片中的字面哨兵做 `\uE003` 转义；原样合并。
- PR #2：合并 secret tooltip 的掩码修复。`.catch` 保留作为极端兜底（例如 `document.body` 缺失时 `appendChild` 抛出），但审查意见指出其原始理由不成立。
- PR #3：合并前由维护者在 `docs/readme-accuracy` 上追加 `c2776c5`，把 secret 说明改为凭据扫描规则与 `{ masked }`，并区分 Host 的 `AuthorizationPrompt`。
- 合并顺序 `#1 → #2 → #3`；在隔离 worktree 中三者合并无冲突。

## 问题与解决办法

- PR #1 所述“卸载时抛 `NotFoundError`”在 React 的删除路径上属实，但 `mountMarkdown` 的 disposer 已用 try/catch 包住 `root.unmount()`，异常被吞掉；实际影响是卸载中断与残留 DOM，不是用户可见崩溃。保留修复，按健壮性改进处理。
- PR #1 把 `useLayoutEffect` 依赖从 `[]` 改为 `[chips, wiring]`；在当前“每次 composition 都重建 root”的设计下不会触发重跑，等价于 `[]`，不阻塞合并。
- PR #2 的 ④ 前提不成立：所列触发条件返回 `false`，且 `.then` 在 `!ok` 时已复位 `copyPending`。保留的 `.catch` 无害，已在 PR 评论中说明。
- PR #3 的 ② 把 Host 鉴权提示 `{ message, placeholder }` 与用户文本节点 `{ masked }` 混淆；仓库测试 fixture（`chipOf('secret', { masked: 'abc' }, 'sk-1')`）也表明 secret 不是“默认不触发”的防御性占位。已改写后合并。
- PR #3 的 ① / ③ 正确：当前只有 `@文件` 接线可点击；`client.js` 中没有 `flushSync`。

## 验证与验收

- 每个 PR 分支单独 `npm test`：通过；合并树 `npm run verify`：全绿。
- 合并后的主分支补充测试与 secret 的代码块回落修复（见下一节），最终 `npm test` 为 64 项。
- 运行中的 Client 通过 Inspect 确认 `conversation.chat.node` 的 `user` / `steering` 以 `priority: -1` 生效，`conversation.user.text.node` 的 `secret` 渲染器 active。

## 参考坐标

- PR 提交：`3f38fba`（#1）、`6d59d25`（#2）、`aa9cf7d`（#3）；维护者修正：`c2776c5`。
- 合并提交：`5a3ae8f`、`cc9e2b6`、`20e3a49`。
- 源码证据：`dsh-client-ui-chat/src/client/contract/slots.ts`、`dsh-client-ui-chat/src/client/chat/ChatNodeSeat.tsx`、`dsh-client-ui-conversation/src/client/conversation/user-text-registry.ts`、`dsh-client-ui-secret-mask/src/client/index.ts`、`dsh-client-ui-secret-mask/src/client/secret-rule.ts`、`dsh-authorization/src/types.ts`。

# secret 在代码块内的回落泄露

## 目的与范围

- 目的：修复用户 prompt 中的密钥落在行内代码或围栏代码时，`restoreChips` 的 opaque 回落把 `chip.raw` 写回气泡、绕过 secret-mask 的问题。
- 范围：`client.js:splitSentinelText` 的 opaque 分支、`test/lifecycle.test.mjs`、README 的对应说明。
- 边界：不改变 secret 在普通文本中的圆点外观，也不改变「复制按钮复制用户原文」的既有语义。

## 可行性

- `splitSentinelText(value, byKey, wiring, opaque)` 在 `opaque === true` 时对每个 chip 使用 `chip.raw`；`restoreChips` 用 `parent.closest('pre, code')` 判定 opaque。
- secret 节点的 `data.masked` 由 `dsh-client-ui-secret-mask` 的 `CredentialScanner.match()` 生成，保留换行结构，可直接作为代码块内的显示文本。
- chip 对象同时携带 `id`、`data`、`raw`，不需要改动 `composeMessage` 或 `uiConversation` 契约。

## 核心进路

- 新增常量 `SECRET_MASK`，secret chip 的可见文本与 `title` 共用它。
- opaque 分支改为：`chip.id === 'secret' ? (chip.data?.masked ?? SECRET_MASK) : chip.raw`。
- 补测试：secret 的 opaque 回落等于 `data.masked`；secret 的 tooltip 不等于 `raw`；字面哨兵被转义。

## 问题与解决办法

- 症状：行内代码或围栏代码中的密钥在 prompt 气泡里显示原文。
- 根因：secret 节点先被替换成哨兵，渲染后哨兵落在 `pre` / `code` 内；该分支按普通 chip 的规则回落 `raw`，而 secret 的 `raw` 就是凭据本身。
- 修法：secret 的 opaque 回落改用 `data.masked`；缺失时用固定 `SECRET_MASK`。
- 注意：这只影响显示；复制按钮仍复制原始 Markdown 源文本，符合既有语义。

## 验证与验收

- `npm test`：64 项全通过。新增 4 项覆盖字面哨兵转义（2）、secret tooltip（1）、secret 的 opaque 回落（1）。
- `npm run verify`：全绿。
- 人工：在已发送 prompt 中用行内代码与围栏代码各写一个形如密钥的字符串，气泡内应显示掩码而非原文；普通文本中的 secret 仍显示六个圆点，悬停不泄露。

## 参考坐标

- `client.js:splitSentinelText`、`client.js:chipElement` 的 `secret` 分支、`client.js:SECRET_MASK`。
- `dsh-client-ui-secret-mask/src/client/credential-scanner.ts:CredentialScanner.match`。
