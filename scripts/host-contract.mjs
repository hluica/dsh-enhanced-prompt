/**
 * Host-half contract probe for the enhanced-prompt bundle.
 *
 * This Host half is deliberately bare: it exports an id and an `apply()` that does
 * nothing, because all rendering happens in the client half. The one property worth
 * defending is that bareness — a Host half that imports a package the profile does
 * not provide becomes "enabled but not running" (`fiberPhase: null`), and Node caches
 * that failed import for the life of the process. So the assertion reads the source
 * and requires that there is no `import` in it at all, which is a stronger claim than
 * "the import happened to work here".
 *
 * @module scripts/host-contract
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runProbe } from './lib/probe-runner.mjs';

/**
 * Assert the Host-half contract.
 * @param context - `{ root, patchId, check }`.
 * @returns `{ identity }` — the entry id, compared against the bundle patch id.
 */
export async function probeHost({ root, patchId, check }) {
  const mod = await import(pathToFileURL(join(root, 'index.js')).href);

  check('exports apply()', typeof mod.apply === 'function');
  check('ENTRY_ID is the Loader entry id', mod.ENTRY_ID === 'dsh-enhanced-prompt', `${mod.ENTRY_ID} — the entry id is also the identity this bundle is mounted under in the profile patch`);

  let mounted = true;
  try {
    mod.apply();
  } catch (error) {
    mounted = false;
    check('apply() mounts without arguments', false, error.message);
  }
  if (mounted) check('apply() mounts without arguments', true);

  // Deliberately no regular expression: this file is plain JavaScript, but the
  // assertion itself is easy to get wrong, and `split` cannot silently degrade into
  // matching everything the way a mis-escaped pattern can.
  const source = await readFile(join(root, 'index.js'), 'utf8');
  const offending = source.split('\n').find((line) => line.trimStart().startsWith('import '));
  check('the Host half imports nothing', offending === undefined, (offending ?? '').trim());

  return { identity: mod.ENTRY_ID };
}

runProbe(import.meta.url, probeHost);
