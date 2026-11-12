# User Prompt 增强插件 —— 可行性与核心进路报告

- 目标插件：`@local/dsh-enhanced-prompt`，目录 `local-plugins/dsh-enhanced-prompt/`
- 目标：改进 DeepSeek Harness（下称 DSH）**用户 prompt 区域**的显示效果，核心是**是否将其中的文本按 Markdown 格式解析渲染**
- 报告日期：2026-10-10
- 探究对象版本：DSH `0.2.0-rc.2`（`app.asar → dsh/package.json`）
- **结论：可行，且存在一条官方明确认可、与 React 生命周期完全契合的进路——以 `priority: -1` 遮蔽 `conversation.chat.node` 的 `user` 键，并在自绘气泡内复用内置的 `MarkdownText`。**

> 本轮只做可行性与进路探究，**未创建任何插件文件**。`dsh-enhanced-prompt/` 在本次之前为空目录，现在只新增本报告。

---

> **后续更新（实现阶段）**：按用户澄清的决策完成实现后，进路与本报告的推荐方案一致，差异如下。
>
> | 决策点 | 结论 | 对实现的影响 |
> | --- | --- | --- |
> | 1 开关粒度 / 默认状态 | **不设开关**，启用即生效，停用＝禁用插件 | 删去设置行与 Host 配置；开关退化为"注册 vs 注销"，Host 半因此**零状态、零导入**（不再需要 `@deepseek-ai/schemastery`，也避开了「已启用但 `fiberPhase: null`」的坑） |
> | 2 引用 chip | **策略 1**（切分原文本，chip 之间渲染，chip 原样插入） | 见下方「实现简化」；`priority: -1` 这一关键点被自动化测试锁定 |
> | 3 渲染样式 | `body`（与回复同权） | 无 chip 时整条消息是一篇完整 Markdown 文档 |
> | 4 复制内容 | 原始 Markdown 源文本 | `contentParts(content).text` 本身就是作者原文，直接复用 |
> | 5 上游特性请求 | 不发起 | — |
> | 附加：气泡宽度 | 与模型输出区等宽，保留靠右 | `.dep-stack{width:100%}` + `.dep-bubble{width:100%}`，恰好等于 `--dsh-chat-content-width` 内容列 |
>
> **实现简化（优于本报告的预估）**：本报告 §6.5 认为策略 1 需要「自己复算 range」。实际读全 `projectUserText` 后发现不必——它的 `pushPlain` 把**源文本切片本身**作为纯文本片段的子节点，因此只要把纯文本片段替换成 `<MarkdownText>`、chip 原样保留（仅补 key）即可，**零引用语法重复实现**。
>
> **新增约束（测试锁定）**：`steering` 与 `user` 一并接管（内置实现里二者共用同一组件）；`priority` 必须为负，`test/lifecycle.test.mjs` 对此有显式断言。回显气泡不经过槽位这一缺口**仍然存在**（本报告 §1、§8 已记录），一期未处理。

---

## 1. 结论摘要

| 问题                             | 结论                                                                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户 prompt 现在怎么显示？       | 按**纯文本**渲染：字符串经 `projectUserText()` 切成「纯文本 run + `@文件`/`/技能`/`@会话` 引用 chip」，塞进 `.bubble`，其 CSS 为 `white-space:pre-wrap`。**没有任何 Markdown 解析**                                               |
| 是否预留了可扩展性？             | **预留了，而且是"明示可替换"级别的**。用户消息走 keyed 槽位 `conversation.chat.node`（键 = 节点种类 `user`），槽位目录原文写着 *"Registering an already-occupied key replaces that occupant."*，`replaceRisk: shadows-shipped-ui` |
| 遮蔽要怎么写？                   | **必须换 priority**。同 key 同 priority 再注册会**抛错**；遮蔽规则是 **priority 最小者渲染**，内置注册用的是默认 `0`，所以我们要用 `priority: -1`                                                                                 |
| 模型回复的 Markdown 组件是什么？ | `MarkdownText`，来自 `@deepseek-ai/dsh-client-ui-primitives`（纯 React、零 Cordis、平台种子模块）                                                                                                                                 |
| 能复用到用户 prompt 上吗？       | **能，且是直接 require 调用**，不需要拷贝源码。该包同时导出了自绘气泡所需的全部零件（`projectUserText`、`FileTypeIcon`、`JsonBlock`、`Tooltip`、`writeClipboard` 等）                                                             |
| 主要代价                         | 替换 keyed 渲染器 = **接管整个用户气泡的绘制**：附件栏、复制按钮 + 时间戳、引用摘要、额外块都要自己重画（零件都能从 primitives 拿，唯二私有工具需自写约 20 行）                                                                   |
| 主要已知缺口                     | **乐观回显气泡不经过槽位**（`ChatNodeList` 直接构造，`ui-chat/lib/client.js:5109`），因此「提交瞬间 → 落定」这段窗口仍是纯文本，含 Markdown 的 prompt 会有一次重排                                                                |

---

## 2. 探究方法与证据来源

全部结论基于**运行时自省 + 本机发行包源码逐行核对**，未使用猜测：

1. **运行时自省**：`cordis_inspect_list` / `cordis_inspect_query` 查询 Client 端 `Slots`（活槽位树 + 占用者 + 目录自述）、`Service`（`slots` / `locale` 契约）、`Theme`（令牌）。
2. **发行包源码**：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`。该 asar 有 12 973 个条目；本次写了一个最小 asar 读取器（`/tmp/dsh-asar/asar.mjs`，按 pickle 头 + JSON 目录定位数据段），直接按路径读取与正则检索，**未解包、未改动任何文件**。
3. **既有同构插件**：`local-plugins/dsh-font-settings/`（已在用）与 `local-plugins/dsh-custom-css/`（其 `FEASIBILITY@0.2.0-rc.2.md` 已系统记录客户端插件装载/样式归属/配置热更新链路）。

> 说明：发行包内 `lib/types/**/*.d.ts` 已被裁剪，类型信息来自 bundle 内的 JSDoc 注释、运行时报错文案，以及 `cordis_inspect` 从活体槽位注册表反推出的类型声明。凡是只靠类型才能确定的地方，本报告均已注明。

---

## 3. 用户 prompt 区域当前如何显示（源码级结论）

### 3.1 渲染链路

```
Host 投影（ChatNode<'user'> 数据）
  ↓
Client: @deepseek-ai/dsh-client-ui-chat
  ChatView → ChatNodeSeat（包装 div，挂 data-chat-* 锚点）
      → renderSlot("conversation.chat.node", owner, { entryKey: node.kind, ... })
          ↓ keyed 槽位按 entryKey 派发；user → 内置 UserMessageNodeView
              → UserStyleBubble
                  → contentParts(node.data.content)   // 拆 text / attachments / rest
                  → projectUserText(text, …)          // 纯文本 run + 引用 chip
```

关键坐标（`dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js`）：

| 行   | 内容                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1770 | `children: renderSlot("conversation.chat.node", routedOwner, { entryKey: routedNode.kind, hookContext, fallback: <JsonBlock/> })`                                              |
| 1446 | `const UserMessageNodeView = react.memo(function UserMessageNodeView({ node, renderMessageImages, openFile, openSkill, t })`                                                   |
| 1332 | `function UserStyleBubble({ content, renderMessageImages, actions, pending = false, echo = false, referenceLabels = [], skillNames = [], previewAttachments, references, t })` |
| 1193 | `function contentParts(content)`                                                                                                                                               |
| 214  | `css$17`：`.IzP3Va_bubble{…white-space:pre-wrap;word-break:break-word;padding:10px 16px}`                                                                                      |
| 1117 | `function MessageIconActions({ text, time, clock, onBranch, …, t })` —— 复制按钮 + 时间戳                                                                                      |
| 5363 | `const NS = "chat"`（ui-chat 的 locale 命名空间）                                                                                                                              |

### 3.2 "纯文本"是源码事实，不是推测

三条独立证据互相印证：

1. **文本投影函数**：`projectUserText`（`dsh-client-ui-primitives/lib/index.js:6700`）的职责是"把已发出的文本切成行内纯文本片段与引用 chip"（原文：*Split one sent text into inline plain runs and reference chips*）。它只识别三类 token：`@[label](dsh-session:…)` 会话、`@"路径"` / `@路径`、`/技能名`。**不经过任何 Markdown 语法**。
2. **气泡 CSS**：`white-space:pre-wrap` —— 换行与空格原样保留，这正是"纯文本"的排版特征；若已 Markdown 化，会由 Markdown 容器接管排版。
3. **没有开关**：ui-chat 的 Config 只有两个字段 —— `transcriptView`（`client.js:11913`）与 `performanceUsage`（`client.js:11943`）。README 第 61 行只描述这两项。**内置不存在"用户消息按 Markdown 渲染"的配置**，所以这是一个真正的新能力，只能由插件提供。

### 3.3 数据结构（自绘时需要原样消费）

`node.data`（`ChatNode<'user'>`）实际被用到的字段：`content`（内容块数组）、`time`、`referenceLabels`、`skillNames`。

`contentParts(content)` 的分派规则（`client.js:1193-1213`）：

```js
const texts = [], attachments = [], rest = [];
for (const block of content) {
  const b = block;
  if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
  else if (b.type === "image" && b.attachment !== void 0) attachments.push({ type: "image", image: { attachment: b.attachment } });
  else if (b.type === "file"  && b.attachment !== void 0) attachments.push({ type: "file",  file:  b.attachment });
  else rest.push(block);
}
return { text: texts.join(""), attachments, rest };
```

`UserStyleBubble` 随后把 `rest` 逐块渲染成 `JsonBlock`（标签 `message.extraBlock`），把 `referenceLabels` 渲染成一行 `referenceSummary`。

### 3.4 两个重要的"边界"

- **`steering` 复用同一个组件**：`registerChatNodeRenderers`（`client.js:6778`）把 `key:"user"` 与 `key:"steering"` 都指向 `UserMessageNodeView`。只改 `user` 会造成两者外观不一致。
- **乐观回显不经过槽位**：`ChatNodeList`（`client.js:5090`）里 `pendingRows` 是**直接构造** `PendingSubmissionBubble` / `PendingSteeringBubble` 的，与槽位渲染的行并列。README 第 81 行原文：*Durable inputs replace their matching echoes in the same render.* —— 也就是说提交后会经历 **纯文本回显 → Markdown 落定** 的一次替换。

---

## 4. 预留的可扩展性（本轮最关键的发现）

### 4.1 用户消息所在槽位是 keyed，且**明示可被替换**

`conversation.chat.node` 的活体目录（`cordis_inspect_query` → Client `Slots.listSubTree`，root 指定该槽位）原文：

> purpose: `Final Chat node renderer, keyed by ChatNodeKind. The component receives the typed node, shared Chat actions, and Turn-data hook. **Reusing a key replaces that node renderer**; a kind with no occupant renders no row.`
>
> registration.key: `Your cell key: the entry renders where the owner dispatches this exact key. **Registering an already-occupied key replaces that occupant.**`
>
> replaceRisk: `shadows-shipped-ui`

已占用的键共 19 个，含 `user`、`steering`。

槽位声明处（`ui-chat/lib/client.js:12398`）：

```js
children: {
  "conversation.chat.node": { kind: "keyed", scope: "session", inject: CHAT_NODE_INJECT },
  "conversation.message.images": { kind: "single", scope: "session" }
}
```

### 4.2 遮蔽的**精确**语义：必须换 priority（这是最容易踩空的一点）

`@deepseek-ai/dsh-client-ui-slots/lib/index.js`：

```js
// 165-185：注册冲突检查
const priority = options.priority ?? 0;
const occupantHint = (occupant) =>
  `at priority ${priority}${occupant.registrant !== undefined ? ` (registered by ${occupant.registrant})` : ""}` +
  ` — register at a different priority to shadow it (lowest renders)`;
case "keyed": {
  if (options.key === undefined) throw new Error(`keyed slot "${options.name}" requires options.key`);
  const occupant = rec.entries.find((e) => e.options.key === options.key && (e.options.priority ?? 0) === priority);
  if (occupant) throw new Error(`keyed slot "${options.name}" already has an entry for key "${options.key}" ${occupantHint(occupant)}`);
  break;
}
```

```js
// 268-290：取每个 cell 的赢家
* Project a key's entries to its shadowing winners: the first live (non-abdicated) entry
* of each cell **in priority order** — … keyed: one cell per `key` …
entriesOfSlot(key) {
  …
  for (const entry of rec.entries) {          // rec.entries 已按 priority 升序排序（221 行）
    if (this.abdicated.has(entry)) continue;
    const cell = kind === "keyed" ? entry.options.key : …;
    if (seenCells.has(cell)) continue;
    seenCells.add(cell);
    heads.push(entry);
  }
}
```

由此得出两条硬结论：

1. **同 key 同 priority 直接抛错**，不是"后注册者胜"。若照字面理解"reusing a key replaces"而写 `priority` 缺省（0），插件会在注册瞬间抛 `keyed slot "conversation.chat.node" already has an entry for key "user" at priority 0 (registered by mf) — register at a different priority to shadow it (lowest renders)`。
2. **渲染的是 priority 最小者**（`lowest renders`）。内置 `ctx.slots.register({ name, key:"user", locale: NS })` 未传 priority → `0`。**所以我们要用 `priority: -1`。**

`priority` 位于公开的条目选项里（`StoredEntry.options` 联合会话返回 `{ key?, id?, order?, label?, priority? }`），是实现层明确支持的字段，不是内部技巧。

### 4.3 被遮蔽后我们的组件能拿到什么

`ChatNodeSeat` 组装的 owner（`ui-chat/lib/client.js:1727-1746`）：

```js
const owner = react.useMemo(() => node === undefined ? null : {
  ...(groupPart === undefined ? {} : { groupPart }),
  cwd, openFile, openSkill, inspectCall, forkAt,
  loadImage, renderMessageImages, fileMentions, turnProcess
}, [...]);
…
const routedOwner = { ...owner, node: routedNode };
```

槽位自身注入的 hooks（`ui-chat/lib/client.js:12251`）：

```js
const CHAT_NODE_INJECT = { hooks: {
  turnData: (_standard, { turnData }) => function useTurnData(key) { return useTurnDataValue(turnData, key); },
  disclosure: (_standard, { disclosureReset }) => bindDisclosure(disclosureReset)
} };
```

外加标准 session props 与（若我们声明 `locale`）`t`。

**重要**：包裹用的 `<div className="…flowItem" data-chat-anchor-key data-chat-flow-key data-chat-paging-anchor data-chat-node-key data-chat-group-part data-chat-flow-kind data-chat-turn …>` 由 `ChatView` 生成，**在我们的组件之外**（`client.js:1763-1772`）。所以替换渲染器**不会**破坏滚动锚点、历史前插锚定、轮次导航与 paging anchor。

### 4.4 其余可用扩展面

| 接口                                                        | 用途                       | 证据                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.general.item`（list）                             | 增加一行设置（我们的开关） | 现有占用者与 order：appearance 10 → font-size 11 → font-sans 11.1 → font-mono 11.2 → custom-css 11.5 → **transcript-view 12** → developer-tools 15 → shortcuts 16 → link-opening 17 → composer-enter 20 → performance-usage 30 → current-version 100。建议取 **12.5**（紧邻消息显示类设置） |
| `ctx.locale.register(ns, {zh, en})` / `ctx.locale.bind(ns)` | 自带双语文案               | `locale` 服务契约；`dsh-custom-css/client.js:401` 实测用法                                                                                                                                                                                                                                  |
| `ctx.configForms.get(ns)`                                   | 读写本插件配置、订阅变更   | `dsh-custom-css/client.js:403`                                                                                                                                                                                                                                                              |
| 客户端 `<style>` 注入                                       | 自绘气泡样式               | `dsh-custom-css/FEASIBILITY@0.2.0-rc.2.md` §5.6（已实测；`document.head.appendChild` + `data-plugin`）                                                                                                                                                                                      |
| Host `webserver/index-inject`                               | 首屏关键层                 | 本插件**不需要**（无首屏闪烁问题，用户气泡不在首屏）                                                                                                                                                                                                                                        |

### 4.5 一个必须知道的限制

**`@deepseek-ai/dsh-client-ui-chat` 不可被 require 复用。** 其 `lib/client.js` 中 `^export` **零匹配** —— 它是自包含的插件产物，`UserStyleBubble`、`MessageIconActions`、`formatMessageClock`（`:1057`）、`useCalendarDay`（`:1075`）全部是模块内私有。**我们无法"调用内置用户气泡再包一层"**，只能自绘。

---

## 5. 模型回复的 Markdown 渲染组件，及其复用性

### 5.1 组件身份

`MarkdownText`，来自 `@deepseek-ai/dsh-client-ui-primitives`（`lib/index.js:11814`）：

```js
const MarkdownText = memo(function MarkdownText({ text, streaming = false, labels, fileMentions, pathImages, variant = "body" }) { … });
```

该包自述：*Pure React atoms for the dsh web UI: controls, icons, markdown, and JSON inspectors (zero cordis)*；其 README 明确其定位是**共享**渲染层（"Shared React UI atoms for the dsh web client"），而**不是** ui-chat 的私有实现。

技术栈：micromark + mdast（GFM）+ KaTeX（TeX）+ Shiki（代码高亮）。

### 5.2 契约

- `text`：Markdown 源文本。
- `streaming`：增量解析，冻结已完成的块、只重解析尾部。**用户消息是落定内容，用默认 `false`。**
- `labels`：**必填**，形状是从源码反推确认的：

  ```js
  labels = {
    code: {
      copyLabel, copiedLabel,
      toolbarLabels: { codeLabel, wrapLabel, unwrapLabel }
    },
    footnotes
  }
  ```

  证据：`primitives/lib/index.js:11361-11363`（`copyLabel`/`copiedLabel`/`toolbarLabels`）、`:11661`（`labels.footnotes`）、`:9472`（`labels.codeLabel`）。这正是 ui-chat `markdownLabels(t)`（`client.js:198`）构造的东西，键落在 **`chat` 命名空间**（`copy`、`copied`、`codeBlock.title`、`codeBlock.wrap`、`codeBlock.unwrap`、`markdown.footnotes`）。

  ⚠️ 该参数**必须引用稳定**，否则流式缓存被丢弃（源码 JSDoc：*pass a reference-stable object (memoized per locale revision), because a new identity discards the streaming render cache*）。用户消息虽非流式，仍应按此写。

  **实现取法**：`ctx.locale.bind('chat')` 可直接复用内置译文（`bind` 实现见 `dsh-client-locale/lib/client.js:1414`：对未注册命名空间**不抛错**，查不到时回落到 key 本身、再回落 `common`）。若不想跨命名空间取键，就自带 6 条双语文案作兜底。
- `fileMentions` / `pathImages`：把行内代码识别为真实文件、把本地图片路径重写为可展示 URL。**仅在落定渲染生效**（源码：*Those two vocabularies are the single streaming gate — they apply to settled renders only*）。可从 owner 的 `openFile` / `fileMentions` 派生。
- `variant`：`body`（默认，完整文档排版）| `compact`（次级内容：13px/20px、各级标题同号 600 字重、更紧凑间距）。

### 5.3 安全性

`MarkdownText` 本身就是**面向不可信模型输出**设计的：丢弃原始 HTML、限制链接协议、图片做白名单（README：*renders untrusted GFM and TeX math, blocks unsafe links and images*）。用户自己的输入比模型输出更可信，因此**不存在新增 XSS 面**——这一点反而比"自己写 markdown→HTML"安全得多。

### 5.4 `MarkdownDelegateProvider`

`primitives/lib/index.js:11040`：`function MarkdownDelegateProvider({ children, openExternalLink, openFile, fileImages })`。

ui-chat 在节点列表外已经挂了一个（`client.js:5280`），所以**我们不需要自己再挂**——只要我们的组件渲染在同一个 Chat 视图内，最近的 Provider 就已经存在，`openFile` 等导航能力天然可用（README：*The nearest MarkdownDelegateProvider supplies optional openExternalLink and openFile navigation callbacks*）。

### 5.5 复用可行性的实证

本地插件 `dsh-font-settings/client.js` 第 14 与 24 行已实测两条通道：

```js
const React = require('react');
const { IconCheckOutlineRegular, … } = require('@deepseek-ai/dsh-client-ui-primitives');
```

且其 `package.json` 的 `dsh.client.inject` 里列了 `@deepseek-ai/dsh-client-ui-primitives`。**平台种子模块通道成立，无需打包 Markdown 解析器**（若自己打包 micromark+shiki，体积与版本漂移都是负担）。

已确认可从 primitives 直接取到（导出表 `lib/index.js:12381`）：

```
FileTypeIcon  JsonBlock  MarkdownDelegateProvider  MarkdownText  Tooltip
extractMarkdownPlainText  fileExtension  fileSizeText  projectUserText  writeClipboard
```

**这基本覆盖了自绘用户气泡所需的全部零件。**

---

## 6. 核心进路（推荐方案 A）

### 6.1 一句话

**在客户端插件里，以 `priority: -1` 向 keyed 槽位 `conversation.chat.node` 注册 `user`（以及 `steering`）键，用一个自绘组件替换内置渲染器；该组件复刻内置气泡的结构与全部既有行为，仅把文本部分从"纯文本"换成 `<MarkdownText>`。**

### 6.2 结构

```
Host 半 (index.js)
  Config schema（z.object + .volatile()）
    enabled: boolean        —— 总开关
    target:  'user'|'both'  —— 是否同时作用于 steering
    variant: 'body'|'compact'
    （其余见 §9 决策点）
  settings.configure({ auto: false }, ctx.fiber)

Client 半 (client.js)  __ModuleLoader__.load({ id:'@local/dsh-enhanced-prompt', factory(require) })
  require('react')
  require('@deepseek-ai/dsh-client-ui-primitives')
  inject: ['slots','locale','configForms']
  ├─ ctx.locale.register(NS, { zh, en })            自有文案
  ├─ <style data-plugin=…> 注入                    自绘气泡样式（仅用 --dsw-* 令牌）
  ├─ ctx.slots.inject('settings.general.item', …)   order 12.5 的开关行
  └─ sync()：按 enabled 注册 / 注销遮蔽条目
        disposeEntry = ctx.slots.inject('conversation.chat.node', () =>
          ctx.slots.register({ name:'conversation.chat.node', key:'user',
                               priority: -1, locale: NS }, UserPromptView))
```

**开关 = 注册/注销**（`ctx.slots.inject` 与 `slots.register` 都返回幂等 disposer）。关闭时我们的条目消失，`entriesOfSlot` 立刻回落到内置 `priority: 0`——**关闭态零风险、零样式残留**。

### 6.3 自绘组件必须复刻的清单

`UserStyleBubble` 做的事，逐项对应到可用零件：

| #   | 行为                                  | 复刻方式                                                                                                    |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | `contentParts(content)` 拆分          | 该函数是 ui-chat 私有（`client.js:1193`，20 行），**照抄实现**                                              |
| 2   | 文本 → 纯文本 + 引用 chip             | 用导出的 `projectUserText(text, referenceLabels, skillNames, 'skill', references)`                          |
| 3   | **文本 → Markdown**（本插件的差异点） | `<MarkdownText text={text} labels={labels} variant={…} />`                                                  |
| 4   | 附件栏（图片 / 文件卡）               | `renderMessageImages({ images, align:'end', compact })` + `FileTypeIcon` / `fileExtension` / `fileSizeText` |
| 5   | 复制按钮 + 时间戳                     | `writeClipboard` + `Tooltip` + 自写的时间格式化（见下）                                                     |
| 6   | 引用摘要行                            | `t('message.referenceSummary', …)` 语义自带文案                                                             |
| 7   | 额外块 `rest`                         | `<JsonBlock label={t('message.extraBlock')} payload={block} truncatedLabel={…} />`                          |
| 8   | 行容器与 pending/echo 标记            | 自绘 class + `data-pending-steering` / `data-submission-echo`（保持 DOM 语义可被外部查询）                  |

**唯二无法复用的私有工具**（ui-chat 不导出）：

- `formatMessageClock(time, t, now)`（`client.js:1057`）
- `useCalendarDay()`（`client.js:1075`）

两者合计约 20 行（今天/昨天/日期 + 时分）。**建议处理方式**：一期先自行实现等价逻辑并复用 `chat` 命名空间的时间文案键；若追求零偏差，可退一步——一期**不改动操作行**，把它画成与内置一致的形态即可。

### 6.4 样式策略

自绘气泡**不要**去猜内置的哈希类名（`IzP3Va_bubble` 这类名字每次构建都会变）。正确做法：**自己的类名 + 内置设计令牌**，即直接使用：

- 颜色/圆角：`--dsw-specific-bubble`、`--dsw-radius-xl`、`--dsw-alias-label-primary`、`--dsw-alias-label-tertiary`、`--dsw-alias-label-caption`
- 排版随"内容字号"设置联动：`--dsh-content-font-size`、`--dsh-content-font-delta`、`--dsh-content-font-size-secondary`、`--dsh-content-font-delta-secondary`
- 宽度对齐：`--dsh-chat-content-width`（内置用的是 `max-width: min(calc(var(--dsh-chat-content-width,748px) * .702), 82%)`）

> 注意区分：`Theme.listTokens` 只列出 **15 个"可被 `overrideTokens` 覆盖"的令牌**；上面这些 `--dsw-*`/`--dsh-*` 变量由内置基础样式表定义、在 CSS 里**可直接使用**，只是不在可覆盖注册表里。这不影响使用。

### 6.5 引用 chip 与 Markdown 的冲突（本方案唯一需要设计判断的地方）

`projectUserText` 产出的是"纯文本 run + 引用 chip"的行内节点序列，而 `MarkdownText` 接受的是**整段源文本**。两者不能简单嵌套。可选策略（详见 §9 决策点 2）：

- **策略 1（简单）**：Markdown 模式下先按 `projectUserText` 的 range 切分源文本，**chip 之间的纯文本段各自送进 `MarkdownText`**，chip 原样插入。保真度最高，代价是要自己复算 range（`projectUserText` 内部已算好但未导出 range）。
- **策略 2（务实）**：文本中**存在引用 chip 时退化为纯文本**，其余情况走 Markdown。
- **策略 3（激进）**：Markdown 模式一律走 `MarkdownText`，**放弃 chip 装饰**（`@路径` 仍会以普通文本显示，若配 `fileMentions` 甚至能变成可点链接）。

---

## 7. 备选方案对比

| 方案                                                              | 能解析 Markdown | 保留内置行为              | 稳健性                                                       | 结论                                           |
| ----------------------------------------------------------------- | --------------- | ------------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| **A. 遮蔽 keyed 槽位（priority −1）+ 自绘 + 复用 `MarkdownText`** | ✅               | ✅（需自绘复刻，零件齐备） | 官方明示机制；React 生命周期干净；卸载自动回落               | **推荐**                                       |
| B. 纯 CSS                                                         | ❌ 无法解析语法  | ✅                         | 高                                                           | **不可行**（只能改观感，不能解析）             |
| C. DOM / MutationObserver 改写内置气泡                            | ✅               | ✅                         | ⚠️ 与 React 争抢同一批 DOM 节点，重渲染时易被覆盖或引发不一致 | 拒绝为主通道                                   |
| D. monkey-patch primitives / 模块劫持                             | ✅               | —                         | ❌ 平台种子模块由加载器持有，且污染全局                       | 拒绝                                           |
| E. 向 DSH 上游提特性请求（内置 `userMarkdown` 配置）              | ✅               | ✅                         | ✅                                                            | **长期最优**，但受发行节奏约束；可作为并行动作 |

**E 的补充说明**：ui-chat 的 Config 已是"按需增长"的形态（`transcriptView`、`performanceUsage`），加一个 `userMessageMarkdown` 属于自然扩展。建议在实现 A 的同时记录该请求——A 落地后，将来若内置支持，卸载本插件即可平滑切换。

---

## 8. 风险与对策

| 风险                                         | 影响                                                                                                      | 对策                                                                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **遮蔽风险 = `shadows-shipped-ui`**          | DSH 升级后内置气泡可能新增功能（如编辑、分支、反应），我们的自绘会"落后"                                  | ① 在自绘组件里保留 owner 的全部入参（`forkAt`、`inspectCall` 等）以备接入；② README 记录版本适用区间；③ 开关默认值待定（建议**默认关闭**，用户显式开启才遮蔽） |
| **乐观回显气泡不走槽位**（`client.js:5109`） | 提交瞬间 → 落定之间是纯文本，含 Markdown 的 prompt 会有一次重排                                           | 一期接受并记录；二期可选：对 `[data-submission-echo]` 做轻量 DOM 装饰，或用 CSS 在 Markdown 模式下弱化回显文本                                                 |
| **同 priority 抛错**                         | 插件在注册瞬间报错、槽位为空                                                                              | 必须 `priority: -1`（本报告 §4.2）。实现时加断言与注释，避免后人"顺手删掉这个负数"                                                                             |
| **`labels` 引用不稳定**                      | 丢弃渲染缓存；Markdown 每次重渲染重新解析                                                                 | `useMemo` 以 `t`（随 locale revision 变身份，`ui-renderer/lib/client.js:515-535` `localeSeat`）为依赖                                                          |
| **性能**：settled 解析含 micromark + Shiki   | 长历史 + 大量代码块的 prompt 可能卡顿                                                                     | 用户消息短、历史按轮分页加载（`chat.loadOlder`，非虚拟化）；一期用 `variant` 控制；必要时给"检测到围栏代码才启用高亮"的开关                                    |
| **复制语义变化**                             | 用户按复制拿到的不再是原文                                                                                | 决策点 4；`extractMarkdownPlainText` 已在 primitives 导出，两种语义都能实现                                                                                    |
| **与 `dsh-custom-css` 叠加**                 | 用户现有 CSS（`div[class*="markdown"] > p { text-indent: 2em }`）会**同时命中用户气泡里的 markdown 容器** | 这是预期行为，但需在 README 提醒：该选择器将一并作用于启用 Markdown 后的用户消息                                                                               |
| **配置写坏导致界面异常**                     | 无法自救                                                                                                  | 沿用 custom-css 的成熟做法：清空/关闭配置字段即可恢复；且关闭 = 条目注销 = 立即回落内置渲染器                                                                  |

---

## 9. 需要你确认的决策点

| #   | 决策点                                         | 备选                                                                                                |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | 开关粒度                                       | (a) 单一总开关（推荐）(b) user / steering 分开 (c) 再加"仅当检测到 Markdown 语法时才解析"的智能模式 |
| 2   | 引用 chip（`@文件` `/技能`）与 Markdown 的关系 | 见 §6.5 策略 1 / 2 / 3                                                                              |
| 3   | 渲染变体                                       | `body`（与模型回复同款完整排版）vs `compact`（次级、更紧凑）——用户气泡是否应与回复"同权"            |
| 4   | 复制按钮复制什么                               | (a) 原始 Markdown 源文本（保持现状语义）(b) 纯文本（`extractMarkdownPlainText`）(c) 两者都给        |
| 5   | 默认状态                                       | 安装后默认开启，还是默认关闭由用户显式打开（考虑到 `shadows-shipped-ui`，建议默认关闭）             |
| 6   | 是否同时发起上游特性请求（方案 E）             | 是 / 否                                                                                             |

---

## 10. 实施步骤（获批后执行）

1. 建包骨架：`package.json`（`exports["./client"]`、`exports["./locale/*.json"]`、`dsh.bundle`、`dsh.client{platform:'web', immediately:true, inject:[…]}`）、`cordis.patch.yml`（`- insert: [{ id: dsh-enhanced-prompt, name: '@local/dsh-enhanced-prompt' }]`）、`icon.svg`。
2. 写 Host 半 `index.js`：`z` Config（字段见 §9）+ `settings.configure({ auto: false }, ctx.fiber)`；自带 `node_modules/@deepseek-ai/schemastery`（沿用 font-settings 的做法，避免"已启用但 fiberPhase 为 null"的导入失败坑）。
3. 写客户端半 `client.js`：
   - `contentParts` 等价实现；
   - `UserPromptView` 组件（§6.3 清单 1–8）；
   - `buildMarkdownLabels()`（`ctx.locale.bind('chat')` + 自有兜底）；
   - `sync()`：按配置注册/注销 `priority: -1` 的槽位条目；
   - `settings.general.item` 行（`order: 12.5`，"摘要 + 展开"形态，参照字体设置行）；
   - 自绘气泡 `<style>` 注入（`data-plugin` 标注 + 卸载清理）。
4. 本地接入 profile：`~/.dsh/profiles/desktop/package.json` 加 `link:` 依赖与 `bundles` 条目 → `pnpm install`。
5. 静态验证（不需重启）：`node --check`；在 React/DOM 桩下跑通 `apply()` 生命周期与槽位注册参数（断言 `priority === -1`、`key === 'user'`）。
6. **重启 Host**（bundle 列表在 Host 启动时合成，无法进程内重试）→ 刷新 GUI → 打开 设置 → 通用 → 确认新行位置 → 开启开关 → 发一条含 Markdown 的 prompt，确认渲染；关闭开关，确认回落内置样式。
7. 写 `README.md`（含"如何自救"）与最终版 `FEASIBILITY@0.2.0-rc.2.md`（回填实现与探究的差异，沿用 custom-css 的体例）。

---

## 11. 参考坐标

| 对象                            | 路径 / 标识                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| asar 读取器（本次新建，仅临时） | `/tmp/dsh-asar/asar.mjs`                                                                                                                                           |
| 用户消息渲染器                  | `app.asar → dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js:1446`（`UserMessageNodeView`）、`:1332`（`UserStyleBubble`）、`:1193`（`contentParts`） |
| 用户气泡 CSS                    | 同上 `:214`（`css$17`，`.IzP3Va_bubble{…white-space:pre-wrap…}`）                                                                                                  |
| 槽位派发点                      | 同上 `:1770`（`renderSlot("conversation.chat.node", …)`）、`:1763-1772`（`data-chat-*` 锚点包装）                                                                  |
| 槽位声明 + 全部键注册           | 同上 `:12398`（声明）、`:6778-6870`（`registerChatNodeRenderers`）                                                                                                 |
| 乐观回显（不经槽位）            | 同上 `:5090-5117`（`ChatNodeList` 的 `pendingRows`）                                                                                                               |
| 槽位注入的 hooks                | 同上 `:12251`（`CHAT_NODE_INJECT`）                                                                                                                                |
| 槽位遮蔽实现                    | `…/dsh-client-ui-slots/lib/index.js:165-185`（冲突检查）、`:268-290`（`entriesOfSlot` 取最小 priority）                                                            |
| Markdown 渲染组件               | `…/dsh-client-ui-primitives/lib/index.js:11814`（`MarkdownText`）、`:11040`（`MarkdownDelegateProvider`）、`:6700`（`projectUserText`）、`:12381`（导出表）        |
| `t` 身份随 locale 变化          | `…/dsh-client-ui-renderer/lib/client.js:515-535`（`localeSeat`）、`:721-724`（`kit["t"]`）                                                                         |
| `locale.bind` 语义              | `…/dsh-client-locale/lib/client.js:1414`                                                                                                                           |
| 可照抄的插件骨架                | `local-plugins/dsh-custom-css/`（Host `index.js` + Client `client.js` + profile patch）                                                                            |
| 客户端模块装载 / 样式归属       | `dsh-custom-css/FEASIBILITY@0.2.0-rc.2.md` §4.2、§5.6（已实测）                                                                                                    |
| 本机 profile                    | `~/.dsh/profiles/desktop/{package.json,cordis.patch.yml}`                                                                                                          |

---

## 12. DSH 0.2.1 适配记录（2026-10-17）

升级到 `0.2.1-rc.2` 后插件**静默失效**：Host 无异常、插件页显示已启用、GUI 里用户 prompt 却回到纯文本。

### 12.1 失效原因（已定位到代码）

运行时自省给出了决定性证据 —— `Slots.listSubTree("conversation.chat.node")` 的占用表：

```
{ registrant: "Kb", key: "user",     priority: -1, active: false }   ← 本插件，已 abdicate
{ registrant: "Kb", key: "steering", priority: -1, active: true  }
{ registrant: "Kb", key: "user",     priority:  0, active: true  }   ← 内置，接管回来
```

`active: false` 不是"未启用"，而是**条目在渲染时抛错被 abdicate**。`dsh-client-ui-renderer` 的 `SlotErrorBoundary` 明确写着：

```js
componentDidCatch(error) {
  console.error(`slot entry crashed in '${this.props.slotKey}':`, error);
  this.props.onEntryError(error);           // → reportEntryError(..., { abdicate: kind !== 'chain' })
}
```

遮蔽型槽位 abdicate 后，出口会**重新选举到该 cell 的下一个存活条目**，于是内置渲染器回来了 —— 界面正常、Host 正常、插件"正在运行"，只是我们那一格被跳过了。

**抛错的直接原因**：0.2.1 移除了 `projectUserText`。它曾是把已发送文本切成"纯文本 run + 引用 chip"的投影函数，0.2.0 的实现完全建立在它之上（本报告 §6.5 的"策略 1"正是复用它的输出）。新版里该导出**不存在**，`primitives` 的 seed 对象上取到 `undefined`，首条用户消息渲染即 `TypeError` → abdicate。

> 附带确认：`@deepseek-ai/dsh-client-ui-primitives` 这个**包目录已不再随发行包分发**（asar 内已无该路径），但它仍是 shell 的 seed 模块（`dsh-web-frontend` 的 seed 表里映射到 `zU`），所以 `require` 不会抛错 —— 这解释了为什么"缺失的导出"表现为运行期渲染崩溃，而不是插件加载失败。

### 12.2 新版的用户 prompt 渲染流程

0.2.1 把这条链路拆成了可组合的 Factory 与 keyed 槽位（全部由 asar 源码核实）：

```
conversation.chat.node[user] → UserMessageNodeView({ node, renderFactorySlot, loadImage, t })
  → renderFactorySlot("conversation.chat.user.content", { content, loadImage, facts, interactive })
    → UserContent                                   （ui-chat，Factory 默认实现）
      → renderFactorySlot("conversation.user.text", { text, facts, interactive, ellipsis })
        → UserText                                  （ui-conversation，Factory 默认实现）
          → renderSlot("conversation.user.text.node", { node, raw, interactive },
                       { entryKey: node.id })
              key "text"   → PlainUserText → UserTextRun      priority 100
              key "session"→ SessionReference                 priority 100
              key "file"、"folder"、"skill"、"command"、"secret" → ui-reference 等
```

要点：

- **正文被单独隔离成一格**（`text`），引用 chip 是同一槽位里的**兄弟 keyed 条目**，由 `ctx.uiConversation.userText` 的 matcher 规则切分（不再有 `projectUserText`）。
- `UserText` 的根是 `display: contents`，所以这一格的内容直接参与气泡的**行内流**，与 chip 并列。
- 这一格是**共享**的：同一 Factory 还被队列预览（`ellipsis: true`）与 `/goal` 命令气泡使用，它们传 `interactive: false`；落定的对话行传 `interactive: true`。
- 槽位目录标 `replaceRisk: shadows-shipped-ui`，`text` 由 `PlainUserText` 占 `priority: 100`。

### 12.3 适配方案：改接 `conversation.user.text.node` 的 `text` 一格

不再替换整个气泡，改为只替换这一格：

|              | 0.2.0 实现                                      | 0.2.1 实现                                              |
| ------------ | ----------------------------------------------- | ------------------------------------------------------- |
| 扩展点       | `conversation.chat.node` 的 `user` + `steering` | `conversation.user.text.node` 的 `text`                 |
| 遮蔽优先级   | `-1`（内置 0）                                  | `-1`（内置 100）                                        |
| 需要重绘     | 气泡、附件栏、引用摘要、复制按钮、时间戳        | **无** —— 只画一段正文                                  |
| 引用 chip    | 自己复用 `projectUserText` 的输出               | 内置解析器负责，chip 渲染器原样                         |
| 回显气泡     | 不覆盖（缺口）                                  | 仍不覆盖，但改为**由 `interactive` 显式划界**的既定范围 |
| 打错时的表现 | 整个气泡回退                                    | 只有正文回退，其余 chrome 不受影响                      |

**范围控制**：`interactive === true` 才走 Markdown，否则回落内置 `UserTextRun`。这样队列预览的单行省略号与 `/goal` 命令气泡保持原样。

**排布约束（第二版）**：`.dep-md{display:inline-block}` —— 盒子是行内级（chip 紧邻流动、不强制换行），内容是块格式化上下文（段落保持真正的块级盒子）。首版曾用 `.dep-md>div` / `p` 全部 `display:inline`，见 §12.5：那会让块级文本属性集体失效。

另把气泡的 `white-space: pre-wrap` 在正文段内重置为 `normal`（代码块自行声明），并把首/末块的 16px 外边距清零，避免在带内边距的气泡里双倍留白。

### 12.5 两个排布缺陷（修复记录）

1. **`text-indent` 不生效、`text-align` 却生效。** 首版把 `<p>` 强制 `display:inline`。`text-indent` 按规范**只作用于块容器**，行内盒子上是惰性的——所以 `div[class*="markdown"] > p{text-indent:2em}` 的声明确实进了 CSSOM、选择器也确实命中了 `<p>`（已核实：settled 渲染器 `c2 → p4` 对 `paragraph` 直接产出 `<p>`，是 markdown 根 div 的直接子节点），但浏览器拒绝执行。两端对齐看起来生效，是因为 `text-align` 是**继承属性**、其有效值由建立行盒的块容器取用，视觉上不落在被内联化的那个 `<p>` 上。
2. **chip 前多一个换行。** 同一原因的另一面：只要那一段 Markdown 里有**块级盒**（段落就是），行内盒会被它切开，于是 chip 落到了新的一行；chip 之后的文字仍是行内，继续跟着排——正好是"插入点前换行、之后不换行"。

两处由同一个改动解决：把「行内化段落」换成「行内级盒子 + 块级内容」。另外顺手处理了**纯空白段**：它会被 Markdown 变成空段落，而空块盒仍会占一个行盒——所以空白段直接交回内置 `UserTextRun` 原样输出。

**宽度**：仍按需求让 prompt 与模型输出等宽。由于不再自绘气泡，改用 `[class*="_userStack"]` / `[class*="_bubble"]` 匹配 CSS Module 的稳定局部名（而非每次构建会变的哈希）。失配时只是宽度退回原样，不影响渲染 —— 这是本插件唯一一处依赖内置类名的地方。

### 12.4 教训

1. **遮蔽型槽位的失效是静默的。** 条目抛错 → abdicate → 下一个条目接管，界面看起来"和没装插件一样"。排查顺序应是：`cordis_inspect` 看占用表的 `active`，再看浏览器控制台的 `slot entry crashed in ...`。
2. **`priority` 的语义是"最小者渲染"，不是"高优先级者渲染"。** 同 key 同 priority 直接抛错（0.2.0 与 0.2.1 一致）。测试里对 `< 内置值` 设了断言，就是为了防止后人"简化"。
3. **依赖运行时导出名要谨慎。** `require` 成功不代表导出还在：primitives 变成纯 seed 之后，包目录消失但 `require` 仍成功，缺失的只有具体导出。
