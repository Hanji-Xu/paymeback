/* Tests for docs/js/share.js: the link format, and the gate that checks everything that comes in.
   This file is plain ASCII on purpose. Unusual characters are built with cp(). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { sanitizeGroup, encodeGroup, decodeGroup, sameContent } from '../docs/js/share.js';
import { CURRENCIES, EXAMPLE_GROUP, computeExpense, num, personTotals } from '../docs/js/core.js';

/* ---------- helpers ---------- */

const cp = (...codes) => String.fromCodePoint(...codes);
const clone = v => structuredClone(v);

const NOT_A_GROUP = 'This does not look like a group.';
const NO_GROUP = 'This link does not hold a group.';
const DAMAGED = 'This link is damaged or was cut short. Ask for it to be sent again.';
const TOO_BIG = 'This link holds more than this page can open.';
const NEWER = 'This link was made with a newer version of this page. Reload the page and try again.';
const OLD_BROWSER = 'This browser is too old to open this link. Try a newer one.';
const ANY_CURRENCY = 'This page does not know a currency used here.';
const TOO_MANY_PEOPLE = 'This group has too many people. The limit is 200.';
const TOO_MANY_BILLS = 'This group has too many bills. The limit is 2000.';
const TOO_MANY_ITEMS = 'A bill has too many items. The limit is 100.';
const TOO_LARGE_TO_LINK = 'This group is too large to fit in a link.';

const FIXED_MESSAGES = new Set([NOT_A_GROUP, NO_GROUP, DAMAGED, TOO_BIG, NEWER, OLD_BROWSER, ANY_CURRENCY,
  TOO_MANY_PEOPLE, TOO_MANY_BILLS, TOO_MANY_ITEMS, TOO_LARGE_TO_LINK]);

// Every error this module throws on purpose carries one of its own plain messages.
function assertUserError(e) {
  assert.ok(e instanceof Error, 'an Error is thrown');
  assert.ok(FIXED_MESSAGES.has(e.message) || /^This page does not know the currency [A-Za-z]{3}\.$/.test(e.message),
    'unexpected message: ' + String(e.message).slice(0, 200));
}

const throwsWith = (fn, message) => assert.throws(fn, e => { assertUserError(e); assert.equal(e.message, message); return true; });
const rejectsWith = (promise, message) => assert.rejects(promise, e => { assertUserError(e); assert.equal(e.message, message); return true; });

const person = (id, name) => ({ id, name });
const baseGroup = (over = {}) => ({ id: 'g-test', name: 'Trip', currency: 'USD', rev: 7,
  people: [person('p-a', 'Ana'), person('p-b', 'Ben'), person('p-c', 'Cy')], expenses: [], rates: {}, ...over });
const expense = (over = {}) => ({ id: 'e-1', kind: 'expense', title: 'Dinner', amount: '120.00', currency: 'USD',
  paid: { mode: 'single', who: ['p-a'], values: {} },
  split: { mode: 'equal', who: ['p-a', 'p-b', 'p-c'], values: {}, items: [], tax: '', tip: '' }, ...over });
const payment = (over = {}) => ({ id: 'e-9', kind: 'payment', title: 'Cy paid Ana back', amount: '50', currency: 'USD',
  from: 'p-c', to: 'p-a', ...over });

// Hand-made links, built with node:zlib instead of the module, so the format is checked from the outside.
function fnv(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}
function sealed(bytes) {
  const out = Buffer.alloc(bytes.length + 4);
  bytes.copy(out);
  out.writeUInt32BE(fnv(bytes), bytes.length);
  return out;
}
const linkOfBytes = (bytes, form = 'v1') => form + '.' + (form === 'v1' ? zlib.deflateRawSync(sealed(bytes)) : sealed(bytes)).toString('base64url');
const linkOf = (value, form) => linkOfBytes(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), form);
function packedOf(link) {
  const raw = Buffer.from(link.slice(3), 'base64url');
  const bytes = link.startsWith('v1.') ? zlib.inflateRawSync(raw) : raw;
  return JSON.parse(bytes.subarray(0, bytes.length - 4).toString());
}

// Runs fn while the named globals do not exist, as in a browser that lacks them.
async function without(names, fn) {
  const saved = names.map(n => Object.getOwnPropertyDescriptor(globalThis, n));
  names.forEach(n => { delete globalThis[n]; });
  try { return await fn(); }
  finally { names.forEach((n, i) => Object.defineProperty(globalThis, n, saved[i])); }
}

/* An independent check of the data model in SPEC section 3: whatever leaves the gate must pass. */
const ID = /^[a-z]-[a-z0-9]{1,12}$/;
const DEC = /^(?=.{1,64}$)(?:\d{1,15}(?:\.\d*)?|\.\d+)$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BAD_KEYS = ['__proto__', 'constructor', 'prototype'];

function plain(o, allowed, required = allowed) {
  assert.equal(Object.getPrototypeOf(o), Object.prototype, 'a plain object');
  const keys = Object.keys(o);
  assert.deepEqual(Object.getOwnPropertyNames(o), keys, 'no hidden keys');
  assert.equal(Object.getOwnPropertySymbols(o).length, 0);
  for (const k of keys) assert.ok(allowed.includes(k), 'unexpected key ' + k);
  for (const k of required) assert.ok(keys.includes(k), 'missing key ' + k);
}
function cleanText(s, min, max) {
  assert.equal(typeof s, 'string');
  assert.ok(s.length >= min && s.length <= max, 'length ' + s.length + ' not in ' + min + '..' + max);
  assert.ok(!CONTROL.test(s), 'no control characters');
  assert.equal(s, s.trim());
  assert.ok(s.isWellFormed(), 'no half characters');
}
const decimalOrEmpty = s => assert.ok(s === '' || DEC.test(s), 'not a decimal: ' + String(s).slice(0, 40));
const positiveDecimal = s => assert.ok(typeof s === 'string' && DEC.test(s) && Number(s) > 0, 'not a positive decimal');
const currencyCode = c => assert.ok(typeof c === 'string' && CURRENCIES.includes(c), 'not a currency');

function assertClean(g) {
  plain(g, ['id', 'name', 'currency', 'rev', 'example', 'people', 'expenses', 'rates', 'fx'],
    ['id', 'name', 'currency', 'rev', 'people', 'expenses', 'rates']);
  const seen = new Set();
  const freshId = id => {
    assert.ok(typeof id === 'string' && ID.test(id), 'bad id');
    assert.ok(!seen.has(id), 'id used twice: ' + id);
    seen.add(id);
  };
  freshId(g.id);
  cleanText(g.name, 1, 60);
  currencyCode(g.currency);
  assert.ok(Number.isSafeInteger(g.rev) && g.rev >= 0);
  if ('example' in g) assert.equal(g.example, true);

  assert.ok(Array.isArray(g.people) && g.people.length <= 200);
  for (const p of g.people) { plain(p, ['id', 'name']); freshId(p.id); cleanText(p.name, 1, 40); }
  const people = new Set(g.people.map(p => p.id));
  const who = list => {
    assert.ok(Array.isArray(list));
    assert.equal(new Set(list).size, list.length, 'nobody twice');
    for (const id of list) assert.ok(people.has(id), 'unknown person on a bill');
  };
  const values = v => {
    plain(v, Object.keys(v));
    for (const [id, s] of Object.entries(v)) { assert.ok(people.has(id)); assert.ok(DEC.test(s)); }
  };
  const rate = fx => { plain(fx, ['rate', 'base']); positiveDecimal(fx.rate); currencyCode(fx.base); };

  assert.ok(Array.isArray(g.expenses) && g.expenses.length <= 2000);
  for (const b of g.expenses) {
    freshId(b.id);
    cleanText(b.title, 0, 80);
    decimalOrEmpty(b.amount);
    currencyCode(b.currency);
    if ('fx' in b) rate(b.fx);
    if (b.kind === 'payment') {
      plain(b, ['id', 'kind', 'title', 'amount', 'currency', 'fx', 'from', 'to'], ['id', 'kind', 'title', 'amount', 'currency', 'from', 'to']);
      for (const id of [b.from, b.to]) assert.ok(id === '' || people.has(id));
    } else {
      assert.equal(b.kind, 'expense');
      plain(b, ['id', 'kind', 'title', 'amount', 'currency', 'fx', 'paid', 'split'], ['id', 'kind', 'title', 'amount', 'currency', 'paid', 'split']);
      plain(b.paid, ['mode', 'who', 'values']);
      assert.ok(['single', 'equal', 'exact', 'percent', 'shares'].includes(b.paid.mode));
      who(b.paid.who); values(b.paid.values);
      plain(b.split, ['mode', 'who', 'values', 'items', 'tax', 'tip']);
      assert.ok(['equal', 'exact', 'percent', 'shares', 'items'].includes(b.split.mode));
      who(b.split.who); values(b.split.values);
      decimalOrEmpty(b.split.tax); decimalOrEmpty(b.split.tip);
      assert.ok(Array.isArray(b.split.items) && b.split.items.length <= 100);
      for (const it of b.split.items) { plain(it, ['name', 'amount', 'who']); cleanText(it.name, 0, 80); decimalOrEmpty(it.amount); who(it.who); }
    }
    computeExpense(g, b);   // whatever passed the gate must be safe to work out
  }

  plain(g.rates, Object.keys(g.rates));
  for (const [code, r] of Object.entries(g.rates)) { currencyCode(code); rate(r); assert.notEqual(r.base, code); }
  if ('fx' in g) {
    plain(g.fx, ['date', 'usd']);
    assert.match(g.fx.date, /^\d{4}-\d{2}-\d{2}$/);
    plain(g.fx.usd, Object.keys(g.fx.usd));
    assert.ok(Object.keys(g.fx.usd).length > 0);
    for (const [code, n] of Object.entries(g.fx.usd)) { currencyCode(code); assert.ok(typeof n === 'number' && n > 0 && Number.isFinite(n)); }
  }
}

// Walks a clean result: nothing in it may be keyed __proto__, constructor or prototype, at any depth.
function assertNoBadKeys(v) {
  if (v === null || typeof v !== 'object') return;
  assert.ok([Object.prototype, Array.prototype].includes(Object.getPrototypeOf(v)));
  for (const k of Object.getOwnPropertyNames(v)) {
    assert.ok(!BAD_KEYS.includes(k), 'bad key ' + k);
    assertNoBadKeys(v[k]);
  }
}

/* ---------- random groups ---------- */

function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickOne = (r, arr) => arr[Math.floor(r() * arr.length)];
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const id7 = r => Array.from({ length: 7 }, () => pickOne(r, BASE36)).join('');
function shuffled(r, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const NAMES = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', "O'Neil", 'Jose Maria', '<b>Bob</b>', 'A&B', '"Q"', 'a  b',
  'Zo' + cp(0xEB), cp(0x674E, 0x96F7), cp(0x41C, 0x430, 0x440, 0x438, 0x44F), cp(0x645, 0x62D, 0x645, 0x62F),
  cp(0x1F469, 0x200D, 0x1F467) + ' fam', 'x'.repeat(40)];
const TITLES = ['Dinner', 'Taxi 2', '', 'Caf' + cp(0xE9) + ' & bar', '<script>alert(1)</script>', 'T'.repeat(80),
  'Hotel "Lux", night 1', cp(0x1F355) + ' pizza', 'Museum: 3 tickets', "Dee's birthday"];
const GROUP_NAMES = ['Lisbon trip', 'Flat 4B', 'G'.repeat(60), '<i>Ski</i> & snow', cp(0x65C5, 0x884C) + ' 2026'];
const DECIMALS = ['0', '5', '12', '120', '780', '99.99', '120.00', '0.5', '.5', '12.', '007', '1234567.89', '0.001',
  '33.333333', '100000000000000', '0.30000000000000004', '123456789012345.123456'];
const RATES = ['1', '1.1251', '0.006336', '157.82', '.5', '12.', '0.00003855', '1000000'];
const PINNED = [0.888786, 157.820352, 25939.856369, 1, 3, 1e-7, 123456789.123, 0.1 + 0.2];
const DATES = ['2026-10-04', '2024-02-29', '1999-12-31'];
const PAID_MODES = ['single', 'equal', 'exact', 'percent', 'shares'];
const SPLIT_MODES = ['equal', 'exact', 'percent', 'shares', 'items'];

// A random group already in the form the gate writes, so the gate must hand it back unchanged.
function randomGroup(r, maxPeople = 8, maxBills = 12) {
  const people = Array.from({ length: Math.floor(r() * (maxPeople + 1)) }, () => person('p-' + id7(r), pickOne(r, NAMES)));
  const ids = people.map(p => p.id);
  const currency = pickOne(r, CURRENCIES);
  const some = () => shuffled(r, ids).slice(0, Math.floor(r() * (ids.length + 1)));
  const one = () => (ids.length && r() < 0.9 ? pickOne(r, ids) : '');
  const values = () => Object.fromEntries(ids.filter(() => r() < 0.5).map(id => [id, pickOne(r, DECIMALS)]));
  const amount = () => (r() < 0.9 ? pickOne(r, DECIMALS) : '');
  const withRate = b => { if (r() < 0.25) b.fx = { rate: pickOne(r, RATES), base: pickOne(r, CURRENCIES) }; return b; };
  const item = () => {
    const it = { name: r() < 0.8 ? pickOne(r, TITLES) : '', amount: amount(), who: r() < 0.8 ? some() : [] };
    if (!it.name && !it.amount && !it.who.length) it.name = 'Item';
    return it;
  };
  const bill = () => {
    const head = { id: 'e-' + id7(r), kind: 'expense', title: pickOne(r, TITLES), amount: amount(),
      currency: r() < 0.5 ? currency : pickOne(r, CURRENCIES) };
    if (r() < 0.25) return withRate({ ...head, kind: 'payment', from: one(), to: one() });
    return withRate({ ...head,
      paid: { mode: pickOne(r, PAID_MODES), who: some(), values: values() },
      split: { mode: pickOne(r, SPLIT_MODES), who: some(), values: values(),
        items: Array.from({ length: Math.floor(r() * 5) }, item),
        tax: r() < 0.3 ? pickOne(r, DECIMALS) : '', tip: r() < 0.3 ? pickOne(r, DECIMALS) : '' } });
  };
  const g = { id: 'g-' + id7(r), name: pickOne(r, GROUP_NAMES), currency, rev: Math.floor(r() * 2e12),
    people, expenses: Array.from({ length: Math.floor(r() * (maxBills + 1)) }, bill), rates: {} };
  if (r() < 0.1) g.example = true;
  for (const code of CURRENCIES) {
    const base = pickOne(r, CURRENCIES);
    if (r() < 0.1 && base !== code) g.rates[code] = { rate: pickOne(r, RATES), base };
  }
  if (r() < 0.3) {
    const usd = {};
    for (const code of CURRENCIES) if (r() < 0.3) usd[code] = code === 'USD' ? 1 : pickOne(r, PINNED);
    if (Object.keys(usd).length) g.fx = { date: pickOne(r, DATES), usd };
  }
  return g;
}

/* ---------- round trips ---------- */

test('the example group passes the gate unchanged and survives a link', async t => {
  assert.deepStrictEqual(sanitizeGroup(EXAMPLE_GROUP), EXAMPLE_GROUP);
  assertClean(sanitizeGroup(EXAMPLE_GROUP));
  const link = await encodeGroup(EXAMPLE_GROUP);
  assert.match(link, /^v1\.[A-Za-z0-9_-]+$/);
  assert.deepStrictEqual(await decodeGroup(link), EXAMPLE_GROUP);
  assert.equal(await encodeGroup(EXAMPLE_GROUP), link, 'the same group gives the same link');
  t.diagnostic('example link: ' + link.length + ' characters');
  assert.ok(link.length < 600, 'example link is ' + link.length + ' characters');
});

test('a link may arrive with its # and with spaces around it', async () => {
  const link = await encodeGroup(EXAMPLE_GROUP);
  assert.deepStrictEqual(await decodeGroup('#' + link), EXAMPLE_GROUP);
  assert.deepStrictEqual(await decodeGroup('  ' + link + ' ' + cp(10)), EXAMPLE_GROUP);
});

test('200 random groups: the gate keeps them as they are and the link gives them back exactly', async () => {
  const r = mulberry32(20261004);
  let longest = 0;
  for (let i = 0; i < 200; i++) {
    const g = randomGroup(r);
    const before = JSON.stringify(g);
    const clean = sanitizeGroup(g);
    assert.deepStrictEqual(clean, g);
    assertClean(clean);
    const link = await encodeGroup(g);
    assert.match(link, /^v1\.[A-Za-z0-9_-]+$/);
    longest = Math.max(longest, link.length);
    const back = await decodeGroup(link);
    assert.deepStrictEqual(back, g);
    assert.ok(sameContent(back, g));
    assert.equal(JSON.stringify(g), before, 'the group handed in is not changed');
  }
  assert.ok(longest > 500, 'the random groups are not all trivial');
});

test('an empty group and a large group survive a link, with and without compression', async () => {
  const empty = { id: 'g-empty01', name: 'New group', currency: 'JPY', rev: 0, people: [], expenses: [], rates: {} };
  const large = randomGroup(mulberry32(7), 150, 400);
  large.people = Array.from({ length: 150 }, (_, i) => person('p-' + String(i).padStart(7, '0'), 'Person ' + i));
  large.expenses = Array.from({ length: 400 }, (_, i) => expense({ id: 'e-' + String(i).padStart(7, '0'), title: 'Bill ' + i,
    paid: { mode: 'single', who: [large.people[i % 150].id], values: {} },
    split: { mode: 'equal', who: large.people.map(p => p.id), values: {}, items: [], tax: '', tip: '' }, currency: large.currency }));
  for (const g of [empty, large]) {
    const v = await encodeGroup(g);
    const u = await without(['CompressionStream'], () => encodeGroup(g));
    assert.ok(v.startsWith('v1.') && u.startsWith('u1.'));
    assert.deepStrictEqual(await decodeGroup(v), g);
    assert.deepStrictEqual(await decodeGroup(u), g);
  }
  assert.ok((await without(['CompressionStream'], () => encodeGroup(large))).length > 0x8000 * 2, 'large enough to need several chunks');
});

test('without CompressionStream the link starts with u1 and still opens everywhere', async () => {
  const r = mulberry32(99);
  for (let i = 0; i < 25; i++) {
    const g = i ? randomGroup(r) : clone(EXAMPLE_GROUP);
    const link = await without(['CompressionStream'], () => encodeGroup(g));
    assert.match(link, /^u1\.[A-Za-z0-9_-]+$/);
    assert.deepStrictEqual(await decodeGroup(link), g);
    // a u1 link needs nothing from the browser to open
    assert.deepStrictEqual(await without(['CompressionStream', 'DecompressionStream'], () => decodeGroup(link)), g);
  }
  assert.equal(typeof CompressionStream, 'function', 'the global is back');
  assert.equal(typeof DecompressionStream, 'function', 'the global is back');
});

test('a v1 link in a browser without DecompressionStream says so plainly', async () => {
  const link = await encodeGroup(EXAMPLE_GROUP);
  await without(['DecompressionStream'], () => rejectsWith(decodeGroup(link), OLD_BROWSER));
  assert.deepStrictEqual(await decodeGroup(link), EXAMPLE_GROUP);
});

/* ---------- the format is pinned ---------- */

const GOLDEN_V1 = 'v1.VVFBahwxEPxJEH1KoBZG0sjZ6zo2vuTktXMROmhn2lkRrWbQyCZ-Ut7jc_4SpFkCA6LpUqtK1d2Wfu5iWE5TItD3loiSwyw-829_mSN_IdDz8Y7QwVqadz55Ah2SJ4eKT1yZt5yueHgn0Lf3KxqZCXTHfMUcA4HuYyDnqh7vZFWbfS4XTkWEJA7xxV884eu-g1WwHaSr0agOEuqmq0zZ7qGg0TsHun9-bD_wThHoIU8D58ALQcmuPrWqsvr_LLdmsiEJDbVV0dV1SImz8EWUM4viT5xb79QEdRU0sK4dS7d-8PHsXwl6DytrlR5yiJFHsfg8htTsqKsVOp595lHMXMIyTAtBN6N9K_4I6TyJN84jE8w6BGhXPRJkt7HaE-j4ml9E5GWZ0kLo92vPTUtve1amAgNVg4Yyzq0yhkBP2YckyiSOIZXcdtAEJFSbuemgYDYL2I7tpu1ezD6M4pC8OPnhF620xmpHuo9Pf__8Aw';
const GOLDEN_U1 = 'u1.WyJnLWxpc2JvbiIsIkxpc2JvbiB0cmlwIChleGFtcGxlKSIsIlVTRCIsMCxbWyJwLWFuYSIsIkFuYSJdLFsicC1iZW4iLCJCZW4iXSxbInAtY3kiLCJDeSJdLFsicC1kZWUiLCJEZWUiXSxbInAtZWxpIiwiRWxpIl1dLFtbImUtMSIsIkFwYXJ0bWVudCBpbiBBbGZhbWEiLDc4MCxbMixbMCwxXSxbMCw1MjAsMSwyNjBdXSxbMSxbMCwxLDIsMyw0XV0sIkVVUiJdLFsiZS0yIiwiR3JvY2VyaWVzIiwyMTAsWzAsWzJdXSxbNCxbMCwxLDIsM10sWzAsMSwxLDEsMiwxLDMsMl1dLCJFVVIiXSxbImUtMyIsIkRpbm5lciBhdCB0aGUgdGFiZXJuYSIsIiIsWzAsWzNdXSxbNSxbXSxbXSxbWyJCYWNhbGhhdSIsMzgsWzFdXSxbIkdyaWxsZWQgc2FyZGluZXMiLDIyLFsyXV0sWyJTaGFyZWQgcGV0aXNjb3MiLDMwLFswLDRdXSxbIlZpbmhvIHZlcmRlIiw1MixbMCwxLDNdXV0sIiIsMTBdLCJFVVIiXSxbImUtNCIsIlN1cmYgbGVzc29ucyIsNDgwLFswLFs0XV0sWzMsWzAsMSwyLDNdLFswLDI1LDEsMjUsMiwyNSwzLDI1XV1dLFsiZS01IiwiVHJhaW4gdG8gU2ludHJhIiw3OCxbMyxbMSwyXSxbMSw1MCwyLDUwXV0sWzEsWzAsMSwyXV0sIkVVUiJdLFsiZS02IiwiQ3kgcGFpZCBBbmEgYmFjayIsNTAsMiwwXV0sW10sW10sMV3THt2p';

const EXAMPLE_PACKED = ['g-lisbon', 'Lisbon trip (example)', 'USD', 0,
  [['p-ana', 'Ana'], ['p-ben', 'Ben'], ['p-cy', 'Cy'], ['p-dee', 'Dee'], ['p-eli', 'Eli']],
  [['e-1', 'Apartment in Alfama', 780, [2, [0, 1], [0, 520, 1, 260]], [1, [0, 1, 2, 3, 4]], 'EUR'],
    ['e-2', 'Groceries', 210, [0, [2]], [4, [0, 1, 2, 3], [0, 1, 1, 1, 2, 1, 3, 2]], 'EUR'],
    ['e-3', 'Dinner at the taberna', '', [0, [3]],
      [5, [], [], [['Bacalhau', 38, [1]], ['Grilled sardines', 22, [2]], ['Shared petiscos', 30, [0, 4]], ['Vinho verde', 52, [0, 1, 3]]], '', 10], 'EUR'],
    ['e-4', 'Surf lessons', 480, [0, [4]], [3, [0, 1, 2, 3], [0, 25, 1, 25, 2, 25, 3, 25]]],
    ['e-5', 'Train to Sintra', 78, [3, [1, 2], [1, 50, 2, 50]], [1, [0, 1, 2]], 'EUR'],
    ['e-6', 'Cy paid Ana back', 50, 2, 0]],
  [], [], 1];

test('version 1 links made today keep opening: the packed layout is pinned', async () => {
  assert.deepStrictEqual(await decodeGroup(GOLDEN_V1), EXAMPLE_GROUP);
  assert.deepStrictEqual(await decodeGroup(GOLDEN_U1), EXAMPLE_GROUP);
  assert.equal(await without(['CompressionStream'], () => encodeGroup(EXAMPLE_GROUP)), GOLDEN_U1);
  assert.deepStrictEqual(packedOf(await encodeGroup(EXAMPLE_GROUP)), EXAMPLE_PACKED);
  // and a link written by hand from the documented layout opens too
  assert.deepStrictEqual(await decodeGroup(linkOf(EXAMPLE_PACKED)), EXAMPLE_GROUP);
  assert.deepStrictEqual(await decodeGroup(linkOf(EXAMPLE_PACKED, 'u1')), EXAMPLE_GROUP);
});

test('packing: defaults are left out, typed numbers keep their exact text, everything else is kept', async () => {
  const g = baseGroup({ currency: 'EUR', rev: 1791140000000,
    expenses: [
      expense({ amount: '120.00', currency: 'EUR', fx: { rate: '1.50', base: 'EUR' } }),
      expense({ id: 'e-2', amount: '0', currency: 'JPY', fx: { rate: '0.0063', base: 'USD' },
        split: { mode: 'items', who: [], values: { 'p-b': '0', 'p-c': '007' }, items: [{ name: '', amount: '', who: ['p-c'] }, { name: 'Tea', amount: '', who: [] }], tax: '0', tip: '' } }),
      payment({ from: '', to: 'p-b', currency: 'EUR' })],
    rates: { USD: { rate: '0.9', base: 'EUR' }, JPY: { rate: '0.0070', base: 'GBP' } },
    fx: { date: '2026-10-04', usd: { USD: 1, EUR: 0.888786, JPY: 157.820352 } } });
  const link = await encodeGroup(g);
  assert.deepStrictEqual(await decodeGroup(link), g);
  assert.deepStrictEqual(packedOf(link), ['g-test', 'Trip', 'EUR', 1791140000000,
    [['p-a', 'Ana'], ['p-b', 'Ben'], ['p-c', 'Cy']],
    [['e-1', 'Dinner', '120.00', [0, [0]], [1, [0, 1, 2]], '', '1.50'],
      ['e-2', 'Dinner', 0, [0, [0]], [5, [], [1, 0, 2, '007'], [['', '', [2]], ['Tea']], 0], 'JPY', 0.0063, 'USD'],
      ['e-9', 'Cy paid Ana back', 50, -1, 1]],
    [['USD', 0.9], ['JPY', '0.0070', 'GBP']],
    ['2026-10-04', ['USD', 1, 'EUR', 0.888786, 'JPY', 157.820352]]]);
});

/* ---------- sameContent ---------- */

test('sameContent ignores rev and example, and nothing else', () => {
  const a = clone(EXAMPLE_GROUP);
  assert.ok(sameContent(a, EXAMPLE_GROUP));
  const b = clone(EXAMPLE_GROUP);
  b.rev = 1791140000000;
  delete b.example;
  assert.ok(sameContent(a, b));
  assert.ok(sameContent(b, a));

  const changes = {
    'group id': g => { g.id = 'g-other'; },
    'group name': g => { g.name = 'Porto trip'; },
    'settle-up currency': g => { g.currency = 'EUR'; },
    'a name': g => { g.people[0].name = 'Anna'; },
    'a person id': g => { g.people[4].id = 'p-eli2'; },
    'order of people': g => { g.people.reverse(); },
    'a new person': g => { g.people.push(person('p-fay', 'Fay')); },
    'an amount': g => { g.expenses[0].amount = '781'; },
    'the same amount written differently': g => { g.expenses[0].amount = '780.00'; },
    'a title': g => { g.expenses[1].title = 'Food'; },
    'a bill currency': g => { g.expenses[1].currency = 'GBP'; },
    'a bill id': g => { g.expenses[1].id = 'e-22'; },
    'who paid': g => { g.expenses[1].paid.who = ['p-ana']; },
    'how it was paid': g => { g.expenses[4].paid.mode = 'equal'; },
    'order of who shares (it decides who gets the odd cent)': g => { g.expenses[0].split.who.reverse(); },
    'a share': g => { g.expenses[1].split.values['p-dee'] = '3'; },
    'an item': g => { g.expenses[2].split.items[0].amount = '39'; },
    'who had an item': g => { g.expenses[2].split.items[0].who = ['p-cy']; },
    'the tip': g => { g.expenses[2].split.tip = '12'; },
    'the tax': g => { g.expenses[2].split.tax = '5'; },
    'a rate fixed on a bill': g => { g.expenses[0].fx = { rate: '1.2', base: 'USD' }; },
    'a payment direction': g => { const p = g.expenses[5]; [p.from, p.to] = [p.to, p.from]; },
    'a bill removed': g => { g.expenses.pop(); },
    'order of bills': g => { g.expenses.reverse(); },
    'a typed rate': g => { g.rates.EUR = { rate: '1.2', base: 'USD' }; },
    'pinned rates': g => { g.fx = { date: '2026-10-04', usd: { EUR: 0.9 } }; }
  };
  for (const [what, change] of Object.entries(changes)) {
    const c = clone(EXAMPLE_GROUP);
    change(c);
    assert.equal(sameContent(a, c), false, what);
    assert.equal(sameContent(c, a), false, what);
  }

  const pinned = clone(EXAMPLE_GROUP), pinned2 = clone(EXAMPLE_GROUP);
  pinned.fx = { date: '2026-10-04', usd: { EUR: 0.9 } };
  pinned2.fx = { date: '2026-10-05', usd: { EUR: 0.9 } };
  assert.equal(sameContent(pinned, pinned2), false, 'the date of the pinned rates');
  pinned2.fx = { date: '2026-10-04', usd: { EUR: 0.91 } };
  assert.equal(sameContent(pinned, pinned2), false, 'a pinned rate');
});

test('sameContent sees through clutter the gate would remove, and never throws', () => {
  const tidy = baseGroup({ expenses: [expense({ amount: '45', split: { mode: 'exact', who: ['p-a', 'p-b'], values: { 'p-a': '20', 'p-b': '25' }, items: [], tax: '', tip: '' } })] });
  const messy = baseGroup({ note: 'x', rev: 99, example: true,
    expenses: [{ title: 'Dinner', kind: 'expense', id: 'e-1', currency: 'USD', amount: ' $45 ', draft: true,
      split: { tip: '', tax: '', items: [{ name: '', amount: '', who: [] }], values: { 'p-b': '25', 'p-c': '', 'p-a': '20', 'p-gone': '9' }, who: ['p-a', 'p-b', 'p-gone', 'p-a'], mode: 'exact' },
      paid: { values: {}, who: ['p-a'], mode: 'single' } }] });
  const before = JSON.stringify(messy);
  assert.ok(sameContent(tidy, messy));
  assert.equal(JSON.stringify(messy), before, 'nothing handed in is changed');

  for (const junk of [null, undefined, 5, 'x', [], {}, { people: [] }]) {
    assert.equal(sameContent(junk, tidy), false);
    assert.equal(sameContent(tidy, junk), false);
    assert.equal(sameContent(junk, junk), false, 'what is not a group is never the same as anything');
  }
});

/* ---------- the gate: what it refuses ---------- */

test('refused: things that are not a group at all', () => {
  for (const v of [null, undefined, 0, 5, NaN, 'group', '', true, [], [baseGroup()], () => baseGroup(), Symbol('g'), 10n]) throwsWith(() => sanitizeGroup(v), NOT_A_GROUP);
  for (const people of [undefined, null, 'Ana, Ben', 3, {}, { 0: person('p-a', 'Ana'), length: 1 }]) throwsWith(() => sanitizeGroup(baseGroup({ people })), NOT_A_GROUP);
  throwsWith(() => sanitizeGroup({}), NOT_A_GROUP);
  throwsWith(() => sanitizeGroup({ currency: 'USD' }), NOT_A_GROUP);
  for (const expenses of ['none', 3, {}, { length: 0 }, true]) throwsWith(() => sanitizeGroup(baseGroup({ expenses })), NOT_A_GROUP);
  // a group that has no list of bills yet is still a group
  for (const expenses of [undefined, null]) assert.deepStrictEqual(sanitizeGroup(baseGroup({ expenses })).expenses, []);
  const noBills = baseGroup();
  delete noBills.expenses;
  assert.deepStrictEqual(sanitizeGroup(noBills), baseGroup());
});

test('refused: a currency the page does not know', () => {
  throwsWith(() => sanitizeGroup(baseGroup({ currency: 'XYZ' })), 'This page does not know the currency XYZ.');
  throwsWith(() => sanitizeGroup(baseGroup({ currency: 'usd' })), 'This page does not know the currency usd.');
  for (const currency of [undefined, null, '', 5, NaN, ['USD'], { code: 'USD' }, 'US', 'USDT', ' USD', '<b>', 'U$D', 'A'.repeat(10 * 1024 * 1024), 'constructor', '__proto__', 'toString']) {
    throwsWith(() => sanitizeGroup(baseGroup({ currency })), ANY_CURRENCY);
  }
  throwsWith(() => sanitizeGroup(baseGroup({ expenses: [expense({ currency: 'XYZ' })] })), 'This page does not know the currency XYZ.');
  for (const currency of [5, ['EUR'], {}, 'EURO', '<i>', true]) throwsWith(() => sanitizeGroup(baseGroup({ expenses: [expense({ currency })] })), ANY_CURRENCY);
  throwsWith(() => sanitizeGroup(baseGroup({ expenses: [payment({ currency: 'BTC' })] })), 'This page does not know the currency BTC.');
  // no currency on a bill means the group's currency
  for (const currency of [undefined, null, '', 0]) {
    assert.equal(sanitizeGroup(baseGroup({ currency: 'CHF', expenses: [expense({ currency })] })).expenses[0].currency, 'CHF');
  }
  for (const code of CURRENCIES) assert.equal(sanitizeGroup(baseGroup({ currency: code })).currency, code);
});

test('refused: more than 200 people, 2000 bills or 100 items, and quickly', () => {
  const people = n => Array.from({ length: n }, (_, i) => person('p-' + i, 'P' + i));
  const bills = n => Array.from({ length: n }, (_, i) => payment({ id: 'e-' + i }));
  const items = n => Array.from({ length: n }, (_, i) => ({ name: 'Item ' + i, amount: '1', who: ['p-a'] }));
  const withItems = n => baseGroup({ expenses: [expense({ split: { mode: 'items', who: [], values: {}, items: items(n), tax: '', tip: '' } })] });

  assert.equal(sanitizeGroup(baseGroup({ people: people(200) })).people.length, 200);
  throwsWith(() => sanitizeGroup(baseGroup({ people: people(201) })), TOO_MANY_PEOPLE);
  assert.equal(sanitizeGroup(baseGroup({ expenses: bills(2000) })).expenses.length, 2000);
  throwsWith(() => sanitizeGroup(baseGroup({ expenses: bills(2001) })), TOO_MANY_BILLS);
  assert.equal(sanitizeGroup(withItems(100)).expenses[0].split.items.length, 100);
  throwsWith(() => sanitizeGroup(withItems(101)), TOO_MANY_ITEMS);

  const start = performance.now();
  throwsWith(() => sanitizeGroup(baseGroup({ people: people(100000) })), TOO_MANY_PEOPLE);
  throwsWith(() => sanitizeGroup(baseGroup({ expenses: bills(100000) })), TOO_MANY_BILLS);
  throwsWith(() => sanitizeGroup(withItems(100000)), TOO_MANY_ITEMS);
  assert.ok(performance.now() - start < 2000);

  // entries that carry nothing do not count towards a limit
  const padded = sanitizeGroup(baseGroup({ people: [...Array(500).fill(null), ...people(200), ...Array(500).fill(7)] }));
  assert.equal(padded.people.length, 200);
  const emptyRows = Array.from({ length: 500 }, () => ({ name: '', amount: '', who: [] }));
  const g = baseGroup({ expenses: [expense({ split: { mode: 'items', who: [], values: {}, items: [...emptyRows, ...items(100)], tax: '', tip: '' } })] });
  assert.equal(sanitizeGroup(g).expenses[0].split.items.length, 100);
});

test('every refusal is a short plain message', () => {
  for (const m of FIXED_MESSAGES) {
    assert.ok(m.length <= 90, m);
    assert.match(m, /^[A-Z].*\.$/);
    assert.doesNotMatch(m, /!|\b(edge|node|provenance|fragment|parse|payload|JSON|invalid|error)\b/i);
  }
});

/* ---------- the gate: what it cleans ---------- */

test('cleaned: keys the model does not have are dropped at every level', () => {
  const g = sanitizeGroup({ ...baseGroup(), extra: 1, version: 9, savedAt: 1, me: 'p-a',
    people: [{ id: 'p-a', name: 'Ana', email: 'ana@example.com', admin: true }, { id: 'p-b', name: 'Ben', id2: 'x' }],
    expenses: [
      { ...expense({ split: { mode: 'items', who: ['p-a'], values: { 'p-a': '1', note: '5' }, extra: [1], tax: '8', tip: '10',
          items: [{ name: 'Soup', amount: '4', who: ['p-b'], qty: 2, sku: '<x>' }] },
        paid: { mode: 'exact', who: ['p-a'], values: { 'p-a': '4.72' }, memo: 'cash' } }),
        fx: { rate: '1.1', base: 'EUR', source: 'bank', date: '2026-01-01' }, from: 'p-a', to: 'p-b', note: 'n', receipt: { url: 'javascript:alert(1)' } },
      { ...payment(), paid: { mode: 'single', who: ['p-a'], values: {} }, split: { mode: 'equal', who: ['p-a'] }, items: [1], memo: 'm' }],
    rates: { EUR: { rate: '1.2', base: 'USD', by: 'me' }, note: 'hello', XYZ: { rate: '2', base: 'USD' } },
    fx: { date: '2026-10-04', source: 'evil.example', usd: { EUR: 0.9, XYZ: 3, note: 1 } } });
  assert.deepStrictEqual(g, { id: 'g-test', name: 'Trip', currency: 'USD', rev: 7,
    people: [person('p-a', 'Ana'), person('p-b', 'Ben')],
    expenses: [
      { id: 'e-1', kind: 'expense', title: 'Dinner', amount: '120.00', currency: 'USD', fx: { rate: '1.1', base: 'EUR' },
        paid: { mode: 'exact', who: ['p-a'], values: { 'p-a': '4.72' } },
        split: { mode: 'items', who: ['p-a'], values: { 'p-a': '1' }, items: [{ name: 'Soup', amount: '4', who: ['p-b'] }], tax: '8', tip: '10' } },
      { id: 'e-9', kind: 'payment', title: 'Cy paid Ana back', amount: '50', currency: 'USD', from: '', to: 'p-a' }],
    rates: { EUR: { rate: '1.2', base: 'USD' } },
    fx: { date: '2026-10-04', usd: { EUR: 0.9 } } });
  assertClean(g);
});

test('cleaned: text is cut to its limit, kept on one line, and never left with half a character', () => {
  const smile = cp(0x1F600);
  const g = sanitizeGroup(baseGroup({ name: 'n'.repeat(100),
    people: [person('p-a', 'y'.repeat(100)), person('p-b', '  Ben  '), person('p-c', 'a'.repeat(39) + smile + 'tail'),
      person('p-d', 'a'.repeat(38) + smile + 'tail'), person('p-e', 'A' + String.fromCharCode(0xD800) + 'B' + String.fromCharCode(0xDC00) + 'C'),
      person('p-f', 'Ana' + cp(10) + 'Ben' + cp(9) + 'Cy' + cp(13)), person('p-g', cp(0) + 'Nul' + cp(0x7F) + cp(0x85) + 'l' + cp(0)),
      person('p-h', 'Ana' + cp(0x202E) + 'neB'), person('p-i', 'Li' + cp(0x2028) + 'ne' + cp(0x2029)), person('p-j', cp(0x2066) + 'iso' + cp(0x2069)),
      person('p-k', ' '.repeat(39) + 'x'.repeat(50))],
    expenses: [expense({ title: 't'.repeat(200), split: { mode: 'items', who: [], values: {}, tax: '', tip: '', items: [{ name: 'i'.repeat(200), amount: '1', who: ['p-a'] }] } })] }));
  assert.equal(g.name, 'n'.repeat(60));
  assert.deepStrictEqual(g.people.map(p => p.name), ['y'.repeat(40), 'Ben', 'a'.repeat(39), 'a'.repeat(38) + smile, 'ABC',
    'Ana Ben Cy', 'Nul  l', 'Ana neB', 'Li ne', 'iso', 'x'.repeat(40)]);
  assert.equal(g.expenses[0].title, 't'.repeat(80));
  assert.equal(g.expenses[0].split.items[0].name, 'i'.repeat(80));
  assertClean(g);
});

test('cleaned: text that is missing or not a string gets a plain stand-in', () => {
  for (const junk of [undefined, null, '', '   ', cp(9, 10, 13), 42, 0, NaN, true, ['Ana'], { name: 'Ana' }, () => 'Ana']) {
    const g = sanitizeGroup(baseGroup({ name: junk, people: [person('p-a', 'Ana'), person('p-b', junk), person('p-c', junk)],
      expenses: [expense({ title: junk }), payment({ title: junk })] }));
    assert.equal(g.name, 'Group');
    assert.deepStrictEqual(g.people.map(p => p.name), ['Ana', 'Person 2', 'Person 3']);
    assert.deepStrictEqual(g.expenses.map(b => b.title), ['', '']);
    assert.ok(computeExpense(g, g.expenses[0]).errTitle, 'the page will ask for a name');
    assertClean(g);
  }
});

test('cleaned: names with HTML in them are kept exactly as typed', async () => {
  const names = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg/onload=alert(1)>', "Tom & Jerry's \"bar\"",
    '&lt;b&gt;', '</title><h1>x', 'javascript:alert(1)', '{{7*7}}', '${alert(1)}', '<!-- -->', "' OR 1=1 --"];
  const g = baseGroup({ name: '<b onmouseover=alert(1)>Trip</b>', people: names.map((n, i) => person('p-' + i, n)),
    expenses: [expense({ title: '<iframe src="javascript:alert(1)"></iframe>', paid: { mode: 'single', who: ['p-0'], values: {} },
      split: { mode: 'items', who: [], values: {}, tax: '', tip: '', items: [{ name: '<a href="//evil.example">x</a>', amount: '1', who: ['p-1'] }] } })] });
  const clean = sanitizeGroup(g);
  assert.deepStrictEqual(clean, g);
  assert.deepStrictEqual(clean.people.map(p => p.name), names);
  assert.deepStrictEqual(await decodeGroup(await encodeGroup(g)), g);
});

test('cleaned: typed numbers come out as plain decimals or empty', () => {
  const cases = [
    ['120', '120'], ['120.00', '120.00'], ['.5', '.5'], ['12.', '12.'], ['007', '007'], ['0', '0'], ['0.30000000000000004', '0.30000000000000004'],
    [' 45 ', '45'], ['$45', '45'], ['45 EUR', '45'], ['1,200.50', '1200.50'], ['1 200.50', '1200.50'], ['12,50', '1250'], ['+7', '7'],
    // odd text is read exactly as core.js num() reads it: the number at the front, once everything but digits, dots and minus is gone
    ['1e5', '15'], ['0x10', '010'], ['5-', '5'], ['1-7', '1'], ['1.2.3', '1.2'], ['12.5.', '12.5'], ['.5.5', '.5'], ['<script>alert(1)</script>', '1'],
    ['1'.repeat(15), '1'.repeat(15)], ['0.' + '1'.repeat(30), '0.' + '1'.repeat(30)], ['9'.repeat(15) + '.' + '9'.repeat(48), '9'.repeat(15) + '.' + '9'.repeat(48)],
    [120, '120'], [12.5, '12.5'], [0, '0'], [-0, '0'], [0.1 + 0.2, '0.30000000000000004'],
    ['-5', ''], [-5, ''], ['-0', ''], ['--5', ''], ['+-5', ''], ['-.5', ''], [NaN, ''], [Infinity, ''], [-Infinity, ''], ['NaN', ''], ['Infinity', ''], ['-Infinity', ''],
    [1e21, ''], [1e-7, ''], [Number.MAX_VALUE, ''], [-Number.MIN_VALUE, ''], ['', ''], [' ', ''], ['.', ''], ['..', ''], ['..5', ''], ['abc', ''],
    [null, ''], [undefined, ''], [true, ''], [false, ''], [[120], ''], [{ valueOf: () => 5 }, ''], [{ toString: () => '5' }, ''], [5n, ''], [Symbol('5'), ''],
    ['1'.repeat(16), ''], ['9'.repeat(15) + '.' + '9'.repeat(49), ''], ['9'.repeat(65), ''], ['9'.repeat(10 * 1024 * 1024), '']];
  for (const [raw, want] of cases) {
    const label = typeof raw === 'string' ? JSON.stringify(raw.slice(0, 30)) : String(typeof raw === 'object' ? typeof raw : String(raw));
    const g = sanitizeGroup(baseGroup({
      expenses: [expense({ amount: raw, fx: { rate: raw, base: 'EUR' },
        paid: { mode: 'exact', who: ['p-a'], values: { 'p-a': raw } },
        split: { mode: 'items', who: [], values: { 'p-b': raw }, items: [{ name: 'x', amount: raw, who: ['p-a'] }], tax: raw, tip: raw } }),
      payment({ amount: raw })],
      rates: { EUR: { rate: raw, base: 'USD' } } }));
    const [e, p] = g.expenses;
    assert.equal(e.amount, want, 'amount ' + label);
    assert.equal(p.amount, want, 'payment amount ' + label);
    assert.equal(e.split.items[0].amount, want, 'item ' + label);
    assert.equal(e.split.tax, want, 'tax ' + label);
    assert.equal(e.split.tip, want, 'tip ' + label);
    assert.deepStrictEqual(e.paid.values, want ? { 'p-a': want } : {}, 'paid value ' + label);
    assert.deepStrictEqual(e.split.values, want ? { 'p-b': want } : {}, 'split value ' + label);
    // a rate must also be more than zero
    assert.deepStrictEqual(e.fx, Number(want) > 0 ? { rate: want, base: 'EUR' } : undefined, 'bill rate ' + label);
    assert.deepStrictEqual(g.rates, Number(want) > 0 ? { EUR: { rate: want, base: 'USD' } } : {}, 'typed rate ' + label);
    // what is kept means the same number to core.js as what was typed
    if (typeof raw === 'string' && want) assert.equal(num(want), num(raw), 'value ' + label);
    assertClean(g);
  }
});

test('cleaned: a loosely typed amount still works out to the same money', () => {
  const raw = baseGroup({ currency: 'EUR', expenses: [expense({ amount: ' $1,200.50 ', currency: 'USD',
    paid: { mode: 'exact', who: ['p-a', 'p-b'], values: { 'p-a': '1,000', 'p-b': '200.50 USD' } },
    split: { mode: 'percent', who: ['p-a', 'p-b', 'p-c'], values: { 'p-a': '50%', 'p-b': '25 %', 'p-c': '25' }, items: [], tax: '', tip: '' } })] });
  const clean = sanitizeGroup(raw);
  assert.equal(clean.expenses[0].amount, '1200.50');
  assert.deepStrictEqual(clean.expenses[0].paid.values, { 'p-a': '1000', 'p-b': '200.50' });
  assert.deepStrictEqual(clean.expenses[0].split.values, { 'p-a': '50', 'p-b': '25', 'p-c': '25' });
  const a = computeExpense(raw, raw.expenses[0]), b = computeExpense(clean, clean.expenses[0]);
  assert.equal(a.err, null);
  assert.deepStrictEqual(b, a);
});

test('typed numbers: whatever the gate keeps or empties, every bill works out exactly as it did before', () => {
  const r = mulberry32(60606);
  // 1. single strings against core.js num()
  const alphabet = '00112233456789....--,, $e%x+';
  for (let i = 0; i < 5000; i++) {
    const raw = Array.from({ length: Math.floor(r() * 12) }, () => pickOne(r, alphabet)).join('');
    const clean = sanitizeGroup(baseGroup({ expenses: [expense({ amount: raw })] })).expenses[0].amount;
    if (clean) { assert.match(clean, DEC); assert.equal(num(clean), num(raw), JSON.stringify(raw)); }
    else assert.ok(num(raw) <= 0, JSON.stringify(raw) + ' was emptied but core.js reads ' + num(raw));
  }
  // 2. whole groups with loosely typed numbers everywhere
  const loose = s => pickOne(r, [s, s, s, ' ' + s, s + ' ', '$' + s, s + ' EUR', 'about ' + s, s.replace(/(\d)(\d{3})(?=\.|$)/, '$1,$2'),
    '-' + s, s + '-', s + '.5.5', '+' + s, s + '%', 'x' + s + 'x', 'abc', '']);
  const looseValues = v => Object.fromEntries(Object.entries(v).map(([id, s]) => [id, loose(s)]));
  const money = res => ({ failed: Boolean(res.err), rate: res.rate, total: res.total, paid: [...res.paid], owed: [...res.owed], edges: res.edges,
    totalOrig: res.totalOrig, paidOrig: [...res.paidOrig], owedOrig: [...res.owedOrig] });
  let fine = 0, converted = 0, failed = 0;
  const compare = raw => {
    const clean = sanitizeGroup(raw);
    assertClean(clean);
    assert.deepStrictEqual(clean.expenses.map(b => b.id), raw.expenses.map(b => b.id));
    raw.expenses.forEach((b, k) => {
      const before = computeExpense(raw, b), after = computeExpense(clean, clean.expenses[k]);
      assert.deepStrictEqual(money(after), money(before), 'bill ' + b.id);
      if (before.err) failed++; else fine++;
      if (!before.err && before.rateSource !== 'same') converted++;
    });
    assert.deepStrictEqual(personTotals(clean), personTotals(raw));
  };
  for (let i = 0; i < 300; i++) {
    const raw = randomGroup(r);
    for (const b of raw.expenses) {
      b.amount = loose(b.amount);
      if (b.fx) b.fx.rate = loose(b.fx.rate);
      if (b.kind === 'payment') continue;
      b.paid.values = looseValues(b.paid.values);
      b.split.values = looseValues(b.split.values);
      b.split.tax = loose(b.split.tax);
      b.split.tip = loose(b.split.tip);
      for (const it of b.split.items) it.amount = loose(it.amount);
    }
    for (const code of Object.keys(raw.rates)) raw.rates[code].rate = loose(raw.rates[code].rate);
    compare(raw);
  }
  assert.ok(failed > 1000, failed + ' bills with a problem were compared');

  // 3. bills that do add up, typed loosely in ways that keep their value
  const dressed = s => pickOne(r, [s, ' ' + s, s + ' ', '$' + s, s + ' EUR', 'about ' + s, s.replace(/(\d)(\d{3})(?=\.|$)/, '$1,$2'), s + '-', '+' + s, s + '%', 'x' + s + 'x']);
  fine = 0;
  for (let i = 0; i < 300; i++) {
    const raw = randomGroup(r, 0, 0);
    raw.people = Array.from({ length: 2 + Math.floor(r() * 5) }, () => person('p-' + id7(r), pickOne(r, NAMES)));
    const ids = raw.people.map(p => p.id);
    const some = () => shuffled(r, ids).slice(0, 1 + Math.floor(r() * ids.length));
    const weights = who => Object.fromEntries(who.map(id => [id, dressed(pickOne(r, ['1', '2', '0.5', '3']))]));
    const percents = who => Object.fromEntries(who.map((id, k) => [id, dressed(who.length === 1 ? '100' : k === 0 ? String(100 - 12.5 * (who.length - 1)) : '12.5')]));
    raw.expenses = Array.from({ length: 6 }, () => {
      const payers = some(), sharers = some();
      const b = expense({ id: 'e-' + id7(r), amount: dressed(pickOne(r, ['120', '99.99', '1234.5', '780', '45', '0.03', '1000000', '7'])),
        currency: r() < 0.4 ? raw.currency : pickOne(r, CURRENCIES),
        paid: pickOne(r, [{ mode: 'single', who: payers.slice(0, 1), values: {} }, { mode: 'equal', who: payers, values: {} },
          { mode: 'shares', who: payers, values: weights(payers) }, { mode: 'percent', who: payers, values: percents(payers) }]),
        split: pickOne(r, [{ mode: 'equal', who: sharers, values: {}, items: [], tax: '', tip: '' },
          { mode: 'shares', who: sharers, values: weights(sharers), items: [], tax: '', tip: '' },
          { mode: 'percent', who: sharers, values: percents(sharers), items: [], tax: '', tip: '' },
          { mode: 'items', who: [], values: {}, tax: dressed(pickOne(r, ['0', '8.5'])), tip: dressed(pickOne(r, ['10', '12.5'])),
            items: Array.from({ length: 1 + Math.floor(r() * 4) }, () => ({ name: 'Dish', amount: dressed(pickOne(r, ['38', '22.5', '9.99', '1200'])), who: some() })) }]) });
      if (r() < 0.3) b.fx = { rate: dressed(pickOne(r, RATES)), base: pickOne(r, CURRENCIES) };
      return b;
    });
    if (r() < 0.5) raw.expenses.push(payment({ id: 'e-' + id7(r), amount: dressed('50'), currency: pickOne(r, CURRENCIES), from: ids[0], to: ids[1] }));
    for (const code of CURRENCIES) if (r() < 0.2 && code !== raw.currency) raw.rates[code] = { rate: dressed(pickOne(r, RATES)), base: raw.currency };
    compare(raw);
  }
  assert.ok(fine > 1500 && converted > 500, fine + ' bills that add up were compared, ' + converted + ' of them converted');
});

test('cleaned: negative, NaN and Infinity never reach the math', () => {
  for (const bad of [-5, '-5', NaN, Infinity, -Infinity, '-0.01', 'Infinity', '1e999']) {
    const g = sanitizeGroup(baseGroup({ rev: bad,
      expenses: [expense({ amount: bad }), payment({ amount: bad }),
        expense({ id: 'e-2', split: { mode: 'shares', who: ['p-a', 'p-b'], values: { 'p-a': bad, 'p-b': '1' }, items: [], tax: bad, tip: bad } })],
      fx: { date: '2026-10-04', usd: { EUR: bad, GBP: 0.75 } } }));
    assertClean(g);
    assert.deepStrictEqual(g.fx.usd, { GBP: 0.75 });
    if (bad !== '1e999') {   // core.js reads '1e999' as 1999, and so does the gate
      assert.equal(g.rev, 0);
      assert.equal(computeExpense(g, g.expenses[0]).errSplit, 'Enter the total.');
      assert.equal(computeExpense(g, g.expenses[1]).errSplit, 'Enter an amount.');
      assert.deepStrictEqual(g.expenses[2].split.values, { 'p-b': '1' });
    }
    for (const b of g.expenses) {
      const r = computeExpense(g, b);
      for (const v of [r.total, ...r.paid.values(), ...r.owed.values()]) assert.ok(Number.isSafeInteger(v) && v >= 0);
    }
  }
});

test('cleaned: lists and objects in the wrong place', () => {
  const g = sanitizeGroup({ id: ['g-x'], name: ['Trip'], currency: 'USD', rev: [7], example: [true],
    people: [['p-z', 'Zed'], person('p-a', 'Ana'), 'Ben', 5, null, undefined, [person('p-q', 'Q')], person('p-b', 'Ben')],
    expenses: [
      ['e-0', 'list'], 'bill', 7, null,
      expense({ paid: ['single', ['p-a']], split: ['equal', ['p-a', 'p-b']] }),
      expense({ id: 'e-2', title: ['T'], amount: ['12'], fx: ['1.5', 'EUR'],
        paid: { mode: ['single'], who: ['p-a'], values: {} },
        split: { mode: 'items', who: 'p-a', values: ['1', '2'], items: { 0: { name: 'x', amount: '1', who: ['p-a'] }, length: 1 }, tax: ['8'], tip: { v: 1 } } }),
      expense({ id: 'e-3', paid: { mode: 'shares', who: { 0: 'p-a', length: 1 }, values: [['p-a', '1']] },
        split: { mode: 'items', who: [['p-a'], { id: 'p-a' }, 'p-b'], values: 'p-a=1', tax: '', tip: '',
          items: [['Soup', '4', ['p-a']], 'Soup 4', null, { name: ['Soup'], amount: { v: 4 }, who: 'p-a' }, { name: 'Tea', amount: '2', who: [['p-a'], 'p-b'] }] } }),
      payment({ id: 'e-4', from: ['p-a'], to: { id: 'p-b' } })],
    rates: [['EUR', '1.2', 'USD']],
    fx: ['2026-10-04', { EUR: 0.9 }] });
  assertClean(g);
  assert.match(g.id, /^g-[a-z0-9]{7}$/);
  assert.equal(g.name, 'Group');
  assert.equal(g.rev, 0);
  assert.ok(!('example' in g) && !('fx' in g));
  assert.deepStrictEqual(g.people, [person('p-a', 'Ana'), person('p-b', 'Ben')]);
  assert.deepStrictEqual(g.rates, {});
  assert.equal(g.expenses.length, 4);
  const nobodyPaid = { mode: 'single', who: [], values: {} };
  const nobodyShares = { mode: 'equal', who: [], values: {}, items: [], tax: '', tip: '' };
  assert.deepStrictEqual(g.expenses[0], { id: 'e-1', kind: 'expense', title: 'Dinner', amount: '120.00', currency: 'USD', paid: nobodyPaid, split: nobodyShares });
  assert.deepStrictEqual(g.expenses[1], { id: 'e-2', kind: 'expense', title: '', amount: '', currency: 'USD', paid: nobodyPaid,
    split: { mode: 'items', who: [], values: {}, items: [], tax: '', tip: '' } });
  assert.deepStrictEqual(g.expenses[2].paid, { mode: 'shares', who: [], values: {} });
  assert.deepStrictEqual(g.expenses[2].split, { mode: 'items', who: ['p-b'], values: {}, items: [{ name: 'Tea', amount: '2', who: ['p-b'] }], tax: '', tip: '' });
  assert.deepStrictEqual(g.expenses[3], { id: 'e-4', kind: 'payment', title: 'Cy paid Ana back', amount: '50', currency: 'USD', from: '', to: '' });
  for (const b of g.expenses) assert.ok(computeExpense(g, b).err, 'each of these bills shows up as one to fix');
});

test('cleaned: bad or repeated ids are replaced, and bills follow the people', () => {
  const long = 'p-' + 'x'.repeat(13);
  const g = sanitizeGroup({ id: 'NOT VALID', name: 'T', currency: 'USD',
    people: [person('p-a', 'A'), person('p-a', 'B'), person('Bad Id', 'C'), person('Bad Id', 'D'), person(7, 'E'), { name: 'F' },
      person(long, 'G'), person('P-A', 'H'), person('', 'I'), person('p-ok', 'J'), person('p_b', 'K'), person('pp-b', 'L'), person('p-' + cp(0xE9), 'M')],
    expenses: [
      { id: 'e-1', kind: 'expense', title: 't', amount: '10', currency: 'USD',
        paid: { mode: 'single', who: ['Bad Id'], values: {} },
        split: { mode: 'shares', who: ['p-a', 'Bad Id', long, 7, '7', '', 'P-A'], values: { 'p-a': '1', 'Bad Id': '2', [long]: '3', 7: '4', '': '5' },
          items: [{ name: 'i', amount: '1', who: ['Bad Id', 'p-a', 'p-ok'] }], tax: '', tip: '' } },
      payment({ id: 'e-1', from: 'Bad Id', to: 'p-a' }),
      payment({ id: 'p-a', from: 'p-a', to: long }),
      payment({ id: 'p-ok', from: '', to: 'p-ok' }),
      payment({ id: 12 }), payment({ id: null }), payment({ id: 'E-1' }), payment({ id: 'e-' + 'z'.repeat(12) }), payment({ id: 'e-' + 'z'.repeat(13) }),
      payment({ id: 'e-1' })] });
  assertClean(g);   // includes: every id well formed and used once
  assert.match(g.id, /^g-[a-z0-9]{7}$/);
  const [A, B, C, D, E, F, G, H, I, J, K, L, M] = g.people.map(p => p.id);
  assert.equal(A, 'p-a');
  assert.equal(J, 'p-ok');
  for (const id of [B, C, D, E, F, G, H, I, K, L, M]) assert.match(id, /^p-[a-z0-9]{7}$/);
  assert.deepStrictEqual(g.people.map(p => p.name), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M']);

  const [first, pay1, pay2, pay3] = g.expenses;
  assert.deepStrictEqual(first.paid.who, [C]);
  assert.deepStrictEqual(first.split.who, [A, C, G, H], 'the first person written with an id owns it; 7 and "" point at nobody');
  assert.deepStrictEqual(first.split.values, { [A]: '1', [C]: '2', [G]: '3' });
  assert.deepStrictEqual(first.split.items[0].who, [C, A, J]);
  assert.deepStrictEqual([pay1.from, pay1.to], [C, A]);
  assert.deepStrictEqual([pay2.from, pay2.to], [A, G]);
  assert.deepStrictEqual([pay3.from, pay3.to], ['', J]);

  const billIds = g.expenses.map(b => b.id);
  assert.equal(billIds[0], 'e-1');
  assert.equal(billIds[7], 'e-' + 'z'.repeat(12));
  for (const i of [1, 2, 3, 4, 5, 6, 8, 9]) assert.match(billIds[i], /^e-[a-z0-9]{7}$/, 'bill ' + i);

  // once clean, the ids stay put
  assert.deepStrictEqual(sanitizeGroup(g), g);
});

test('cleaned: people who are not in the group are taken off bills, and nobody is listed twice', () => {
  const g = sanitizeGroup(baseGroup({ expenses: [
    expense({ paid: { mode: 'equal', who: ['p-gone', 'p-b', 'p-b', 'p-a', 'p-b'], values: { 'p-gone': '5', 'p-b': '1' } },
      split: { mode: 'items', who: ['p-c', 'p-zz', 'p-c'], values: { 'p-zz': '1' }, tax: '', tip: '',
        items: [{ name: 'Wine', amount: '9', who: ['p-gone', 'p-a', 'p-a'] }, { name: '', amount: '', who: ['p-gone'] }] } }),
    payment({ from: 'p-gone', to: 'p-a' }), payment({ id: 'e-8', from: 'p-b', to: 'new:Fay' })] }));
  assertClean(g);
  assert.deepStrictEqual(g.expenses[0].paid, { mode: 'equal', who: ['p-b', 'p-a'], values: { 'p-b': '1' } });
  assert.deepStrictEqual(g.expenses[0].split, { mode: 'items', who: ['p-c'], values: {}, items: [{ name: 'Wine', amount: '9', who: ['p-a'] }], tax: '', tip: '' });
  assert.deepStrictEqual([g.expenses[1].from, g.expenses[1].to], ['', 'p-a']);
  assert.deepStrictEqual([g.expenses[2].from, g.expenses[2].to], ['p-b', '']);
  assert.equal(computeExpense(g, g.expenses[1]).err, 'Choose who paid whom.');
});

test('cleaned: an unknown way to pay or split is not guessed, and an unknown kind is an expense', () => {
  for (const mode of ['weighted', 'items', '', 'EQUAL', 0, null, undefined, ['equal'], 'constructor', 'toString', '__proto__']) {
    const g = sanitizeGroup(baseGroup({ expenses: [expense({ paid: { mode, who: ['p-a'], values: { 'p-a': '1' } } })] }));
    assert.deepStrictEqual(g.expenses[0].paid, { mode: 'single', who: [], values: {} });
    assert.equal(computeExpense(g, g.expenses[0]).err, 'Choose who paid.');
  }
  for (const mode of ['weighted', 'single', '', 'Equal', 1, null, undefined, ['equal'], 'constructor', 'hasOwnProperty']) {
    const g = sanitizeGroup(baseGroup({ expenses: [expense({ split: { mode, who: ['p-a'], values: { 'p-a': '1' }, items: [{ name: 'x', amount: '1', who: ['p-a'] }], tax: '1', tip: '1' } })] }));
    assert.deepStrictEqual(g.expenses[0].split, { mode: 'equal', who: [], values: {}, items: [], tax: '', tip: '' });
    assert.equal(computeExpense(g, g.expenses[0]).err, 'Choose who shares it.');
  }
  for (const side of [undefined, null, 'single', 5, []]) {
    const g = sanitizeGroup(baseGroup({ expenses: [expense({ paid: side, split: side })] }));
    assert.deepStrictEqual(g.expenses[0].paid, { mode: 'single', who: [], values: {} });
    assert.deepStrictEqual(g.expenses[0].split, { mode: 'equal', who: [], values: {}, items: [], tax: '', tip: '' });
  }
  for (const kind of [undefined, null, 'expense', 'EXPENSE', 'Payment', 'refund', 5, ['payment'], { kind: 'payment' }]) {
    const b = sanitizeGroup(baseGroup({ expenses: [{ ...expense(), from: 'p-a', to: 'p-b', kind }] })).expenses[0];
    assert.deepStrictEqual(b, expense());
  }
  const p = sanitizeGroup(baseGroup({ expenses: [{ ...expense(), ...payment() }] })).expenses[0];
  assert.deepStrictEqual(p, payment());
});

test('cleaned: rates that cannot be used are left out, the rest is kept', () => {
  const g = sanitizeGroup(baseGroup({
    rates: { EUR: { rate: '1.2', base: 'USD' }, GBP: { rate: '1.4', base: 'EUR' }, JPY: { rate: '0', base: 'USD' }, CHF: { rate: '-1', base: 'USD' },
      CAD: { rate: '1.1', base: 'XYZ' }, AUD: { rate: '1.1' }, NZD: { rate: '1', base: 'NZD' }, SGD: '1.3', HKD: ['1.3', 'USD'], CNY: null,
      INR: { rate: 0.012, base: 'USD' }, eur: { rate: '9', base: 'USD' }, XYZ: { rate: '9', base: 'USD' }, MXN: { rate: 'abc', base: 'USD' } },
    expenses: [expense({ currency: 'EUR', fx: { rate: '1.5', base: 'GBP' } }), expense({ id: 'e-2', currency: 'EUR', fx: { rate: '1.5' } }),
      expense({ id: 'e-3', currency: 'EUR', fx: { rate: '0', base: 'USD' } }), expense({ id: 'e-4', currency: 'EUR', fx: { rate: '1.5', base: 'XYZ' } }),
      expense({ id: 'e-5', currency: 'EUR', fx: { base: 'USD' } }), expense({ id: 'e-6', currency: 'EUR', fx: '1.5' }), expense({ id: 'e-7', currency: 'EUR', fx: null }),
      payment({ currency: 'EUR', fx: { rate: 1.25, base: 'USD' } })] }));
  assertClean(g);
  assert.deepStrictEqual(g.rates, { EUR: { rate: '1.2', base: 'USD' }, GBP: { rate: '1.4', base: 'EUR' }, INR: { rate: '0.012', base: 'USD' } });
  assert.deepStrictEqual(g.expenses.map(b => b.fx), [{ rate: '1.5', base: 'GBP' }, { rate: '1.5', base: 'USD' }, undefined, undefined, undefined, undefined, undefined, { rate: '1.25', base: 'USD' }]);
  assert.ok(g.expenses.every(b => b.fx || !('fx' in b)), 'no fx key at all when there is no rate');
  // a rate the gate left out is one core.js would not have used either
  assert.equal(computeExpense(g, g.expenses[2]).rateSource, 'manual');
});

test('cleaned: the pinned table needs a real date and real numbers', () => {
  const table = usd => sanitizeGroup(baseGroup({ fx: { date: '2026-10-04', usd } })).fx;
  assert.deepStrictEqual(table({ EUR: 0.888786, JPY: 157.820352 }), { date: '2026-10-04', usd: { EUR: 0.888786, JPY: 157.820352 } });
  assert.deepStrictEqual(table({ USD: 1, EUR: 0.9 }), { date: '2026-10-04', usd: { USD: 1, EUR: 0.9 } });
  assert.deepStrictEqual(table({ USD: 5, EUR: 0.9 }), { date: '2026-10-04', usd: { USD: 1, EUR: 0.9 } }, 'USD is always 1');
  assert.deepStrictEqual(table({ EUR: 0.9, GBP: NaN, JPY: Infinity, CHF: -1, CAD: 0, AUD: '1.4', NZD: null, SGD: [1.3], HKD: { v: 7.8 }, XYZ: 2, eur: 3, CNY: -Infinity, INR: true }),
    { date: '2026-10-04', usd: { EUR: 0.9 } });
  for (const usd of [{}, { XYZ: 1 }, { EUR: '0.9' }, { EUR: NaN }, [], null, undefined, 'EUR=0.9', 5]) assert.equal(table(usd), undefined);
  for (const date of ['2026-02-31', '2026-13-01', '2026-00-10', '04/10/2026', '2026-10-4', '2026-10-04T00:00:00Z', ' 2026-10-04', '', 20261004, null, undefined, ['2026-10-04'], new Date(0), '<b>', '9'.repeat(10 * 1024 * 1024)]) {
    assert.ok(!('fx' in sanitizeGroup(baseGroup({ fx: { date, usd: { EUR: 0.9 } } }))), 'date ' + String(date).slice(0, 30));
  }
  for (const date of ['2026-10-04', '2024-02-29', '1999-12-31', '2026-01-01']) {
    assert.deepStrictEqual(sanitizeGroup(baseGroup({ fx: { date, usd: { EUR: 0.9 } } })).fx, { date, usd: { EUR: 0.9 } });
  }
  for (const fx of [null, undefined, 'pinned', 5, [], ['2026-10-04', { EUR: 0.9 }], { date: '2026-10-04' }, { usd: { EUR: 0.9 } }]) {
    assert.ok(!('fx' in sanitizeGroup(baseGroup({ fx }))));
  }
});

test('cleaned: rev is a whole number from 0 up, example is only ever true', () => {
  const rev = v => sanitizeGroup(baseGroup({ rev: v })).rev;
  assert.equal(rev(1791140000000), 1791140000000);
  assert.equal(rev(0), 0);
  assert.equal(rev(12.9), 12);
  for (const v of [-1, NaN, Infinity, -Infinity, 1e300, '1791140000000', null, undefined, [5], { valueOf: () => 5 }, true, 5n]) assert.equal(rev(v), 0);
  assert.equal(sanitizeGroup(baseGroup({ example: true })).example, true);
  for (const v of [false, 1, 'true', 'yes', null, undefined, {}, [true]]) assert.ok(!('example' in sanitizeGroup(baseGroup({ example: v }))));
});

test('cleaned: 10 MB strings anywhere are handled quickly', () => {
  const big = 'A'.repeat(10 * 1024 * 1024), spaced = ' '.repeat(5 * 1024 * 1024) + big;
  const start = performance.now();
  const g = sanitizeGroup({ id: big, name: big, currency: 'USD', rev: big, example: big,
    people: [person(big, big), person('p-a', spaced), person(spaced, 'Cy')],
    expenses: [{ id: big, kind: big, title: big, amount: big, currency: 'USD', fx: { rate: big, base: big },
      paid: { mode: 'single', who: [big, spaced, 'p-a'], values: { [big]: big, 'p-a': big } },
      split: { mode: 'items', who: [big], values: { [big]: '2' }, items: [{ name: big, amount: big, who: [big] }], tax: big, tip: big } },
    { id: 'e-2', kind: 'payment', title: spaced, amount: spaced, currency: 'USD', from: big, to: spaced }],
    rates: { EUR: { rate: big, base: big }, [big]: { rate: '1', base: 'USD' } },
    fx: { date: big, usd: { EUR: big, [big]: 1 } } });
  assert.ok(performance.now() - start < 2000);
  assertClean(g);
  assert.equal(g.name, 'A'.repeat(60));
  assert.equal(g.people[0].name, 'A'.repeat(40));
  assert.equal(g.people[1].name, 'Person 2', 'a name hidden behind megabytes of spaces counts as no name');
  const [P, Q, R] = g.people.map(p => p.id);
  const [bill, pay] = g.expenses;
  assert.equal(bill.title, 'A'.repeat(80));
  assert.equal(bill.amount, '');
  assert.deepStrictEqual(bill.paid, { mode: 'single', who: [P, R, Q], values: {} });
  assert.deepStrictEqual(bill.split, { mode: 'items', who: [P], values: { [P]: '2' }, items: [{ name: 'A'.repeat(80), amount: '', who: [P] }], tax: '', tip: '' });
  assert.deepStrictEqual([pay.from, pay.to, pay.title, pay.amount], [P, R, '', '']);
  assert.deepStrictEqual(g.rates, {});
  assert.ok(!('fx' in g) && !('fx' in bill) && !('example' in g));
});

test('cleaned: junk nested 100,000 levels deep is ignored without running out of stack', () => {
  let list = [], obj = {};
  for (let i = 0; i < 100000; i++) { list = [list]; obj = { a: obj, people: [obj], expenses: [obj], split: obj, values: obj, items: [obj] }; }
  const g = sanitizeGroup({ id: list, name: obj, currency: 'USD', rev: list, example: obj,
    people: [list, obj, { id: list, name: obj }, person('p-a', 'Ana')],
    expenses: [list, obj, { id: obj, kind: list, title: obj, amount: list, currency: 'USD', fx: obj, paid: obj, split: obj },
      { id: 'e-1', kind: 'expense', title: 't', amount: '1', currency: 'USD', fx: { rate: list, base: obj },
        paid: { mode: 'single', who: [list, obj, 'p-a'], values: obj },
        split: { mode: 'items', who: list, values: list, items: [list, obj, { name: obj, amount: list, who: [obj] }], tax: obj, tip: list } },
      { kind: 'payment', from: obj, to: list }],
    rates: { EUR: obj, GBP: { rate: list, base: obj }, deep: obj },
    fx: { date: list, usd: obj } });
  assertClean(g);
  assert.equal(g.people.length, 3);
  assert.equal(g.expenses.length, 4);
  assert.deepStrictEqual(g.expenses[2].paid, { mode: 'single', who: ['p-a'], values: {} });
  assert.deepStrictEqual(g.expenses[2].split, { mode: 'items', who: [], values: {}, items: [], tax: '', tip: '' });
  assert.deepStrictEqual(g.rates, {});
  assert.ok(!('fx' in g));
  for (const b of [g.expenses[0], g.expenses[1], g.expenses[3]]) assert.ok(computeExpense(g, b).err);
});

test('cleaned: keys named __proto__, constructor and prototype get nowhere', async () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const evil = '{"polluted":"yes","isAdmin":true,"currency":"USD","people":[],"mode":"equal","who":["p-a"],"rate":"9","base":"USD"}';
  const text = `{
    "__proto__": ${evil}, "constructor": {"prototype": ${evil}}, "prototype": ${evil},
    "id": "g-x", "name": "T", "currency": "USD", "rev": 1,
    "people": [
      {"__proto__": ${evil}, "constructor": ${evil}, "prototype": ${evil}, "id": "p-a", "name": "A"},
      {"id": "__proto__", "name": "B"}, {"id": "constructor", "name": "C"}, {"id": "prototype", "name": "D"},
      {"id": "toString", "name": "__proto__"}, {"__proto__": {"id": "p-z", "name": "Z"}}],
    "expenses": [
      {"__proto__": ${evil}, "constructor": ${evil}, "prototype": ${evil},
       "id": "e-1", "kind": "expense", "title": "constructor", "amount": "10", "currency": "USD",
       "fx": {"__proto__": ${evil}, "constructor": ${evil}, "rate": "1.5", "base": "EUR"},
       "paid": {"__proto__": ${evil}, "constructor": ${evil}, "mode": "shares",
                "who": ["__proto__", "constructor", "prototype", "p-a", "toString", "hasOwnProperty"],
                "values": {"__proto__": "1", "constructor": "2", "prototype": "3", "p-a": "4", "toString": "5", "valueOf": "6"}},
       "split": {"__proto__": ${evil}, "prototype": ${evil}, "mode": "items", "who": ["__proto__"], "values": {"__proto__": "5"},
                 "items": [{"__proto__": ${evil}, "constructor": ${evil}, "name": "prototype", "amount": "1", "who": ["constructor"]}],
                 "tax": "", "tip": ""}},
      {"__proto__": {"kind": "payment", "from": "p-a", "to": "p-a", "amount": "5", "title": "inherited"}},
      {"id": "e-3", "kind": "payment", "title": "p", "amount": "5", "currency": "USD", "from": "__proto__", "to": "constructor"}],
    "rates": {"__proto__": {"rate": "2", "base": "USD"}, "constructor": {"rate": "2", "base": "USD"}, "prototype": {"rate": "2", "base": "USD"},
              "EUR": {"__proto__": ${evil}, "constructor": ${evil}, "rate": "1.2", "base": "USD"},
              "GBP": {"__proto__": {"rate": "1.4", "base": "USD"}}},
    "fx": {"__proto__": ${evil}, "constructor": ${evil}, "date": "2026-10-04",
           "usd": {"__proto__": 5, "constructor": 6, "prototype": 7, "EUR": 0.9, "toString": 8}}
  }`;
  const input = JSON.parse(text);
  assert.ok(Object.hasOwn(input, '__proto__'), 'the hostile keys really are there');
  const check = g => {
    assertClean(g);
    assertNoBadKeys(g);
    const [A, B, C, D, E] = g.people.map(p => p.id);
    assert.equal(A, 'p-a');
    for (const id of [B, C, D, E]) assert.match(id, /^p-[a-z0-9]{7}$/);
    assert.deepStrictEqual(g.people.map(p => p.name), ['A', 'B', 'C', 'D', '__proto__', 'Person 6'], 'as a name, the word is only text');
    const [bill, inherited, pay] = g.expenses;
    assert.equal(bill.title, 'constructor');
    assert.deepStrictEqual(bill.fx, { rate: '1.5', base: 'EUR' });
    assert.deepStrictEqual(bill.paid, { mode: 'shares', who: [B, C, D, A, E], values: { [B]: '1', [C]: '2', [D]: '3', [A]: '4', [E]: '5' } });
    assert.deepStrictEqual(bill.split, { mode: 'items', who: [B], values: { [B]: '5' }, items: [{ name: 'prototype', amount: '1', who: [C] }], tax: '', tip: '' });
    assert.deepStrictEqual({ ...inherited, id: '' }, { id: '', kind: 'expense', title: '', amount: '', currency: 'USD',
      paid: { mode: 'single', who: [], values: {} }, split: { mode: 'equal', who: [], values: {}, items: [], tax: '', tip: '' } }, 'nothing inherited is read');
    assert.deepStrictEqual([pay.from, pay.to], [B, C]);
    assert.deepStrictEqual(g.rates, { EUR: { rate: '1.2', base: 'USD' } });
    assert.deepStrictEqual(g.fx, { date: '2026-10-04', usd: { EUR: 0.9 } });
  };
  const g = sanitizeGroup(input);
  check(g);
  check(await decodeGroup(await encodeGroup(input)));
  check(await decodeGroup(await without(['CompressionStream'], () => encodeGroup(input))));

  assert.deepStrictEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  assert.deepStrictEqual(Object.getOwnPropertyNames(Array.prototype).includes('polluted'), false);
  for (const probe of [{}, [], '', 0, () => 0, g, g.people, g.rates, g.expenses[0].paid.values]) {
    assert.equal(probe.polluted, undefined);
    assert.equal(probe.isAdmin, undefined);
  }
});

test('cleaned: only fields the object itself holds are read, even if every object has been tampered with', () => {
  const inherited = Object.create({ id: 'g-x', name: 'Inherited', currency: 'USD', people: [], expenses: [] });
  throwsWith(() => sanitizeGroup(inherited), NOT_A_GROUP);

  const planted = { mode: 'equal', who: ['p-a', 'p-b'], values: { 'p-a': '9' }, kind: 'payment', from: 'p-a', to: 'p-b', amount: '999', fx: { rate: '9', base: 'USD' },
    example: true, rates: { EUR: { rate: '9', base: 'USD' } }, rate: '9', base: 'USD', EUR: 9, date: '2026-10-04', usd: { EUR: 9 }, title: 'Planted', name: 'Planted', id: 'p-a',
    'p-b': '7', tax: '5', tip: '5', items: [{ name: 'Planted', amount: '9', who: ['p-b'] }], currency: 'EUR', people: [], expenses: [], rev: 5 };
  let g;
  try {
    for (const [k, v] of Object.entries(planted)) Object.defineProperty(Object.prototype, k, { value: v, configurable: true, enumerable: false, writable: true });
    g = sanitizeGroup({ currency: 'USD', people: [{}, { id: 'p-b' }], rates: { EUR: {}, GBP: { rate: '2' } }, fx: {},
      expenses: [{}, { kind: 'expense', paid: {}, split: {}, fx: {} },
        { id: 'e-3', paid: { mode: 'shares', who: ['p-b'], values: {} }, split: { mode: 'items', who: ['p-b'], values: {} } }] });
    throwsWith(() => sanitizeGroup({}), NOT_A_GROUP);
    throwsWith(() => sanitizeGroup({ people: [] }), ANY_CURRENCY);
  } finally {
    for (const k of Object.keys(planted)) delete Object.prototype[k];
  }
  assert.equal(({}).mode, undefined, 'the test cleaned up after itself');
  assertClean(g);
  assert.equal(g.name, 'Group');
  assert.deepStrictEqual(g.people.map(p => p.name), ['Person 1', 'Person 2']);
  assert.equal(g.people[1].id, 'p-b');
  assert.notEqual(g.people[0].id, 'p-a');
  for (const b of g.expenses.slice(0, 2)) {
    assert.deepStrictEqual({ ...b, id: '' }, { id: '', kind: 'expense', title: '', amount: '', currency: 'USD',
      paid: { mode: 'single', who: [], values: {} }, split: { mode: 'equal', who: [], values: {}, items: [], tax: '', tip: '' } });
  }
  assert.deepStrictEqual(g.expenses[2], { id: 'e-3', kind: 'expense', title: '', amount: '', currency: 'USD',
    paid: { mode: 'shares', who: ['p-b'], values: {} }, split: { mode: 'items', who: ['p-b'], values: {}, items: [], tax: '', tip: '' } });
  assert.equal(g.rev, 0);
  assert.deepStrictEqual(g.rates, {});
  assert.ok(!('fx' in g) && !('example' in g));
});

test('the result shares nothing with what was handed in', () => {
  const input = baseGroup({ expenses: [expense({ fx: { rate: '1.5', base: 'EUR' }, split: { mode: 'items', who: ['p-a'], values: { 'p-a': '1' }, items: [{ name: 'x', amount: '1', who: ['p-a'] }], tax: '', tip: '' } }), payment()],
    rates: { EUR: { rate: '1.2', base: 'USD' } }, fx: { date: '2026-10-04', usd: { EUR: 0.9 } } });
  const frozen = clone(input);
  const deepFreeze = o => { Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
  const g = sanitizeGroup(deepFreeze(frozen));
  assert.deepStrictEqual(g, input);
  const walk = (a, b) => {
    if (a === null || typeof a !== 'object') return;
    assert.notEqual(a, b, 'the same object appears on both sides');
    assert.ok(!Object.isFrozen(a));
    for (const k of Object.keys(a)) walk(a[k], b[k]);
  };
  walk(g, frozen);
  g.people[0].name = 'Changed';
  g.expenses[0].split.items[0].who.push('p-b');
  g.rates.EUR.rate = '9';
  g.fx.usd.EUR = 9;
  assert.deepStrictEqual(frozen, input);
});

/* ---------- fuzzing the gate ---------- */

const protoBag = () => JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"id":"p-a","name":"N","mode":"equal","who":["p-a"],"rate":"2","base":"USD"}');
const JUNK = [
  () => null, () => undefined, () => NaN, () => Infinity, () => -Infinity, () => -1, () => 0, () => 1, () => 1e21, () => 1.5, () => true, () => false,
  () => '', () => ' ', () => 'x', () => 'p-a', () => 'e-1', () => 'USD', () => 'EUR', () => 'XYZ', () => '12.50', () => '-3', () => '1e9', () => 'equal', () => 'items',
  () => 'payment', () => '2026-10-04', () => '__proto__', () => 'constructor', () => '<script>alert(1)</script>', () => 'x'.repeat(5000),
  () => cp(0xD800), () => cp(0, 10, 0x202E) + 'x', () => [], () => ({}), () => [[]], () => [null], () => ['p-a', 'p-b'], () => ({ 'p-a': '1' }),
  () => protoBag(), () => [protoBag()], () => 5n, () => Symbol('s'), () => (() => 1), () => new Date(0), () => new Map([['p-a', '1']]),
  () => Object.create(null), () => Object.create({ id: 'p-a', mode: 'equal' })];

// A copy of `v` in which some parts, at any depth, have been swapped for junk.
function vandalise(r, v, rate) {
  if (r() < rate) return pickOne(r, JUNK)();
  if (Array.isArray(v)) {
    const out = v.map(x => vandalise(r, x, rate));
    if (r() < rate) out.push(...out.slice(0, 3));   // repeated entries: repeated ids
    return out;
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (r() >= rate / 2) out[k] = vandalise(r, x, rate);
    if (r() < rate) out[pickOne(r, ['__proto__x', 'extra', 'constructor', 'prototype', 'toString'])] = pickOne(r, JUNK)();
    return out;
  }
  return v;
}

test('fuzz: 3000 vandalised groups are each refused with a plain message or come out clean', () => {
  const r = mulberry32(424242);
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  let refused = 0, cleaned = 0;
  for (let i = 0; i < 3000; i++) {
    const input = vandalise(r, randomGroup(r, 6, 8), pickOne(r, [0.01, 0.03, 0.1, 0.3]));
    let g;
    try { g = sanitizeGroup(input); }
    catch (e) { assertUserError(e); refused++; continue; }
    cleaned++;
    assertClean(g);
    assertNoBadKeys(g);
    assert.deepStrictEqual(sanitizeGroup(g), g, 'a clean group passes the gate unchanged');
  }
  assert.ok(refused > 100 && cleaned > 1000, 'both outcomes are exercised: ' + refused + ' refused, ' + cleaned + ' cleaned');
  assert.deepStrictEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  assert.equal(({}).polluted, undefined);
});

test('fuzz: 500 pieces of pure junk never get through as anything but a clean group', () => {
  const r = mulberry32(31337);
  for (let i = 0; i < 500; i++) {
    const input = i % 2 ? pickOne(r, JUNK)() : { id: pickOne(r, JUNK)(), name: pickOne(r, JUNK)(), currency: pickOne(r, ['USD', 'EUR', pickOne(r, JUNK)()]), rev: pickOne(r, JUNK)(),
      people: r() < 0.8 ? Array.from({ length: 4 }, () => pickOne(r, JUNK)()) : pickOne(r, JUNK)(),
      expenses: r() < 0.8 ? Array.from({ length: 4 }, () => pickOne(r, JUNK)()) : pickOne(r, JUNK)(), rates: pickOne(r, JUNK)(), fx: pickOne(r, JUNK)() };
    try { assertClean(sanitizeGroup(input)); }
    catch (e) { if (e instanceof assert.AssertionError) throw e; assertUserError(e); }
  }
});

/* ---------- hostile links ---------- */

test('link: not a string, no group in it, or from a newer version', async () => {
  for (const v of [undefined, null, 5, {}, [], true, () => 'v1.x', Symbol('v1.x')]) await rejectsWith(decodeGroup(v), NO_GROUP);
  for (const v of ['', ' ', '#', 'hello', '#bills', '#graph', 'settle', 'v1', 'v1,abc', 'V1.abc', 'https://example.com/#v1.abc', '1.abc', 'vv1.abc', '.v1.']) await rejectsWith(decodeGroup(v), NO_GROUP);
  for (const v of ['v2.abc', '#v2.abc', 'v10.abc', 'u2.abc', 'z1.abc', 'v0.', 'x9.' + GOLDEN_V1.slice(3)]) await rejectsWith(decodeGroup(v), NEWER);
});

test('link: a good prefix with garbage after it', async () => {
  const body = GOLDEN_V1.slice(3);
  const garbage = ['', ' ', '!', '!!!!', 'not base64', 'AAAA', 'A', 'AA', 'AAA', '====', 'AAAA====', 'ab+/', 'ab cd', 'ab%2Dcd', 'ab.cd', 'ab#cd', body + '=', body + '.', body + '?x=1',
    body.replace('-', '+'), body.replace('_', '/'), body + ' ' + body, body.slice(0, 200) + cp(10) + body.slice(200), cp(0x1F600), cp(0xE9) + body, '<script>alert(1)</script>',
    'null', 'undefined', '[object Object]', '__proto__', 'constructor', 'e30', 'W10', 'bnVsbA', Buffer.from('{"__proto__":{"polluted":1}}').toString('base64url')];
  for (const form of ['v1.', 'u1.']) for (const tail of garbage) await rejectsWith(decodeGroup(form + tail), DAMAGED);
  // the u1 body read as v1, and the other way round
  await rejectsWith(decodeGroup('v1.' + GOLDEN_U1.slice(3)), DAMAGED);
  await rejectsWith(decodeGroup('u1.' + GOLDEN_V1.slice(3)), DAMAGED);

  const r = mulberry32(555);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (let i = 0; i < 400; i++) {
    const tail = Array.from({ length: 1 + Math.floor(r() * 300) }, () => pickOne(r, alphabet)).join('');
    await rejectsWith(decodeGroup((i % 2 ? 'v1.' : 'u1.') + tail), DAMAGED);
  }
  assert.equal(({}).polluted, undefined);
});

test('link: cut short anywhere, it is refused; it never opens as part of a group', async () => {
  for (const link of [GOLDEN_V1, GOLDEN_U1]) {
    for (let keep = 3; keep < link.length; keep++) await rejectsWith(decodeGroup(link.slice(0, keep)), DAMAGED);
    for (const keep of [0, 1, 2]) await rejectsWith(decodeGroup(link.slice(0, keep)), NO_GROUP);
  }
  const big = await encodeGroup(randomGroup(mulberry32(3), 40, 300));
  assert.ok(big.length > 4000);
  for (let keep = 3; keep < big.length; keep += 97) await rejectsWith(decodeGroup(big.slice(0, keep)), DAMAGED);
});

test('link: with any one character changed, it is refused or still opens as exactly the same group', async () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (const link of [GOLDEN_V1, GOLDEN_U1]) {
    let opened = 0;
    for (let i = 3; i < link.length; i++) {
      for (const step of [1, 17, 40]) {
        const other = alphabet[(alphabet.indexOf(link[i]) + step) % 64];
        const changed = link.slice(0, i) + other + link.slice(i + 1);
        let g;
        try { g = await decodeGroup(changed); }
        catch (e) { assert.equal(e.message, DAMAGED); continue; }
        opened++;
        assert.deepStrictEqual(g, EXAMPLE_GROUP, 'changed at ' + i);
      }
    }
    // only the spare bits of the very last character can change without changing the data
    assert.ok(opened <= 3, opened + ' changed links opened');
  }
});

test('link: two characters swapped or a piece left out is noticed too', async () => {
  const link = GOLDEN_U1;
  for (let i = 3; i < link.length - 1; i++) {
    if (link[i] === link[i + 1]) continue;
    await rejectsWith(decodeGroup(link.slice(0, i) + link[i + 1] + link[i] + link.slice(i + 2)), DAMAGED);
  }
  for (let i = 3; i < link.length - 8; i += 5) await rejectsWith(decodeGroup(link.slice(0, i) + link.slice(i + 4)), DAMAGED);
});

test('link: a deflate bomb is stopped at 1 MB, not after it has filled the memory', async () => {
  const zeros = 'v1.' + zlib.deflateRawSync(Buffer.alloc(64 * 1024 * 1024)).toString('base64url');
  assert.ok(zeros.length < 100000, 'the bomb is a short link: ' + zeros.length);
  const spaces = 'v1.' + zlib.deflateRawSync(Buffer.concat([Buffer.from('["g-a","n","USD"'), Buffer.alloc(64 * 1024 * 1024, 32), Buffer.from(']')])).toString('base64url');
  const nested = 'v1.' + zlib.deflateRawSync(Buffer.alloc(32 * 1024 * 1024, '[')).toString('base64url');
  const start = performance.now();
  for (const bomb of [zeros, spaces, nested]) await rejectsWith(decodeGroup(bomb), TOO_BIG);
  assert.ok(performance.now() - start < 3000, 'stopped early');

  // count the bytes that really come out of the unpacking: it must stop near the limit, not at 64 MB
  const Real = globalThis.DecompressionStream;
  let out = 0;
  class Counting {
    constructor(format) {
      const real = new Real(format);
      this.writable = real.writable;
      this.readable = real.readable.pipeThrough(new TransformStream({ transform(chunk, c) { out += chunk.length; c.enqueue(chunk); } }));
    }
  }
  globalThis.DecompressionStream = Counting;
  try {
    for (const bomb of [zeros, spaces, nested]) {
      out = 0;
      await rejectsWith(decodeGroup(bomb), TOO_BIG);
      assert.ok(out > 1024 * 1024 && out < 2 * 1024 * 1024, out + ' bytes were unpacked');
    }
    out = 0;
    assert.deepStrictEqual(await decodeGroup(GOLDEN_V1), EXAMPLE_GROUP);
    assert.ok(out > 600 && out < 700, 'the counter sees the real work: ' + out);
  } finally {
    globalThis.DecompressionStream = Real;
  }
  // the page still works afterwards
  assert.deepStrictEqual(await decodeGroup(GOLDEN_V1), EXAMPLE_GROUP);
});

test('link: exactly 1 MB opens, one byte more does not', async () => {
  const head = '["g-a","Trip","USD",5', limit = 1024 * 1024;
  const padded = n => head + ' '.repeat(n - head.length - 1) + ']';
  const want = { id: 'g-a', name: 'Trip', currency: 'USD', rev: 5, people: [], expenses: [], rates: {} };
  for (const form of ['v1', 'u1']) {
    assert.deepStrictEqual(await decodeGroup(linkOf(padded(limit), form)), want);
    await rejectsWith(decodeGroup(linkOf(padded(limit + 1), form)), TOO_BIG);
    await rejectsWith(decodeGroup(linkOf(padded(2 * limit), form)), TOO_BIG);
  }
  await rejectsWith(decodeGroup('u1.' + 'A'.repeat(3 * limit)), TOO_BIG);
  await rejectsWith(decodeGroup('v1.' + 'A'.repeat(3 * limit)), TOO_BIG);
  await rejectsWith(decodeGroup(linkOf(['g-a', 'A'.repeat(10 * limit), 'USD'])), TOO_BIG);
});

test('link: well-formed on the outside, wrong on the inside', async () => {
  for (const form of ['v1', 'u1']) {
    for (const text of ['', ' ', '{', '[', '["g-a","n","USD"', 'nul', "['g-a']", '[1,]', '\\', 'NaN', '[NaN]', 'undefined']) await rejectsWith(decodeGroup(linkOf(text, form)), DAMAGED);
    for (const value of [null, true, 5, 'text', {}, { 0: 'g-a', 1: 'n', 2: 'USD', length: 3 }, clone(EXAMPLE_GROUP)]) await rejectsWith(decodeGroup(linkOf(value, form)), DAMAGED);
    // bytes that are not UTF-8
    await rejectsWith(decodeGroup(linkOfBytes(Buffer.from([0x5B, 0x22, 0xFF, 0xFE, 0x22, 0x5D]), form)), DAMAGED);
    await rejectsWith(decodeGroup(linkOfBytes(Buffer.from([0x5B, 0x22, 0xC3, 0x22, 0x5D]), form)), DAMAGED);
    // a list, but not a group
    for (const value of [[], [1, 2, 3], ['g-a'], ['g-a', 'n'], [null, null, null], [[], [], []], ['g-a', 'n', 'XYZ'], ['g-a', 'n', ['USD']], ['g-a', 'n', { c: 'USD' }]]) {
      await assert.rejects(decodeGroup(linkOf(value, form)), e => { assertUserError(e); assert.match(e.message, /currency/); return true; });
    }
  }
  // a good body with the wrong check bytes
  const body = Buffer.from(JSON.stringify(EXAMPLE_PACKED));
  await rejectsWith(decodeGroup('u1.' + Buffer.concat([body, Buffer.from([0, 0, 0, 0])]).toString('base64url')), DAMAGED);
  await rejectsWith(decodeGroup('u1.' + body.toString('base64url')), DAMAGED);
  await rejectsWith(decodeGroup('v1.' + zlib.deflateRawSync(body).toString('base64url')), DAMAGED);
});

test('link: too many people or bills inside is refused, 100,000 people included', async () => {
  const head = '["g-a","n","USD",0,';
  await rejectsWith(decodeGroup(linkOf(head + '[' + Array(100000).fill('[0,0]').join(',') + ']]')), TOO_MANY_PEOPLE);
  await rejectsWith(decodeGroup(linkOf(head + '[' + Array(201).fill('["","x"]').join(',') + ']]')), TOO_MANY_PEOPLE);
  await rejectsWith(decodeGroup(linkOf(head + '[],[' + Array(2001).fill('["","t",1,0,0]').join(',') + ']]')), TOO_MANY_BILLS);
  await rejectsWith(decodeGroup(linkOf(head + '[["p-a","A"]],[["e-1","t","",[0,[0]],[5,[],[],[' + Array(101).fill('["i",1,[0]]').join(',') + ']]]]]')), TOO_MANY_ITEMS);
  await rejectsWith(decodeGroup(linkOf(head + '[],[["e-1","t",1,-1,-1,"XYZ"]]]')), 'This page does not know the currency XYZ.');
  // people who are not written as [id, name] keep their place but are not people
  const g = await decodeGroup(linkOf(head + '[' + Array(5000).fill('0').join(',') + ',["p-a","Ana"]],[["e-1","t",5,5000,5000]]]'));
  assert.deepStrictEqual(g.people, [person('p-a', 'Ana')]);
  assert.deepStrictEqual([g.expenses[0].from, g.expenses[0].to], ['p-a', 'p-a']);
});

test('link: hostile ids, places and keys inside a packed group are cleaned like anything else', async () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const packed = ['__proto__', '<b>T</b>', 'USD', -5,
    [['__proto__', 'A'], ['constructor', 'B'], ['p-ok', '<img src=x onerror=alert(1)>'], ['p-ok', 'D'], 'junk', ['prototype']],
    [['e-1', 't', 10, [4, [0, 1, 2, 3, 4, 5, 99, -1, 1.5, 'x', null, [0], '__proto__', 'length', 'constructor'], [0, 1, 1, 2, 2, 3, 99, 4, 'length', 5, '__proto__', 6]],
        [5, ['constructor'], [0, { v: 1 }, 1, [2], 2, '-3'], [['i', 1, [0, 'push']], 'junk', [], [['x']], ['j', -1, [2]]], 'x', []]],
      ['e-2', 'pay', 5, 0, 1], ['e-3', 'pay', 5, 99, -1], ['e-4', 'pay', 5, 'constructor', '__proto__'], ['e-5', 'pay', 5, 2.5, null],
      ['e-6', 't', 1, ['constructor', [0]], ['__proto__', [0]]], ['e-7', 't', 1, [99, [0]], [-1, [0]]], ['e-8', 't', 1, [1.5, [0]], [[1], [0]]],
      ['e-9', 't', 1, [1, [2]], [1, [2]], '', 'x', 'EUR'], ['e-10', 't', 1, [1, [2]], [1, [2]], '', 1.5, 'constructor'], ['e-11', 't', 1, [1, [2]], [1, [2]], '', '1.50'],
      'junk', 7, null, { 0: 'e-12' }],
    [['__proto__', 1, 'USD'], ['constructor', 2], ['EUR', 1.2], ['GBP', 1.4, 'EUR'], ['JPY', -1], ['CHF', 1, 'toString'], 'junk', [], [['EUR'], 9]],
    ['2026-10-04', ['__proto__', 1, 'constructor', 2, 'EUR', 0.9, 'GBP', '0.7', 'JPY', -1, 'toString', 3, 'CHF']],
    'yes'];
  for (const form of ['v1', 'u1']) {
    const g = await decodeGroup(linkOf(packed, form));
    assertClean(g);
    assertNoBadKeys(g);
    assert.match(g.id, /^g-[a-z0-9]{7}$/);
    assert.equal(g.name, '<b>T</b>');
    assert.equal(g.rev, 0);
    assert.ok(!('example' in g));
    const [A, B, C, D, F] = g.people.map(p => p.id);
    assert.equal(C, 'p-ok');
    assert.deepStrictEqual(g.people.map(p => p.name), ['A', 'B', '<img src=x onerror=alert(1)>', 'D', 'Person 5']);
    const bills = Object.fromEntries(g.expenses.map(b => [b.title + ':' + b.id, b]));
    const first = g.expenses[0];
    assert.equal(first.id, 'e-1');
    assert.deepStrictEqual(first.paid, { mode: 'shares', who: [A, B, C, F], values: { [A]: '1', [B]: '2', [C]: '3' } }, 'D shares an id with C, so place 3 points at C');
    assert.deepStrictEqual(first.split, { mode: 'items', who: [], values: {}, items: [{ name: 'i', amount: '1', who: [A] }, { name: 'j', amount: '', who: [C] }], tax: '', tip: '' });
    assert.deepStrictEqual([bills['pay:e-2'].from, bills['pay:e-2'].to], [A, B]);
    for (const id of ['e-3', 'e-4', 'e-5']) assert.deepStrictEqual([bills['pay:' + id].from, bills['pay:' + id].to], ['', '']);
    for (const id of ['e-6', 'e-7', 'e-8']) {
      assert.deepStrictEqual(bills['t:' + id].paid, { mode: 'single', who: [], values: {} });
      assert.deepStrictEqual(bills['t:' + id].split, { mode: 'equal', who: [], values: {}, items: [], tax: '', tip: '' });
    }
    assert.ok(!('fx' in bills['t:e-9']) && !('fx' in bills['t:e-10']));
    assert.deepStrictEqual(bills['t:e-11'].fx, { rate: '1.50', base: 'USD' });
    assert.equal(g.expenses.length, 11, 'entries that are not lists are not bills');
    assert.deepStrictEqual(g.rates, { EUR: { rate: '1.2', base: 'USD' }, GBP: { rate: '1.4', base: 'EUR' } });
    assert.deepStrictEqual(g.fx, { date: '2026-10-04', usd: { EUR: 0.9 } });
  }
  assert.deepStrictEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  assert.equal(({}).polluted, undefined);
  assert.equal([].polluted, undefined);
});

test('link: junk nested 200,000 levels deep is refused with a plain message', async () => {
  for (const form of ['v1', 'u1']) {
    for (const text of ['['.repeat(200000) + ']'.repeat(200000), '[' + '{"a":'.repeat(100000) + '1' + '}'.repeat(100000) + ']',
      '["g-a","n","USD",0,' + '['.repeat(100000) + ']'.repeat(100000) + ',' + '['.repeat(100000) + ']'.repeat(100000) + ']']) {
      let g;
      try { g = await decodeGroup(linkOf(text, form)); }
      catch (e) { assertUserError(e); continue; }
      assertClean(g);
    }
  }
});

test('fuzz: 400 vandalised packed groups are refused with a plain message or open clean', async () => {
  const r = mulberry32(8675309);
  const jsonJunk = [null, true, false, 0, 1, -1, 1.5, 1e21, 99, '', 'x', 'USD', 'XYZ', 'p-a', '__proto__', 'constructor', '2026-10-04', '<b>', [], {}, [[]], [0], [0, 1],
    { __proto__x: 1 }, 'A'.repeat(3000)];
  const wreck = (v, rate) => {
    if (r() < rate) return r() < 0.15 ? JSON.parse('{"__proto__":{"polluted":1},"constructor":2}') : pickOne(r, jsonJunk);
    if (!Array.isArray(v)) return v;
    const out = v.map(x => wreck(x, rate));
    if (r() < rate) out.splice(Math.floor(r() * (out.length + 1)), 0, pickOne(r, jsonJunk));
    if (r() < rate) out.splice(Math.floor(r() * out.length), 1);
    return out;
  };
  let refused = 0, opened = 0;
  for (let i = 0; i < 400; i++) {
    const packed = packedOf(await encodeGroup(randomGroup(r, 6, 8)));
    const link = linkOf(wreck(packed, pickOne(r, [0.01, 0.03, 0.1])), i % 2 ? 'v1' : 'u1');
    let g;
    try { g = await decodeGroup(link); }
    catch (e) { assertUserError(e); refused++; continue; }
    opened++;
    assertClean(g);
    assertNoBadKeys(g);
    assert.deepStrictEqual(await decodeGroup(await encodeGroup(g)), g);
  }
  assert.ok(refused > 5 && opened > 100, refused + ' refused, ' + opened + ' opened');
  assert.equal(({}).polluted, undefined);
});

/* ---------- making links ---------- */

test('encodeGroup sends only what passed the gate', async () => {
  const messy = baseGroup({ secret: 'hunter2', people: [{ id: 'p-a', name: 'Ana', email: 'hunter2@example.com' }, person('p-b', 'Ben')],
    expenses: [{ ...expense({ amount: ' $45 ', split: { mode: 'equal', who: ['p-a', 'p-b', 'p-gone'], values: {}, items: [{ name: '', amount: '', who: [] }], tax: '', tip: '' } }), note: 'hunter2' }] });
  const u = await without(['CompressionStream'], () => encodeGroup(messy));
  assert.ok(!Buffer.from(u.slice(3), 'base64url').toString('latin1').includes('hunter2'));
  for (const link of [u, await encodeGroup(messy)]) assert.deepStrictEqual(await decodeGroup(link), sanitizeGroup(messy));
  assert.equal(sanitizeGroup(messy).expenses[0].amount, '45');
});

test('encodeGroup refuses what is not a group, and a group too large for any link', async () => {
  for (const v of [null, undefined, 'x', [], {}]) await rejectsWith(encodeGroup(v), NOT_A_GROUP);
  await rejectsWith(encodeGroup(baseGroup({ currency: 'XYZ' })), 'This page does not know the currency XYZ.');
  await rejectsWith(encodeGroup(baseGroup({ people: Array.from({ length: 201 }, (_, i) => person('p-' + i, 'P')) })), TOO_MANY_PEOPLE);
  const items = Array.from({ length: 20 }, (_, i) => ({ name: 'Item number ' + i + ' ' + 'x'.repeat(50), amount: '1', who: ['p-a'] }));
  const huge = baseGroup({ expenses: Array.from({ length: 2000 }, (_, i) => expense({ id: 'e-' + i, split: { mode: 'items', who: [], values: {}, items, tax: '', tip: '' } })) });
  await rejectsWith(encodeGroup(huge), TOO_LARGE_TO_LINK);
  await rejectsWith(without(['CompressionStream'], () => encodeGroup(huge)), TOO_LARGE_TO_LINK);
});
