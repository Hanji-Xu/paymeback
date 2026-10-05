/* The published folder as a whole: what the browser's content security policy would block, links between
   the files, and the words on the page that are promises about the parser. No browser is needed: these
   read the files under docs/ as text. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import { EXAMPLE_GROUP, computeExpense } from '../docs/js/core.js';
import { parseText } from '../docs/js/parse.js';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(DOCS).filter(path => !path.endsWith('.DS_Store'));
const names = files.map(path => relative(DOCS, path).split('\\').join('/'));
const read = name => readFileSync(join(DOCS, name), 'utf8');
const html = read('index.html');
const modules = names.filter(name => /^js\/[^/]+\.js$/.test(name));
const scripts = [...modules, 'sw.js'];

const unescape = s => s.replace(/&#10;/g, '\n').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('the published folder holds the page, one stylesheet, the modules and the offline worker, and nothing else', () => {
  assert.deepEqual(names.slice().sort(), ['.nojekyll', 'css/style.css', 'index.html', ...modules, 'sw.js'].sort());
  assert.deepEqual(modules.slice().sort(), ['app', 'core', 'editor', 'graph', 'parse', 'share', 'simplify', 'stage', 'store'].map(n => `js/${n}.js`));
});

test('the page sets the content security policy of the spec, and loads one stylesheet and one module', () => {
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(policy, 'the policy is there');
  assert.equal(policy[1], "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self' https://open.er-api.com; base-uri 'none'; form-action 'none'");
  assert.deepEqual([...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(m => [m[1].trim(), m[2]]), [['type="module" src="./js/app.js"', '']]);
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]), ['./css/style.css']);
  assert.ok(!/<style\b/i.test(html), 'no style element');
});

test('nothing the policy would block: no style attributes, no inline handlers, no javascript: links, no eval', () => {
  for (const name of ['index.html', ...scripts]) {
    const text = read(name);
    assert.ok(!/\sstyle\s*=\s*["'`\\]/i.test(text), `${name}: a style attribute`);
    assert.ok(!/\son[a-z]+\s*=\s*["'`\\]/i.test(text), `${name}: an inline event handler`);
    assert.ok(!/javascript:/i.test(text), `${name}: a javascript: address`);
    assert.ok(!/\beval\s*\(|new Function\b|setAttribute\(\s*['"]style['"]|\.cssText\b|document\.write/.test(text), `${name}: eval or a style written as text`);
  }
});

test('every address is relative, except the exchange rates and the credit for them', () => {
  const allowed = new Set(['https://open.er-api.com', 'https://open.er-api.com/v6/latest/USD', 'https://www.exchangerate-api.com',
    'http://www.w3.org/2000/svg']);   // the last one is the name of the SVG format inside the icon, not a request
  for (const name of names.filter(n => /\.(html|css|js)$/.test(n))) {
    const text = read(name);
    for (const m of text.matchAll(/\bhttps?:\/\/[^\s"'`<>);]+/g)) assert.ok(allowed.has(m[0]), `${name}: ${m[0]}`);
    assert.ok(!/(?:src|href)\s*=\s*["']\/(?!\/)/.test(text), `${name}: an address that starts at the root of the server`);
    assert.ok(!/@import|url\(\s*["']?(?!data:)/.test(name.endsWith('.css') ? text : ''), `${name}: the stylesheet loads another file`);
  }
  // The one request to another site is made in store.js and nowhere else.
  // (The offline worker fetches the page's own files.)
  for (const name of scripts) {
    const asks = /(?<![.\w])fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(read(name));
    assert.equal(asks, name === 'js/store.js' || name === 'sw.js', `${name}: asks the network for something, or should and does not`);
  }
});

test('the modules import only each other, by names that exist, and export by name only', () => {
  const exported = new Map(modules.map(name => {
    const text = read(name);
    assert.ok(!/^export\s+default\b/m.test(text), `${name}: a default export`);
    return [name, new Set([...text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]))];
  }));
  for (const name of modules) {
    const text = read(name);
    assert.ok(!/\bimport\s*\(/.test(text), `${name}: a module loaded later`);
    const imports = [...text.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?$/gm)];
    assert.equal(imports.length, (text.match(/^import\b/gm) || []).length, `${name}: an import in another form`);
    for (const [, list, from] of imports) {
      assert.match(from, /^\.\/[a-z]+\.js$/, `${name}: ${from}`);
      const target = exported.get('js/' + from.slice(2));
      assert.ok(target, `${name}: ${from} does not exist`);
      for (const what of list.split(',').map(s => s.trim()).filter(Boolean)) {
        assert.ok(target.has(what), `${name}: ${from} has no ${what}`);
        assert.ok(text.split(what).length > 2, `${name}: ${what} is imported and never used`);
      }
    }
  }
  // The pure modules never reach for the page.
  for (const name of ['js/core.js', 'js/simplify.js', 'js/parse.js', 'js/share.js', 'js/graph.js', 'js/store.js']) {
    assert.ok(!/\bdocument\.|\bwindow\./.test(read(name)), `${name} touches the page`);
  }
});

test('every element the scripts look up by id is on the page, once', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'an id is used twice');
  for (const name of modules) {
    for (const m of read(name).matchAll(/(?:\$|getElementById)\('([^']+)'\)/g)) assert.ok(ids.includes(m[1]), `${name} looks for #${m[1]}`);
  }
  // Links inside the page lead somewhere.
  for (const m of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(m[1]), `a link to #${m[1]}`);
  for (const m of html.matchAll(/aria-(?:labelledby|describedby)="([^"]+)"/g)) assert.ok(ids.includes(m[1]), `a label points at #${m[1]}`);
});

test('the eight lines under "What you can write" all read as bills in the example group', () => {
  const examples = [...html.matchAll(/data-example="([^"]*)"/g)].map(m => unescape(m[1]));
  assert.equal(examples.length, 8);
  for (const text of examples) {
    const { drafts } = parseText(text, EXAMPLE_GROUP, {});
    assert.equal(drafts.length, 1, text);
    assert.deepEqual(drafts[0].errors, [], text);
    assert.ok(drafts[0].ok && drafts[0].bill, text);
    assert.deepEqual(drafts[0].newPeople, [], text);
    assert.equal(computeExpense(EXAMPLE_GROUP, drafts[0].bill).err, null, text);
  }
  // Together, as the page inserts them one under the other, they still read the same way.
  const all = parseText(examples.join('\n') + '\n', EXAMPLE_GROUP, {}).drafts.filter(d => d.kind !== 'comment');
  assert.equal(all.length, 8);
  assert.ok(all.every(d => d.ok && d.bill));
  // The placeholder in the text box is made of lines that work too.
  const placeholder = unescape(/<textarea[^>]*placeholder="([^"]*)"/.exec(html)[1]);
  assert.ok(parseText(placeholder, EXAMPLE_GROUP, {}).drafts.every(d => d.ok && d.bill), placeholder);
});

test('the offline worker saves exactly the files of the page, and leaves other sites alone', () => {
  const sw = read('sw.js');
  const list = /const FILES = \[([^\]]*)\]/.exec(sw);
  assert.ok(list, 'the list of files is there');
  const saved = [...list[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const wanted = ['./', ...names.filter(name => name !== '.nojekyll' && name !== 'index.html' && name !== 'sw.js').map(name => './' + name)];
  assert.deepEqual(saved.slice().sort(), wanted.sort());
  assert.match(sw, /const CACHE = 'paymeback-v\d+';/);
  assert.match(sw, /request\.method !== 'GET' \|\| !request\.url\.startsWith\(ROOT\)\) return;/);
  assert.ok(!/skipWaiting|clients\.claim/.test(sw), 'a new version waits for the next visit');
  // The page asks for the worker only where it can run for real visitors.
  assert.match(read('js/app.js'), /location\.protocol === 'https:' && 'serviceWorker' in navigator/);
  assert.match(read('js/app.js'), /serviceWorker\.register\('\.\/sw\.js'\)/);
});

test('nothing is left behind: no console output, no debugger, no blocking dialogs, no notes to self', () => {
  for (const name of scripts) {
    const text = read(name);
    assert.ok(!/\bconsole\.\w+\(|\bdebugger\b/.test(text), `${name}: console or debugger`);
    assert.ok(!/(?<![.\w])(?:alert|confirm|prompt)\s*\(/.test(text), `${name}: alert, confirm or prompt`);
    assert.ok(!/\b(?:TODO|FIXME|XXX)\b/.test(text), `${name}: a note to self`);
  }
});
