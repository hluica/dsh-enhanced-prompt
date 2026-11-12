# User Prompt Markdown（`@local/dsh-enhanced-prompt`）

最后实质性修改于Harness版本：0.2.2-rc.1

让 **DeepSeek Harness 的用户 prompt 气泡**走与模型回复完全相同的 Markdown 渲染管线。

用户 prompt 中的 GFM 表格、代码高亮、TeX 公式与块级结构都按与模型回复相同的规则渲染；`@文件` / `/技能` / `@会话` 引用仍保持为可点击 chip；在已发送的 prompt 中选中文本时，官方「引用文本」按钮照常出现，引用发送后显示为紧凑预览。

## 效果

| 特性 | 效果 |
| --- | --- |
| 文本渲染 | `MarkdownText`（与模型回复同一个组件） |
| `# 标题`、`- 列表`、`**粗体**` | 正常渲染 |
| 围栏代码块 | 语法高亮 + 复制按钮 |
| `@文件` / `/技能` / `@会话` 引用 chip | 仍为可点击 chip |
| 选中 prompt 文本 | 官方「引用文本」按钮照常出现，可把选区插入 composer |
| `> 引用` 行 | 渲染为官方 `QuotePreview` 紧凑预览；悬停显示全文 |
| 气泡宽度 | 与模型输出区等宽 |
| 复制按钮 | 复制**原始 Markdown 源文本**（同一份内容） |

## 工作原理

用户 prompt 的渲染由可组合的 Factory 与 keyed 槽位组成：

```
conversation.chat.node[user] → UserMessageNodeView
  → renderFactorySlot("conversation.chat.user.content", …) → UserContent
    → renderFactorySlot("conversation.user.text", …)       → UserText
      → renderSlot("conversation.user.text.node", { node, raw, interactive })
          key "text"  → PlainUserText → UserTextRun
          key "file" / "folder" / "session" / … → 引用 chip
          key "quote" → QuotedUserText → QuotePreview（0.2.2 起）
```

**内置解析器在 Markdown 解析前就按引用切开文本**，因此逐段渲染会破坏跨 chip 的块结构：列表项里出现 `@a.ts` 时，前半段自成一篇 `<ul>`、后半段自成一篇 `<p>`，chip 夹在两个块之间，前后各换行。这不是 CSS 能修的。

本插件采用**整条消息一篇文档**的渲染方式：

1. 接管 `conversation.chat.node` 的 `user` / `steering`；
2. 用 `uiConversation.userText.createEvaluator()`（与内置同一套规则）求出 `{id,start,end}` 节点；
3. 把每个非文本区间替换成私用区哨兵，拼成**一篇** Markdown 源；
4. `MarkdownText` 渲染一次；
5. 在渲染结果里把哨兵换回真正的 `ReferenceChip` 或 `QuotePreview`。

chip 于是落在 `<li><p>` 内部，列表、有序编号、代码围栏、`text-indent` 全部由**一次**解析决定；`> ` 行则由 0.2.2 的 `quote` 规则单独接管，见下。

0.2.2 的 `dsh-message-quotes` 会向同一个求值器注册 `quote` 规则：显式 `> ` 行变成带解码文本的 `quote` 节点。它也走同一条哨兵管线，最终渲染为官方 `QuotePreview`；引用前后的 `\n\n` 保留在 Markdown 源里，因此预览保持自己的块位置，不会合并两侧的块。

气泡本身带有 `data-text-interaction-source`，这是官方 Chat 选区层用来接纳「引用文本」操作的标记；原生 `UserContent` / `UserMessageBubble` 用的是同一个标记。插件只提供这个接入面，按钮、选区交互与 composer 插入仍由官方 `dsh-message-quotes` 负责。

附件仍由内置 `conversation.chat.user.content` Factory 绘制（传空文本时它只输出附件栏，图片走内置 `conversation.chat.user.images`），额外内容块与引用摘要由本插件补齐。

### 关键约束

1. **priority 必须低于内置的 0。** keyed cell 渲染 **priority 最小**的存活条目；同 key 同 priority 会**直接抛错**而不是覆盖。本插件用 `-1`，测试里有显式断言。
2. **哨兵替换是命令式的。** `MarkdownText` 的 props 只有 `{text, streaming, labels, fileMentions, pathImages, variant}`，**没有 children 插槽**，无法在 React 树里注入 chip。因此 Markdown 输出挂在一个由本插件独占的 `react-dom` root 里（宿主 `<div class="dep-md-host">` 从不交给 React 管 children），在**该 root 提交之后**的 `useLayoutEffect` 里替换哨兵，再用 `createPortal` 把每个 chip 或 quote preview 渲染进占位 `span`。
3. **样式用本插件自己的 `dep-` 类名**；唯一按 CSS Module **稳定局部名**匹配的是附件栏的「加宽」规则（`[class*="_userStack"]`，不是每次构建都会变的哈希）。官方消息气泡改用其显式标记 `[data-message-bubble]`，不再用 `_bubble` 类名子串——primitives 的 Tooltip 气泡同样是 `_bubble_*`，且是 `position:fixed`，被加宽规则误中会撑到 `max-width`。即使失配，也只是宽度退回原样，不影响渲染。

## 没有开关

按设计，本插件**不提供设置项**，也不在「设置 → 通用」里增加任何行：

- **启用即生效**，一经运行就始终重写 prompt 样式；
- **停用方式**＝在插件页禁用（或卸载）本插件。Client 半的注册与样式都挂在自己的 fiber 上，卸载时一并释放，内置渲染器立刻接管回来。

## 安装

插件需要接入 profile 才能在应用内生效（两步，均为既有机制）：

1. `~/.dsh/profiles/desktop/package.json`：
   - `dependencies` 增加 `"@local/dsh-enhanced-prompt": "link:/Users/hanluica/Documents/deepseek-harness/local-plugins/dsh-enhanced-prompt"`
   - `dsh.profile.bundles` 数组加入 `"@local/dsh-enhanced-prompt"`
2. 在 profile 目录执行 `pnpm install`。

装载条目由本插件自带的 `cordis.patch.yml` 的 `insert` 提供，bundle 机制会自动叠加，无需手工编辑 profile patch。

> **必须重启 Host**：profile 的 bundle 列表在 Host 启动时合成，无法在进程内重试。重启后再刷新 GUI。

## 依赖与构建

插件当前面向 DSH `0.2.2-rc.1`：`package.json` 的 `peerDependencies["@deepseek-ai/dsh"]` 为 `^0.2.2-rc.1`，`dsh.client.inject` 同时声明 `@deepseek-ai/dsh-client-ui-conversation` 与 `@deepseek-ai/dsh-client-ui-primitives`。

Host 半**零导入**：`index.js` 只导出 `ENTRY_ID` 和一个空的 `apply()`，存在的意义是给 Loader 条目一个可挂载的模块。这是刻意的设计——Host 半一旦 import 了 profile 不提供的包，插件就会变成「已启用但未运行」（`fiberPhase: null`），而且 Node 会**永久缓存**这次导入失败，只能重启重试。

所以本插件**不携带 `node_modules/`，也没有依赖锁**：没有依赖就没有可锁的东西，而一棵不存在的树不可能藏着断链、过期版本或没人声明的包。`npm run build` 在依赖声明为空时会**删除**任何出现的 `node_modules/`，`verify` 也会把它判为失败。

### 命令

| 命令             | 作用                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify` | 一个命令回答「这插件现在健康吗」：真实文件不变量、清单契约、`node --check`、**Host 半零导入 + `ENTRY_ID`**，以及下面的 `npm test` |
| `npm test`       | `test/lifecycle.test.mjs`：Client 半的生命周期与渲染回归（60 项检查，不需要应用在场）                                             |
| `npm run build`  | 清掉 macOS 边角文件与任何 `node_modules/`，然后跑 `verify`——本插件没有可物化的依赖                                                |
| `npm run clean`  | 删除 `node_modules/`（若存在）与 `.cache/`                                                                                        |

`verify` 把 `npm test` 当作「行为测试」一并跑掉：它不重复实现测试，只跑 `package.json` 里声明的那条命令。

### `verify` 检查什么

- 整个插件目录**没有符号连接、没有 Finder 替身（按 `book` 魔术字识别）、没有 `.DS_Store`/`._*`**。
- 清单契约：`exports` 的每个目标、`dsh.bundle.patch`、`dsh.client`、`locale/en.json` 锚点、图标大小（≤256 KiB）、`files[]`；patch 里的 `id` 必须等于 Host 半导出的 `ENTRY_ID`（改名会让 profile 挂载不到，也等于换了身份）。
- `index.js` 与 `client.js` 能被 `node --check` 解析。
- **Host 半在一个全新进程里真的能导入**，而且 `index.js` 源码里**没有任何 `import`**——这一条用源码断言，不靠「导入成功」去推断，因为后者在依赖缺失时可能只是因为恰好没走到那条语句。
- 没有依赖声明时：`node_modules/` 必须不存在、也不该出现锁文件。

### 构建系统与它的参考副本

本插件的 `scripts/` 是一套完整构建系统（依赖物化 + 不变量检查），它跟着插件走，所以这个目录单独复制出去仍能构建与自检；整体说明见工作区根目录的 [`BUILD-SYSTEM.md`](../BUILD-SYSTEM.md)。

其中除 `host-contract.mjs` 之外的 5 个文件（`build.mjs`、`verify.mjs`、`lib/fsx.mjs`、`lib/tar.mjs`、`lib/probe-runner.mjs`）是根目录 [`build-system/scripts/`](../build-system/scripts) 这份**参考副本**的逐字节副本：改构建系统要改参考副本，再 `node build-system/sync.mjs` 同步下来。`verify` 每次都核对这件事，不一致会指名并给出那句命令。

`scripts/host-contract.mjs` 是**本插件自己的**（`sync` 永不覆盖）：它断言 `ENTRY_ID`、`apply()` 可被调用，以及——本插件最要紧的一条——**`index.js` 源码里没有任何 `import`**。最后这条刻意用源码断言而非「导入成功」反推：依赖缺失时的导入失败会被 Node 永久缓存，只有源码层面的「零导入」才是这个插件真正承诺的东西。`verify` 会把它们的每一条连同通用不变量一起打印。

## 已知行为与限制

这些都是设计取舍或平台现状，不是缺陷：

- **单个换行会被合并。** 这是标准 Markdown 语义（软换行 = 空格），与模型回复的表现一致——因为按约定使用了 `body` 变体，与回复"同权"。需要强制换行时用空行分段，或行尾加两个空格。
- **只对落定消息生效。** 提交瞬间的乐观回显气泡不经过 chat node，仍由内置组件绘制，因此到落定那一刻才切换为 Markdown。
- **队列预览与 `/goal` 命令气泡不生效。** 它们走共享的 `conversation.user.text`，本插件不接管那条路径。
- **引用预览按块位置显示。** 原生纯文本流会把引用前后的 `\n\n` 显示成空格；本插件保留 Markdown 块边界，因此 `QuotePreview` 独占一个段落，不会合并引用两侧的块。这是为了不让引用破坏列表、表格与代码围栏等结构。
- **代码围栏内的 `> …` 仍降级为原文。** 引用规则在 Markdown 之前运行，可能把围栏里的 `>` 行识别成引用；哨兵落在 `pre`/`code` 内时会放回原始 token，因此预览不出现但文本不丢，与 chip 的围栏降级同源。
- **「引用文本」按钮由官方插件拥有。** 本插件只把增强气泡标记为 `data-text-interaction-source`；选区判断、按钮文案、Session 可写限制与 composer 插入都由 `dsh-message-quotes` 负责，插件没有自己的引用实现。
- **chip 在代码围栏内降级为原文。** 解析器不知道围栏边界，可能把围栏里的 `@x` 当成引用；替换时若哨兵落在 `pre`/`code` 内，会放回原始 token 而不是插入一个块级 chip。
- **`/skill` chip 目前不可点击。** chat node owner props 不提供 `openSkill`，因此 skill chip 渲染为不可交互的样式。文件 chip 仍可点击打开。
- **`@session` / `folder` / `command` chip 保持非交互**——与内置渲染器一致。
- **升级风险。** 本插件接管整个 chat node 渲染，`MarkdownText` 的 props、`conversation.user.text` 的节点形状、或 `uiConversation` 服务一旦变动都会影响它。`uiConversation` 未出现在公开服务目录里，属于未编目 API。渲染抛错时槽位错误边界会**静默 abdicate**（只在浏览器控制台留一行 `slot entry crashed in ...`），界面回落到内置纯文本——遇到"插件已启用但 prompt 没变化"，先看控制台。
- **与「用户 CSS」插件叠加是预期行为。** 若那边写了 `div[class*="markdown"] > p { … }` 之类的规则，会命中用户气泡内的 Markdown 容器——这正是 `text-indent` 能生效的前提。需要区分时可改用本插件的 `.dep-bubble` 类名。

## 文件

```
dsh-enhanced-prompt/
├── package.json        # exports["./client"] + dsh.bundle + dsh.client + 构建脚本
├── cordis.patch.yml    # 装载条目
├── index.js            # Host 半：无状态、无设置、零导入
├── client.js           # Client 半：全部功能
├── icon.svg
├── locale/{zh,en}.json # 插件页显示名
├── scripts/            # 构建与不变量检查（共享文件是根目录 build-system/ 参考副本的逐字节副本）
├── test/lifecycle.test.mjs  # 无需应用的逻辑回归
├── README.md
└── FEASIBILITY@*.md    # 按 DSH 版本归档的可行性记录
```

**没有 `node_modules/`，也没有 `deps.lock.json`**——见「[依赖与构建](#依赖与构建)」：Host 半零导入，所以这里不该有依赖树。

## 静态验证状态

一条命令跑完全部检查（真实文件不变量 + 清单契约 + Host 半导入 + 行为测试）：

```bash
npm run verify
```

其中行为测试是 `npm test`（也就是 `node test/lifecycle.test.mjs`），在 React / DOM / Cordis 桩下跑真实 `client.js`，**60 项检查全部通过**，覆盖：

- 工厂契约与 `inject` 列表、样式标签归属、`user` / `steering` 两个 cell 以 `priority: -1` 注册；
- **组合逻辑**：列表项里的 chip 不切断文档（`- 检查 @a.ts 的实现` 组成单一 Markdown 源）、引用节点保留 `\n\n` 块边界、无引用时原样、多个 chip、求值器抛错时回落、重叠匹配跳过；
- **chip 映射**：file/folder/session/skill/command/secret 各自的外观与激活，`quote` 映射到 `QuotePreview` 且传入解码文本、未知类型回落原文，缺少 opener 时不加交互；
- **哨兵替换**：文本/chip/文本三段、`pre`/`code` 内回落原文、未知哨兵保留、纯文本直通；
- 样式表关键规则（含气泡加宽只匹配 `data-message-bubble`、不再使用 `_bubble` 类名子串），以及当前 API 契约的回归守卫（包括气泡的 `data-text-interaction-source` 与 `QuotePreview` 来源）。

`mountMarkdown` 依赖真实浏览器（`createRoot` / `flushSync` / `TreeWalker`），不在 Node 桩里执行。

已接入 `~/.dsh/profiles/desktop`（link 依赖 + bundles 条目），`@local/dsh-enhanced-prompt`、`/client`、`/locale/*.json` 均已验证可解析。

`verify` 覆盖不到的那几项只能靠眼睛：重启应用后发一条**列表项内含文件引用**的 prompt，确认 chip 前后不换行、缩进只出现一次、chip 可点击打开文件；再在一条已发送的 prompt 中选中文本，确认「引用文本」按钮出现，点击后引用进入 composer，发送后显示为紧凑预览且悬停可见全文。

