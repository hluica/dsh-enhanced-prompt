/**
 * Lifecycle + composition harness for the enhanced-prompt client half.
 *
 * Run:  node test/lifecycle.test.mjs
 *
 * Runs the real `client.js` under stub React / DOM / Cordis surfaces. The DOM
 * mount itself (`mountMarkdown`) needs a browser, so it is not exercised here;
 * everything it depends on is, through the pure helpers the module exposes as
 * `__test`:
 *
 *   - `composeMessage` — the whole point of this version: the chip must NOT
 *     split the document, so a list item stays one Markdown source; quote
 *     nodes must keep their `\n\n` block boundary;
 *   - `chipElement`    — each reference kind maps to the shipped
 *     `ReferenceChip` with the right appearance and activation; a quote maps
 *     to the shipped `QuotePreview` with decoded text.
 *   - `splitSentinelText` — sentinels become chips, except inside pre/code.
 */

const FRAGMENT = Symbol.for('react.fragment');

function createElement(type, props, ...children) {
  const next = { ...(props || {}) };
  if (children.length === 1) next.children = children[0];
  else if (children.length > 1) next.children = children;
  return { type, props: next, key: next.key === undefined ? null : next.key };
}

const React = {
  Fragment: FRAGMENT,
  createElement,
  memo: (fn) => fn,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  isValidElement: (value) => value !== null && typeof value === 'object' && 'props' in value && 'type' in value,
};

function MarkdownText() {}
function ReferenceChip() {}
function QuotePreview() {}
function JsonBlock() {}
function Tooltip() {}
function IconCopyOutlineRegular() {}
function IconCheckOutlineRegular() {}
const primitives = {
  MarkdownText,
  ReferenceChip,
  QuotePreview,
  JsonBlock,
  Tooltip,
  IconCopyOutlineRegular,
  IconCheckOutlineRegular,
  writeClipboard: async () => true,
};

const reactDom = { createPortal: (element, container, key) => ({ type: 'portal', element, container, key }) };
const reactDomClient = {
  createRoot: () => ({ render() {}, unmount() {} }),
};

// --- stub DOM --------------------------------------------------------------
const appended = [];
const elementProto = { closest: () => null };
globalThis.Element = function Element() {};
globalThis.Element.prototype = elementProto;
globalThis.NodeFilter = { SHOW_TEXT: 4 };
globalThis.document = {
  createElement: (tag) => ({ tag, dataset: {}, textContent: '', className: '', remove() {} }),
  createTextNode: (text) => ({ nodeValue: text }),
  createDocumentFragment: () => ({ children: [], appendChild() {} }),
  createTreeWalker: () => ({ nextNode: () => false }),
  head: { appendChild: (el) => appended.push(el) },
};

// --- capture the module definition ----------------------------------------
let definition = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def;
    },
  },
};

const CLIENT_URL = new URL('../client.js', import.meta.url).href;
const { readFileSync } = await import('node:fs');
const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
await import(CLIENT_URL);

// --- stub Cordis -----------------------------------------------------------
const registrations = [];
const slotInjections = [];
const effects = [];
const ctx = {
  effect(fn, label) {
    effects.push(label);
    return fn();
  },
  slots: {
    inject(key, callback) {
      slotInjections.push(key);
      return callback();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
  uiConversation: {
    userText: {
      createEvaluator: () => (input) => input.text,
    },
  },
};

const plugin = definition.factory((id) => {
  if (id === 'react') return React;
  if (id === 'react-dom') return reactDom;
  if (id === 'react-dom/client') return reactDomClient;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error(`unexpected require: ${id}`);
});

const { composeMessage, chipElement, splitSentinelText } = plugin.__test;

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

console.log('\n[1] factory contract');
check('returns an inject list', Array.isArray(plugin.inject));
check(
  'injects slots, locale and uiConversation',
  plugin.inject.join(',') === 'slots,locale,uiConversation',
  plugin.inject.join(','),
);
check('returns apply', typeof plugin.apply === 'function');

console.log('\n[2] apply()');
plugin.apply(ctx);
check('appends one style tag', appended.length === 1, `got ${appended.length}`);
check('style owned via data-plugin', appended[0].dataset.plugin === '@local/dsh-enhanced-prompt');
check('injects into conversation.chat.node', slotInjections.every((k) => k === 'conversation.chat.node'));
check('registers two cells', registrations.length === 2, `got ${registrations.length}`);
check(
  'takes user and steering',
  registrations.map((r) => r.options.key).sort().join(',') === 'steering,user',
);
check(
  'shadows at negative priority',
  registrations.every((r) => r.options.priority === -1),
  registrations.map((r) => r.options.priority).join(','),
);
check('declares the chat locale seat', registrations.every((r) => r.options.locale === 'chat'));
check('three effects', effects.length === 3, effects.join(' | '));
const injected = registrations[0].options.inject();
check('provides the shipped parser', typeof injected.createUserTextEvaluator === 'function');

console.log('\n[3] one document per message — the list case');
const listText = '- 检查 @a.ts 的实现';
const listNodes = [
  { id: 'text', start: 0, end: 4 },
  { id: 'file', start: 5, end: 10, data: { path: 'a.ts', label: 'a.ts' } },
  { id: 'text', start: 10, end: listText.length },
];
const listComposed = composeMessage(listText, () => listNodes, {});
check(
  'chip does not split the list item',
  listComposed.markdown === '- 检查 \uE0000\uE001 的实现',
  JSON.stringify(listComposed.markdown),
);
check('one chip recorded', listComposed.chips.length === 1);
check('chip keeps its kind', listComposed.chips[0].id === 'file');
check('chip keeps its raw token', listComposed.chips[0].raw === '@a.ts', listComposed.chips[0].raw);
check('list marker survives in the same source', listComposed.markdown.startsWith('- '));

console.log('\n[3b] quote nodes keep their block boundary');
const quoteText = 'A\n\n> quoted\n\nB';
const quoteNodes = [
  { id: 'text', start: 0, end: 1, data: { text: 'A' } },
  { id: 'text', start: 1, end: 3, data: { text: '\n\n', display: ' ' } },
  { id: 'quote', start: 3, end: 11, data: { text: 'quoted' } },
  { id: 'text', start: 11, end: 13, data: { text: '\n\n', display: ' ' } },
  { id: 'text', start: 13, end: 14, data: { text: 'B' } },
];
const quoteComposed = composeMessage(quoteText, () => quoteNodes, {});
check(
  'quote does not consume the surrounding blank lines',
  quoteComposed.markdown === 'A\n\n\uE0000\uE001\n\nB',
  JSON.stringify(quoteComposed.markdown),
);
check(
  'quote is recorded as one chip',
  quoteComposed.chips.length === 1 && quoteComposed.chips[0].id === 'quote',
);
check('quote stores decoded text', quoteComposed.chips[0].data.text === 'quoted');
check('quote raw keeps the markers for code fallback', quoteComposed.chips[0].raw === '> quoted');
const quoteOnly = composeMessage('> q', () => [
  { id: 'quote', start: 0, end: 3, data: { text: 'q' } },
], {});
check('quote-only message is still one sentinel', quoteOnly.markdown === '\uE0000\uE001');

console.log('\n[4] other composition cases');
const plain = composeMessage('just text', () => [{ id: 'text', start: 0, end: 9 }], {});
check('no references means verbatim source', plain.markdown === 'just text' && plain.chips.length === 0);

const trailing = composeMessage('see @a.ts and @b.ts', () => [
  { id: 'text', start: 0, end: 4 },
  { id: 'file', start: 4, end: 9, data: { path: 'a.ts', label: 'a.ts' } },
  { id: 'text', start: 9, end: 14 },
  { id: 'file', start: 14, end: 19, data: { path: 'b.ts', label: 'b.ts' } },
], {});
check('two chips become two sentinels', trailing.chips.length === 2 && trailing.markdown === 'see \uE0000\uE001 and \uE0001\uE001');

const broken = composeMessage('x @a.ts', () => { throw new Error('boom'); }, {});
check('evaluator failure falls back to the raw source', broken.markdown === 'x @a.ts' && broken.chips.length === 0);

const overlapping = composeMessage('aaa @a.ts', () => [
  { id: 'file', start: 4, end: 9, data: { path: 'a.ts' } },
  { id: 'file', start: 6, end: 9, data: { path: 'b.ts' } },
], {});
check('overlapping matches are skipped', overlapping.chips.length === 1, String(overlapping.chips.length));

console.log('\n[5] chips map to the shipped primitive');
const chipOf = (id, data, raw) => chipElement({ key: '0', id, data, raw }, 'k', { openFile: () => {}, openSkill: () => {} });
const fileChip = chipOf('file', { path: 'a.ts', label: 'a.ts' }, '@a.ts');
check('file chip is a ReferenceChip', fileChip.type === ReferenceChip);
check('file appearance', fileChip.props.appearance === 'file');
check('file keeps its label', fileChip.props.label === 'a.ts');
check('file is activatable', typeof fileChip.props.onActivate === 'function');
const folderChip = chipOf('folder', { label: 'src' }, '@src/');
check('folder appearance and no activation', folderChip.props.appearance === 'folder' && folderChip.props.onActivate === undefined);
const sessionChip = chipOf('session', { label: 'other' }, '@other');
check('session appearance and no activation', sessionChip.props.appearance === 'session' && sessionChip.props.onActivate === undefined);
const skillChip = chipOf('skill', { name: 'review' }, '/review');
check('skill label and activation', skillChip.props.label === '/review' && typeof skillChip.props.onActivate === 'function');
const commandChip = chipOf('command', { name: 'goal' }, '/goal');
check('command label, no activation', commandChip.props.label === '/goal' && commandChip.props.onActivate === undefined);
const quoteChip = chipOf('quote', { text: 'quoted' }, '> quoted');
check('quote is the shipped QuotePreview', quoteChip.type === QuotePreview);
check('quote preview gets decoded text', quoteChip.props.text === 'quoted');
check('transcript quote is not removable', quoteChip.props.removal === undefined);
const secretChip = chipOf('secret', { masked: 'abc' }, 'sk-1');
check('secret renders masked', secretChip.type === 'span' && secretChip.props['data-secret'] === '');
const unknownChip = chipOf('mystery', {}, '@x');
check('unknown kind falls back to raw text', unknownChip === '@x');
const noWiring = chipElement({ key: '0', id: 'file', data: { path: 'a.ts', label: 'a.ts' }, raw: '@a.ts' }, 'k', {});
check('missing opener leaves the chip inert', noWiring.props.onActivate === undefined);

console.log('\n[6] sentinel substitution');
const byKey = new Map([['0', { key: '0', id: 'file', data: { path: 'a.ts', label: 'a.ts' }, raw: '@a.ts' }]]);
const mixed = splitSentinelText('检查 \uE0000\uE001 的实现', byKey, { openFile: () => {} }, false);
check('produces text, chip, text', mixed.length === 3 && typeof mixed[0] === 'string' && mixed[1].element !== undefined);
check('chip element preserved', mixed[1].element.type === ReferenceChip);
const opaque = splitSentinelText('\uE0000\uE001', byKey, { openFile: () => {} }, true);
check('inside pre/code the raw token is used', opaque.length === 1 && opaque[0] === '@a.ts');
const orphan = splitSentinelText('a \uE0009\uE001 b', byKey, {}, false);
check('unknown sentinel is left as-is', orphan.length === 3 && orphan[1] === '\uE0009\uE001');
const noSentinel = splitSentinelText('plain', byKey, {}, false);
check('plain text passes through', noSentinel.length === 1 && noSentinel[0] === 'plain');

console.log('\n[7] stylesheet shape');
const css = appended[0].textContent;
check('bubble is a normal block (no inline hack)', css.includes('.dep-bubble{') && !css.includes('.dep-md{'));
check('markdown host present', css.includes('.dep-md-host-inner>div>:first-child{margin-top:0}'));
check('paragraph margin trimmed at the end', css.includes('.dep-md-host-inner>div>:last-child{margin-bottom:0}'));
check('chip slots stay inline', css.includes('.dep-chip-slot{display:inline}'));
check('width: stack spans the column', /\[class\*="_userStack"\]\{width:100%;max-width:100%\}/.test(css));
check('width: message bubble spans the column', /\[data-message-bubble\]\{[^}]*width:100%/.test(css));
check('no class-substring bubble widening (Tooltip collision)', !/\[class\*="_bubble"\]/.test(css));

console.log('\n[8] regression guards');
check('no projectUserText (removed in 0.2.1)', !SOURCE.includes('projectUserText'));
check('no longer shadows the per-run text cell', !SOURCE.includes("'conversation.user.text.node'"));
check('uses the shipped content factory for attachments', SOURCE.includes("'conversation.chat.user.content'"));
check('bubble keeps the official selection source marker', SOURCE.includes("'data-text-interaction-source': ''"));
check('quote preview comes from the shipped primitives', SOURCE.includes('QuotePreview'));
check('no renderMessageImages (removed from owner props)', !SOURCE.includes('renderMessageImages'));
// `flushSync` from an effect is a no-op flush: it left the sentinels unsubstituted.
check('never flushes synchronously from an effect', !SOURCE.includes('flushSync'));
check('chips are rendered as portals, not nested roots', SOURCE.includes('createPortal') && (SOURCE.match(/createRoot\(/g) ?? []).length === 1);

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
