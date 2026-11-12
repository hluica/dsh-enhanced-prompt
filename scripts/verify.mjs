#!/usr/bin/env node
/**
 * Check the plugin against the invariants its build and its host both depend on.
 *
 * Three families of check live here, in the order they can break:
 *
 * 1. **Layout.** Every path under the plugin is a real file or directory — no
 *    symbolic link, no Finder alias, no macOS sidecar. This is the property the
 *    dependency build exists to provide, so it is checked from the outside rather
 *    than trusted from the build that just wrote it.
 * 2. **Dependencies.** The generated tree matches `deps.lock.json` byte for byte,
 *    and each package's runtime entry is present.
 * 3. **Host contract.** The manifest satisfies what DSH's loader and client-module
 *    system read (`exports`, `dsh.bundle`, `dsh.client`, locale anchor, icon), the
 *    two shipped files parse, and the Host half really imports and honours its own
 *    contract in a fresh process.
 * 4. **Toolkit.** This plugin's copy of the build is the canonical one in
 *    the canonical copy beside the plugins, so a fix applied there does not silently
 *    skip this plugin.
 *
 * Everything here is the same in every plugin; the Host-half assertions are not, so
 * they live in the plugin's own `scripts/host-contract.mjs` and are reported
 * alongside the rest. That check is the one that pays for the file: a Host half
 * that fails to import marks the plugin "enabled but not running", and Node caches
 * that failure for the life of the process, so the only cheap moment to catch it is
 * outside the Host — which is exactly here.
 *
 * Usage:
 *   node scripts/verify.mjs
 *
 * @module scripts/verify
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  LOCK_PATH,
  NODE_MODULES,
  PACKAGE_MANAGER_ARTIFACTS,
  RECEIPT_NAME,
  RECEIPT_PATH,
  ROOT,
  collectViolations,
  filesUnder,
  findCanonicalBuildSystem,
  isPluginPackage,
  syncCommand,
  readJson,
  say,
  sha256hex,
} from './lib/fsx.mjs';

/** Checks that failed, reported together at the end so one run lists everything. */
const failures = [];

/**
 * Record one check.
 * @param label - What was checked, phrased as the property that must hold.
 * @param condition - Whether it holds.
 * @param detail - Optional evidence shown when it does not.
 */
function check(label, condition, detail) {
  if (condition) say.ok(label);
  else {
    say.fail(detail === undefined ? label : `${label} — ${detail}`);
    failures.push(label);
  }
}

/**
 * Whether a manifest `files` entry exists, tolerating one `*` segment.
 * @param pattern - Path or glob relative to the plugin root.
 * @returns True when at least one path matches.
 */
function matchesFiles(pattern) {
  if (!pattern.includes('*')) return existsSync(join(ROOT, pattern));
  const star = pattern.indexOf('*');
  const directory = join(ROOT, pattern.slice(0, star));
  if (!existsSync(directory)) return false;
  const suffix = pattern.slice(star + 1);
  return readdirSync(directory).some((name) => suffix === '' || name.endsWith(suffix));
}

/**
 * The file a bare import of a package resolves to, by Node's own condition order.
 *
 * `types` is deliberately skipped: type declarations are erased before runtime and
 * are pruned from the vendored tree, so demanding them would fail the build for a
 * file no process can load.
 *
 * @param manifest - A package's parsed `package.json`.
 * @returns Path relative to the package root, or undefined when it declares none.
 */
function runtimeEntryOf(manifest) {
  const conditions = ['import', 'node', 'default', 'require'];
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object') {
      for (const condition of conditions) if (typeof value[condition] === 'string') return value[condition];
    }
    return undefined;
  };
  const root = manifest.exports?.['.'];
  return pick(root) ?? (typeof manifest.module === 'string' ? manifest.module : undefined) ?? (typeof manifest.main === 'string' ? manifest.main : undefined);
}

/** Check that nothing in the tree is a link, an alias, or a macOS sidecar. */
function verifyLayout() {
  say.step('layout · real files only');
  const { links, aliases, junk } = collectViolations();
  const list = (paths) => paths.slice(0, 5).join(', ') + (paths.length > 5 ? `, … ${paths.length} total` : '');
  check('no symbolic links', links.length === 0, list(links));
  check('no macOS Finder aliases', aliases.length === 0, list(aliases));
  check('no macOS sidecar files', junk.length === 0, list(junk));

  const artifacts = PACKAGE_MANAGER_ARTIFACTS.filter((artifact) => existsSync(join(NODE_MODULES, artifact)));
  check('no package-manager artifacts in node_modules/', artifacts.length === 0, artifacts.join(', '));
}

/** Check that the generated dependency tree is exactly what the lock describes. */
function verifyDependencies() {
  const manifest = readJson(join(ROOT, 'package.json'));

  // A plugin whose Host half imports nothing carries no tree at all: the absence
  // is the guarantee, because a tree that does not exist cannot hold a link, a
  // stale version, or a package nothing declares.
  if (Object.keys(manifest.dependencies ?? {}).length === 0) {
    say.step('dependencies · none declared');
    check('node_modules/ is absent', !existsSync(NODE_MODULES), 'this plugin declares no dependencies, so a tree here could only be stale — `npm run build` removes it');
    check('no lock file to drift', !existsSync(LOCK_PATH), 'deps.lock.json exists while package.json declares no dependencies — declare the package that was pinned, or delete the file');
    return;
  }

  say.step('dependencies · tree matches deps.lock.json');
  if (!existsSync(LOCK_PATH)) {
    check('deps.lock.json present', false, 'dependencies are declared but nothing is pinned — pin each with `node scripts/build.mjs --pin <name>@<exact version>`');
    return;
  }
  const lockBytes = readFileSync(LOCK_PATH);
  const lock = JSON.parse(lockBytes.toString('utf8'));

  check('lock records a registry', typeof lock.registry === 'string' && lock.registry !== '', JSON.stringify(lock.registry));

  const pinned = new Map();
  const duplicates = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (pinned.has(entry.name)) duplicates.push(`${entry.name} (${pinned.get(entry.name).version}, ${entry.version})`);
    pinned.set(entry.name, entry);
    check(`${key} is keyed by its own identity`, `${entry.name}@${entry.version}` === key);
    check(`${key} points at a vendor list`, entry.vendor === '*' || Array.isArray(entry.vendor), JSON.stringify(entry.vendor));
    check(`${key} records declared dependency ranges`, Object.values(entry.dependencies ?? {}).every((range) => typeof range === 'string' && range !== ''), JSON.stringify(entry.dependencies ?? {}));
  }
  check('every package is pinned once', duplicates.length === 0, `${duplicates.join(', ')} — edges resolve by name, so a second pinned version is unreachable`);

  for (const [key, entry] of Object.entries(lock.packages)) {
    const missing = Object.keys(entry.dependencies ?? {}).filter((name) => !pinned.has(name));
    check(`${key} has a pinned entry for everything it requires`, missing.length === 0, `${missing.join(', ')} — pin with \`node scripts/build.mjs --pin <name>@<exact version>\``);
  }

  // Reachability is what decides whether an entry is supposed to be in the tree:
  // the build walks the same graph from `package.json`'s dependencies — the single
  // source of truth for what the plugin requires — so a pinned package nothing
  // requires would otherwise be reported as a missing install instead of the dead
  // entry it is.
  const roots = Object.keys(manifest.dependencies ?? {});
  const reachable = new Set();
  const unresolved = roots.filter((name) => !pinned.has(name));
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const child of Object.keys(pinned.get(name)?.dependencies ?? {})) queue.push(child);
  }
  check('every root has a pinned entry', unresolved.length === 0, `${unresolved.join(', ')} — pin with \`node scripts/build.mjs --pin <name>@<exact version>\``);
  const orphaned = [...pinned.keys()].filter((name) => !reachable.has(name));
  check('every pinned package is required by something', orphaned.length === 0, `${orphaned.join(', ')} — nothing in the closure requires them: declare the package in package.json dependencies, list it under the dependencies of the package that needs it, or drop the lock entry`);

  if (!existsSync(RECEIPT_PATH)) {
    check('build receipt present', false, 'node_modules/.dsh-vendor.json is missing — run `npm run build`');
    return;
  }
  const receipt = readJson(RECEIPT_PATH);
  check('receipt belongs to this package', receipt.tool === `${manifest.name}/build`, `receipt says ${JSON.stringify(receipt.tool)}`);
  check('receipt was produced from this lock', receipt.lockHash === sha256hex(lockBytes), 'deps.lock.json changed since the last build — run `npm run build`');

  const vendored = new Set();
  const expectedTopLevel = new Set([RECEIPT_NAME]);
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!reachable.has(entry.name)) continue;
    const record = receipt.packages?.[entry.name];
    const kept = entry.vendor === '*' ? undefined : entry.vendor;
    if (kept !== undefined && kept.length === 0) {
      check(`${key} intentionally not vendored`, record === undefined && !existsSync(join(NODE_MODULES, entry.name)), `${entry.note ?? 'no note in the lock'}`);
      continue;
    }
    expectedTopLevel.add(entry.name.split('/')[0]);
    if (record === undefined) {
      check(`${key} vendored`, false, 'absent from the build receipt — run `npm run build`');
      continue;
    }
    vendored.add(entry.name);

    const recorded = Object.entries(record.files ?? {});
    const present = [...filesUnder(join(NODE_MODULES, entry.name))];
    const drifted = recorded.filter(([file, digest]) => {
      const found = present.find((candidate) => candidate.rel === file);
      return found === undefined || found.linked || sha256hex(readFileSync(found.path)) !== digest;
    });
    const extra = present.filter((candidate) => !recorded.some(([file]) => file === candidate.rel)).map((candidate) => candidate.rel);
    const incomplete = kept === undefined ? [] : kept.filter((file) => !recorded.some(([recordedFile]) => recordedFile === file));
    check(`${key} files intact (${recorded.length})`, record.version === entry.version && drifted.length === 0 && extra.length === 0 && incomplete.length === 0, [...drifted.map(([file]) => file), ...extra.map((file) => `${file} (extra)`), ...incomplete.map((file) => `${file} (not vendored)`), ...(record.version === entry.version ? [] : [`receipt records ${record.version}, lock pins ${entry.version}`])].join(', '));

    const installed = readJson(join(NODE_MODULES, entry.name, 'package.json'));
    check(`${key} manifest agrees with the lock`, installed.name === entry.name && installed.version === entry.version);
    const entryFile = runtimeEntryOf(installed);
    check(`${key} runtime entry present`, entryFile !== undefined && existsSync(join(NODE_MODULES, entry.name, entryFile)), entryFile ?? 'its package.json declares no entry');
  }

  const stray = (existsSync(NODE_MODULES) ? readdirSync(NODE_MODULES) : []).filter((name) => !expectedTopLevel.has(name));
  check('node_modules/ holds nothing but the vendored packages', stray.length === 0, stray.length === 0 ? undefined : `${stray.join(', ')} — this tree is generated from deps.lock.json: erase it with \`npm run build\`, or record the package with \`node scripts/build.mjs --pin <name>@<version>\` if the plugin really needs it`);

  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    check(`package.json dependency ${name}@${range} is vendored`, vendored.has(name), 'its lock entry may declare an empty vendor list');
  }
}

/** Check the manifest fields DSH reads when it mounts and serves the plugin. */
function verifyManifest() {
  say.step('manifest · DSH contract');
  const manifest = readJson(join(ROOT, 'package.json'));

  check('type is module', manifest.type === 'module', `found ${JSON.stringify(manifest.type)}`);
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    check(`exports[${JSON.stringify(subpath)}] resolves`, typeof target === 'string' && matchesFiles(target), `target ${JSON.stringify(target)} matches nothing`);
  }
  check('locale anchor locale/en.json exists', existsSync(join(ROOT, 'locale', 'en.json')), 'without the English anchor DSH reads no locale file at all');
  for (const file of readdirSync(join(ROOT, 'locale'))) {
    if (!file.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = readJson(join(ROOT, 'locale', file));
    } catch (error) {
      check(`locale/${file} parses`, false, error.message);
      continue;
    }
    check(`locale/${file} carries meta.title`, typeof parsed.meta?.title === 'string' && parsed.meta.title !== '');
  }

  const patch = manifest.dsh?.bundle?.patch;
  check('dsh.bundle.patch is declared', typeof patch === 'string' && existsSync(join(ROOT, patch)), `found ${JSON.stringify(patch)}`);
  if (typeof patch === 'string' && existsSync(join(ROOT, patch))) {
    const source = readFileSync(join(ROOT, patch), 'utf8');
    check('bundle patch names this package', source.includes(manifest.name), `${patch} does not mention ${manifest.name}`);
  }

  check('dsh.client.platform is web', manifest.dsh?.client?.platform === 'web', `found ${JSON.stringify(manifest.dsh?.client?.platform)}`);
  const inject = manifest.dsh?.client?.inject;
  check('dsh.client.inject lists package names', Array.isArray(inject) && inject.every((name) => typeof name === 'string' && name !== ''), JSON.stringify(inject));

  const icon = manifest.icon;
  if (typeof icon === 'string') {
    const path = join(ROOT, icon);
    const size = existsSync(path) ? readFileSync(path).length : -1;
    check('icon exists and is within 256 KiB', size >= 0 && size <= 256 * 1024, size < 0 ? `${icon} is missing` : `${size} bytes`);
  }

  for (const pattern of manifest.files ?? []) {
    check(`files[] entry ${pattern} exists`, matchesFiles(pattern));
  }

  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
    check(`peerDependencies ${name} is a non-empty range`, typeof range === 'string' && range.trim() !== '', JSON.stringify(range));
  }
}

/** Check that both shipped halves parse as the module type the package declares. */
function verifyParse() {
  say.step('parse · shipped files');
  for (const file of ['index.js', 'client.js']) {
    const result = spawnSync(process.execPath, ['--check', join(ROOT, file)], { encoding: 'utf8' });
    check(`${file} parses`, result.status === 0, (result.stderr ?? '').trim().split('\n').slice(-3).join(' '));
  }
}

/**
 * Check that this plugin's copy of the build system matches the canonical one.
 *
 * Every plugin carries its own copy so that it stays a self-contained package that
 * can be copied and rebuilt on its own; the price is copies that drift. The
 * canonical files live in the build system's own directory next to the plugins, and
 * that directory — not a sibling plugin — is the reference whenever it is present.
 * With no canonical copy to compare against, remaining siblings still agree or not,
 * which is the best answer available in a lone copy of a plugin.
 */
function verifyBuildSystem() {
  const shared = ['build.mjs', 'verify.mjs', 'lib/fsx.mjs', 'lib/tar.mjs', 'lib/probe-runner.mjs'];
  const parent = dirname(ROOT);
  let siblings = [];
  try {
    siblings = readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== basename(ROOT))
      .map((entry) => join(parent, entry.name));
  } catch {
    siblings = [];
  }

  const canonical = findCanonicalBuildSystem();

  let references;
  if (canonical !== undefined) {
    say.step(`build system · matches the canonical copy in ${basename(canonical)}/`);
    references = [join(canonical, 'scripts')];
  } else {
    say.step('build system · matches the sibling copies');
    const peers = siblings.filter((directory) => existsSync(join(directory, 'scripts', 'lib', 'fsx.mjs')));
    if (peers.length === 0) {
      say.info('neither the canonical build system nor a sibling plugin carries it, so there is nothing to compare');
      return;
    }
    references = peers;
  }

  for (const file of shared) {
    const mine = readFileSync(join(ROOT, 'scripts', file));
    const drifted = references.filter((directory) => {
      try {
        return !readFileSync(join(directory, file)).equals(mine);
      } catch {
        return true;
      }
    });
    // With a canonical copy there is exactly one reference, so naming it would
    // only print "scripts differs"; without one, which sibling drifted is the point.
    const remedy = canonical === undefined
      ? `${drifted.map((directory) => basename(directory)).join(', ')} differ — decide which copy is right and copy it over the others`
      : `this plugin is behind ${basename(canonical)}/scripts — run \`node ${basename(canonical)}/sync.mjs\` to take the canonical file; if this plugin's copy is the improvement, move it into ${basename(canonical)}/ first`;
    check(`scripts/${file} is the canonical copy`, drifted.length === 0, remedy);
  }

  check('scripts/host-contract.mjs exists', existsSync(join(ROOT, 'scripts', 'host-contract.mjs')), `this plugin owns its Host-half probe — \`${syncCommand()}\` creates it from the template, and its TODO block still needs this plugin's assertions`);
}

/**
 * Run the plugin's own test script, when it declares one.
 *
 * `verify` deliberately does not re-implement behaviour tests; it runs whatever
 * `package.json` says the tests are, so one command answers "is this plugin
 * healthy" for a plugin with dependencies and for one whose whole surface is its
 * client half.
 */
function verifyTests() {
  const command = readJson(join(ROOT, 'package.json')).scripts?.test;
  say.step('tests · declared test script');
  if (typeof command !== 'string' || command === '') {
    say.info('package.json declares no test script');
    return;
  }
  const result = spawnSync('npm', ['test', '--silent'], { cwd: ROOT, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  check(`npm test passes (${command})`, result.status === 0, output.split('\n').filter((row) => row !== '').slice(-3).join(' '));
}

/**
 * Run the plugin's own Host-half probe in a fresh process.
 *
 * The assertions belong to the plugin (`scripts/host-contract.mjs`); the process,
 * the wire format and the failure reporting are the same everywhere and live in
 * `lib/probe-runner.mjs` on the plugin side. A separate process is not incidental:
 * a failed `import()` is cached for the life of the process, so probing the Host
 * half here rather than in the running Host is the only way to get a truthful
 * answer more than once.
 *
 * @param patchId - Entry id the bundle patch declares, handed to the probe.
 * @returns `{ identity, checks }`, or `{ checks: [<why no verdict>] }`.
 */
function probeHostHalf(patchId) {
  const script = join(ROOT, 'scripts', 'host-contract.mjs');
  if (!existsSync(script)) {
    return { checks: [{ label: 'the Host-half probe runs', ok: false, detail: `scripts/host-contract.mjs is missing — run \`${syncCommand()}\`` }] };
  }
  const result = spawnSync(process.execPath, [script, '--root', ROOT, '--patch-id', patchId ?? ''], { cwd: ROOT, encoding: 'utf8' });
  const line = (result.stdout ?? '').split('\n').find((candidate) => candidate.startsWith('PROBE '));
  if (line === undefined) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').filter((row) => row !== '').slice(-4).join(' ');
    return { checks: [{ label: 'the Host-half probe runs', ok: false, detail: `it produced no verdict (exit status ${result.status}): ${output}` }] };
  }
  return JSON.parse(line.slice('PROBE '.length));
}

/** Check that the Host half loads in a fresh process and honours its own contract. */
function verifyHostHalf() {
  say.step('runtime · Host half and its contract');
  const patch = readJson(join(ROOT, 'package.json')).dsh?.bundle?.patch;
  const patchId = typeof patch === 'string' && existsSync(join(ROOT, patch))
    ? /(?:^|\s)id:\s*['"]?([^\s'"]+)/u.exec(readFileSync(join(ROOT, patch), 'utf8'))?.[1]
    : undefined;

  const probe = probeHostHalf(patchId);
  for (const entry of probe.checks ?? []) check(entry.label, entry.ok, entry.detail);
  if (patchId !== undefined && probe.identity !== undefined) {
    check('bundle patch id equals the identity the Host half declares', probe.identity === patchId, `patch declares ${JSON.stringify(patchId)}, Host half owns ${JSON.stringify(probe.identity)} — renaming the entry id orphans whatever the plugin stored under it`);
  }
}

if (!isPluginPackage()) {
  say.fail(`${ROOT} holds no package.json, so it is not a plugin package`);
  say.info(`the canonical copy of the build system is not a plugin: copy it into one with \`${syncCommand()} <plugin directory>\``);
  process.exit(1);
}

verifyLayout();
verifyDependencies();
verifyManifest();
verifyBuildSystem();
verifyParse();
verifyTests();
verifyHostHalf();

if (failures.length > 0) {
  say.step(`verify · ${failures.length} check(s) failed`);
  for (const failure of failures) say.fail(failure);
  process.exitCode = 1;
} else {
  say.step('verify · all checks passed');
}
