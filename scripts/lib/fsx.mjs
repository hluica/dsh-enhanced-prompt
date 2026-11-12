/**
 * Filesystem facts the dependency build and its verification share.
 *
 * The invariant both halves enforce is the same one: every byte of this plugin's
 * dependency tree is a real file in a real directory. A symbolic link, a Finder
 * alias, or a stray macOS sidecar is a defect rather than cosmetic noise, so the
 * probes that find them live here, next to the paths they are run against.
 *
 * @module scripts/lib/fsx
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the plugin package root — the directory holding `package.json`. */
export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Generated dependency tree. Always produced by `scripts/build.mjs`, never by hand. */
export const NODE_MODULES = join(ROOT, 'node_modules');

/** Tarball cache, so a rebuild needs no network. Safe to delete at any time. */
export const TARBALL_CACHE = join(ROOT, '.cache', 'tarballs');

/** Pinned dependency intent: versions, integrity, and what each package contributes. */
export const LOCK_PATH = join(ROOT, 'deps.lock.json');

/** Build receipt inside the generated tree, recording what was written and its digests. */
export const RECEIPT_NAME = '.dsh-vendor.json';
export const RECEIPT_PATH = join(NODE_MODULES, RECEIPT_NAME);

/**
 * Artifacts a package manager leaves behind in this directory. They are listed
 * rather than tolerated because each one means a symlink-based layout was created
 * here at some point, and the receipt cannot describe it.
 */
export const PACKAGE_MANAGER_ARTIFACTS = [
  '.pnpm',
  '.bin',
  '.modules.yaml',
  '.pnpm-workspace-state-v1.json',
  '.package-lock.json',
  '.yarn-integrity',
];

/** Names macOS adds to directories it touches, and the Finder alias signature. */
const MACOS_SIDECAR = /^(?:\.DS_Store|\._[^/]*|\.Spotlight-V100|\.Trashes|\.fseventsd|\.AppleDouble|\.LSOverride|\.VolumeIcon\.icns)$/u;
const MACOS_DIRECTORY = /^(?:__MACOSX)$/u;
const ALIAS_MAGIC = 0x626f6f6b;

/**
 * Whether this directory is a plugin package rather than the canonical copy itself.
 *
 * The build system's canonical copy sits next to the plugins, so running its scripts
 * from there is an easy mistake to make; it should say so instead of failing on a
 * missing manifest.
 *
 * @returns True when `package.json` is present at the plugin root.
 */
export function isPluginPackage() {
  return existsSync(join(ROOT, 'package.json'));
}

/**
 * Locate the canonical copy of this build system among the plugin's siblings.
 *
 * It is identified by what it holds — a sync tool, a probe template, and the shared
 * libraries — rather than by its directory name, so renaming the directory cannot
 * silently downgrade a check into a comparison of plugins, and so diagnostics can
 * name the directory the reader will actually see.
 *
 * @returns Absolute directory of the canonical copy, or undefined when there is none.
 */
export function findCanonicalBuildSystem() {
  const parent = dirname(ROOT);
  let siblings;
  try {
    siblings = readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(parent, entry.name));
  } catch {
    return undefined;
  }
  return siblings.find((directory) => existsSync(join(directory, 'sync.mjs'))
    && existsSync(join(directory, 'scripts', 'host-contract.template.mjs'))
    && existsSync(join(directory, 'scripts', 'lib', 'probe-runner.mjs')));
}

/**
 * The command that copies the canonical build system into a plugin.
 *
 * Spelled from wherever the canonical copy actually is, so the instructions printed
 * by a failed check stay runnable after the directory is renamed.
 *
 * @returns A shell command fragment, for example ``node build-system/sync.mjs``.
 */
export function syncCommand() {
  const canonical = findCanonicalBuildSystem();
  return `node ${canonical === undefined ? 'build-system' : basename(canonical)}/sync.mjs`;
}

/**
 * Convert an absolute path inside the plugin into its reporting form.
 * @param path - Absolute path.
 * @returns Path relative to the plugin root, with `/` separators.
 */
export function rel(path) {
  const value = relative(ROOT, path);
  return value.split(sep).join('/');
}

/**
 * Walk a tree without ever following a link.
 *
 * `readdir` with file types plus `lstat` means a symlink is reported as itself,
 * which is what every probe below needs; a follow-based walk would hide the very
 * entries that have to be found.
 *
 * @param root - Directory to walk.
 * @param options - Optional `skip` predicate; return true to prune a subtree.
 * @yields `{ path, rel, name, dirent }` for every entry below `root`, depth first.
 */
export function* walkTree(root, options = {}) {
  const walk = function* walk(directory) {
    let names;
    try {
      names = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // A tree being rewritten underneath a probe is not a walk failure.
    }
    for (const dirent of names) {
      const path = join(directory, dirent.name);
      const entry = { path, rel: rel(path), name: dirent.name, dirent };
      if (options.skip?.(entry) === true) continue;
      yield entry;
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) yield* walk(path);
    }
  };
  yield* walk(root);
}

/**
 * Whether a file is a Finder alias rather than its target's contents.
 *
 * A Finder alias is a regular file whose payload starts with the `book` alias
 * record magic, so it is invisible to a link check and must be probed by content.
 * Resource-fork aliases (FinderInfo flag `kIsAlias`) keep their payload in the
 * fork and are out of reach of a Node probe; they are not created by the copy
 * operations this plugin sees.
 *
 * @param path - Absolute path of a regular file.
 * @returns True when the payload carries the alias signature.
 */
export function isFinderAlias(path) {
  let handle;
  try {
    handle = readFileSync(path, { flag: 'r' });
  } catch {
    return false;
  }
  return handle.length >= 4 && handle.readUInt32BE(0) === ALIAS_MAGIC;
}

/**
 * Collect every entry that breaks the real-file invariant.
 * @param root - Directory to inspect; defaults to the plugin root.
 * @returns `{ links, aliases, junk }`, each an array of reporting paths.
 */
export function collectViolations(root = ROOT) {
  const links = [];
  const aliases = [];
  const junk = [];
  for (const entry of walkTree(root)) {
    const name = entry.dirent.name;
    if (MACOS_SIDECAR.test(name) || MACOS_DIRECTORY.test(name)) junk.push(entry.rel);
    else if (entry.dirent.isSymbolicLink()) links.push(entry.rel);
    else if (entry.dirent.isFile() && isFinderAlias(entry.path)) aliases.push(entry.rel);
  }
  return { links, aliases, junk };
}

/**
 * List every file below a directory, without following links.
 *
 * Both halves of the build compare a package directory against a recorded file
 * set, and both must see a link as a file rather than as its target, so the walk
 * is shared instead of written twice.
 *
 * @param directory - Directory to list.
 * @param prefix - Path prefix accumulated so far.
 * @yields `{ path, rel, linked }` for every non-directory entry, depth first.
 */
export function* filesUnder(directory, prefix = '') {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of entries) {
    const path = join(directory, dirent.name);
    if (dirent.isSymbolicLink()) yield { path, rel: `${prefix}${dirent.name}`, linked: true };
    else if (dirent.isDirectory()) yield* filesUnder(path, `${prefix}${dirent.name}/`);
    else yield { path, rel: `${prefix}${dirent.name}`, linked: false };
  }
}

/**
 * Delete a path if it exists, following nothing.
 * @param path - Absolute path to remove.
 */
export function removeTree(path) {
  rmSync(path, { recursive: true, force: true });
}

/**
 * Read and parse a JSON file, naming it in the failure.
 * @param path - Absolute path.
 * @returns The parsed value.
 * @throws When the file is unreadable or not JSON.
 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${rel(path)}: ${error.message}`);
  }
}

/**
 * Write a JSON file, creating parents, with a trailing newline.
 * @param path - Absolute path.
 * @param value - Value to serialize.
 */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * SHA-256 of a buffer, in hex.
 * @param buffer - Bytes to digest.
 * @returns Lowercase hex digest.
 */
export function sha256hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Verify a Subresource-Integrity string against bytes.
 * @param buffer - Bytes to digest.
 * @param integrity - `sha512-<base64>` as the registry publishes it.
 * @returns True when the digest matches.
 */
export function matchesIntegrity(buffer, integrity) {
  const [algorithm, expected] = String(integrity).split('-', 2);
  if (algorithm !== 'sha512' || expected === undefined) return false;
  return createHash('sha512').update(buffer).digest('base64') === expected;
}

/**
 * Render a byte count for the build report.
 * @param bytes - Count to render.
 * @returns Human-readable size with one decimal.
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/** Report prefixes, kept identical across both scripts so output stays greppable. */
export const say = {
  step: (message) => console.log(`\u001B[1m${message}\u001B[0m`),
  info: (message) => console.log(`  ${message}`),
  ok: (message) => console.log(`  \u001B[32m✓\u001B[0m ${message}`),
  warn: (message) => console.log(`  \u001B[33m!\u001B[0m ${message}`),
  fail: (message) => console.log(`  \u001B[31m✗\u001B[0m ${message}`),
};
