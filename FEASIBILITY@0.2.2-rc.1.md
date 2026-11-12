# 用户 Prompt 的引用文本选择与发送后紧凑预览 —— 0.2.2-rc.1 适配可行性

- 复核日期：2026-11-07
- 对象：DSH `0.2.2-rc.1`，插件 `@local/dsh-enhanced-prompt` v3.0.0（实施后 v3.1.0）
- 文档性质：调查、可行性记录与实施记录（2026-11-07）。§1–§10 为调查与方案；实际改动与验证见 §11。
- 目标：让 0.2.2-rc.1 新增的两项引用能力在插件接管后的用户 prompt 气泡中继续工作：
  1. 在已发送的 prompt 中选中文本时出现「引用文本」按钮；
  2. 含引用的 prompt 发送后，引用部分显示为紧凑预览，而不是裸 `>` 文本或普通 blockquote。

---

## 1. 结论摘要

| 能力 | 官方实现位置 | 插件当前表现 | 适配结论 |
| --- | --- | --- | --- |
| 选中文本 → 「引用文本」按钮 | `dsh-client-ui-chat` 的文本交互层 + `dsh-message-quotes` 的选区交互注册 | **不出现**：增强气泡没有 `data-text-interaction-source` 标记，选区在 `readTextSelection()` 阶段就被拒绝 | 在增强气泡 `.dep-bubble` 上加同一个 DOM 标记即可；按钮本身仍由官方交互层渲染，插件不重写 |
| 发送后紧凑预览 | `dsh-message-quotes` 的 `quoteRule` + `conversation.user.text.node` 的 `quote` 格 + primitives 的 `QuotePreview` | **未渲染预览**：`composeMessage()` 把 `quote` 节点当普通 chip 的哨兵，`chipElement()` 没有 `quote` 分支，最终退回原文 `> …` | 给 `chipElement()` 增加 `quote` 分支，复用官方 `QuotePreview`；哨兵替换管线不变 |
| Composer 内的引用编辑 | `dsh-client-ui-conversation` 的 `QuoteNode` / `normalizeQuoteBoundaries()` | 不受插件影响（插件不接管 composer） | 不改 |
| Host / 会话数据 | `dsh-message-quotes` 不写 quote 元数据，引用就是普通 Markdown 文本 | 不受影响 | 不改 |

**推荐方案：标记增强气泡 + 复用官方 `QuotePreview`。** 不重写按钮，不复制预览组件，不改 composer，不新增 locale key，也不引入新的 Host 依赖。

---

## 2. 证据来源

1. 发行包：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`，版本 `0.2.2-rc.1`；按路径读取 `dsh/node_modules/@deepseek-ai/**`，未解包、未改动。
2. 关键包：
   - `dsh-message-quotes` v0.2.2-rc.1（引用规则、选区交互、`QuotePreview` 使用方）
   - `dsh-client-ui-chat` v0.2.2-rc.1（选区交互、文本交互浮层、`UserContent` 气泡）
   - `dsh-client-ui-conversation` v0.2.2-rc.1（composer `QuoteNode`、`UserText` 求值与槽位）
   - `dsh-web-frontend` v0.2.2-rc.1（shell bundle 内的 `ui-primitives`，含 `QuotePreview` 实现与 CSS）
3. 插件当前实现：`dsh-enhanced-prompt/client.js` v3.0.0。
4. 用最小 asar 读取器抽取上述包，并以符号而非压缩后的变量名定位实现；行号均指对应包 `lib/client.js` 或 shell bundle，作为辅助坐标。

本轮没有可用的浏览器交互环境，因此**未做真实鼠标选区测试**；下面的结论来自源码路径与一次纯函数模拟（见 §3.3）。最终仍需按 §9 在重启后目视验收。

---

## 3. 0.2.2-rc.1 的实现

### 3.1 「引用文本」按钮

按钮不是某个气泡组件自带的，而是 **Chat 视图的文本交互层 + 插件注册的交互**：

```text
ChatView
  useTextInteraction(scroll.columnRef, surfaceRef, dispatchInteraction, ids)
    document selectionchange
      readTextSelection(root, selection)
        sourceOf(node) = node.closest("[data-text-interaction-source]")
      dispatchInteraction(...)
        → uiConversation.interactions 中注册的所有交互
  renderSlot("conversation.chat.text-interaction", {
    trigger, readText, dismiss, clearSelection
  })
```

坐标（`dsh-client-ui-chat/lib/client.js`）：

| 符号 | 行 | 作用 |
| --- | --- | --- |
| `readTextSelection` / `sourceOf` | 777 | 选区两端必须落在同一个 `[data-text-interaction-source]` 元素内 |
| `selectedText` | 约 790 | 按可见块边界投影选区文本，去除渲染器 chrome |
| `available` | 817 | 再次要求 `target.source.hasAttribute("data-text-interaction-source")`，并检查祖先没有 `hidden` / `inert` / `data-text-interaction-exclude` / `display:none` / `visibility:hidden` |
| `useTextInteraction` | 862 | `selectionchange`、pointer、contextmenu、滚动重定位全部在这里 |
| `conversation.chat.text-interaction` 槽渲染 | 3683 | 浮层挂载点，只渲染当前打开的交互条目 |

`dsh-message-quotes/lib/client.js` 负责「引用」这一条交互：

| 符号 | 行 | 作用 |
| --- | --- | --- |
| `QuoteSelectionAction` | 29 | 浮层里的「引用文本」按钮；`onClick` 调用 `inputActions.insertQuote(readText())` |
| `onInteraction` | 170–180 | 仅在 `trigger === "selection"`、`readText() !== null`、Session 可写时 `request.open()` |
| `conversation.chat.text-interaction` 注册 | 181–185 | key `quote`，locale 命名空间 `messageQuotes` |
| 字典 `quote.add` | 128 | 中文文案「引用文本」 |

官方原生气泡在 `dsh-client-ui-chat/lib/client.js` 的 `UserContent()` 里把标记挂在 `UserMessageBubble` 上：

```js
showBubble && jsxs(UserMessageBubble, {
  "data-message-bubble": "",
  "data-text-interaction-source": "",
  children: [...]
})
```

见 `UserContent`（9359 行起），标记在 9395 行。插件接管 `conversation.chat.node` 的 `user` / `steering` 后，自己画 `.dep-bubble`，但**没有带这个标记**；因此：

- `readTextSelection()` 找不到 source；
- `dispatchInteraction` 不会发生；
- `dsh-message-quotes` 的 `onInteraction` 不会打开；
- 浮层和按钮都不会出现。

这不是插件与 `message-quotes` 之间的 API 不兼容，而是增强气泡没有加入官方定义的「可选区表面」。

### 3.2 发送后的紧凑预览

引用在 composer 里是一个原子 `QuoteNode`，不是消息元数据：

| 符号 | 位置 | 作用 |
| --- | --- | --- |
| `QuoteNode` | `dsh-client-ui-conversation/lib/client.js` 13782 | `isInline()` 的 Lexical 装饰节点；`getTextContent()` 返回 `formatQuoteText(__text)` |
| `QuoteNodeView` | 13770 | composer 内的 `QuotePreview`（带移除按钮） |
| `formatQuoteText` | primitives | 每行加 `> ` 前缀 |
| `insertQuote` | 15186 | 在当前选区后插入 `QuoteNode` + 空格 |
| `normalizeQuoteBoundaries` | 5196 | 序列化时在引用前后插入 `\n\n`，并修剪相邻文本 |
| `serializeDraftPrompt` | 5231 | 最终把 quote 序列化成 Markdown blockquote 文本 |

因此发送到消息里的文本形如：

```text
前言

> 被引用的第一行
> 被引用的第二行

后文
```

`dsh-message-quotes` 在客户端注册一条 UserText 规则：

| 符号 | 行 | 作用 |
| --- | --- | --- |
| `quoteTextOf` | 74 | 去掉每行最多一个 `> `（允许最多 3 个前导空格），统一换行 |
| `messageQuoteRanges` | 82 | 识别连续的、显式 `>` 行；只返回非空引用片段 |
| `quoteRule` | 94 | `id: "quote"`, `order: -10`；返回 `{ id: "quote", start, end, data: { text } }` |
| `quoteRule` 的 `text` 分支 | 110–118 | 紧邻引用的 `\n\n` 返回 `{ id: "text", data: { display: " " } }`，让内置纯文本流把引用与前后文压成同一行 |
| `QuotedUserText` | 63 | `QuotePreview({ text: node.data.text })` |
| `conversation.user.text.node` 的 `quote` 格 | 186–190 | `priority: 100`，把 quote 节点交给 `QuotedUserText` |

`UserText`（`dsh-client-ui-conversation/lib/client.js` 4243）先求值，再把每个节点交给 keyed 槽：

```js
nodes = evaluate({ text, facts });
nodes.map((node) => renderSlot("conversation.user.text.node", {
  node, raw, interactive
}, {
  entryKey: node.id,
  fallback: <UserTextRun text={node.id === "text" ? node.data.display ?? raw : raw} />
}))
```

所以原生路径里：

- `quote` 节点 → `conversation.user.text.node` 的 `quote` 格 → `QuotedUserText` → `QuotePreview`；
- 相邻 `\n\n` 的 `display: " "` → 内置 `PlainUserText` 显示成一个空格；
- 引用预览与前后文在同一个纯文本流里内联排列。

`QuotePreview` 是 `@deepseek-ai/dsh-client-ui-primitives` 的导出（shell bundle 中实现为 `function RU({ text, removal })`）：

- 外层 `span`，`data-quote-preview`；
- 引用图标 + 单行省略的 `[data-quote-preview-text]`；
- `max-width: min(80%, 300px)`，`inline-flex`；
- 悬停显示完整文本的 popover（`[data-quote-popover]`，`white-space: pre-wrap`）；
- 文本按**纯文本**渲染，不做 Markdown 或 chip 装饰。

这正是「发送后显示紧凑预览」的实现。

### 3.3 插件当前为什么两项都不工作

插件当前路径（`dsh-enhanced-prompt/client.js`）：

1. `EnhancedUserNode` 接管 `user` / `steering`，画 `.dep-row` → `.dep-stack` → `.dep-bubble`（527 行起，气泡在 583–600 行）；**没有 `data-text-interaction-source`**。
2. `composeMessage`（182 行）用 `uiConversation.userText.createEvaluator()` 求值；除 `text` 外的每个节点都替换成私用区哨兵，并记录为 chip。
3. `quote` 节点会被记录为 `{ id: "quote", data: { text }, raw: "> …" }`。
4. `chipElement`（222 行）的 `switch` 没有 `quote` 分支，落到 `default: return chip.raw`。
5. 于是 `MarkdownText` 里是一个段落中的裸 `> …` 文本，`restoreChips` 再把哨兵替换回这个裸文本。

本轮用插件暴露的纯函数做了一次模拟：

```js
text = "A\n\n> quoted\n\nB"
evaluate = () => [
  { id: "text", start: 0, end: 1 },
  { id: "text", start: 1, end: 3, data: { text: "\n\n", display: " " } },
  { id: "quote", start: 3, end: 11, data: { text: "quoted" } },
  { id: "text", start: 11, end: 13, data: { text: "\n\n", display: " " } },
  { id: "text", start: 13, end: 14 },
]
```

结果：

```text
composed.markdown = "A\n\n\uE0000\uE001\n\nB"
chips = [{ id: "quote", data: { text: "quoted" }, raw: "> quoted" }]
chipElement(...) = "> quoted"          // 不是 QuotePreview
```

这解释了用户观察到的现象，也确认了修复点：**哨兵管线本身已经捕获了 quote 节点，只差渲染分支。**

---

## 4. 核心进路

### 4.1 选中按钮：把增强气泡加入官方选区表面

在 `EnhancedUserNode` 渲染 `.dep-bubble` 时增加：

```js
h('div', {
  className: 'dep-bubble',
  'data-text-interaction-source': '',
}, ...)
```

只加在**有文本内容的气泡**上；附件栏和引用摘要不应成为 source，这与原生 `UserContent` 把标记放在 `UserMessageBubble` 上一致。

为什么不是别的元素：

- 放在 `.dep-row` / `.dep-stack`：会把附件、引用摘要、操作行也纳入，和原生语义不一致；
- 放在 `.dep-md-host`：会漏掉 `JsonBlock` 等额外内容，且 `.dep-md-host` 是独立 root 的宿主，不应承担交互语义；
- 放在每个 chip：选区会跨多个元素，`readTextSelection` 要求两端在同一个 source 内，直接失效。

标记加上后，官方 `useTextInteraction` 会照常：

1. 在选区结束时派发 `trigger: "selection"`；
2. 调 `message-quotes` 的 `onInteraction`；
3. 在 `conversation.chat.text-interaction` 浮层渲染「引用文本」；
4. 点击时 `readText()` 从增强气泡的 DOM 投影取文本，再 `inputActions.insertQuote(text)`。

插件**不注册**该交互，也不实现按钮，因此 locale、Session 可写判断、subagent 限制、composer 插入/撤销等全部沿用官方行为。

### 4.2 紧凑预览：复用官方 `QuotePreview`

从 primitives 解构 `QuotePreview`，在 `chipElement` 增加：

```js
case 'quote':
  return typeof QuotePreview === 'function'
    ? h(QuotePreview, { key, text: data.text ?? chip.raw })
    : chip.raw;
```

要点：

- `data.text` 是 `quoteTextOf` 解码后的纯文本；不要用 `chip.raw`，否则预览里会带 `> ` 前缀。
- 不传 `removal`：发送后的消息不是 composer，引用不可移除；与官方 `QuotedUserText` 一致。
- 保留 `key`，因为该元素会被 portal 到哨兵占位 `span`。
- `typeof QuotePreview !== 'function'` 的回退只用于旧版/异常环境：旧版没有 quote 节点，正常不会触发；这是防御，不是兼容承诺。
- 哨兵落进 `pre` / `code` 时，现有 `splitSentinelText(..., opaque = true)` 仍返回 `chip.raw`，因此代码围栏里的 `> …` 保持字面量；见 §7。

### 4.3 引用预览放在块级位置还是内联位置

这是本方案唯一需要明确取舍的地方。

**推荐 A：保留 `\n\n` 块边界，让 `QuotePreview` 出现在引用所在的块位置。**

- `composeMessage` 继续忽略 `text` 节点（包括 `display: " "` 的分隔节点），Markdown 源保持 `A\n\n哨兵\n\nB`。
- `MarkdownText` 生成 `<p>A</p><p>哨兵</p><p>B</p>`，`restoreChips` 把中间段落里的哨兵文本节点替换成承载 `QuotePreview` 的 `span`。
- 结果：紧凑预览仍然出现，但它独占一个段落，前后保留 Markdown 的段间距；不会把引用前后的两个块合并。
- 优点：不破坏插件「整条消息一篇 Markdown」的核心承诺；引用后面的列表、表格、代码围栏仍是独立的块；实现最小。
- 代价：与原生纯文本流的内联外观不完全一致（原生会把前后 `\n\n` 显示成空格）。

**备选 B：消费 `quoteRule` 的 `display: " "` 节点，复刻原生内联流。**

- 在 `composeMessage` 里对 `id === "text"` 且 `data.display !== undefined` 的节点也做替换：`markdown += text.slice(cursor, item.start) + item.data.display; cursor = item.end`。
- 源会变成 `A 哨兵 B`，`QuotePreview` 与前后文在同一段内联排列，视觉上最接近原生。
- 代价：引用前后的 `\n\n` 被压成空格，会改变 Markdown 块结构。例如：

  ```text
  > 引用

  - 列表项
  ```

  会变成 `哨兵 - 列表项`，列表不再成列表；段落、表格、代码围栏也可能被合并。这与插件「用 Markdown 结构渲染 prompt」的目标冲突。

**建议先采用 A**，并在 README 的「已知行为与限制」里写明「引用预览按块位置显示，不合并相邻块」。如果目视验收后认为必须完全复刻原生的内联外观，再把 B 作为显式选项评估；不建议默认 B。

可选的视觉微调（不影响语义）：对只包含引用哨兵的段落降低上下 margin，例如用 `.dep-md-host-inner p:has(> .dep-chip-slot [data-quote-preview])` 收紧间距。这个 CSS 依赖 `:has` 与 portal 后的 DOM，建议在真实浏览器里确认后再加，不作为首版必需项。

### 4.4 不需要改的东西

- **不改 composer**：引用插入、QuoteNode、序列化、撤销都在 `dsh-client-ui-conversation` 内，插件不参与。
- **不改 Host 半**：quote 没有会话元数据，`dsh-message-quotes` 的 Host 入口是空 `apply()`。
- **不改 `conversation.user.text` factory**：该 factory 不可替换（见 `FEASIBILITY@0.2.1-rc.2.md` §4.1）。
- **不注册 `conversation.user.text.node` 的 `quote` 格**：那会同时改变原生气泡的渲染，且 keyed 格已有官方条目；增强插件只在自己的 DOM 内复用 primitive。
- **不加 locale key**：按钮文案由 `dsh-message-quotes` 的 `messageQuotes.quote.add` 提供；`QuotePreview` 没有文案。
- **不新增依赖**：`@deepseek-ai/dsh-client-ui-primitives` 已在 `dsh.client.inject` 和运行时 require 中。

---

## 5. 问题与解决办法

| 症状 | 根因 | 修法 | 后续注意 |
| --- | --- | --- | --- |
| 增强 prompt 中选中文本没有「引用文本」 | 增强气泡缺少 `data-text-interaction-source`，`readTextSelection` / `available` 直接拒绝 | 在 `.dep-bubble` 上加该属性 | 该属性目前是 DOM 契约而非编目 API；加一条源码守卫/注释，升级时核对 |
| 发送后引用显示成裸 `> …` | `quote` 节点被当作通用 chip，`chipElement` 落到 `default: raw` | 增加 `case 'quote': QuotePreview` | 必须用 `data.text`，不能用 `raw` |
| 引用预览在代码围栏里不出现 | 哨兵落在 `pre` / `code` 内时 `splitSentinelText` 走 opaque 分支，故意回退原文 | 保持现状 | 与现有 chip 的围栏降级一致；README 记录 |
| 引用预览独占段落，和原生内联流不同 | 推荐 A 保留 Markdown 块边界 | 接受并在 README 说明；如需原生外观再评估 B | B 会合并前后块，需明确取舍 |
| 旧版 primitives 没有 `QuotePreview` | 版本差异 | `typeof` 回退到 `chip.raw` | 旧版没有 quote 节点，正常不会走到；不要把它当兼容承诺 |
| 插件先渲染、`message-quotes` 后注册，quote 规则未进入本次求值 | 插件的 `composeMessage` 只依赖 `text` / `facts` / evaluator，不订阅 `userText` revision | 启动顺序通常保证 quote 插件已在；如需硬化，可在 `inject` 里加入 `uiConversation.userText.getSnapshot()/subscribe()` 并用 `useSyncExternalStore` 驱动重算 | 同一条消息重渲染时 evaluator 会重新读取规则；不是首版阻断项 |
| `QuotePreview` 在独立 React root 中拿不到 `HoverCardGroup` 上下文 | `MarkdownMount` 由 `createRoot(host)` 挂载，不继承外层 context | `HoverCard` 的 `grouped` 上下文是可选的；无 provider 时仍渲染独立 popover | 若以后需要组内互斥 hover，再在 Markdown root 内包 `HoverCardGroup` |

---

## 6. 备选方案对比

| 方案 | 内容 | 结论 |
| --- | --- | --- |
| **A（推荐）** | `.dep-bubble` 加 source 标记；`chipElement` 增加 `quote → QuotePreview`；保留 `\n\n` | 改动最小、复用官方组件、不破坏 Markdown 结构 |
| B | 在 A 基础上消费 `display: " "` 分隔节点，复刻原生内联流 | 视觉最接近原生，但会合并引用前后块；作为可选项 |
| C | 通过 `renderSlot("conversation.user.text.node", …)` 调用官方 `quote` 格 | **不可行**：chat node 的注册没有声明该 children，`renderSlot` 会抛 `SlotOwnershipError`；见 `FEASIBILITY@0.2.1-rc.2.md` §4.2 |
| D | 注册自己的 `conversation.user.text.node` `quote` 格 | 会影响原生气泡，且与官方同 key 条目冲突；不采用 |
| E | 替换 `conversation.user.text` factory | factory 已存在，`registerFactory` 直接抛错；不采用 |
| F | 让 MarkdownText 把 `> …` 渲染成 blockquote，再用 CSS 伪装成预览 | 没有引用图标、没有 hover 全文、与原生 `QuotePreview` 不一致；不采用 |
| G | 自绘一个 QuotePreview 副本 | 复制样式与行为，升级易漂移；不采用 |

---

## 7. 风险与边界

1. **DOM 契约风险。** `data-text-interaction-source` 是 `dsh-client-ui-chat` 内部使用的属性，不在公开服务目录里。0.2.2-rc.1 的实现明确以它为准；升级时要重新核对 `readTextSelection` / `available`。
2. **Primitive 导出风险。** `QuotePreview` 是 primitives 的公开导出，`dsh-message-quotes` 自己也用它；但 props `{ text, removal? }` 仍是实现细节。测试里加 `QuotePreview` 桩并断言 `text` 来源，升级时容易发现。
3. **块级 vs 内联。** 推荐 A 的引用预览是块级位置；如果用户要求与原生像素级一致，需要接受 B 对 Markdown 块结构的合并代价。
4. **代码围栏。** `quoteRule` 在 Markdown 之前运行，可能把围栏里的 `>` 行识别为 quote；哨兵落进 `pre`/`code` 后回退原文，因此预览不出现但文本不丢。与现有 chip 的限制同源。
5. **规则时序。** `message-quotes` 是 web bundle 的一部分，通常先于本地插件加载；如果热重载/禁用顺序异常，已渲染的消息可能暂时没有 quote 节点。`UserText` 通过 revision 订阅规避，本插件暂未订阅；如出现，需加 `useSyncExternalStore`。
6. **文本选择语义。** `readText()` 读取的是增强气泡的可见 DOM 投影，不是原始 Markdown。代码块、chip、引用预览的可见文本可能与原文不同；这与原生气泡的行为一致，不是新增偏差。
7. **版本与契约。** 建议插件版本升到 `3.1.0`。`peerDependencies` 的 `^0.2.1-rc.2` **不覆盖** `0.2.2-rc.1`：按 semver 预发布规则，范围里的预发布比较器只匹配同一 `major.minor.patch`，实测 `satisfies('0.2.2-rc.1', '^0.2.1-rc.2') === false`；应改为 `^0.2.2-rc.1`。README 的「最后实质性修改于Harness版本」改为 `0.2.2-rc.1`。
8. **重启。** Client 半改动需要重启 DSH 并刷新 GUI；按工作区约定，代码完成后应停止后续工作并提示用户重启，不用 workaround 规避。

---

## 8. 实施步骤（下一轮）

1. **`client.js`**
   - 从 `@deepseek-ai/dsh-client-ui-primitives` 解构 `QuotePreview`。
   - 在 `EnhancedUserNode` 的 `.dep-bubble` 上增加 `'data-text-interaction-source': ''`。
   - 在 `chipElement` 的 `switch` 中增加 `quote` 分支；文本取 `data.text ?? chip.raw`，`typeof QuotePreview === 'function'` 时渲染，否则回退 `chip.raw`。
   - 保持 `composeMessage` 不变（方案 A）；补注释说明 quote 节点与 `\n\n` 的处理。
2. **`test/lifecycle.test.mjs`**
   - primitives 桩加入 `QuotePreview`。
   - `composeMessage` 增加「含 quote 节点的消息」用例：断言哨兵源、`chips[0].id === 'quote'`、`data.text`、`raw`。
   - `chipElement` 增加 quote 用例：断言渲染 `QuotePreview`、传入解码后的 `text`、不传 `removal`。
   - 增加源码守卫：`.dep-bubble` 带 `data-text-interaction-source`；`QuotePreview` 来自 primitives；不注册 `conversation.user.text.node`。
   - 更新检查计数与 README 中的测试数。
3. **`package.json`**：`version` 升到 `3.1.0`（新增能力，向后兼容）；`peerDependencies["@deepseek-ai/dsh"]` 改为 `^0.2.2-rc.1`（见 §7.7；旧的 `^0.2.1-rc.2` 不覆盖 `0.2.2-rc.1` 的预发布版本）。
4. **`README.md`**
   - 首行版本改为 `0.2.2-rc.1`。
   - 「效果」表加入「选中文本 → 引用文本」「引用预览」两行。
   - 「工作原理」补充：增强气泡保留 `data-text-interaction-source`；`quote` 节点用 `QuotePreview` 渲染，不经过 `conversation.user.text.node`。
   - 「已知行为与限制」补充：引用预览按块位置显示（方案 A，不合并相邻块）；代码围栏内退化为原文；选择按钮由官方 `message-quotes` 拥有。
5. **验证**
   - 在插件目录运行 `npm run verify`（它包含 `npm test`、清单契约、Host 半零导入等）。
   - 如果只改 Client 半，Host 半零导入断言应保持不变。
6. **重启与目视验收**
   - 重启 Host、刷新 GUI。
   - 按 §9 逐项检查，并重点确认增强气泡的选区按钮、发送后的预览、悬停全文、引用前后块结构。
   - 如果目视发现必须内联，再评估方案 B，而不是在首版直接合并块。

---

## 9. 验收标准

- 在增强 prompt（`user` 与 `steering` 都覆盖）中选中文本，出现「引用文本」按钮；点击后 composer 出现可移除的引用预览；发送后消息里出现紧凑引用预览。
- 引用预览显示解码后的文本（无 `> ` 前缀），超长时省略，悬停显示完整文本。
- 多行引用、多条引用、引用位于消息开头/结尾、引用前后有普通文本时，均能显示预览且不报错。
- 引用文本里的 `@file` / `/skill` 等 token 在预览中按纯文本显示，不被渲染成 chip（与原生 `message-quotes` 一致）。
- 引用在代码围栏内时，按现有规则退化为原文，不丢字符。
- 预览不破坏引用前后的 Markdown 块（方案 A）：列表、代码围栏、表格仍是独立块。
- 复制按钮仍复制原始 Markdown 文本（含 `> ` 前缀），不受预览影响。
- 附件、引用摘要、操作行不因为 source 标记而变成可选区（与原生一致）。
- 禁用插件后回退到内置渲染，无残留样式；原生引用按钮与预览仍正常。
- `npm run verify` 全部通过；README 的版本声明、功能表、限制与测试数同步更新。

---

## 10. 参考坐标

| 文件 / 符号 | 行（0.2.2-rc.1 发行包） | 用途 |
| --- | --- | --- |
| `dsh-client-ui-chat/lib/client.js` · `readTextSelection` / `sourceOf` | 777 | 选区必须落在同一个 source |
| 同上 · `available` | 817 | 复核 source trait 与可见性 |
| 同上 · `useTextInteraction` | 862 | 选区、浮层定位、交互派发 |
| 同上 · `conversation.chat.text-interaction` 渲染 | 3683 | 「引用文本」按钮浮层 |
| 同上 · `UserContent` / `UserMessageBubble` | 9359 / 9395 | 原生气泡的 `data-text-interaction-source` |
| `dsh-message-quotes/lib/client.js` · `QuoteSelectionAction` | 29 | 按钮与 `insertQuote` |
| 同上 · `quoteTextOf` / `messageQuoteRanges` / `quoteRule` | 74 / 82 / 94 | 引用识别、解码、`\n\n` 显示节点 |
| 同上 · `QuotedUserText` | 63 | `QuotePreview` 使用方 |
| 同上 · `apply` 注册 | 159–190 | 交互、rule、两个槽位 |
| `dsh-client-ui-conversation/lib/client.js` · `UserText` / `renderSlot` | 4243 / 4266 | 逐节点渲染与 fallback |
| 同上 · `normalizeQuoteBoundaries` / `serializeDraftPrompt` | 5196 / 5231 | composer 序列化出 `\n\n> …\n\n` |
| 同上 · `QuoteNodeView` / `QuoteNode` / `getTextContent` | 13770 / 13782 / 13837 | composer 引用节点 |
| 同上 · `insertQuote` | 15186 | 插入引用 |
| 同上 · rules / factory children | 22554–22570 | 内置 userText 规则与 keyed 子槽 |
| `dsh-web-frontend/.../index-BgUyXZcc.js` · `QuotePreview` | shell bundle 导出 | 紧凑预览组件 |
| `dsh-web-frontend/.../index-lh_YM6sT.css` · `_quote_at713_*` | CSS | 预览的内联布局、省略与 popover |
| 插件 `client.js` · `composeMessage` | 182 | 当前把 quote 当通用 chip |
| 插件 `client.js` · `chipElement` | 222 | 缺 `quote` 分支 |
| 插件 `client.js` · `EnhancedUserNode` / `.dep-bubble` | 527 / 583–600 | 缺 `data-text-interaction-source` |
| 插件 `client.js` · `apply` | 621 | `user` / `steering` 两个 keyed 注册 |

> 行号随发行构建可能变化；升级时以符号和结构为准，行号只用于快速定位。

---

## 11. 实施记录（2026-11-07）

### 11.1 决策与范围

用户确认采用 **方案 A**：保留引用前后的 `\n\n` 块边界，`QuotePreview` 按引用所在的块位置显示；不消费 `quoteRule` 的 `display: " "` 分隔节点。

本轮只改 Client 半、测试、清单与文档；Host 半仍为零导入，未改 composer、未新增依赖、未新增 locale key。

### 11.2 实际改动

| 文件 | 改动 |
| --- | --- |
| `client.js` | 从 primitives 解构 `QuotePreview`；`chipElement()` 增加 `quote` 分支，使用解码后的 `data.text`，不传 `removal`；`EnhancedUserNode` 的 `.dep-bubble` 增加 `data-text-interaction-source: ''`；`composeMessage()` 保持原样（方案 A，未消费 `display` 节点）；顶部注释补充引用与选区说明 |
| `test/lifecycle.test.mjs` | primitives 桩加入 `QuotePreview`；新增 5 项 quote 组合检查（块边界、单 chip、解码文本、raw 回退、纯引用消息）、3 项 quote 映射检查（`QuotePreview`、`text`、无 `removal`）、2 项源码守卫（气泡标记、primitive 来源）；总数 49 → 59 |
| `package.json` | `version` 3.0.0 → 3.1.0；`peerDependencies["@deepseek-ai/dsh"]` `^0.2.1-rc.2` → `^0.2.2-rc.1`；`description` 补充引用预览 |
| `README.md` | 「最后实质性修改于Harness版本」→ `0.2.2-rc.1`；效果表加入选区按钮与 `QuotePreview`；工作原理补充 `quote` 规则与气泡标记；已知限制补充块位置、代码围栏降级、按钮归属；测试数 49 → 59；补充 peer 范围与手动验收步骤 |
| `FEASIBILITY@0.2.2-rc.1.md` | 本文件；新增本节实施记录 |

实施后的关键代码形态：

```js
// chipElement()
case 'quote':
  return typeof QuotePreview === 'function'
    ? h(QuotePreview, { key, text: data.text ?? chip.raw })
    : chip.raw;

// EnhancedUserNode 的气泡
h('div', {
  className: 'dep-bubble',
  'data-text-interaction-source': '',
}, ...)
```

`composeMessage()` 没有改成消费 `display` 节点，所以引用两侧的 `\n\n` 仍在 Markdown 源里；测试 `quote does not consume the surrounding blank lines` 直接断言了这一点。

### 11.3 验证结果

- `npm test`：**59 项检查全部通过**，0 失败。
- `npm run verify`：**all checks passed**（真实文件、依赖、清单、构建系统一致、`node --check`、Host 半导入与零导入、`npm test`）。
- 首次 `verify` 因插件目录里预存的 `.DS_Store` 失败；删除该 macOS 边角文件后重跑通过。此文件不是本轮代码产生的，但与构建系统的「真实文件」不变量有关，记录在此。
- 尚未做真实浏览器验收：需要在 Host 重启、GUI 刷新后按 §9 检查选区按钮、composer 插入、发送后预览与悬停全文。

### 11.4 与方案的偏差

无功能偏差。实现选择方案 A；`QuotePreview` 仍是官方 primitive，没有复制 CSS 或自绘预览。`QuotePreview` 未定义时的 `chip.raw` 回退仅作为防御分支存在，未在 0.2.2-rc.1 上触发。

### 11.5 后续注意

- 本次是 Client 半改动，必须重启 Host 后才会加载到新的 `client.js`；按工作区约定，应在交付时提示用户重启，不用 workaround 绕过。
- 若重启后目视发现引用预览的块间距不可接受，再评估 §4.3 的方案 B；不要在未验证的情况下默认合并块。
- `data-text-interaction-source` 与 `QuotePreview` 的 props 都是升级时首先要复核的上游契约。

---

# Prompt 操作区「复制」提示宽度异常 —— 0.2.2-rc.1 修复可行性

- 复核日期：2026-11-07
- 对象：DSH `0.2.2-rc.1`，插件 `@local/dsh-enhanced-prompt` v3.1.0（实施后 v3.1.1）
- 文档性质：缺陷调查、修复方案与实施记录（2026-11-07）。§1–§9 为调查与方案；实际改动与验证见 §10。
- 触发：用户报告——插件接管用户 prompt 气泡后，悬停气泡下方的「复制」按钮，浅色模式下黑色提示条宽度过大、文字左对齐、右侧大量空白；未启用插件时提示条宽度恰好包住文字。

## 1. 目的与范围

修复增强气泡下方操作区（`MessageActions`：时间文本 + 复制按钮）的 Tooltip 样式回归：让「复制」提示条恢复为 `width: max-content` 的自然宽度，与官方气泡一致。

范围限定为**插件注入的 CSS 选择器**：

- 不改 primitives 的 `Tooltip`，不改官方 `UserMessageBubble`；
- 不改操作区 DOM 结构与交互，不改复制逻辑；
- 不改 Host 半，不新增依赖、locale key 或设置项。

## 2. 现象与证据

### 2.1 两条 CSS 规则相撞

插件样式表（`client.js` 的 `CSS` 数组）里有一条 0.2.0/0.2.1 时期留下的「加宽」规则：

```css
:is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]) [class*="_bubble"]{
  box-sizing:border-box;width:100%
}
```

它的本意是让**官方 `UserMessageBubble`** 与模型输出等宽（0.2.1 插件不再自绘气泡，只能靠这条规则改内置气泡）。`[class*="_bubble"]` 是一个类名子串匹配，当时用来避开 CSS Module 每次构建都会变的哈希。

Tooltip 的 CSS Module 局部名恰好也叫 `bubble`：

```css
/* dsh-web-frontend 的 shell CSS，符号 Np.bubble */
._bubble_44yfq_1{
  display:inline-flex;align-items:safe center;gap:8px;
  position:fixed;z-index:100;width:max-content;box-sizing:border-box;
  max-width:min(50vw,calc(100vw - 24px));…
  padding:3px 7px;background:var(--dsw-alias-tooltip-bg);
  color:var(--dsw-static-neutral-bluish-00);…
}
```

于是这条插件规则同时命中了 Tooltip 的 `_bubble_44yfq_1`。

### 2.2 Tooltip 就在用户 flow 的 DOM 里

`Tooltip`（shell bundle 中的 `Mn`）默认**不 portal**：它把提示条 `<span className={Np.bubble} role="tooltip">` 与触发元素一起渲染，只有传入 `portal: true` 才 `createPortal(…, document.body)`。

插件的复制按钮没有传 `portal`：

```js
h(Tooltip, { label, side: 'bottom' },
  h('button', { className: 'dep-action', … }))
```

而它位于 `.dep-actions` → `.dep-row` → `conversation.chat.node` 槽位 → Chat 的 flowItem 中；flowItem 由 `dsh-client-ui-chat` 打上 `data-chat-flow-kind`（`user` / `steering` 等）。因此 Tooltip 的 `_bubble_44yfq_1` 是 `[data-chat-flow-kind="user"]` 的后代，完整命中上述选择器。

### 2.3 层叠结果

- 插件规则特异性 `(0,2,0)`（`:is()` 内的属性选择器 + 后代属性选择器），高于 Tooltip 自身 `._bubble_44yfq_1` 的 `(0,1,0)`，所以 `width:100%` 覆盖 `width:max-content`。
- 提示条是 `position:fixed`，`width:100%` 的百分比按初始包含块（视口）解析；再被 Tooltip 自己的 `max-width:min(50vw, calc(100vw - 24px))` 截住。
- `display:inline-flex` 没有设置 `justify-content`，默认从行首排布，所以文字落在左侧，右侧留出被 `max-width` 限制后的空白。
- 官方气泡没有这条插件样式，所以原生提示条仍是 `width:max-content`，恰好包住文字。

这解释了「只在插件激活时出现、浅色模式下是黑底白字宽条」的全部现象。

### 2.4 最小复现（headless Edge）

不启动 DSH，仅用相同声明复现：

- 视口 `748px`，提示文字「复制」：
  - Tooltip 规则 + 插件规则 → 计算宽度 `374px`（= `50vw`，被 `max-width` 截断），`position:fixed`、`display:flex`、左对齐；
  - 去掉插件规则（对照）→ `40px`（文字 + 左右各 `7px` padding）；
  - 把插件选择器换成 `[data-message-bubble]` → `40px`；
  - 单独验证新选择器仍能加宽官方气泡：`data-message-bubble` 元素在 `600px` 容器内得到 `600px`。
- 复现文件在 `/tmp`，未写入插件目录。

结论：缺陷与修法都可由同一组 CSS 声明稳定复现，不依赖 DSH 的运行时状态。

## 3. 根因

**一条为官方气泡写的 `[class*="_bubble"]` 加宽规则，误中了 primitives 的 Tooltip 气泡（同名 CSS Module 局部名 `bubble`）。** `position:fixed` 把 `width:100%` 放大到视口级，`max-width:50vw` 再把它截成一个宽黑条；`inline-flex` 的默认起点让文字左对齐。

## 4. 核心进路

**把「加宽官方气泡」的选择器从类名子串匹配改成官方显式 DOM 标记 `[data-message-bubble]`。**

`dsh-client-ui-chat` 的 `UserContent` 给官方 `UserMessageBubble` 传了 `"data-message-bubble": ""`；这个属性只出现在官方消息气泡上，Tooltip、chip、代码块复制按钮都不带。改后：

```css
:is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]) [data-message-bubble]{
  box-sizing:border-box;width:100%
}
```

- 插件自绘的 `.dep-bubble` 已有 `width:100%`，不依赖这条规则；
- 若插件渲染器 abdicate、官方气泡回退，这条规则仍能加宽它；
- `data-message-bubble` 找不到时只是宽度退回原生 `~70%`，与旧规则失配时的降级行为一致。

### 备选方案对比

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| A（选用） | `[data-message-bubble]` | 精确命中官方气泡；同时修好所有落在用户 flow 内的 primitives Tooltip；保留降级加宽 |
| B | 给选择器加 `:not([role="tooltip"])` | 只挡住 Tooltip，仍会误中将来任何 `_bubble` 类名；治标不治本 |
| C | 复制按钮的 `Tooltip` 传 `portal: true` | 提示条移到 `document.body`，绕开祖先选择器；但代码块复制按钮、引用 chip 等其他 Tooltip 仍会被误中，且改变层级/定位行为，不能单独作为根因修复 |
| D | 删掉这条规则 | 插件自绘气泡不受影响，但失去「插件 abdicate 时官方气泡仍等宽」的降级；不如 A 保留意图 |

不选 B/C 作为唯一修法：根因是「类名子串匹配跨模块误伤」，不是「这一个 Tooltip 恰好被误伤」。

## 5. 问题与解决办法

| 项 | 内容 |
| --- | --- |
| 症状 | 插件激活时，悬停「复制」按钮出现超宽黑底提示条，文字左对齐、右侧空白；未激活时正常 |
| 根因 | 插件 `[class*="_bubble"]{width:100%}` 误中 Tooltip 的 `_bubble_44yfq_1`；`position:fixed` + `100%` + `max-width:50vw` 放大成宽条，`inline-flex` 默认左对齐 |
| 修法 | 将加宽规则的目标改为 `[data-message-bubble]`，不再用 CSS Module 局部名子串 |
| 影响面 | 只影响「官方气泡加宽」这条降级规则；插件自绘气泡、复制逻辑、Tooltip 组件本身均不变 |
| 后续注意 | 插件样式不要再按 `class*="_xxx"` 匹配任何可能与其他 CSS Module 同名的局部名；优先使用上游的显式 `data-*` 标记。`_userStack` 那条规则仍保留：它作用于附件栏的官方 content factory，且不与 Tooltip 同名 |

## 6. 实施步骤（下一轮）

1. `client.js`：仅替换 `CSS` 数组第 121 行的选择器（`[class*="_bubble"]` → `[data-message-bubble]`），注释同步说明「官方气泡标记」。
2. `test/lifecycle.test.mjs`：把「width: bubble spans the column」改为断言 `[data-message-bubble]{…width:100%}`；新增一条回归守卫，断言样式表中不再出现 `[class*="_bubble"]`（防止重新引入同名误伤）。检查数 59 → 60。
3. `package.json`：`version` `3.1.0` → `3.1.1`（行为修复）。
4. `README.md`：把「唯一依赖内置类名的是『加宽』两条规则」改为「`_userStack` 用稳定局部名；官方气泡改用 `data-message-bubble` 属性」，测试数更新为 60。
5. `FEASIBILITY@0.2.2-rc.1.md`：在本章追加实施记录（实际改动、`verify` 结果、目视验收结果）。
6. 运行 `npm run verify`；通过后按工作区约定提示重启 Host，再刷新 GUI 做目视验收。

## 7. 验证与验收

静态：

- `npm run verify` 全绿（含 `node --check`、Host 半零导入、清单契约与行为测试）；
- 样式表不再包含 `[class*="_bubble"]`，且仍包含 `[data-message-bubble]{…width:100%}`；
- `[class*="_userStack"]` 加宽规则保持不变。

目视（重启 Host、刷新 GUI 后）：

1. 悬停已发送 prompt 下方的「复制」按钮：黑色提示条宽度应贴合「复制」二字（约 40px，含 padding），文字不再左对齐留白；
2. 与禁用插件时的原生提示条并排对比，宽度应一致；
3. 悬停 prompt 内代码块的复制按钮（若显示 Tooltip），提示条同样应贴合；
4. 确认 prompt 气泡仍与模型输出等宽，附件栏与引用摘要布局未回退；
5. 浅色与深色模式各看一次（提示条配色由 `--dsw-alias-tooltip-bg` 决定，本次不改）。

因为这是 Client 半改动，**必须重启 Host** 才加载新的 `client.js`；不能用页面刷新代替。

## 8. 参考坐标

| 位置 | 符号 / 选择器 | 坐标（0.2.2-rc.1 构建） |
| --- | --- | --- |
| 插件 `client.js` | 加宽规则 | 第 121 行 |
| 插件 `client.js` | `MessageActions` 的 `Tooltip` 调用 | 第 529–536 行（`side: 'bottom'`，未传 `portal`） |
| 插件 `client.js` | 操作区挂载 | 第 642 行 |
| shell `index-BgUyXZcc.js` | `Np = { bubble: "_bubble_44yfq_1", label: "_label_44yfq_30" }` | 第 123 行 |
| shell `index-BgUyXZcc.js` | `function Mn(...)`（Tooltip） | 第 132 行 |
| shell `index-BgUyXZcc.js` | `createPortal(te, document.body)`（`portal` 分支） | 第 132 行 |
| shell `index-lh_YM6sT.css` | `._bubble_44yfq_1{…width:max-content…max-width:min(50vw,…)}` | 第 1 行，列 11669 |
| `dsh-client-ui-chat/lib/client.js` | flowItem 的 `"data-chat-flow-kind"` | 第 4589 行 |
| `dsh-client-ui-chat/lib/client.js` | `UserMessageBubble` 的 `"data-message-bubble": ""` | 第 9394 行 |
| `dsh-client-ui-chat/lib/client.js` | `_userStack` 宽度规则 | 第 5053 行 |
| `test/lifecycle.test.mjs` | 当前 `[class*="_bubble"]` 断言 | 第 278 行 |

shell bundle 与 CSS 的文件名带内容哈希，升级后会变；定位时以符号 `Np.bubble`、`Mn`、`data-message-bubble` 为准，行号只作辅助。

## 9. 风险与边界

- **上游标记变化**：若未来 `dsh-client-ui-chat` 不再传 `data-message-bubble`，加宽规则静默失配；插件自绘气泡不受影响，只是失去 abdicate 时的降级加宽。这是可以接受的降级面。
- **不改变 Tooltip 自身契约**：提示条仍由 primitives 负责定位、宽度与配色；插件只是不再误改它。
- **同类问题排查**：任何 `[class*="_xxx"]` 都可能跨 CSS Module 撞名；本插件只保留 `_userStack` 这一处局部名匹配，且已确认附件栏中不存在同名 Tooltip。
- **重启要求**：Client 半改动必须重启 Host 才会生效，交付时应主动停止并提示用户，不用 workaround。

## 10. 实施记录（2026-11-07）

### 10.1 决策与范围

用户确认「按方案实施」，采用方案 A（`[data-message-bubble]`）。只改 Client 半的 CSS 选择器、测试、版本号与文档；未改 Tooltip 用法、复制逻辑、操作区 DOM、Host 半、依赖或 locale。

### 10.2 实际改动

| 文件 | 改动 |
| --- | --- |
| `client.js` | 第 121 行加宽规则：`[class*="_bubble"]` → `[data-message-bubble]`；上方注释改为说明「附件栏仍按 `_userStack` 稳定局部名匹配，官方气泡改用显式标记，避免误中 primitives 的 `_bubble_*` Tooltip」 |
| `test/lifecycle.test.mjs` | 「width: bubble spans the column」改为断言 `[data-message-bubble]{…width:100%}`；新增回归守卫「no class-substring bubble widening (Tooltip collision)」，断言样式表不再出现 `[class*="_bubble"]`；检查数 59 → 60 |
| `package.json` | `version` 3.1.0 → 3.1.1 |
| `README.md` | 「关键约束」第 3 条改为：附件栏用 `_userStack`，官方气泡用 `data-message-bubble`，并说明 `_bubble` 子串会误中 fixed 定位的 Tooltip；测试数 59 → 60；测试覆盖补充该守卫 |
| `FEASIBILITY@0.2.2-rc.1.md` | 本文件；新增本节实施记录 |

实施后的关键代码形态：

```js
':is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]) [data-message-bubble]{box-sizing:border-box;width:100%}',
```

与实施前的唯一功能差异就是这条选择器；其余 CSS 声明、DOM 与组件调用均未变。

### 10.3 验证结果

- `npm test`：**60 项检查全部通过**，0 失败（新增守卫通过，原 `_bubble` 断言已替换）。
- `npm run verify`：**all checks passed**（真实文件、依赖、清单、构建系统一致、`node --check`、Host 半导入与零导入、`npm test`）。
- headless Edge 的最小复现（§2.4）在实施前已验证：旧规则下提示条 `374px`（= `50vw`），换成 `[data-message-bubble]` 后 `40px`（文字 + padding），且官方气泡仍可加宽到容器宽度。实施后的选择器与该复现完全一致。
- 尚未做真实 GUI 目视验收：需要重启 Host、刷新 Web GUI 后按 §7 检查「复制」Tooltip 宽度、代码块 Tooltip、气泡宽度与浅/深色两种主题。

### 10.4 与方案的偏差

无。未采用 `:not([role="tooltip"])`，也未给 Tooltip 加 `portal`。

### 10.5 后续注意

- 本次是 Client 半改动，必须重启 Host 后才会加载新的 `client.js`；按工作区约定，交付时提示用户重启，不用页面刷新代替，也不以 workaround 规避。
- 重启后若仍看到宽提示条，先确认加载的是 3.1.1 的 `client.js`（插件页版本/文件时间），再检查 `[data-message-bubble]` 是否仍由上游 `UserContent` 输出。
- 上游若改名 `data-message-bubble`，只会失去「插件 abdicate 时官方气泡等宽」的降级；插件自绘气泡的 `.dep-bubble{width:100%}` 不受影响。

