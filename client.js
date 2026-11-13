/**
 * Client half of the enhanced-prompt bundle.
 *
 * The shipped user prompt bubble renders its prose as plain text, and DSH 0.2.1
 * splits that prose at every reference token BEFORE Markdown parsing. Rendering
 * each slice separately (the previous approach) therefore breaks any block
 * structure that spans a chip: a list item containing `@a.ts` becomes
 * `<ul>…</ul>` + `<p>…</p>` with the chip wedged between them.
 *
 * This version composes ONE Markdown document per message and puts the chips
 * and quote previews back inside it:
 *
 *   1. evaluate the authored text with the shipped parser
 *      (`uiConversation.userText.createEvaluator()`), which yields
 *      `{ id, start, end, data }` nodes;
 *   2. replace every non-text range with a private-use sentinel, producing a
 *      single Markdown source;
 *   3. render that source once with `MarkdownText`;
 *   4. replace the sentinels inside the rendered DOM with real reference chips
 *      or the shipped compact quote preview.
 *
 * Step 4 is imperative because `MarkdownText` exposes no children slot: its
 * props are `{ text, streaming, labels, fileMentions, pathImages, variant }`,
 * and there is no hook for injecting an element. To keep React's reconciler out
 * of that DOM, the Markdown output is mounted into its own `react-dom` root
 * inside a host element React never gives children to.
 *
 * DSH 0.2.2's `dsh-message-quotes` contributes one more evaluator rule: explicit
 * `> ` lines become `quote` nodes with decoded `data.text`. They travel through
 * the same sentinel path and are restored with `QuotePreview`. The surrounding
 * `\n\n` stay in the Markdown source, so a quote preview keeps its block
 * position instead of merging the blocks around it.
 *
 * The bubble also carries `data-text-interaction-source`, the marker the
 * shipped Chat selection layer uses to admit the official "quote text" action.
 * The shipped bubble (`UserContent` → `UserMessageBubble`) carries the same
 * marker.
 *
 * Attachments keep using the shipped `conversation.chat.user.content` Factory —
 * called with empty text it renders exactly the attachment rail (images go
 * through the shipped `conversation.chat.user.images` cell).
 *
 * There is no switch: loading the bundle rewrites settled prompts, disabling it
 * disposes the registrations and the shipped renderer returns.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-enhanced-prompt',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const { createRoot } = require('react-dom/client');
    const {
      IconCheckOutlineRegular,
      IconCopyOutlineRegular,
      JsonBlock,
      MarkdownText,
      QuotePreview,
      ReferenceChip,
      Tooltip,
      writeClipboard,
    } = require('@deepseek-ai/dsh-client-ui-primitives');

    const { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    /** Stable empty list for the portal slots, so an empty result never re-renders. */
    const EMPTY_SLOTS = [];

    /** This bundle's identity: module id and stylesheet ownership. */
    const PLUGIN_ID = '@local/dsh-enhanced-prompt';

    /** Keyed Chat-node seat; the shipped renderers occupy the same seat. */
    const CHAT_NODE_SLOT = 'conversation.chat.node';

    /** Node kinds taken over (both render the same user bubble). */
    const TAKEN_KINDS = ['user', 'steering'];

    /**
     * A keyed cell renders its LOWEST live priority and the shipped entries sit
     * at the default 0; a negative value wins the cell outright. Registering at
     * the same priority throws instead of overriding.
     */
    const SHADOW_PRIORITY = -1;

    /** `chat` carries the clock and message copy; `common` supplies Markdown chrome. */
    const LOCALE_NS = 'chat';

    /** Shipped Factory that draws the user content stack (we use its attachment rail). */
    const CONTENT_FACTORY = 'conversation.chat.user.content';

    /** Private-use sentinels; no Markdown grammar claims these code points. */
    const SENTINEL_OPEN = '\uE000';
    const SENTINEL_CLOSE = '\uE001';
    const SENTINEL_RE = /\uE000([0-9a-z]+)\uE001/g;

    const CSS = [
      '.dep-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px}',
      '.dep-stack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;width:100%;max-width:100%}',
      '.dep-bubble{box-sizing:border-box;width:100%;background:var(--dsw-specific-bubble);border-radius:var(--dsw-radius-xl);color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));word-break:break-word;white-space:normal;padding:10px 16px}',

      // The shipped markdown sheet gives every paragraph a 16px vertical margin;
      // inside a padded bubble that doubles the top and bottom padding.
      '.dep-md-host-inner>div>:first-child{margin-top:0}',
      '.dep-md-host-inner>div>:last-child{margin-bottom:0}',

      '.dep-chip-slot{display:inline}',
      '.dep-secret{font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary)}',
      '.dep-refsummary{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}',

      '.dep-actions{display:flex;align-items:center;gap:8px;height:calc(28px + var(--dsh-content-font-delta,0px))}',
      '.dep-time{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;padding-right:12px}',
      '.dep-action{display:inline-flex;align-items:center;justify-content:center;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dep-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}',
      '.dep-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',

      // Prompt width: the shipped stack caps the bubble at ~70% of the content
      // column; match the assistant's output width instead. The attachment rail
      // still comes from the shipped content factory, so its wrapper is matched
      // by the stable CSS-module local name (not the per-build hash); if a
      // future DSH renames the module the rule simply stops applying.
      ':is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]) [class*="_userStack"]{width:100%;max-width:100%}',
      // The shipped bubble is matched by its explicit marker, never by a
      // `[class*="_bubble"]` substring: primitives' Tooltip bubble is also a
      // CSS-module `_bubble_*`, is fixed-positioned, and would inherit this
      // width:100% (blowing up to its max-width) inside the user flow.
      ':is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]) [data-message-bubble]{box-sizing:border-box;width:100%}',

      '@media (hover:hover){.dep-actions{opacity:0;transition:opacity 80ms}',
      ':is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]):not(:has(~ :is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]))) .dep-actions,',
      '.dep-row:hover .dep-actions,.dep-row:focus-within .dep-actions{opacity:1}}',
    ].join('\n');

    /**
     * Append this bundle's stylesheet and return its disposer.
     * @returns disposer removing the style tag.
     */
    function injectStyles() {
      const tag = document.createElement('style');
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = `${PLUGIN_ID}/enhanced-prompt.css`;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /**
     * Split one authored message into text, attachments and leftover blocks.
     * Mirrors the shipped `contentParts` so only the drawing changes.
     * @param content - the node's content block array.
     * @returns joined text, attachment descriptors and unhandled blocks.
     */
    function contentParts(content) {
      const texts = [];
      const attachments = [];
      const rest = [];
      for (const block of content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        else if (block.type === 'image' && block.attachment !== undefined) {
          attachments.push({ type: 'image', image: { attachment: block.attachment } });
        } else if (block.type === 'file' && block.attachment !== undefined) {
          attachments.push({ type: 'file', file: block.attachment });
        } else rest.push(block);
      }
      return { text: texts.join(''), attachments, rest };
    }

    /**
     * Markdown chrome copy for one locale revision.
     * @param t - translate seat.
     * @returns labels for code fences and footnotes.
     */
    function markdownLabels(t) {
      return {
        code: {
          copyLabel: t('copy'),
          copiedLabel: t('copied'),
          toolbarLabels: {
            codeLabel: t('codeBlock.title'),
            wrapLabel: t('codeBlock.wrap'),
            unwrapLabel: t('codeBlock.unwrap'),
          },
        },
        footnotes: t('markdown.footnotes'),
      };
    }

    /**
     * Compose the whole message into one Markdown source.
     *
     * Every non-text node the parser found is replaced by a sentinel, so the
     * text that reaches `MarkdownText` is the authored document rather than a
     * fragment. Nodes are consumed in order and any overlap is skipped, which
     * matches the parser's own "nearest token wins" behaviour.
     *
     * @param text - the authored message text.
     * @param evaluate - the shipped parser's evaluator.
     * @param facts - parser facts (session labels, skill names).
     * @returns the composed source and the chips with their sentinel keys.
     */
    function composeMessage(text, evaluate, facts) {
      const chips = [];
      if (typeof text !== 'string' || text === '') return { markdown: text, chips };
      let nodes;
      try {
        nodes = evaluate({ text, facts });
      } catch {
        nodes = undefined;
      }
      if (!Array.isArray(nodes) || nodes.length === 0) return { markdown: text, chips };

      let markdown = '';
      let cursor = 0;
      let seq = 0;
      for (const item of nodes) {
        if (item === null || item === undefined || item.id === 'text') continue;
        if (typeof item.start !== 'number' || typeof item.end !== 'number') continue;
        if (item.start < cursor || item.end <= item.start) continue;
        markdown += text.slice(cursor, item.start);
        const key = seq.toString(36);
        markdown += SENTINEL_OPEN + key + SENTINEL_CLOSE;
        chips.push({ key, id: item.id, data: item.data, raw: text.slice(item.start, item.end) });
        cursor = item.end;
        seq += 1;
      }
      markdown += text.slice(cursor);
      return { markdown, chips };
    }

    /**
     * Build the React element for one parsed non-text node.
     *
     * Reference tokens use `ReferenceChip`, the primitive every shipped
     * renderer uses, so the result is visually identical to the unsplit path.
     * `quote` nodes are owned by `dsh-message-quotes` and use the shipped
     * compact preview; their decoded text must not be re-interpreted as
     * Markdown.
     *
     * @param chip - parsed node, its data and the raw source token.
     * @param key - React key.
     * @param wiring - file and skill activation callbacks from the seat owner.
     * @returns the chip or quote element, or the raw token for an unknown kind.
     */
    function chipElement(chip, key, wiring) {
      const data = chip.data ?? {};
      switch (chip.id) {
        case 'file':
          return h(ReferenceChip, {
            key,
            appearance: 'file',
            label: data.label ?? chip.raw,
            title: chip.raw,
            ...(typeof wiring.openFile === 'function'
              ? { onActivate: () => wiring.openFile(data.path) }
              : {}),
          });
        case 'folder':
          return h(ReferenceChip, {
            key,
            appearance: 'folder',
            label: data.label ?? chip.raw,
            title: chip.raw,
          });
        case 'session':
          return h(ReferenceChip, {
            key,
            appearance: 'session',
            label: data.label ?? chip.raw,
            title: chip.raw,
          });
        case 'skill':
          return h(ReferenceChip, {
            key,
            appearance: 'skill',
            label: `/${data.name}`,
            title: chip.raw,
            ...(typeof wiring.openSkill === 'function'
              ? { onActivate: () => wiring.openSkill(data.name) }
              : {}),
          });
        case 'command':
          return h(ReferenceChip, {
            key,
            appearance: 'command',
            label: `/${data.name}`,
            title: chip.raw,
          });
        case 'quote':
          // `data.text` is decoded by the shipped quote rule; the raw token
          // still carries the `> ` markers. A transcript quote is not
          // removable, so `removal` stays absent.
          return typeof QuotePreview === 'function'
            ? h(QuotePreview, { key, text: data.text ?? chip.raw })
            : chip.raw;
        case 'secret':
          return h(
            'span',
            { key, className: 'dep-secret', 'data-secret': '', title: '\u2022\u2022\u2022\u2022\u2022\u2022' },
            '\u2022\u2022\u2022\u2022\u2022\u2022',
          );
        default:
          return chip.raw;
      }
    }

    /**
     * Split one rendered text node into plain strings and chip placeholders.
     * @param value - the text node's content.
     * @param byKey - chips keyed by sentinel sequence.
     * @param wiring - activation callbacks.
     * @param opaque - true inside `pre`/`code`, where a chip is not allowed.
     * @returns ordered pieces; strings are text, objects carry an element.
     */
    function splitSentinelText(value, byKey, wiring, opaque) {
      const pieces = [];
      let last = 0;
      SENTINEL_RE.lastIndex = 0;
      let match;
      while ((match = SENTINEL_RE.exec(value)) !== null) {
        if (match.index > last) pieces.push(value.slice(last, match.index));
        const chip = byKey.get(match[1]);
        if (chip === undefined) pieces.push(match[0]);
        else if (opaque) pieces.push(chip.raw);
        else pieces.push({ element: chipElement(chip, `chip-${chip.key}`, wiring) });
        last = match.index + match[0].length;
      }
      if (last < value.length) pieces.push(value.slice(last));
      return pieces;
    }

    /**
     * Replace every sentinel in a rendered Markdown subtree with a chip slot.
     *
     * Runs only after the Markdown root has actually committed, so the DOM it
     * walks is final. Each replacement leaves an empty `<span>`; the chips are
     * rendered into those spans as portals by `MarkdownMount`, which keeps every
     * chip inside React's tree (no nested roots, no second reconciler).
     *
     * @param element - the subtree React just committed.
     * @param chips - chips keyed by sentinel sequence.
     * @param wiring - activation callbacks.
     * @returns one entry per replaced sentinel.
     */
    function restoreChips(element, chips, wiring) {
      const byKey = new Map(chips.map((chip) => [chip.key, chip]));
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const targets = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeValue !== null && node.nodeValue.indexOf(SENTINEL_OPEN) !== -1) targets.push(node);
      }

      const slots = [];
      for (const textNode of targets) {
        const parent = textNode.parentNode;
        if (parent === null) continue;
        const opaque = parent instanceof Element ? parent.closest('pre, code') !== null : false;
        const pieces = splitSentinelText(textNode.nodeValue ?? '', byKey, wiring, opaque);
        const fragment = document.createDocumentFragment();
        for (const piece of pieces) {
          if (typeof piece === 'string') {
            fragment.appendChild(document.createTextNode(piece));
            continue;
          }
          const holder = document.createElement('span');
          holder.className = 'dep-chip-slot';
          fragment.appendChild(holder);
          slots.push({ holder, element: piece.element });
        }
        parent.replaceChild(fragment, textNode);
      }
      return slots;
    }

    /**
     * The Markdown document plus its chips.
     *
     * This component is mounted into its own `react-dom` root so the host bubble
     * component never reconciles the substituted DOM. It restores the chips in a
     * layout effect — after React has committed the Markdown output — and then
     * renders them as portals into the slots it created.
     *
     * @param props - composed source, chrome copy, chips and activation wiring.
     * @returns the Markdown wrapper with its portal children.
     */
    function MarkdownMount({ markdown, labels, chips, wiring }) {
      const hostRef = useRef(null);
      const [slots, setSlots] = useState(EMPTY_SLOTS);

      useLayoutEffect(() => {
        const element = hostRef.current;
        if (element === null) return;
        const restored = restoreChips(element, chips, wiring);
        setSlots(restored.length === 0 ? EMPTY_SLOTS : restored);
      }, []);

      return h(
        'div',
        { ref: hostRef, className: 'dep-md-host-inner' },
        h(MarkdownText, { text: markdown, labels }),
        slots.map((slot, index) => createPortal(slot.element, slot.holder, String(index))),
      );
    }

    /**
     * Mount the Markdown document into `host`.
     *
     * `host` is a plain element the bubble component renders empty; React never
     * gives it children, so the sentinel substitution cannot desynchronise the
     * bubble's reconciler.
     *
     * @param host - element React leaves empty.
     * @param markdown - composed source with sentinels.
     * @param labels - Markdown chrome copy.
     * @param chips - chips keyed by sentinel sequence.
     * @param wiring - activation callbacks.
     * @returns disposer unmounting the root.
     */
    function mountMarkdown(host, markdown, labels, chips, wiring) {
      const root = createRoot(host);
      root.render(h(MarkdownMount, { markdown, labels, chips, wiring }));
      return () => {
        try {
          root.unmount();
        } catch {
          /* the element may already be gone with the containing bubble */
        }
      };
    }

    const pad2 = (value) => String(value).padStart(2, '0');

    /** Local midnight for the day containing `now`. */
    function startOfLocalDay(now) {
      const date = new Date(now);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    }

    /** Milliseconds from `now` to the next local midnight. */
    function msUntilNextLocalMidnight(now) {
      const date = new Date(now);
      const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
      return next.getTime() - now;
    }

    /**
     * Local calendar day that advances at each midnight, so yesterday's message
     * stops claiming to be "today" without a reload.
     * @returns midnight epoch ms for the current local day.
     */
    function useCalendarDay() {
      const [day, setDay] = useState(() => startOfLocalDay(Date.now()));
      useEffect(() => {
        let timer;
        const arm = () => {
          const now = Date.now();
          setDay(startOfLocalDay(now));
          timer = setTimeout(arm, msUntilNextLocalMidnight(now));
        };
        timer = setTimeout(arm, msUntilNextLocalMidnight(Date.now()));
        return () => clearTimeout(timer);
      }, []);
      return day;
    }

    /**
     * Compact local timestamp: `HH:mm` today, a date template plus the clock
     * otherwise.
     * @param time - epoch ms from the message's source event.
     * @param t - translate seat carrying `clock.md` / `clock.ymd`.
     * @param now - reference instant.
     * @returns the display string.
     */
    function formatMessageClock(time, t, now = Date.now()) {
      const date = new Date(time);
      const reference = new Date(now);
      const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
      const sameDay =
        date.getFullYear() === reference.getFullYear() &&
        date.getMonth() === reference.getMonth() &&
        date.getDate() === reference.getDate();
      if (sameDay) return clock;
      const params = { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
      const template =
        date.getFullYear() === reference.getFullYear() ? t('clock.md', params) : t('clock.ymd', params);
      return `${template} ${clock}`;
    }

    /**
     * Copy button plus local clock, matching the shipped message chrome. The
     * payload is the authored text verbatim, i.e. the Markdown source.
     * @param props - payload text, event time, row class and translate seat.
     * @returns the actions row.
     */
    function MessageActions({ text, time, className, t }) {
      const day = useCalendarDay();
      const [copied, setCopied] = useState(false);
      const copyPending = useRef(false);
      const copyTimer = useRef(null);
      const copyEpoch = useRef(0);

      useEffect(
        () => () => {
          copyEpoch.current += 1;
          copyPending.current = false;
          if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        },
        [],
      );

      const onCopy = useCallback(() => {
        if (copied || copyPending.current) return;
        const epoch = copyEpoch.current;
        copyPending.current = true;
        writeClipboard(text).then((ok) => {
          if (epoch !== copyEpoch.current) return;
          copyPending.current = false;
          if (!ok) return;
          setCopied(true);
          copyTimer.current = window.setTimeout(() => {
            copyTimer.current = null;
            setCopied(false);
          }, 1000);
        }).catch(() => {
          if (epoch !== copyEpoch.current) return;
          copyPending.current = false;
        });
      }, [copied, text]);

      const label = copied ? t('copied') : t('copy');

      return h(
        'div',
        { className, 'data-clock': 'start' },
        time === undefined ? null : h('span', { className: 'dep-time' }, formatMessageClock(time, t, day)),
        h(
          Tooltip,
          { label, side: 'bottom' },
          h(
            'button',
            { type: 'button', className: 'dep-action', 'aria-label': label, onClick: onCopy },
            copied ? h(IconCheckOutlineRegular, {}) : h(IconCopyOutlineRegular, {}),
          ),
        ),
      );
    }

    /**
     * Replacement renderer for the `user` and `steering` Chat nodes.
     *
     * Composes one Markdown document, mounts it into its own root, and restores
     * the reference chips inside it. Attachments keep using the shipped content
     * Factory, called with empty text so it draws only the attachment rail.
     *
     * @param props - seat-owner props for one keyed Chat node.
     * @returns the rewritten prompt row.
     */
    const EnhancedUserNode = memo(function EnhancedUserNode({
      node,
      t,
      renderFactorySlot,
      loadImage,
      createUserTextEvaluator,
      openFile,
      openSkill,
    }) {
      const data = node.data;
      const { text, attachments, rest } = useMemo(() => contentParts(data.content), [data.content]);
      const labels = useMemo(() => markdownLabels(t), [t]);

      const facts = useMemo(() => {
        const next = {};
        if (data.referenceLabels !== undefined) next.sessionLabels = data.referenceLabels;
        if (data.skillNames !== undefined) next.skillNames = data.skillNames;
        return next;
      }, [data.referenceLabels, data.skillNames]);

      const composed = useMemo(() => {
        if (typeof createUserTextEvaluator !== 'function') return { markdown: text, chips: [] };
        let evaluate;
        try {
          evaluate = createUserTextEvaluator();
        } catch {
          return { markdown: text, chips: [] };
        }
        return composeMessage(text, evaluate, facts);
      }, [text, facts, createUserTextEvaluator]);

      const hostRef = useRef(null);
      const wiring = useMemo(() => ({ openFile, openSkill }), [openFile, openSkill]);
      const showBubble = composed.markdown !== '' || rest.length > 0;

      useEffect(() => {
        const host = hostRef.current;
        if (host === null) return undefined;
        host.replaceChildren();
        return mountMarkdown(host, composed.markdown, labels, composed.chips, wiring);
      }, [composed, labels, wiring]);

      const truncated = useCallback((total) => t('json.truncated', { total }), [t]);

      return h(
        'div',
        { className: 'dep-row' },

        attachments.length > 0 &&
          renderFactorySlot(CONTENT_FACTORY, {
            content: { text: '', attachments, extraBlocks: [] },
            loadImage,
            facts: {},
            interactive: true,
          }),

        h(
          'div',
          { className: 'dep-stack' },

          showBubble &&
            h(
              'div',
              {
                className: 'dep-bubble',
                // The shipped text-interaction layer only admits selections
                // whose endpoints share this marker; the shipped bubble
                // (`UserContent` → `UserMessageBubble`) carries the same one.
                'data-text-interaction-source': '',
              },
              h('div', { className: 'dep-md-host', ref: hostRef }),
              rest.map((block, index) =>
                h(JsonBlock, {
                  key: `rest${index}`,
                  label: t('message.extraBlock'),
                  payload: block,
                  truncatedLabel: truncated,
                }),
              ),
            ),

          Array.isArray(data.referenceLabels) &&
            data.referenceLabels.length > 0 &&
            h(
              'div',
              { className: 'dep-refsummary' },
              t('message.referenceSummary', {
                labels: data.referenceLabels.join(t('message.referenceSeparator')),
              }),
            ),
        ),

        h(MessageActions, { text, time: data.time, className: 'dep-actions', t }),
      );
    });

    /**
     * Mount the Client half.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(injectStyles, 'enhanced-prompt: bubble stylesheet');
      for (const kind of TAKEN_KINDS) {
        ctx.effect(
          () =>
            ctx.slots.inject(CHAT_NODE_SLOT, () =>
              ctx.slots.register(
                {
                  name: CHAT_NODE_SLOT,
                  key: kind,
                  priority: SHADOW_PRIORITY,
                  locale: LOCALE_NS,
                  inject: () => ({
                    createUserTextEvaluator: () => ctx.uiConversation.userText.createEvaluator(),
                  }),
                },
                EnhancedUserNode,
              ),
            ),
          `enhanced-prompt: ${kind} renderer`,
        );
      }
    }

    return {
      inject: ['slots', 'locale', 'uiConversation'],
      apply,
      // Pure helpers, exercised by test/lifecycle.test.mjs without a DOM.
      __test: { composeMessage, chipElement, contentParts, splitSentinelText },
    };
  },
});
