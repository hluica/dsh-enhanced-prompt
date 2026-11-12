/**
 * Host half of the enhanced-prompt bundle.
 *
 * It owns no settings and no Host-side state: the feature is a presentation
 * choice with no durable preference. Per the agreed design there is no switch
 * either — enabling this bundle rewrites the bubble, and disabling the bundle
 * is the way to get the shipped rendering back. The Client half disposes its
 * slot shadow on unload, so the shipped renderer returns by itself.
 *
 * This module therefore only exists to give the Loader entry something to
 * mount. It deliberately imports nothing: a bare import keeps the entry immune
 * to the "enabled but `fiberPhase: null`" failure mode, which happens when a
 * Host half pulls in a package the profile does not provide.
 *
 * All rendering lives in `./client.js`.
 */

/** Loader entry id, also this bundle's identity in the profile patch. */
const ENTRY_ID = 'dsh-enhanced-prompt';

/**
 * Mount the Host half. There is nothing to mount: the Client half is loaded
 * from `exports["./client"]` via the `dsh.client` declaration in
 * `package.json`, independently of this function.
 */
function apply() {}

export { ENTRY_ID, apply };
