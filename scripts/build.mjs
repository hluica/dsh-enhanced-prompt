#!/usr/bin/env node
/**
 * Materialize the plugin's runtime dependencies as real files.
 *
 * Why this exists at all: the Host half imports `@deepseek-ai/schemastery`, and
 * the profile that mounts this plugin does not provide it, so the package has to
 * carry its own copy. A package manager's isolated layout carries it as a chain of
 * symbolic links into a virtual store, which breaks the moment the directory is
 * copied, archived, or viewed by anything that resolves links (and which Finder
 * turns into aliases). This build produces the same resolution result with plain
 * files: every dependency is a real directory under `node_modules/`, holding only
 * the entries that can be reached at runtime.
 *
 * The pipeline is a pure function of `deps.lock.json` and the pinned tarballs:
 * resolve the closure, fetch each tarball into `.cache/`, verify its published
 * integrity, extract only the allowlisted entries, wipe the generated tree, write
 * real files, and hand off to `scripts/verify.mjs`. Nothing is written before
 * every tarball is in hand, so a failing download or a mismatched digest leaves
 * the previous tree untouched.
 *
 * Usage:
 *   node scripts/build.mjs [--offline] [--force] [--registry=<url>] [--no-verify]
 *   node scripts/build.mjs --pin <name>@<exact version>
 *   node scripts/build.mjs --clean
 *
 * @module scripts/build
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readTar } from './lib/tar.mjs';
import {
  LOCK_PATH,
  NODE_MODULES,
  PACKAGE_MANAGER_ARTIFACTS,
  RECEIPT_NAME,
  RECEIPT_PATH,
  ROOT,
  TARBALL_CACHE,
  collectViolations,
  filesUnder,
  isPluginPackage,
  syncCommand,
  formatBytes,
  matchesIntegrity,
  readJson,
  rel,
  removeTree,
  say,
  sha256hex,
  writeJson,
} from './lib/fsx.mjs';

/** Receipt schema version; bump when the receipt shape changes, not the dependencies. */
const RECEIPT_VERSION = 1;

/**
 * The receipt's `tool` field, derived from the manifest.
 *
 * The build is carried by every plugin in this workspace, so nothing here names
 * one of them: the identity that matters is which package wrote the tree.
 * @param manifest - Parsed `package.json`.
 * @returns The tool identity, for example `@local/dsh-custom-css/build`.
 */
function receiptTool(manifest) {
  return `${manifest.name}/build`;
}

/**
 * Parse the command line.
 *
 * Flags are read here rather than in a dependency because the build must run with
 * nothing installed: it is what installs things.
 *
 * @param argv - Arguments after the script name.
 * @returns `{ clean, offline, force, pin, registry, verify }`.
 */
function parseArguments(argv) {
  const options = { clean: false, offline: false, force: false, pin: undefined, registry: undefined, verify: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--clean') options.clean = true;
    else if (argument === '--offline') options.offline = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--no-verify') options.verify = false;
    else if (argument === '--pin') options.pin = argv[++index];
    else if (argument.startsWith('--pin=')) options.pin = argument.slice('--pin='.length);
    else if (argument.startsWith('--registry=')) options.registry = argument.slice('--registry='.length).replace(/\/+$/u, '');
    else throw new Error(`build: unknown argument ${argument}\nusage: node scripts/build.mjs [--offline] [--force] [--registry=<url>] [--no-verify] [--clean] [--pin <name>@<version>]`);
  }
  if (options.pin === undefined && argv.includes('--pin')) throw new Error('build: --pin wants an exact name@version');
  return options;
}

/**
 * Require an exact version.
 *
 * Ranges are refused rather than resolved: this build vendors one tarball per
 * dependency and records its integrity, so a range would either be a lie in the
 * manifest or an unrecorded version in the tree. Pinning keeps `package.json` and
 * `deps.lock.json` telling the same story.
 *
 * @param range - Declared version or range.
 * @param name - Package the declaration belongs to, for the message.
 * @param where - Field the declaration came from, for the message.
 * @returns The exact version.
 * @throws When the declaration is not an exact version.
 */
function exactVersion(range, name, where) {
  if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(range)) return range;
  throw new Error(`${where}: ${name} must be pinned to an exact version, found ${JSON.stringify(range)} — this build vendors exact tarballs, so a range cannot be resolved or integrity-checked here`);
}

/**
 * Read the plugin manifest and the lock, and resolve the lock's closure.
 *
 * `package.json` decides *what* is required; the lock decides which exact tarball
 * satisfies it, and transitively which exact versions its own dependencies take.
 * A dependency that is declared but absent from the lock is an error rather than
 * an implicit registry lookup: an unrecorded version cannot be integrity-checked.
 *
 * @returns `{ manifest, lock, lockBytes, closure }` where `closure` lists lock
 * entries in dependency order.
 * @throws When a declared dependency has no lock entry, or the lock is malformed.
 */
function resolveClosure() {
  const manifest = readJson(join(ROOT, 'package.json'));
  // A plugin whose Host half imports nothing has no closure and needs no lock:
  // absence is the whole dependency policy, and an empty lock file would only be
  // one more thing to keep true.
  if (Object.keys(manifest.dependencies ?? {}).length === 0) {
    return { manifest, lock: undefined, lockBytes: undefined, closure: [] };
  }
  if (!existsSync(LOCK_PATH)) {
    throw new Error('deps.lock.json: dependencies are declared but nothing is pinned; pin each one with `node scripts/build.mjs --pin <name>@<exact version>`');
  }
  const lockBytes = readFileSync(LOCK_PATH);
  const lock = JSON.parse(lockBytes.toString('utf8'));
  if (lock.lockfileVersion !== 1) throw new Error(`deps.lock.json: unsupported lockfileVersion ${JSON.stringify(lock.lockfileVersion)}`);

  const entries = new Map();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (`${entry.name}@${entry.version}` !== key) {
      throw new Error(`deps.lock.json: entry ${key} describes ${entry.name}@${entry.version}; the key and the entry must agree`);
    }
    if (entries.has(entry.name)) {
      throw new Error(`deps.lock.json: ${entry.name} is pinned twice (${entries.get(entry.name).version} and ${entry.version}); edges resolve by name, so a package holds exactly one pinned version`);
    }
    entries.set(entry.name, entry);
  }

  const closure = [];
  const seen = new Set();
  const queue = Object.entries(manifest.dependencies ?? {})
    .map(([name, range]) => ({ name, version: exactVersion(range, name, 'package.json dependencies'), requiredBy: 'package.json' }));
  while (queue.length > 0) {
    const { name, version, requiredBy } = queue.shift();
    const entry = entries.get(name);
    if (entry === undefined) {
      throw new Error(`deps.lock.json: ${requiredBy} requires ${name}, which has no pinned entry; pin one with \`node scripts/build.mjs --pin ${name}@<exact version>\``);
    }
    if (entry.version !== version && requiredBy === 'package.json') {
      throw new Error(`deps.lock.json: package.json requires ${name}@${version} but the lock pins ${entry.version}; pin it with \`node scripts/build.mjs --pin ${name}@${version}\``);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    closure.push({ key: `${entry.name}@${entry.version}`, ...entry });
    for (const childName of Object.keys(entry.dependencies ?? {})) {
      queue.push({ name: childName, requiredBy: `deps.lock.json ${name}@${entry.version}` });
    }
  }
  return { manifest, lock, lockBytes, closure };
}

/**
 * Split an exact `name@version` pin request.
 * @param spec - Argument as typed.
 * @returns `{ name, version }`.
 * @throws When the spec is not an exact package-and-version pair.
 */
function parsePinSpec(spec) {
  const match = /^(@[^/]+\/[^@]+|[^@/][^@]*)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(spec);
  if (match === null) throw new Error(`build: --pin wants an exact name@version, got ${JSON.stringify(spec)} (for example --pin @deepseek-ai/schemastery@3.18.4)`);
  return { name: match[1], version: match[2] };
}

/**
 * Record one package's registry facts in the lock, so nobody has to transcribe
 * an integrity hash by hand.
 *
 * What is fetched is authoritative (`resolved`, `integrity`, the declared
 * dependency edges); what is *not* fetched is a resolution decision. The lock
 * pins one version per name and edges resolve by name, so a range declared by a
 * dependency never has to be resolved here — the pinned entry is what the
 * maintainer reviewed. An entry that already exists keeps its `vendor` allowlist
 * and its `note`, because both record judgement rather than registry facts.
 *
 * @param spec - `name@exact-version` as typed on the command line.
 * @param registryOverride - Mirror to query instead of the lock's registry.
 * @returns The name that was pinned.
 */
async function pinPackage(spec, registryOverride) {
  const { name, version } = parsePinSpec(spec);
  const lock = readJson(LOCK_PATH);
  const registry = registryOverride ?? lock.registry;
  const key = `${name}@${version}`;

  let manifest;
  try {
    const response = await fetch(`${registry.replace(/\/+$/u, '')}/${name.replace('/', '%2f')}/${version}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    manifest = await response.json();
  } catch (error) {
    throw new Error(`build: cannot read ${key} from ${registry} (${error.message}); pass --registry=<mirror> if that registry is unreachable`);
  }
  const { tarball, integrity } = manifest.dist ?? {};
  if (typeof tarball !== 'string' || typeof integrity !== 'string') {
    throw new Error(`build: ${registry} returned no dist.tarball/dist.integrity for ${key}`);
  }
  if (manifest.version !== version) {
    throw new Error(`build: ${registry} answered ${key} with version ${manifest.version}`);
  }

  const existing = lock.packages[key];
  const dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([, range]) => typeof range === 'string').sort(([left], [right]) => left.localeCompare(right)));
  lock.packages[key] = {
    name,
    version,
    // Canonical, mirror-independent: the origin comes from the lock, the path from
    // whatever served the tarball, so `--registry` stays a fetch-time concern.
    resolved: new URL(new URL(tarball).pathname.replace(/^\//u, ''), `${lock.registry.replace(/\/+$/u, '')}/`).href,
    integrity,
    vendor: existing?.vendor ?? '*',
    dependencies,
    ...(existing?.note === undefined ? {} : { note: existing.note }),
  };
  writeJson(LOCK_PATH, lock);

  say.step(`pin · ${key}`);
  say.ok(`${existing === undefined ? 'added to' : 'updated in'} deps.lock.json (integrity ${integrity.slice(0, 24)}…)`);
  if (existing === undefined) say.info(`vendor is "*" — every file of the tarball is vendored. Trim it to the entries that load at runtime once the feature using this package works.`);
  if (existing !== undefined && JSON.stringify(existing.dependencies ?? {}) !== JSON.stringify(dependencies)) {
    say.warn(`declared dependencies changed: ${JSON.stringify(existing.dependencies ?? {})} → ${JSON.stringify(dependencies)}; check that the pinned entry of each still satisfies the range`);
  }
  const pinned = new Set(Object.values(lock.packages).map((entry) => entry.name));
  for (const dependency of Object.keys(dependencies)) {
    if (!pinned.has(dependency)) say.warn(`${key} requires ${dependency} (${dependencies[dependency]}), which has no pinned entry yet — pin it too, or the build will refuse`);
  }
  return { name, key };
}

/**
 * Read a tarball from the cache, downloading it when it is missing.
 *
 * The cache is keyed by package and version and validated by integrity on every
 * read, so a truncated or substituted file is refetched instead of trusted.
 *
 * @param pkg - Lock entry being materialized.
 * @param url - Tarball URL to fetch when the cache cannot answer.
 * @param offline - When true, a cache miss is an error rather than a download.
 * @returns The verified tarball bytes.
 */
async function obtainTarball(pkg, url, offline) {
  const cached = join(TARBALL_CACHE, `${pkg.name.replaceAll('/', '+')}-${pkg.version}.tgz`);
  if (existsSync(cached)) {
    const bytes = readFileSync(cached);
    if (matchesIntegrity(bytes, pkg.integrity)) return { bytes, source: 'cache' };
    say.warn(`cache entry for ${pkg.key} failed its integrity check; discarding it`);
    removeTree(cached);
  }
  if (offline) throw new Error(`build: --offline was requested but ${pkg.key} is not in the tarball cache; run the build once without --offline`);

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`build: cannot reach ${url} for ${pkg.key} (${error.message}); pass --registry=<mirror> or --offline`);
  }
  if (!response.ok) throw new Error(`build: ${url} answered ${response.status} ${response.statusText} for ${pkg.key}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!matchesIntegrity(bytes, pkg.integrity)) {
    throw new Error(`build: ${pkg.key} downloaded from ${url} does not match deps.lock.json integrity ${pkg.integrity}; refusing to install it`);
  }
  mkdirSync(TARBALL_CACHE, { recursive: true });
  writeFileSync(cached, bytes);
  return { bytes, source: 'registry' };
}

/**
 * Drop the wrapper directory every npm tarball carries.
 *
 * `npm pack` roots an archive at a single directory (conventionally `package/`),
 * so allowlisted paths are only meaningful relative to it. The strip is derived
 * from the archive rather than hard-coded, and is skipped when the entries do not
 * actually share one root.
 *
 * @param entries - Entries as read from the tarball.
 * @returns Entries with package-relative paths.
 */
function withoutWrapperDirectory(entries) {
  const roots = new Set(entries.map((entry) => entry.path.split('/')[0]));
  if (roots.size !== 1) return entries;
  const [root] = roots;
  return entries
    .map((entry) => ({ ...entry, path: entry.path.slice(root.length + 1) }))
    .filter((entry) => entry.path !== '');
}

/**
 * Build the tarball URL to fetch, honouring a registry override.
 *
 * Only the origin is replaced: the path in the lock is what the registry's own
 * layout uses, so a mirror is addressed by moving that path under the mirror's
 * origin rather than by string-substituting a host.
 *
 * @param resolved - Tarball URL recorded in the lock.
 * @param registry - Mirror origin to use instead, when one was requested.
 * @returns Absolute URL to fetch.
 */
function tarballUrl(resolved, registry) {
  const recorded = new URL(resolved);
  if (registry === undefined) return recorded.href;
  return new URL(recorded.pathname.replace(/^\//u, ''), `${registry.replace(/\/+$/u, '')}/`).href;
}

/**
 * Which files of a package the tree keeps.
 *
 * A list is an explicit judgement call; `"*"` is the safe default a fresh pin
 * starts from — everything the tarball ships, so a package whose entry imports
 * siblings cannot be broken by a half-written allowlist. `[]` means the package
 * is in the closure for the record but contributes nothing (a type-only edge).
 *
 * @param pkg - Lock entry.
 * @param available - Every file the tarball contains, keyed by path.
 * @returns The paths to keep.
 */
function vendoredPaths(pkg, available) {
  if (pkg.vendor === '*') return [...available.keys()];
  return pkg.vendor;
}

/**
 * Prepare every package's files in memory, before anything on disk is touched.
 *
 * Allowlisting here is what makes the tree minimal: the published tarball of a
 * library ships documentation, type declarations and TypeScript sources that
 * never load at runtime, and they are dropped rather than copied.
 *
 * @param closure - Resolved lock entries.
 * @param registry - Registry override to fetch from, or undefined for the lock's own.
 * @param offline - Whether downloads are forbidden.
 * @returns `{ prepared, receipts }` — files per package, and receipt records.
 */
async function prepare(closure, registry, offline) {
  const prepared = [];
  const receipts = {};
  for (const pkg of closure) {
    if (pkg.vendor !== '*' && pkg.vendor.length === 0) {
      say.info(`${pkg.key} — nothing vendored${pkg.note === undefined ? '' : ` (${pkg.note.split(':')[0]})`}`);
      continue;
    }
    const { bytes, source } = await obtainTarball(pkg, tarballUrl(pkg.resolved, registry), offline);
    const entries = withoutWrapperDirectory(readTar(bytes));
    const available = new Map(entries.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry]));
    const wanted = vendoredPaths(pkg, available);

    const files = [];
    const missing = [];
    for (const allowed of wanted) {
      const entry = available.get(allowed);
      if (entry === undefined) missing.push(allowed);
      else files.push(entry);
    }
    if (missing.length > 0) {
      const sample = [...available.keys()].slice(0, 8).join(', ');
      throw new Error(`deps.lock.json: ${pkg.key} does not ship ${missing.join(', ')}; the package changed shape, so re-check its runtime entries. The tarball contains: ${sample}${available.size > 8 ? ', …' : ''}`);
    }

    const bytesKept = files.reduce((total, entry) => total + entry.data.length, 0);
    const dropped = entries.filter((entry) => entry.type === 'file' && !wanted.includes(entry.path)).length;
    say.info(`${pkg.key} — ${files.length} file(s), ${formatBytes(bytesKept)} from ${source}, ${dropped} entr${dropped === 1 ? 'y' : 'ies'} dropped${pkg.vendor === '*' ? ' (vendor "*" keeps everything)' : ''}`);
    prepared.push({ pkg, files });
    receipts[pkg.name] = {
      version: pkg.version,
      integrity: pkg.integrity,
      files: Object.fromEntries(files.map((entry) => [entry.path, sha256hex(entry.data)])),
    };
  }
  return { prepared, receipts };
}

/**
 * Whether the generated tree already matches the lock exactly.
 *
 * A cheap path for the common case: the receipt records the lock's digest and a
 * digest per file, so an untouched tree is recognized without touching the
 * network. The comparison is set-exact in both directions — a missing file and an
 * extra one are both drift.
 *
 * @param manifest - Parsed `package.json`, which identifies the receipt.
 * @param lockBytes - Raw `deps.lock.json`, whose digest is the receipt's identity.
 * @param receipts - Receipt records the current lock would produce.
 * @returns True when every recorded file is present, unchanged, unlinked, and
 * unaccompanied, and no package-manager artifact reappeared.
 */
function treeIsCurrent(manifest, lockBytes, receipts) {
  if (!existsSync(RECEIPT_PATH)) return false;
  let receipt;
  try {
    receipt = readJson(RECEIPT_PATH);
  } catch {
    return false;
  }
  if (receipt.tool !== receiptTool(manifest) || receipt.version !== RECEIPT_VERSION) return false;
  if (receipt.lockHash !== sha256hex(lockBytes)) return false;
  const names = Object.keys(receipt.packages ?? {}).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(receipts).sort())) return false;
  for (const name of names) {
    const recorded = receipt.packages[name];
    if (recorded.version !== receipts[name].version) return false;
    const expected = Object.entries(recorded.files ?? {});
    const found = [...filesUnder(join(NODE_MODULES, name))];
    if (found.length !== expected.length || found.some((entry) => entry.linked)) return false;
    const digests = new Map(found.map((entry) => [entry.rel, sha256hex(readFileSync(entry.path))]));
    if (expected.some(([file, digest]) => digests.get(file) !== digest)) return false;
  }
  return !PACKAGE_MANAGER_ARTIFACTS.some((artifact) => existsSync(join(NODE_MODULES, artifact)));
}

/**
 * Replace the generated tree with the prepared files.
 *
 * The tree is wholly generated, so it is removed rather than merged: a merge
 * would silently keep a leftover virtual store, and the leftover is precisely
 * what this build exists to eliminate. Anything that was not produced by this
 * build is reported before it goes.
 *
 * @param manifest - Parsed `package.json`, which identifies the receipt.
 * @param prepared - Files to write, grouped by package.
 * @param receipts - Receipt records for the tree being written.
 * @param lockBytes - Raw lock, digested into the receipt.
 * @param registry - Registry the bytes actually came from.
 */
function writeTree(manifest, prepared, receipts, lockBytes, registry) {
  const expected = new Set(prepared.map(({ pkg }) => pkg.name.split('/')[0]));
  const unexpected = existsSync(NODE_MODULES)
    ? readdirSync(NODE_MODULES).filter((name) => name !== RECEIPT_NAME && !expected.has(name))
    : [];
  if (unexpected.length > 0) say.warn(`removing ${unexpected.length} unmanaged entr${unexpected.length === 1 ? 'y' : 'ies'} from node_modules: ${unexpected.join(', ')}`);

  removeTree(NODE_MODULES);
  mkdirSync(NODE_MODULES, { recursive: true });

  let written = 0;
  let bytes = 0;
  for (const { pkg, files } of prepared) {
    for (const entry of files) {
      const target = join(NODE_MODULES, pkg.name, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data);
      chmodSync(target, (entry.mode & 0o777) || 0o644);
      written += 1;
      bytes += entry.data.length;
    }
  }
  writeJson(RECEIPT_PATH, {
    tool: receiptTool(manifest),
    version: RECEIPT_VERSION,
    registry,
    lockHash: sha256hex(lockBytes),
    packages: receipts,
  });
  say.ok(`wrote ${written} file(s), ${formatBytes(bytes)} into node_modules/`);
}

/**
 * Run the build.
 * @returns Exit code: 0 when the tree was written or already current and verified.
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!isPluginPackage()) {
    say.fail(`${ROOT} holds no package.json, so it is not a plugin package`);
    say.info(`the canonical copy of the build system is not a plugin: copy it into one with \`${syncCommand()} <plugin directory>\``);
    return 1;
  }
  if (options.clean) {
    const removed = [NODE_MODULES, join(ROOT, '.cache')].filter((path) => existsSync(path));
    for (const path of removed) removeTree(path);
    say.ok(`removed ${removed.length === 0 ? 'nothing' : removed.map((path) => `${rel(path)}/`).join(' and ')}`);
    return 0;
  }

  const pinned = options.pin === undefined ? undefined : await pinPackage(options.pin, options.registry);

  const { manifest, lock, lockBytes, closure } = resolveClosure();
  if (Object.keys(manifest.dependencies ?? {}).length === 0) {
    say.step(`${manifest.name} · no runtime dependencies`);
    // Nothing is declared, so nothing may be installed: an absent tree is the only
    // shape that cannot hide a stale or linked dependency, and anything sitting in
    // node_modules is removed rather than left to be misread as the dependency set.
    if (existsSync(NODE_MODULES)) {
      say.warn(`no dependencies are declared, so ${rel(NODE_MODULES)}/ is removed`);
      removeTree(NODE_MODULES);
    } else {
      say.ok(`${rel(NODE_MODULES)}/ is absent, which is the declared policy`);
    }
    return finish(options);
  }

  const registry = options.registry ?? lock.registry;
  const vendorable = closure.filter((pkg) => pkg.vendor === '*' || pkg.vendor.length > 0).length;
  say.step(`${manifest.name} · vendoring ${vendorable} runtime package(s) as real files`);
  if (pinned !== undefined && !closure.some((pkg) => pkg.name === pinned.name)) {
    say.warn(`${pinned.key} is pinned but nothing requires it: declare it in package.json dependencies (exact version) or in the dependencies of the package that needs it`);
  }

  const { prepared, receipts } = await prepare(closure, options.registry, options.offline);

  if (!options.force && treeIsCurrent(manifest, lockBytes, receipts)) say.ok('node_modules/ already matches deps.lock.json');
  else writeTree(manifest, prepared, receipts, lockBytes, registry);

  return finish(options);
}

/**
 * Strip macOS sidecars, then hand over to `verify`.
 *
 * Both halves of the build end here so that "the tree is clean" and "the plugin
 * is healthy" mean the same thing whatever the plugin's dependency set is.
 *
 * @param options - Parsed arguments; `verify: false` stops after the cleanup.
 * @returns Exit code from `verify`, or 0 when verification was skipped.
 */
function finish(options) {
  const stripped = collectViolations().junk;
  for (const path of stripped) removeTree(join(ROOT, path));
  if (stripped.length > 0) say.ok(`removed ${stripped.length} macOS sidecar file(s)`);

  if (!options.verify) return 0;
  const verified = spawnSync(process.execPath, [join(ROOT, 'scripts', 'verify.mjs')], { stdio: 'inherit' });
  return verified.status ?? 1;
}

process.exitCode = await main().catch((error) => {
  say.fail(error.message);
  say.info(existsSync(NODE_MODULES) ? `nothing was replaced: ${rel(NODE_MODULES)}/ still holds the previous tree` : `${rel(NODE_MODULES)}/ is absent, and nothing was written`);
  return 1;
});
