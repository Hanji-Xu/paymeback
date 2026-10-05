/* Runs the earlier single-file app (the "legacy app") inside node:vm, so its simplification can be compared
   with docs/js/simplify.js. The legacy script is one function that reads a few DOM nodes when it loads and
   would start the whole page on DOMContentLoaded; with the stubs below it only defines its functions.

   The legacy file is not part of this repository. It is looked for one folder above the repository, or at
   the path in the SETTLE_LEGACY_HTML environment variable. Tests skip themselves when it is missing. */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const legacyPath = process.env.SETTLE_LEGACY_HTML || fileURLToPath(new URL('../../index.html', import.meta.url));

// With this line added, the legacy app asks window.__compute for a bill's result when one is set. That lets a
// test hand both implementations the very same bill results and compare the simplification alone.
const COMPUTE_START = 'function computeExpense(e) {';
const COMPUTE_HOOK = COMPUTE_START + ' if (window.__compute) return window.__compute(e);';

let script;   // compiled once, run in a fresh context for every group

function legacyScript() {
  if (script !== undefined) return script;
  script = null;
  if (!existsSync(legacyPath)) return script;
  const html = readFileSync(legacyPath, 'utf8');
  const open = '<script id="app-src">', start = html.indexOf(open), end = html.indexOf('</script>', start);
  if (start < 0 || end < 0) return script;
  const code = html.slice(start + open.length, end);
  if (!code.includes(COMPUTE_START)) throw new Error('The legacy app at ' + legacyPath + ' has no computeExpense to hook into.');
  script = new vm.Script(code.replace(COMPUTE_START, COMPUTE_HOOK), { filename: 'legacy-app.js' });
  return script;
}

export const legacyAvailable = () => legacyScript() !== null;

/* Load the legacy app with `group` as its only group and return what it exposes for testing:
   { computeExpense(bill), buildSteps(mode), allocate(total, entries) }.
   opts.compute, when given, replaces the legacy bill math: bill -> Result.
   Maps and Sets it returns were made inside the vm, so pass them through toPlain() before comparing. */
export function loadLegacy(group, opts = {}) {
  const app = legacyScript();
  if (!app) throw new Error('Legacy app not found at ' + legacyPath);
  const state = JSON.stringify({ version: 1, savedAt: 0, groups: [group] });
  const window = {
    document: {
      readyState: 'loading',            // the app then waits for DOMContentLoaded, which never comes
      head: null,
      getElementById: id => ({ textContent: id === 'split-state' ? state : '', innerHTML: '' }),
      addEventListener() {}
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false }),
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    __compute: opts.compute || null
  };
  window.window = window;
  app.runInNewContext(window);
  return window.__settle;
}

const tagOf = value => Object.prototype.toString.call(value);

// Maps and Sets (from the vm or from the new modules) as plain arrays, so both sides compare with deepStrictEqual.
export function toPlain(value) {
  if (tagOf(value) === '[object Map]' || tagOf(value) === '[object Set]' || Array.isArray(value)) return [...value].map(toPlain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]));
  return value;
}
