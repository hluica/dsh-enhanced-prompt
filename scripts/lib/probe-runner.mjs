/**
 * Make a plugin's `host-contract.mjs` runnable as its own process.
 *
 * `verify` probes the Host half in a fresh process on purpose: a failed
 * `import()` is cached by the module loader for the life of the process, so a
 * probe running anywhere else would answer truthfully only once. This module owns
 * that boilerplate — argument reading, the assertion collector, the `PROBE` line —
 * so the plugin's own file contains nothing but its assertions.
 *
 * A probe module ends with one line:
 *
 * ```js
 * runProbe(import.meta.url, probeHost);
 * ```
 *
 * which does nothing when the module is imported and everything when it is the
 * process entry point.
 *
 * @module scripts/lib/probe-runner
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read a `--name value` argument.
 * @param argv - Arguments after the script name.
 * @param name - Flag to look for.
 * @returns The following argument, or undefined.
 */
function argument(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * Run a plugin's probe when this module's owner is the entry point.
 *
 * Every assertion is recorded — passing ones too — so the checker's report shows
 * the plugin's own contract alongside the generic invariants instead of hiding it
 * behind a single line.
 *
 * @param moduleUrl - `import.meta.url` of the calling probe module.
 * @param probeHost - `async ({ root, patchId, check }) => ({ identity })`.
 */
export async function runProbe(moduleUrl, probeHost) {
  const self = fileURLToPath(moduleUrl);
  if (process.argv[1] === undefined || resolve(process.argv[1]) !== self) return;

  const argv = process.argv.slice(2);
  const root = argument(argv, '--root') ?? dirname(dirname(self));
  const patchId = argument(argv, '--patch-id');
  const checks = [];
  const check = (label, condition, detail) => {
    checks.push({ label, ok: condition === true, detail: detail === undefined ? undefined : String(detail) });
  };

  let identity;
  try {
    identity = (await probeHost({ root, patchId, check }))?.identity;
  } catch (error) {
    // The import itself failing is the failure this probe exists to catch, so it is
    // reported as one check rather than as a crashed process: the checker can then
    // print the reason next to everything else that passed.
    checks.push({ label: 'the Host half imports', ok: false, detail: error.message });
  }

  process.stdout.write(`PROBE ${JSON.stringify({ identity, checks })}\n`);
}
