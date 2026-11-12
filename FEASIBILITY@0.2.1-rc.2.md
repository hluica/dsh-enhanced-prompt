# 用户 Prompt 统一渲染 —— 可行性复核

- 复核日期：2026-10-17
- 对象：DSH `0.2.1-rc.2`，插件 `@local/dsh-enhanced-prompt` v3.0.0
- 问题：chip 出现在列表项中时，chip 前后各产生一次换行；同一消息被拆成多篇独立 Markdown 文档
- 结论：**「整条消息一篇 Markdown + chip 原位插入」可实现，但必须替换 `conversation.chat.node` 的 `user` / `steering` 渲染器。`conversation.user.text` factory 不可替换，因此不存在比这更轻的接入点。**
- 推荐方案：§5 方案 C（薄替换 chat node + 复用内置内容栈）

> 本文件是独立复核记录，不修改 `FEASIBILITY@0.2.0-rc.2.md`（0.2.0 建插件、0.2.1 适配）与其中的 §12。

---

## 1. 结论摘要

| 问题                                                                         | 结论                                                 | 依据                                                                              |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| 逐段渲染这条路上还能修好吗？                                                 | **不能**                                             | 切分发生在 Markdown 解析之前，详见 §3                                             |
| 能否替换 `conversation.user.text` factory，自己统一渲染？                    | **不能**                                             | `registerFactory` 对同名与已声明子槽位均抛错，§4.1                                |
| 替换 chat node 后，能否调用 chip 所在的 `conversation.user.text.node` 槽位？ | **不能**                                             | `renderSlot` 受本条目 children 约束，§4.2                                         |
| 能否复用内置的「用户内容栈」（附件、额外块、引用摘要）？                     | **能**                                               | `renderFactorySlot` 是名字通用的，§4.2                                            |
| 插件能否拿到切分解析器？                                                     | **能**                                               | `uiConversation` 是 Cordis Service，`userText.createEvaluator()` 可用，§4.3       |
| 能否自绘 chip？                                                              | **能**                                               | primitives 导出 `ReferenceChip`，签名 `{appearance,label,title,onActivate}`，§4.3 |
| 唯一可用的接入点                                                             | 替换 `conversation.chat.node` 的 `user` / `steering` | 由上四行推出                                                                      |

---

## 2. 证据来源

1. 发行包源码：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（0.2.1-rc.2，18312 个条目），用最小 asar 读取器按路径读取与正则检索，未解包、未改动。
2. 运行时自省：`cordis_inspect_query` 的 Client `Slots`（`conversation.chat.node`、`factory:conversation.user.text`）。
3. 相关包：`dsh-client-ui-chat`、`dsh-client-ui-conversation`、`dsh-client-ui-reference`、`dsh-client-ui-renderer`、`dsh-web-frontend`（shell bundle 内的 slots 核心与 primitives）。

行号均指对应包的 `lib/client.js`，除非另行注明。

---

## 3. 机制复核：为什么逐段渲染必然破坏结构

### 3.1 切分发生在 Markdown 之前

`UserText`（`dsh-client-ui-conversation`，约 4180 行）先求值、再逐节点渲染：

```js
nodes = evaluate({ text, facts });          // 得到 [{ id, start, end, data }]
...
renderSlot("conversation.user.text.node", { node, raw, interactive },
           { entryKey: node.id, fallback: <UserTextRun text={...} /> })
```

`evaluate` 来自 `uiConversation.userText.createEvaluator()`，其规则（`session`、`file`、`folder`、`skill`、`command`、`secret`）在**纯文本**上匹配 `@…` / `/…` 等 token，把原文切成「文本段 + 引用节点」。

本插件当前替换的是 `key: "text"` 那一格，即**单个文本段**。因此每个段落都被当作一篇完整文档交给 `MarkdownText` 重新解析。

### 3.2 列表项案例的完整推演

原文：

```
- 检查 @a.ts 的实现
```

切分结果：

| 节点 | 原文区间    | 本插件渲染                                                  |
| ---- | ----------- | ----------------------------------------------------------- |
| text | `"- 检查 "` | `<MarkdownText text="- 检查 "/>` → `<ul><li>检查</li></ul>` |
| file | `"@a.ts"`   | 内置 `FileReference` → chip                                 |
| text | `" 的实现"` | `<MarkdownText text=" 的实现"/>` → `<p>的实现</p>`          |

chip 夹在 `</ul>` 与 `<p>` 之间，两侧都是 block box，于是前后各换行。这两个 block box 是 Markdown 输出的一部分，**外层容器的 `display` 取值（`inline` / `inline-block` / `block`）无法改变它**。上一轮的两次 CSS 调整都作用在外层容器上，因此不可能有效。

### 3.3 同一缺陷的其他表现

- 有序列表在每个切片处重新从 1 编号；
- 引用块、表格、代码围栏被 chip 截断后各自失效或降级；
- 段落被从中间切开时，`text-indent` 与段间距按两段分别计算（用户上一轮观察到的"缩进只作用于前半段"即此）；
- 行内强调、链接跨 chip 时同样断开。

结论：这是**解析顺序**问题，不是排版参数问题。逐段渲染这条路没有修复空间。

---

## 4. 本轮验证结果

### 4.1 factory 不可替换（阻断"替换 factory"路线）

slots 核心的 `registerFactory`（在 shell bundle 内，`dsh-client-ui-slots` 种子模块）：

```js
registerFactory=((e,t)=>{const r=e,i=this.factoryRecord(r.name);
if(i.definition!==void 0)throw new Error(`slot factory "${r.name}" already has a definition`);
for(const l of Object.keys(r.children??{})){const d=this.records.get(l);
if(d?.spec!==void 0)throw new Error(`slot "${l}" is already declared (by ${d.declaredBy??"an unknown entry"})`)}
...})
```

两道拦截都成立：

1. 同名 factory 已有定义 → 抛 `already has a definition`；
2. 即使绕过，重新声明 `conversation.user.text.node` → 抛 `already declared`。

因此**不能**替换 factory 以获得「一次拿到全文」的位置。

### 4.2 `renderSlot` 受 children 约束，`renderFactorySlot` 不受

```js
// boundRenderSlot
const declared = entry.children?.[key];
if (declared === void 0)
  throw new SlotOwnershipError(`slot '${key}' is not declared by this entry's children`);
```

`conversation.chat.node` 声明的 children 只有：`tool.call.toolview`、`conversation.chat.message.images`、`conversation.chat.assistant-actions`、`conversation.chat.reasoning.body`、`conversation.chat.commandview`、`conversation.chat.turnTail`。

**不含** `conversation.user.text.node`。所以即便替换了 chat node，也**无法调用 chip 的槽位**，chip 只能自绘。

反过来，factory 的渲染入口是名字通用的：

```js
render = ((name, props, options) => jsx(FactoryOutlet, { name, inputProps: props, slots, fallback, caller }))
```

无所有权检查。所以替换者可以合法调用 `renderFactorySlot("conversation.chat.user.content", …)`，复用内置的整段内容栈（附件栏、额外块、引用摘要、图片）。

### 4.3 解析器与 chip 组件都可达

- `UiConversation` 是 Cordis Service：`super(ctx, "uiConversation")`（约 4041 行），实例在 19498 行创建。插件可 `inject: ['uiConversation']` 后调用 `ctx.uiConversation.userText.createEvaluator()`。
- 求值器返回 `(input) => document.evaluate(input, rules)`，输出节点含 `{ id, start, end, data }`。
- `ReferenceChip` 由 `@deepseek-ai/dsh-client-ui-primitives` 导出：

  ```js
  function ReferenceChip({ appearance, label, title, onActivate }) // 无 onActivate → <span>，有 → <button>
  ```

  `appearance` 取 `file` / `folder` / `session` / `skill` / `command`。
- 内置 file chip 的数据是 `{ path, label }`，激活调用 `openFile(path)`；chat node 的 owner props 正好提供 `openFile`。

> 注意：`uiConversation` 未出现在 `cordis_inspect` 的 Client Service 目录里（该目录只列"已编目"的服务），但 `super(ctx, "uiConversation")` 证明它是真实服务。这属于**未编目 API**，是方案 C 的一项风险。

---

## 5. 备选方案与成本

### 方案 A：只替换 text 节点（现状）

- 代码量：最小
- 结构：不可修复（§3）
- 结论：**不可用**

### 方案 B：全量替换 chat node

- 自绘 row、内容栈（附件栏、图片、额外块、引用摘要）、actions（复制、时间戳）
- 自行组合一篇 Markdown；chip 用 `ReferenceChip` 自绘
- 成本：高；等于把 0.2.1 重构掉的 chrome 再抄一遍，重新承担升级漂移风险
- 可用性：可行，但不划算

### 方案 C：薄替换 chat node + 复用内置内容栈（推荐）

替换 `conversation.chat.node` 的 `user` / `steering`，只自绘 row 与 actions（约 60 行），其余交给内置：

1. 取 `node.data.content`，用 `contentParts` 拆出 `text` / `attachments` / `rest`；
2. 用 `createEvaluator()` 对 `text` 求值，得到 `[{ id, start, end }]`；
3. 把每个非 `text` 节点的区间替换为哨兵 `\uE000{seq}\uE001`，拼成一篇完整 Markdown 源；
4. `renderFactorySlot("conversation.chat.user.content", { content: { text: 哨兵文本, attachments, extraBlocks: rest }, loadImage, facts: {}, interactive: true })`；
5. 内置 `UserContent` 负责附件、额外块、引用摘要；`UserText` 重新求值时已找不到引用 token（都被哨兵替换），于是产出**单个 text 节点**；
6. 该节点落回本插件的 `text` 渲染器 → `MarkdownText` 渲染整篇 → 遍历返回的 React 树，把哨兵换成 `ReferenceChip`（file/folder/session/… 各自 appearance，`onActivate` 接 `openFile`）。

优点：列表、编号、引用块、代码围栏、缩进全部由**一次**解析决定；附件与引用摘要仍是内置实现。

成本：中。新增约 150–200 行（求值、哨兵拼装、React 树替换、chip 映射）。

---

## 6. 未解风险（方案 C）

1. **哨兵替换需要遍历 `MarkdownText` 返回的 React 元素树**，替换字符串子节点并保持 key 稳定。需要处理：字符串被拆成多个 child、元素本身是 chip 占位、以及不应替换的情形（如哨兵落进代码围栏内部文本）。
2. **哨兵需携带 chip 身份**。实现上用模块级 `Map<compositionId, node[]>`，哨兵里只放序号；compose 时登记、渲染时查表。并发渲染（多 Session）需保证 id 唯一。
3. **其他 matcher 仍可能命中拼好的文本**（`secret`、`command` 等会把文档再次切开）。传 `facts: {}` 可减少命中面，但 `secret` 类规则按文本形态匹配，需实测确认；必要时在 compose 后自检节点数，若 >1 则退回内置渲染。
4. **引用摘要行可能重复**：`UserContent` 会依据 `referenceLabels` 再渲染一行摘要，而 chip 已在正文中。建议 compose 时传空数组或不传。
5. **`interactive` 必须原样传递**，否则 file chip 不可点击（`onActivate` 缺省时渲染为 `<span>`）。
6. **未编目服务**：`uiConversation` 不在公开服务目录里，属于实现细节；若上游改动，方案 C 失效。需要版本断言与失败回退（回退到内置 `UserTextRun`）。
7. **metrics/锚点不受影响**：`data-chat-*` 锚点在 chat node 外层包装上，替换渲染器不触碰；但替换后仍需保留 row 的可聚焦/可选中行为。
8. 回显、队列预览、`/goal` 气泡继续走内置路径（`interactive: false`），本方案不改变它们。

---

## 7. 验收标准

重构完成后必须逐条验证：

- 列表项内含 chip：chip 前后均不换行，缩进只出现一次；
- 有序列表跨 chip 连续编号；
- 同一段落被 chip 切开后，`text-indent` 只作用于段首一次；
- 代码围栏、表格、引用块不被 chip 截断；
- 无 chip 的消息行为与现在一致；
- `interactive: false` 的队列预览、`/goal` 命令气泡不受影响；
- 禁用插件后回退到内置渲染，无残留样式；
- 文件 chip 可点击并打开对应文件；`@session` chip 仍为非交互标签。

---

## 8. 建议

推荐 **方案 C**。它是唯一同时满足「结构正确」与「不重抄 chrome」的路径。

若实施中发现哨兵替换不稳定（第 6 节第 1、3 项），退到**方案 B**：自绘全部 chrome 并直接组合文档，chip 仍用 `ReferenceChip`。不建议继续在方案 A 上做 CSS 修补——§3 已说明那条路没有修复空间。
