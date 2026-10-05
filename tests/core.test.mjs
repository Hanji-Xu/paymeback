import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_RATES, CURRENCIES, EXAMPLE_GROUP,
  esc, uid, num, personName, listJoin, sumMap,
  minorDigits, toMinor, fromMinor, plainMoney, formatMoney, allocate,
  tableRate, rateFor, billRate, fmtRate, fmtDate, fxNote,
  computeExpense, personTotals, usedCurrencies
} from '../docs/js/core.js';

/* ---------- helpers ---------- */

// Seeded random numbers, so a failing case can be reproduced.
function rng(seed) {
  let s = seed;
  return () => {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const int = (rnd, a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (rnd, arr) => arr[int(rnd, 0, arr.length - 1)];

const A = 'p-a', B = 'p-b', C = 'p-c', D = 'p-d';
const obj = map => Object.fromEntries(map);

function group(over = {}) {
  return { id: 'g-test', name: 'Test', currency: 'USD', rev: 0,
    people: [{ id: A, name: 'Ana' }, { id: B, name: 'Ben' }, { id: C, name: 'Cy' }, { id: D, name: 'Dee' }],
    expenses: [], rates: {}, ...over };
}
function expense(over = {}) {
  const { paid, split, ...rest } = over;
  return { id: 'e-test', kind: 'expense', title: 'Dinner', amount: '120.00', currency: 'USD',
    paid: { mode: 'single', who: [A], values: {}, ...paid },
    split: { mode: 'equal', who: [A, B, C], values: {}, items: [], tax: '', tip: '', ...split },
    ...rest };
}
const payment = (over = {}) => ({ id: 'e-pay', kind: 'payment', title: 'Ana paid Ben back', amount: '50', currency: 'USD', from: A, to: B, ...over });

// Money never leaks: both sides add up to the total, in the group's units and in the bill's units.
function assertSums(r) {
  assert.equal(sumMap(r.paid), r.total, 'paid adds up to the total');
  assert.equal(sumMap(r.owed), r.total, 'owed adds up to the total');
  assert.equal(sumMap(r.paidOrig), r.totalOrig, 'paid adds up in the bill currency');
  assert.equal(sumMap(r.owedOrig), r.totalOrig, 'owed adds up in the bill currency');
  for (const m of [r.paid, r.owed, r.paidOrig, r.owedOrig]) for (const v of m.values()) assert.ok(Number.isInteger(v) && v >= 0, 'whole, never negative');
}

const byId = id => EXAMPLE_GROUP.expenses.find(e => e.id === id);

/* ---------- small helpers ---------- */

describe('small helpers', () => {
  test('esc escapes the five HTML characters', () => {
    assert.equal(esc('<b a="1" c=\'2\'>Tom & Jo</b>'), '&lt;b a=&quot;1&quot; c=&#39;2&#39;&gt;Tom &amp; Jo&lt;/b&gt;');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(12), '12');
    assert.equal(esc('<script>alert(1)</script>').includes('<'), false);
  });

  test('uid is the prefix, a dash and exactly 7 base36 characters', () => {
    const seen = new Set();
    for (let i = 0; i < 3000; i++) {
      const id = uid('p');
      assert.match(id, /^p-[0-9a-z]{7}$/);
      seen.add(id);
    }
    assert.ok(seen.size > 2990, 'ids do not repeat');
    assert.match(uid('g'), /^g-[0-9a-z]{7}$/);
    assert.match(uid('e'), /^e-[0-9a-z]{7}$/);
  });

  test('num reads numbers leniently and gives 0 for anything unreadable', () => {
    assert.equal(num('12.50'), 12.5);
    assert.equal(num('$1,200.50'), 1200.5);
    assert.equal(num(' 7 '), 7);
    assert.equal(num(7), 7);
    assert.equal(num('-3'), -3);
    for (const bad of ['', null, undefined, 'abc', '.', '-', NaN, Infinity, {}, '9'.repeat(400)]) assert.equal(num(bad), 0);
  });

  test('personName, listJoin and sumMap', () => {
    const g = group();
    assert.equal(personName(g, B), 'Ben');
    assert.equal(personName(g, 'p-gone'), '?');
    assert.equal(listJoin([]), '');
    assert.equal(listJoin(['Ana']), 'Ana');
    assert.equal(listJoin(['Ana', 'Ben']), 'Ana and Ben');
    assert.equal(listJoin(['Ana', 'Ben', 'Cy']), 'Ana, Ben and Cy');
    assert.equal(sumMap(new Map()), 0);
    assert.equal(sumMap(new Map([[A, 5], [B, 7]])), 12);
  });
});

/* ---------- money ---------- */

describe('currencies and money', () => {
  test('the currency list is the built-in rate table', () => {
    assert.deepEqual([...CURRENCIES], Object.keys(BUILTIN_RATES.usd));
    assert.equal(CURRENCIES.length, 31);
    assert.equal(BUILTIN_RATES.usd.USD, 1);
    assert.equal(BUILTIN_RATES.usd.EUR, 0.888786);
    assert.match(BUILTIN_RATES.date, /^\d{4}-\d\d-\d\d$/);
    for (const c of CURRENCIES) assert.ok(BUILTIN_RATES.usd[c] > 0);
    assert.ok(Object.isFrozen(CURRENCIES) && Object.isFrozen(BUILTIN_RATES) && Object.isFrozen(BUILTIN_RATES.usd));
  });

  test('minorDigits: no decimals for yen, won and dong; two for the rest', () => {
    for (const c of CURRENCIES) assert.equal(minorDigits(c), ['JPY', 'KRW', 'VND'].includes(c) ? 0 : 2, c);
    assert.equal(minorDigits('KWD'), 3);
    assert.equal(minorDigits('XX'), 2, 'falls back to 2 for a code that is not a currency');
    assert.equal(minorDigits(undefined), 2);
    assert.equal(minorDigits('JPY'), 0, 'same answer the second time');
  });

  test('toMinor turns typed amounts into whole minor units', () => {
    assert.equal(toMinor('120', 'USD'), 12000);
    assert.equal(toMinor('120.5', 'USD'), 12050);
    assert.equal(toMinor('19.99', 'EUR'), 1999);
    assert.equal(toMinor('1.15', 'EUR'), 115);
    assert.equal(toMinor('0.07', 'USD'), 7);
    assert.equal(toMinor('1000', 'JPY'), 1000);
    assert.equal(toMinor('1000.4', 'JPY'), 1000);
    assert.equal(toMinor('1.234', 'KWD'), 1234);
    assert.equal(toMinor(12.5, 'USD'), 1250);
    assert.equal(toMinor('-5', 'USD'), -500);
    for (const empty of ['', null, undefined, 'abc', '-0']) assert.equal(toMinor(empty, 'USD'), 0);
  });

  test('fromMinor writes the currency\'s own number of decimals, no grouping', () => {
    assert.equal(fromMinor(12345, 'USD'), '123.45');
    assert.equal(fromMinor(120000000, 'EUR'), '1200000.00');
    assert.equal(fromMinor(5, 'USD'), '0.05');
    assert.equal(fromMinor(50, 'USD'), '0.50');
    assert.equal(fromMinor(0, 'USD'), '0.00');
    assert.equal(fromMinor(-5, 'USD'), '-0.05');
    assert.equal(fromMinor(-12345, 'USD'), '-123.45');
    assert.equal(fromMinor(1000, 'JPY'), '1000');
    assert.equal(fromMinor(0, 'JPY'), '0');
    assert.equal(fromMinor(1234, 'KWD'), '1.234');
    assert.equal(fromMinor(NaN, 'USD'), '0.00');
  });

  test('toMinor(fromMinor(n)) gives n back for every currency', () => {
    const rnd = rng(11);
    for (const c of [...CURRENCIES, 'KWD']) {
      for (let n = 0; n <= 1200; n++) assert.equal(toMinor(fromMinor(n, c), c), n);
      for (let i = 0; i < 300; i++) { const n = int(rnd, 0, 1e12); assert.equal(toMinor(fromMinor(n, c), c), n); }
    }
  });

  test('plainMoney is the amount and the code', () => {
    assert.equal(plainMoney(12000, 'EUR'), '120.00 EUR');
    assert.equal(plainMoney(1000, 'JPY'), '1000 JPY');
  });

  test('formatMoney shows the currency\'s own decimals', () => {
    assert.equal(formatMoney(87760, 'USD', 'en-US'), '$877.60');
    assert.equal(formatMoney(12000, 'USD', 'en-US'), '$120.00');
    assert.equal(formatMoney(5, 'USD', 'en-US'), '$0.05');
    assert.equal(formatMoney(-12298, 'USD', 'en-US'), '-$122.98');
    assert.equal(formatMoney(1000, 'JPY', 'en-US'), '¥1,000');
    assert.equal(formatMoney(1578, 'JPY', 'ja-JP').includes('.'), false);
    assert.match(formatMoney(25000, 'KRW', 'en-US'), /25,000$/);
    assert.match(formatMoney(25940, 'VND', 'en-US'), /25,940$/);
    assert.match(formatMoney(12345, 'EUR', 'de-DE'), /^123,45\s€$/u);
    assert.match(formatMoney(12345, 'EUR', 'en-US'), /^€123\.45$/);
    assert.match(formatMoney(12345, 'EUR'), /123.45/, 'works without a locale');
  });

  test('formatMoney falls back to "CODE amount" when the currency or locale is not usable', () => {
    assert.equal(formatMoney(12345, 'XX', 'en-US'), 'XX 123.45');
    assert.equal(formatMoney(12345, 'EUR', 'not a locale'), 'EUR 123.45');
  });
});

/* ---------- allocate ---------- */

describe('allocate', () => {
  test('simple cases', () => {
    assert.deepEqual(obj(allocate(100, [[A, 1], [B, 1], [C, 1]])), { [A]: 34, [B]: 33, [C]: 33 });
    assert.deepEqual(obj(allocate(1000, [[A, 1], [B, 1], [C, 1]])), { [A]: 334, [B]: 333, [C]: 333 });
    assert.deepEqual(obj(allocate(200, [[A, 1], [B, 1], [C, 1]])), { [A]: 67, [B]: 67, [C]: 66 });
    assert.deepEqual(obj(allocate(21000, [[A, 1], [B, 1], [C, 1], [D, 2]])), { [A]: 4200, [B]: 4200, [C]: 4200, [D]: 8400 });
    assert.deepEqual(obj(allocate(9999, [[A, 50], [B, 30], [C, 20]])), { [A]: 4999, [B]: 3000, [C]: 2000 });
    assert.deepEqual(obj(allocate(1, [[A, 1], [B, 3]])), { [A]: 0, [B]: 1 });
  });

  test('always sums exactly, never negative, each within one unit of the exact share', () => {
    const rnd = rng(1);
    for (let n = 0; n < 6000; n++) {
      const total = n % 7 === 0 ? int(rnd, 0, 1e12) : int(rnd, 0, 100000);
      const kind = n % 4;
      const entries = Array.from({ length: int(rnd, 1, 9) }, (_, i) => ['p' + i,
        kind === 0 ? int(rnd, 0, 5) : kind === 1 ? rnd() * 100 : kind === 2 ? int(rnd, 1, 1000) / 10 : int(rnd, 0, 1e6)]);
      const sumW = entries.reduce((s, e) => s + e[1], 0);
      const out = allocate(total, entries);
      assert.deepEqual([...out.keys()], entries.map(e => e[0]), 'one result per entry, in order');
      if (sumW === 0) { assert.equal(sumMap(out), 0); continue; }
      assert.equal(sumMap(out), total, `sum for total ${total} ${JSON.stringify(entries)}`);
      for (const [id, w] of entries) {
        const v = out.get(id);
        assert.ok(Number.isInteger(v) && v >= 0, 'whole and not negative');
        assert.ok(Math.abs(v - total * w / sumW) < 1, 'within one unit of the exact share');
        if (w === 0) assert.equal(v, 0, 'no weight, no money');
      }
    }
  });

  test('equal weights differ by at most 1 and the first ones get the extra unit', () => {
    const rnd = rng(2);
    for (let n = 0; n < 2000; n++) {
      const count = int(rnd, 1, 12), total = int(rnd, 0, 1e6), w = pick(rnd, [1, 2, 0.5, 33.3, 7]);
      const vals = [...allocate(total, Array.from({ length: count }, (_, i) => [i, w])).values()];
      assert.equal(vals.reduce((s, v) => s + v, 0), total);
      assert.ok(Math.max(...vals) - Math.min(...vals) <= 1);
      assert.deepEqual(vals, [...vals].sort((x, y) => y - x), 'larger parts come first');
      assert.equal(vals.filter(v => v === Math.max(...vals)).length, total % count || count);
    }
  });

  test('is deterministic and leaves its input alone', () => {
    const rnd = rng(3);
    for (let n = 0; n < 300; n++) {
      const entries = Array.from({ length: int(rnd, 1, 8) }, (_, i) => ['p' + i, rnd() * 10]);
      const copy = structuredClone(entries), total = int(rnd, 0, 1e7);
      const first = allocate(total, entries);
      assert.deepEqual(allocate(total, entries), first);
      assert.deepEqual(allocate(total, structuredClone(entries)), first);
      assert.deepEqual(entries, copy);
    }
  });

  test('zero weights, zero total, nobody', () => {
    assert.deepEqual(obj(allocate(500, [[A, 0], [B, 0]])), { [A]: 0, [B]: 0 });
    assert.deepEqual(obj(allocate(0, [[A, 1], [B, 2]])), { [A]: 0, [B]: 0 });
    assert.deepEqual(obj(allocate(500, [[A, 0], [B, 3], [C, 0]])), { [A]: 0, [B]: 500, [C]: 0 });
    assert.equal(allocate(500, []).size, 0);
  });

  test('a single entry gets everything', () => {
    assert.deepEqual(obj(allocate(12345, [[A, 1]])), { [A]: 12345 });
    assert.deepEqual(obj(allocate(1, [[A, 0.001]])), { [A]: 1 });
    assert.deepEqual(obj(allocate(7, [[A, 1e6]])), { [A]: 7 });
  });
});

/* ---------- bills: who paid ---------- */

describe('computeExpense: who paid', () => {
  const g = group();

  test('one payer', () => {
    const r = computeExpense(g, expense());
    assert.equal(r.err, null);
    assert.equal(r.cur, 'USD');
    assert.equal(r.total, 12000);
    assert.equal(r.totalOrig, 12000);
    assert.deepEqual(obj(r.paid), { [A]: 12000 });
    assert.deepEqual(obj(r.owed), { [A]: 4000, [B]: 4000, [C]: 4000 });
    assert.deepEqual(r.edges, [[B, A, 4000], [C, A, 4000]]);
    assert.equal(r.rate, 1);
    assert.equal(r.rateSource, 'same');
    assertSums(r);
  });

  test('"single" uses the first person only', () => {
    const r = computeExpense(g, expense({ paid: { mode: 'single', who: [B, A] } }));
    assert.deepEqual(obj(r.paid), { [B]: 12000 });
  });

  test('several payers in equal parts', () => {
    const r = computeExpense(g, expense({ amount: '100.00', paid: { mode: 'equal', who: [A, B, C] } }));
    assert.deepEqual(obj(r.paid), { [A]: 3334, [B]: 3333, [C]: 3333 });
    assertSums(r);
  });

  test('several payers by amount', () => {
    const r = computeExpense(g, expense({ paid: { mode: 'exact', who: [A, B], values: { [A]: '80', [B]: '40.00' } } }));
    assert.equal(r.err, null);
    assert.deepEqual(obj(r.paid), { [A]: 8000, [B]: 4000 });
    assertSums(r);
  });

  test('several payers by percent', () => {
    const r = computeExpense(g, expense({ amount: '99.99', paid: { mode: 'percent', who: [A, B], values: { [A]: '60', [B]: '40' } } }));
    assert.deepEqual(obj(r.paid), { [A]: 5999, [B]: 4000 });
    assertSums(r);
  });

  test('several payers by shares', () => {
    const r = computeExpense(g, expense({ paid: { mode: 'shares', who: [A, B], values: { [A]: '2', [B]: '1' } } }));
    assert.deepEqual(obj(r.paid), { [A]: 8000, [B]: 4000 });
    assertSums(r);
  });

  test('with several payers each share is owed to them in proportion to what each paid', () => {
    // 120.00: Ana paid 80, Ben paid 40; Ana, Ben and Cy share it, 40.00 each.
    const r = computeExpense(g, expense({ paid: { mode: 'exact', who: [A, B], values: { [A]: '80', [B]: '40' } } }));
    assert.deepEqual(r.edges, [
      [A, B, 1333],            // a third of Ana's 40.00 is owed to Ben; the rest is her own money
      [B, A, 2667],            // two thirds of Ben's 40.00 is owed to Ana
      [C, A, 2666], [C, B, 1334]   // Cy's 40.00 goes to what each payer is still owed, so no cent is lost
    ]);
    assert.ok(r.edges.every(([debtor, creditor]) => debtor !== creditor), 'nobody owes themselves');
    const toAna = r.edges.filter(e => e[1] === A && e[0] === C)[0][2], toBen = r.edges.filter(e => e[1] === B && e[0] === C)[0][2];
    assert.equal(toAna + toBen, 4000, 'Cy\'s debts add up to Cy\'s share');
    // Ana paid 80.00 and her share is 40.00: the debts leave her exactly 40.00 up. Ben paid his own share.
    assert.equal(2667 + 2666 - 1333, 8000 - 4000);
    assert.equal(1333 + 1334 - 2667, 4000 - 4000);
  });

  test('the debts of a bill move exactly what each person paid minus their share, to the cent', () => {
    const rnd = rng(77);
    for (let n = 0; n < 400; n++) {
      const cur = pick(rnd, ['USD', 'EUR', 'JPY', 'KRW']);
      const sub = chance => { const who = [A, B, C, D].filter(() => rnd() < chance); return who.length ? who : [A]; };
      const weights = who => Object.fromEntries(who.map(id => [id, String(int(rnd, 1, 9))]));
      const payers = sub(0.6), sharers = sub(0.7);
      const base = pick(rnd, ['USD', 'EUR', 'JPY']);
      const grp = { ...g, currency: base };
      const r = computeExpense(grp, expense({ amount: fromMinor(int(rnd, 1, 500000), cur), currency: cur,
        paid: { mode: pick(rnd, ['equal', 'shares']), who: payers, values: weights(payers) },
        split: { mode: pick(rnd, ['equal', 'shares']), who: sharers, values: weights(sharers) } }));
      assert.equal(r.err, null);
      const net = new Map(grp.people.map(p => [p.id, 0]));
      for (const [d, c, v] of r.edges) {
        assert.ok(Number.isInteger(v) && v > 0 && d !== c);
        net.set(d, net.get(d) - v); net.set(c, net.get(c) + v);
      }
      for (const p of grp.people) assert.equal(net.get(p.id), (r.paid.get(p.id) || 0) - (r.owed.get(p.id) || 0), `${p.id} in bill ${n}`);
    }
  });

  test('a payer who is not sharing the bill is owed all of it', () => {
    const r = computeExpense(g, expense({ amount: '90', paid: { mode: 'single', who: [D] } }));
    assert.deepEqual(obj(r.paid), { [D]: 9000 });
    assert.equal(r.owed.has(D), false);
    assert.deepEqual(r.edges, [[A, D, 3000], [B, D, 3000], [C, D, 3000]]);
    assertSums(r);
  });

  test('a payer who is the only one sharing owes nothing and creates no debts', () => {
    const r = computeExpense(g, expense({ split: { who: [A] } }));
    assert.equal(r.err, null);
    assert.deepEqual(r.edges, []);
  });

  test('people who left the group and repeated names are ignored', () => {
    const r = computeExpense(g, expense({ paid: { mode: 'equal', who: [A, 'p-gone', A] }, split: { who: [A, B, B, 'p-gone', C] } }));
    assert.deepEqual(obj(r.paid), { [A]: 12000 });
    assert.deepEqual(obj(r.owed), { [A]: 4000, [B]: 4000, [C]: 4000 });
    assertSums(r);
  });
});

/* ---------- bills: how they are split ---------- */

describe('computeExpense: how it is split', () => {
  const g = group();

  test('equally', () => {
    const r = computeExpense(g, expense({ amount: '100' }));
    assert.deepEqual(obj(r.owed), { [A]: 3334, [B]: 3333, [C]: 3333 });
    assert.deepEqual(r.edges, [[B, A, 3333], [C, A, 3333]]);
    assertSums(r);
  });

  test('by set amounts', () => {
    const r = computeExpense(g, expense({ amount: '60', split: { mode: 'exact', values: { [A]: '30', [B]: '20', [C]: '10.00' } } }));
    assert.equal(r.err, null);
    assert.deepEqual(obj(r.owed), { [A]: 3000, [B]: 2000, [C]: 1000 });
    assert.deepEqual(r.edges, [[B, A, 2000], [C, A, 1000]]);
    assertSums(r);
  });

  test('by percent', () => {
    const r = computeExpense(g, expense({ amount: '99.99', split: { mode: 'percent', values: { [A]: '50', [B]: '30', [C]: '20' } } }));
    assert.deepEqual(obj(r.owed), { [A]: 4999, [B]: 3000, [C]: 2000 });
    assertSums(r);
  });

  test('by percent with thirds', () => {
    const r = computeExpense(g, expense({ amount: '100', split: { mode: 'percent', values: { [A]: '33.333', [B]: '33.333', [C]: '33.334' } } }));
    assert.equal(r.err, null);
    assert.deepEqual(obj(r.owed), { [A]: 3333, [B]: 3333, [C]: 3334 });
  });

  test('by shares', () => {
    const r = computeExpense(g, expense({ amount: '100', split: { mode: 'shares', values: { [A]: '1', [B]: '1', [C]: '2' } } }));
    assert.deepEqual(obj(r.owed), { [A]: 2500, [B]: 2500, [C]: 5000 });
    assert.equal(r.splitNote, '4 shares in total');
    assertSums(r);
  });

  test('by shares, someone with no share pays nothing', () => {
    const r = computeExpense(g, expense({ amount: '90', split: { mode: 'shares', values: { [A]: '1.5', [B]: '', [C]: '1.5' } } }));
    assert.deepEqual(obj(r.owed), { [A]: 4500, [B]: 0, [C]: 4500 });
    assert.equal(r.splitNote, '3 shares in total');
    assert.deepEqual(r.edges, [[C, A, 4500]]);
  });

  test('by items, with tax and tip shared in proportion to what each person ordered', () => {
    const bill = expense({ amount: '', split: { mode: 'items', who: [], tax: '8.5', tip: '10', items: [
      { name: 'Pizza', amount: '20.00', who: [A, B] },
      { name: 'Salad', amount: '9.99', who: [C] },
      { name: 'Wine', amount: '30', who: [A, B, C] }
    ] } });
    const r = computeExpense(g, bill);
    assert.equal(r.err, null);
    assert.equal(r.subtotal, 5999);
    assert.equal(r.extra, 1110);              // 18.5% of 59.99 = 11.09815
    assert.equal(r.total, 7109);
    assert.deepEqual(obj(r.owed), { [A]: 2370, [B]: 2370, [C]: 2369 });
    assert.deepEqual(r.edges, [[B, A, 2370], [C, A, 2369]]);
    assertSums(r);
  });

  test('by items: the amount on the bill is ignored and empty rows are skipped', () => {
    const items = [{ name: '', amount: '', who: [] }, { name: 'Taxi', amount: '10', who: [B] }, null];
    const r = computeExpense(g, expense({ amount: '999', split: { mode: 'items', who: [], items } }));
    assert.equal(r.err, null);
    assert.equal(r.total, 1000);
    assert.equal(r.extra, 0);
    assert.deepEqual(obj(r.owed), { [B]: 1000 });
  });

  test('by items: the example dinner is 156.20 EUR', () => {
    const r = computeExpense(EXAMPLE_GROUP, byId('e-3'));
    assert.equal(r.subtotal, 14200);
    assert.equal(r.extra, 1420);
    assert.equal(r.totalOrig, 15620);
    assert.deepEqual(obj(r.owedOrig), { 'p-ben': 6086, 'p-cy': 2420, 'p-ana': 3558, 'p-eli': 1650, 'p-dee': 1906 });
    assertSums(r);
  });

  test('a payment: "Ana paid Ben 50" means Ben now owes Ana 50', () => {
    const r = computeExpense(g, payment());
    assert.equal(r.err, null);
    assert.equal(r.total, 5000);
    assert.deepEqual(obj(r.paid), { [A]: 5000 });
    assert.deepEqual(obj(r.owed), { [B]: 5000 });
    assert.deepEqual(r.edges, [[B, A, 5000]]);
    assertSums(r);
  });

  test('every combination of paying and splitting adds up', () => {
    const paidSides = [
      { mode: 'single', who: [B] }, { mode: 'equal', who: [A, B, D] },
      { mode: 'exact', who: [A, D], values: { [A]: '100.10', [D]: '23.35' } },
      { mode: 'percent', who: [B, C], values: { [B]: '12.5', [C]: '87.5' } },
      { mode: 'shares', who: [A, B, C], values: { [A]: '3', [B]: '2', [C]: '2' } }
    ];
    const splitSides = [
      { mode: 'equal', who: [A, B, C, D] },
      { mode: 'exact', who: [A, B], values: { [A]: '23.45', [B]: '100' } },
      { mode: 'percent', who: [A, C, D], values: { [A]: '10', [C]: '45', [D]: '45' } },
      { mode: 'shares', who: [B, C, D], values: { [B]: '1', [C]: '1', [D]: '1' } },
      { mode: 'items', who: [], tax: '7', tip: '', items: [{ name: 'x', amount: '100', who: [A, B, C] }, { name: 'y', amount: '15.37', who: [D] }] }
    ];
    for (const paid of paidSides) for (const split of splitSides) {
      const r = computeExpense(g, expense({ amount: '123.45', paid, split }));
      assert.equal(r.err, null, `${paid.mode} / ${split.mode}: ${r.err}`);
      assert.equal(r.total, 12345);
      assertSums(r);
      // What the debts move is exactly what each person paid minus their share.
      const net = new Map(g.people.map(p => [p.id, 0]));
      for (const [d, c, v] of r.edges) {
        assert.ok(Number.isInteger(v) && v > 0 && d !== c);
        net.set(d, net.get(d) - v); net.set(c, net.get(c) + v);
      }
      assert.equal(sumMap(net), 0);
      for (const p of g.people) assert.equal(net.get(p.id), (r.paid.get(p.id) || 0) - (r.owed.get(p.id) || 0));
    }
  });

  test('does not change the group or the bill', () => {
    for (const bill of EXAMPLE_GROUP.expenses) {
      assert.ok(Object.isFrozen(bill));
      assert.equal(computeExpense(EXAMPLE_GROUP, bill).err, null);   // would throw if it tried to write
    }
  });
});

/* ---------- every error ---------- */

describe('computeExpense: problems are reported on the right field', () => {
  const g = group();
  const blocked = r => {
    assert.ok(r.err, 'has a blocking message');
    assert.equal(r.total, 0);
    assert.equal(r.paid.size, 0);
    assert.equal(r.owed.size, 0);
    assert.deepEqual(r.edges, []);
  };
  const plain = msg => {
    assert.equal(typeof msg, 'string');
    assert.match(msg, /^["A-Z]/, 'starts like a sentence');
    assert.match(msg, /\.$/, 'ends with a full stop');
    assert.doesNotMatch(msg, /[!<>]|undefined|NaN|null|edge|node|parse/i);
    assert.ok(msg.length <= 120, 'short');
  };

  test('nobody paid', () => {
    for (const paid of [{ who: [] }, { who: ['p-gone'] }, { mode: 'equal', who: [] }]) {
      const r = computeExpense(g, expense({ paid }));
      assert.equal(r.errPaid, 'Choose who paid.');
      assert.equal(r.errSplit, null);
      assert.equal(r.err, r.errPaid);
      blocked(r); plain(r.errPaid);
      assert.equal(r.totalOrig, 12000, 'the bill-currency side is still there for the preview');
      assert.deepEqual(obj(r.owedOrig), { [A]: 4000, [B]: 4000, [C]: 4000 });
    }
  });

  test('no way of paying chosen', () => {
    for (const mode of [undefined, 'items', 'weird']) {
      const r = computeExpense(g, expense({ paid: { mode } }));
      assert.equal(r.errPaid, 'Choose how it was paid.');
      blocked(r); plain(r.errPaid);
    }
    const r = computeExpense(g, { ...expense(), paid: undefined });
    assert.equal(r.errPaid, 'Choose how it was paid.');
  });

  test('amounts paid do not add up', () => {
    const under = computeExpense(g, expense({ paid: { mode: 'exact', who: [A, B], values: { [A]: '80', [B]: '30' } } }));
    assert.equal(under.errPaid, 'The amounts paid add up to 110.00 USD. The total is 120.00 USD, so 10.00 USD is left to assign.');
    blocked(under); plain(under.errPaid);
    assert.deepEqual(obj(under.paidOrig), { [A]: 8000, [B]: 3000 }, 'what is filled in so far');
    const over = computeExpense(g, expense({ paid: { mode: 'exact', who: [A, B], values: { [A]: '80', [B]: '45.50' } } }));
    assert.equal(over.errPaid, 'The amounts paid add up to 125.50 USD. The total is 120.00 USD, so that is 5.50 USD too much.');
    blocked(over); plain(over.errPaid);
  });

  test('percents paid do not make 100', () => {
    const r = computeExpense(g, expense({ paid: { mode: 'percent', who: [A, B], values: { [A]: '60', [B]: '30' } } }));
    assert.equal(r.errPaid, 'The percents add up to 90%. They need to make 100%.');
    blocked(r); plain(r.errPaid);
  });

  test('payer shares are all zero', () => {
    const r = computeExpense(g, expense({ paid: { mode: 'shares', who: [A, B], values: {} } }));
    assert.equal(r.errPaid, 'Give at least one person a share.');
    blocked(r); plain(r.errPaid);
  });

  test('no total', () => {
    for (const amount of ['', '0', '0.00', '-12', 'abc', null, undefined]) {
      const r = computeExpense(g, expense({ amount }));
      assert.equal(r.errSplit, 'Enter the total.', String(amount));
      assert.equal(r.errPaid, null);
      assert.equal(r.err, r.errSplit);
      assert.equal(r.totalOrig, 0);
      blocked(r); plain(r.errSplit);
    }
  });

  test('nobody shares it', () => {
    for (const who of [[], ['p-gone'], undefined, 'p-a']) {
      const r = computeExpense(g, { ...expense(), split: { mode: 'equal', who, values: {}, items: [], tax: '', tip: '' } });
      assert.equal(r.errSplit, 'Choose who shares it.');
      blocked(r); plain(r.errSplit);
    }
  });

  test('no way of splitting chosen', () => {
    for (const mode of [undefined, 'single', 'weird']) {
      const r = computeExpense(g, expense({ split: { mode } }));
      assert.equal(r.errSplit, 'Choose how to split it.');
      blocked(r); plain(r.errSplit);
    }
    assert.equal(computeExpense(g, { ...expense(), split: undefined }).errSplit, 'Choose how to split it.');
  });

  test('set amounts do not add up', () => {
    const under = computeExpense(g, expense({ split: { mode: 'exact', values: { [A]: '30', [B]: '20', [C]: '10' } } }));
    assert.equal(under.errSplit, 'The amounts add up to 60.00 USD. The total is 120.00 USD, so 60.00 USD is left to assign.');
    blocked(under); plain(under.errSplit);
    assert.deepEqual(obj(under.owedOrig), { [A]: 3000, [B]: 2000, [C]: 1000 });
    const over = computeExpense(g, expense({ split: { mode: 'exact', values: { [A]: '100', [B]: '20.01', [C]: '' } } }));
    assert.equal(over.errSplit, 'The amounts add up to 120.01 USD. The total is 120.00 USD, so that is 0.01 USD too much.');
    blocked(over); plain(over.errSplit);
    const yen = computeExpense(g, expense({ amount: '1000', currency: 'JPY', split: { mode: 'exact', who: [A, B], values: { [A]: '400', [B]: '500' } } }));
    assert.equal(yen.errSplit, 'The amounts add up to 900 JPY. The total is 1000 JPY, so 100 JPY is left to assign.');
  });

  test('percents do not make 100', () => {
    const r = computeExpense(g, expense({ split: { mode: 'percent', values: { [A]: '50', [B]: '30', [C]: '30.5' } } }));
    assert.equal(r.errSplit, 'The percents add up to 110.5%. They need to make 100%.');
    blocked(r); plain(r.errSplit);
    assert.equal(computeExpense(g, expense({ split: { mode: 'percent', values: {} } })).errSplit, 'The percents add up to 0%. They need to make 100%.');
  });

  test('shares are all zero', () => {
    const r = computeExpense(g, expense({ split: { mode: 'shares', values: { [A]: '0', [B]: '', [C]: '-2' } } }));
    assert.equal(r.errSplit, 'Give at least one person a share.');
    blocked(r); plain(r.errSplit);
  });

  test('items: nothing listed', () => {
    for (const items of [[], undefined, [{ name: '', amount: '', who: [] }]]) {
      const r = computeExpense(g, expense({ split: { mode: 'items', who: [], items } }));
      assert.equal(r.errSplit, 'Add at least one item.');
      assert.equal(r.errPaid, null);
      blocked(r); plain(r.errSplit);
    }
  });

  test('items: a row without a price or without people', () => {
    const noPrice = computeExpense(g, expense({ split: { mode: 'items', items: [{ name: 'Pizza', amount: '20', who: [A] }, { name: 'Wine', amount: '', who: [B] }] } }));
    assert.equal(noPrice.errSplit, 'Item 2 needs a price.');
    blocked(noPrice); plain(noPrice.errSplit);
    const noPeople = computeExpense(g, expense({ split: { mode: 'items', items: [{ name: 'Wine', amount: '30', who: [] }] } }));
    assert.equal(noPeople.errSplit, '"Wine" needs at least one person.');
    blocked(noPeople); plain(noPeople.errSplit);
    const unnamed = computeExpense(g, expense({ split: { mode: 'items', items: [{ name: 'Pizza', amount: '20', who: [A] }, { name: '', amount: '30', who: ['p-gone'] }] } }));
    assert.equal(unnamed.errSplit, '"Item 2" needs at least one person.');
    plain(unnamed.errSplit);
  });

  test('a problem with the split is reported before a problem with who paid', () => {
    const r = computeExpense(g, expense({ paid: { who: [] }, split: { who: [] } }));
    assert.equal(r.errSplit, 'Choose who shares it.');
    assert.equal(r.errPaid, 'Choose who paid.');
    assert.equal(r.err, r.errSplit);
  });

  test('no name: reported on errTitle, but the math still works', () => {
    for (const title of ['', '   ', null, undefined]) {
      const r = computeExpense(g, expense({ title }));
      assert.equal(r.errTitle, 'Give the bill a name.');
      assert.equal(r.err, null, 'a missing name does not block the math');
      assert.equal(r.total, 12000);
      assert.equal(r.edges.length, 2);
      plain(r.errTitle);
    }
    assert.equal(computeExpense(g, expense()).errTitle, null);
    assert.equal(computeExpense(g, payment({ title: '' })).errTitle, null, 'payments do not need a name');
  });

  test('no exchange rate', () => {
    const r = computeExpense(g, expense({ currency: 'XYZ' }));
    assert.equal(r.errFx, 'No exchange rate for XYZ to USD. Type one under GROUP.');
    assert.equal(r.err, r.errFx);
    assert.equal(r.errSplit, null);
    assert.equal(r.errPaid, null);
    assert.equal(r.rate, null);
    blocked(r); plain(r.errFx);
    assert.equal(r.totalOrig, 12000);
    const pay = computeExpense(g, payment({ currency: 'XYZ' }));
    assert.equal(pay.errFx, 'No exchange rate for XYZ to USD. Type one under GROUP.');
    blocked(pay);
    // Typing a rate for the group fixes it.
    const fixed = computeExpense(group({ rates: { XYZ: { rate: '2', base: 'USD' } } }), expense({ currency: 'XYZ' }));
    assert.equal(fixed.err, null);
    assert.equal(fixed.total, 24000);
  });

  test('payments: who and how much', () => {
    for (const over of [{ from: 'p-gone' }, { to: 'p-gone' }, { from: undefined }, { to: undefined }]) {
      const r = computeExpense(g, payment(over));
      assert.equal(r.errPaid, 'Choose who paid whom.');
      assert.equal(r.err, r.errPaid);
      blocked(r); plain(r.errPaid);
    }
    const same = computeExpense(g, payment({ to: A }));
    assert.equal(same.errPaid, 'Pick two different people.');
    blocked(same); plain(same.errPaid);
    for (const amount of ['', '0', '-5', 'abc']) {
      const r = computeExpense(g, payment({ amount }));
      assert.equal(r.errSplit, 'Enter an amount.');
      assert.equal(r.errPaid, null);
      assert.equal(r.err, r.errSplit);
      blocked(r); plain(r.errSplit);
    }
  });

  test('absurdly large numbers are refused, quickly, instead of giving a wrong answer', { timeout: 5000 }, () => {
    const big = '9'.repeat(300);
    const cases = [
      [expense({ amount: big }), 'errSplit', 'That amount is too large.'],
      [expense({ amount: '100000000000000' }), 'errSplit', 'That amount is too large.'],
      [payment({ amount: big }), 'errSplit', 'That amount is too large.'],
      [expense({ split: { mode: 'items', items: [{ name: 'x', amount: big, who: [A] }] } }), 'errSplit', 'That amount is too large.'],
      [expense({ split: { mode: 'items', tip: big, items: [{ name: 'x', amount: '10', who: [A, B] }] } }), 'errSplit', 'That amount is too large.'],
      [expense({ split: { mode: 'shares', values: { [A]: big, [B]: big, [C]: '1' } } }), 'errSplit', 'Use smaller numbers for the shares.'],
      [expense({ paid: { mode: 'shares', who: [A, B], values: { [A]: big, [B]: '1' } } }), 'errPaid', 'Use smaller numbers for the shares.'],
      [expense({ currency: 'EUR', fx: { rate: big, base: 'USD' } }), 'errFx', 'That amount is too large.']
    ];
    for (const [bill, field, message] of cases) {
      const r = computeExpense(g, bill);
      assert.equal(r[field], message);
      assert.equal(r.err, message);
      blocked(r); plain(message);
    }
    // The largest amount that is accepted still adds up exactly.
    const ok = computeExpense(g, expense({ amount: '100000000000.00', split: { who: [A, B, C] } }));
    assert.equal(ok.err, null);
    assert.equal(ok.total, 1e13);
    assertSums(ok);
  });
});

/* ---------- conversion ---------- */

describe('conversion to the group\'s currency', () => {
  const eurToUsd = 1 / 0.888786;

  test('the example bills convert as published', () => {
    const want = { 'e-1': [78000, 87760], 'e-2': [21000, 23628], 'e-3': [15620, 17575], 'e-5': [7800, 8776] };
    for (const [id, [orig, total]] of Object.entries(want)) {
      const r = computeExpense(EXAMPLE_GROUP, byId(id));
      assert.equal(r.err, null);
      assert.equal(r.cur, 'EUR');
      assert.equal(r.totalOrig, orig, id);
      assert.equal(r.total, total, id);
      assert.equal(r.rate, eurToUsd);
      assert.equal(r.rateSource, 'builtin');
      assert.equal(r.rateDate, BUILTIN_RATES.date);
      assertSums(r);
    }
  });

  test('paid and owed are shared out again from the original amounts', () => {
    const apartment = computeExpense(EXAMPLE_GROUP, byId('e-1'));
    assert.deepEqual(obj(apartment.paidOrig), { 'p-ana': 52000, 'p-ben': 26000 });
    assert.deepEqual(obj(apartment.paid), { 'p-ana': 58507, 'p-ben': 29253 });
    assert.deepEqual(obj(apartment.owed), { 'p-ana': 17552, 'p-ben': 17552, 'p-cy': 17552, 'p-dee': 17552, 'p-eli': 17552 });
    const groceries = computeExpense(EXAMPLE_GROUP, byId('e-2'));
    assert.deepEqual(obj(groceries.owedOrig), { 'p-ana': 4200, 'p-ben': 4200, 'p-cy': 4200, 'p-dee': 8400 });
    assert.deepEqual(obj(groceries.owed), { 'p-ana': 4726, 'p-ben': 4726, 'p-cy': 4725, 'p-dee': 9451 });
    const dinner = computeExpense(EXAMPLE_GROUP, byId('e-3'));
    assert.deepEqual(obj(dinner.owed), { 'p-ben': 6848, 'p-cy': 2723, 'p-ana': 4003, 'p-eli': 1856, 'p-dee': 2145 });
    const train = computeExpense(EXAMPLE_GROUP, byId('e-5'));
    assert.deepEqual(obj(train.paid), { 'p-ben': 4388, 'p-cy': 4388 });
    assert.deepEqual(obj(train.owed), { 'p-ana': 2926, 'p-ben': 2925, 'p-cy': 2925 });
  });

  test('a bill in the group\'s own currency is not converted', () => {
    const r = computeExpense(EXAMPLE_GROUP, byId('e-4'));
    assert.equal(r.total, 48000);
    assert.equal(r.totalOrig, 48000);
    assert.equal(r.rate, 1);
    assert.equal(r.rateSource, 'same');
    assert.equal(r.rateDate, undefined);
    assert.deepEqual(obj(r.paid), obj(r.paidOrig));
    assert.deepEqual(obj(r.owed), obj(r.owedOrig));
    // No currency on the bill means the group's currency.
    const bare = computeExpense(group({ currency: 'EUR' }), expense({ currency: undefined }));
    assert.equal(bare.cur, 'EUR');
    assert.equal(bare.rateSource, 'same');
  });

  test('a payment in another currency', () => {
    const r = computeExpense(group(), payment({ amount: '50', currency: 'EUR' }));
    assert.equal(r.totalOrig, 5000);
    assert.equal(r.total, 5626);                  // 50 / 0.888786 = 56.2565...
    assert.deepEqual(r.edges, [[B, A, 5626]]);
    assertSums(r);
  });

  test('half a cent rounds up, exactly as on paper', () => {
    const at = (amount, rate, currency = 'EUR', base = 'USD') =>
      computeExpense(group({ currency: base }), expense({ amount, currency, fx: { rate, base } })).total;
    assert.equal(at('3675', '0.609', 'CZK'), 223808);     // 2238.075
    assert.equal(at('33.30', '1.25'), 4163);              // 41.625
    assert.equal(at('1299', '7.585'), 985292);            // 9852.915
    assert.equal(at('2425', '3.881'), 941143);            // 9411.425
    assert.equal(at('0.01', '0.5'), 1);                   // 0.005
    assert.equal(at('0.01', '0.4999'), 0);
    assert.equal(at('1', '0.005', 'USD', 'JPY'), 0);      // 0.005 yen
    assert.equal(at('100', '0.005', 'USD', 'JPY'), 1);    // 0.5 yen
    assert.equal(at('7', '0.5', 'JPY', 'KRW'), 4);        // 3.5 won
    assert.equal(at('5', '0.001', 'JPY', 'USD'), 1);      // 0.005 dollars
  });

  test('with a typed rate the total is the exact product, rounded half up', () => {
    const rnd = rng(21);
    const codes = ['EUR', 'USD', 'JPY', 'KRW', 'GBP', 'VND', 'CHF'];
    let halves = 0;
    for (let n = 0; n < 4000; n++) {
      const base = pick(rnd, codes), cur = pick(rnd, codes.filter(c => c !== base));
      const decimals = int(rnd, 0, 5), mantissa = int(rnd, 1, 40000), minor = int(rnd, 1, 2000000);
      const rate = (mantissa / 10 ** decimals).toFixed(decimals);
      const g = group({ currency: base, rates: { [cur]: { rate, base } } });
      const r = computeExpense(g, expense({ amount: fromMinor(minor, cur), currency: cur }));
      // minor / 10^dCur * mantissa / 10^decimals * 10^dBase, in whole numbers
      const top = BigInt(minor) * BigInt(mantissa) * 10n ** BigInt(minorDigits(base));
      const bottom = 10n ** BigInt(decimals + minorDigits(cur));
      if ((top * 2n) % bottom === 0n && top % bottom !== 0n) halves++;
      assert.equal(r.err, null);
      assert.equal(r.totalOrig, minor);
      assert.equal(r.total, Number((top + bottom / 2n) / bottom), `${fromMinor(minor, cur)} ${cur} at ${rate} to ${base}`);
      assert.equal(r.rateSource, 'manual');
      assertSums(r);
    }
    assert.ok(halves > 20, 'the run included exact halves');
  });

  test('random bills in any currency keep exact sums after conversion', () => {
    const rnd = rng(22);
    const g0 = group();
    const ids = g0.people.map(p => p.id);
    const some = () => { const w = ids.filter(() => rnd() < 0.6); return w.length ? w : [pick(rnd, ids)]; };
    for (let n = 0; n < 3000; n++) {
      const base = pick(rnd, CURRENCIES), cur = pick(rnd, CURRENCIES);
      const g = { ...g0, currency: base };
      const minor = int(rnd, 1, 5000000);
      const paidWho = some(), splitWho = some();
      const paid = pick(rnd, [
        { mode: 'single', who: paidWho, values: {} }, { mode: 'equal', who: paidWho, values: {} },
        { mode: 'shares', who: paidWho, values: Object.fromEntries(paidWho.map(id => [id, String(int(rnd, 1, 5))])) }
      ]);
      const split = pick(rnd, [
        { mode: 'equal', who: splitWho }, { mode: 'shares', who: splitWho, values: Object.fromEntries(splitWho.map(id => [id, String(int(rnd, 1, 9) / 2)])) },
        { mode: 'items', who: [], tax: String(int(rnd, 0, 20)), tip: String(int(rnd, 0, 20)), items: [
          { name: 'one', amount: fromMinor(minor, cur), who: splitWho }, { name: 'two', amount: fromMinor(int(rnd, 1, 9000), cur), who: some() }] }
      ]);
      const r = computeExpense(g, expense({ amount: fromMinor(minor, cur), currency: cur, paid, split }));
      assert.equal(r.err, null);
      assertSums(r);
      const rate = BUILTIN_RATES.usd[base] / BUILTIN_RATES.usd[cur];
      if (cur !== base) assert.equal(r.rate, rate);
      const float = r.totalOrig / 10 ** minorDigits(cur) * rate * 10 ** minorDigits(base);
      assert.ok(Math.abs(r.total - float) <= 0.5 + 1e-6 * Math.max(1, float), `${cur} to ${base}: ${r.total} against ${float}`);
      // Debts never move more than was owed, and each debtor's debts stay within their share.
      for (const id of ids) {
        const debts = r.edges.filter(e => e[0] === id).reduce((s, e) => s + e[2], 0);
        assert.ok(debts <= (r.owed.get(id) || 0));
      }
    }
  });
});

/* ---------- currencies without decimals ---------- */

describe('currencies without decimals', () => {
  test('1000 yen split three ways is 334, 333, 333 yen', () => {
    const r = computeExpense(group({ currency: 'JPY' }), expense({ amount: '1000', currency: 'JPY' }));
    assert.equal(r.err, null);
    assert.equal(r.total, 1000);
    assert.deepEqual(obj(r.owed), { [A]: 334, [B]: 333, [C]: 333 });
    assert.deepEqual(r.edges, [[B, A, 333], [C, A, 333]]);
    assertSums(r);
  });

  test('yen amounts are whole yen in every mode', () => {
    const g = group({ currency: 'JPY' });
    const exact = computeExpense(g, expense({ amount: '1000', currency: 'JPY', split: { mode: 'exact', who: [A, B], values: { [A]: '600', [B]: '400' } } }));
    assert.deepEqual(obj(exact.owed), { [A]: 600, [B]: 400 });
    const items = computeExpense(g, expense({ amount: '', currency: 'JPY', split: { mode: 'items', tip: '10', items: [
      { name: 'Ramen', amount: '950', who: [A] }, { name: 'Gyoza', amount: '500', who: [A, B, C] }] } }));
    assert.equal(items.subtotal, 1450);
    assert.equal(items.extra, 145);
    assert.equal(items.total, 1595);
    // Gyoza: 167, 167, 166. Tip of 145 on 1117, 167, 166: 112, 17, 16.
    assert.deepEqual(obj(items.owed), { [A]: 1229, [B]: 184, [C]: 182 });
    assertSums(items);
    const pay = computeExpense(g, payment({ amount: '2500', currency: 'JPY' }));
    assert.deepEqual(pay.edges, [[B, A, 2500]]);
  });

  test('yen to dollars keeps exact sums', () => {
    const r = computeExpense(group({ currency: 'USD' }), expense({ amount: '1000', currency: 'JPY' }));
    assert.equal(r.err, null);
    assert.equal(r.totalOrig, 1000);
    assert.deepEqual(obj(r.owedOrig), { [A]: 334, [B]: 333, [C]: 333 });
    assert.equal(r.rate, 1 / 157.820352);
    assert.equal(r.total, 634);                 // 1000 / 157.820352 = 6.3363...
    assert.deepEqual(obj(r.owed), { [A]: 212, [B]: 211, [C]: 211 });
    assert.deepEqual(obj(r.paid), { [A]: 634 });
    assert.deepEqual(r.edges, [[B, A, 211], [C, A, 211]]);
    assertSums(r);
  });

  test('dollars to yen keeps exact sums', () => {
    const r = computeExpense(group({ currency: 'JPY' }), expense({ amount: '10.00', currency: 'USD' }));
    assert.equal(r.err, null);
    assert.equal(r.totalOrig, 1000);
    assert.equal(r.rate, 157.820352);
    assert.equal(r.total, 1578);                // 10 x 157.820352 = 1578.2
    assert.deepEqual(obj(r.owed), { [A]: 527, [B]: 526, [C]: 525 });
    assertSums(r);
  });

  test('won to dong, neither has decimals', () => {
    const r = computeExpense(group({ currency: 'VND' }), expense({ amount: '10000', currency: 'KRW' }));
    assert.equal(r.total, Math.round(10000 * 25939.856369 / 1348.606131));
    assertSums(r);
  });

  test('an amount too small to be one unit of the group\'s currency leaves no debt', () => {
    const r = computeExpense(group({ currency: 'USD' }), expense({ amount: '1', currency: 'VND' }));
    assert.equal(r.err, null);
    assert.equal(r.totalOrig, 1);
    assert.equal(r.total, 0);
    assert.deepEqual(r.edges, []);
    const pay = computeExpense(group({ currency: 'USD' }), payment({ amount: '1', currency: 'VND' }));
    assert.equal(pay.err, null);
    assert.deepEqual(pay.edges, []);
  });
});

/* ---------- which rate is used ---------- */

describe('exchange rates', () => {
  const builtinEur = 1 / 0.888786;

  test('same currency', () => {
    assert.deepEqual(rateFor(group(), 'USD'), { rate: 1, source: 'same' });
    assert.deepEqual(billRate(group(), { currency: 'USD' }), { rate: 1, source: 'same' });
    assert.deepEqual(billRate(group({ currency: 'EUR' }), {}), { rate: 1, source: 'same' });
    assert.deepEqual(billRate(group(), { currency: 'USD', fx: { rate: '3', base: 'USD' } }), { rate: 1, source: 'same' }, 'a fixed rate means nothing here');
  });

  test('built-in table', () => {
    assert.deepEqual(rateFor(group(), 'EUR'), { rate: builtinEur, source: 'builtin', date: BUILTIN_RATES.date });
    assert.deepEqual(rateFor(group({ currency: 'EUR' }), 'USD'), { rate: 0.888786, source: 'builtin', date: BUILTIN_RATES.date });
    assert.deepEqual(rateFor(group({ currency: 'GBP' }), 'JPY'), { rate: 0.756408 / 157.820352, source: 'builtin', date: BUILTIN_RATES.date });
    assert.deepEqual(tableRate(group(), 'EUR'), rateFor(group(), 'EUR'));
  });

  test('unknown currency', () => {
    assert.equal(rateFor(group(), 'XYZ'), null);
    assert.equal(rateFor(group({ currency: 'XYZ' }), 'EUR'), null);
    assert.equal(tableRate(group(), 'constructor'), null);
    assert.deepEqual(billRate(group(), { currency: 'XYZ' }), { rate: null });
  });

  test('the pinned table beats the built-in one', () => {
    const g = group({ fx: { date: '2026-11-20', usd: { USD: 1, EUR: 0.8 } } });
    assert.deepEqual(rateFor(g, 'EUR'), { rate: 1.25, source: 'pinned', date: '2026-11-20' });
    assert.deepEqual(rateFor(g, 'GBP'), { rate: 1 / 0.756408, source: 'builtin', date: BUILTIN_RATES.date }, 'not pinned: built-in');
    const between = group({ currency: 'EUR', fx: { date: '2026-11-20', usd: { EUR: 0.8, GBP: 0.4 } } });
    assert.deepEqual(rateFor(between, 'GBP'), { rate: 2, source: 'pinned', date: '2026-11-20' });
    assert.deepEqual(rateFor(between, 'USD'), { rate: 0.8, source: 'pinned', date: '2026-11-20' }, 'USD is 1 in any table');
  });

  test('a pinned table with unusable numbers is skipped', () => {
    for (const usd of [{ EUR: 0 }, { EUR: -1 }, { EUR: '0.8' }, { EUR: NaN }, { EUR: Infinity }, null, 'x']) {
      assert.equal(rateFor(group({ fx: { date: '2026-11-20', usd } }), 'EUR').source, 'builtin');
    }
    assert.equal(rateFor(group({ fx: null }), 'EUR').source, 'builtin');
  });

  test('a rate typed for the group beats the pinned table', () => {
    const g = group({ rates: { EUR: { rate: '1.2', base: 'USD' } }, fx: { date: '2026-11-20', usd: { EUR: 0.8 } } });
    assert.deepEqual(rateFor(g, 'EUR'), { rate: 1.2, source: 'manual' });
    assert.deepEqual(tableRate(g, 'EUR'), { rate: 1.25, source: 'pinned', date: '2026-11-20' }, 'tableRate ignores typed rates');
  });

  test('a typed rate only counts for the currency it was typed against', () => {
    assert.equal(rateFor(group({ rates: { EUR: { rate: '1.2', base: 'GBP' } } }), 'EUR').source, 'builtin');
    for (const rate of ['', '0', '-1', 'abc', null]) assert.equal(rateFor(group({ rates: { EUR: { rate, base: 'USD' } } }), 'EUR').source, 'builtin');
  });

  test('order: fixed on the bill, then typed for the group, then pinned, then built-in', () => {
    const bill = expense({ amount: '100', currency: 'EUR', fx: { rate: '1.5', base: 'USD' } });
    const g = group({ rates: { EUR: { rate: '1.2', base: 'USD' } }, fx: { date: '2026-11-20', usd: { EUR: 0.8 } } });

    assert.deepEqual(billRate(g, bill), { rate: 1.5, source: 'fixed' });
    let r = computeExpense(g, bill);
    assert.deepEqual([r.total, r.rate, r.rateSource, r.rateDate], [15000, 1.5, 'fixed', undefined]);

    delete bill.fx;
    assert.deepEqual(billRate(g, bill), { rate: 1.2, source: 'manual' });
    r = computeExpense(g, bill);
    assert.deepEqual([r.total, r.rate, r.rateSource, r.rateDate], [12000, 1.2, 'manual', undefined]);

    g.rates = {};
    assert.deepEqual(billRate(g, bill), { rate: 1.25, source: 'pinned', date: '2026-11-20' });
    r = computeExpense(g, bill);
    assert.deepEqual([r.total, r.rate, r.rateSource, r.rateDate], [12500, 1.25, 'pinned', '2026-11-20']);

    delete g.fx;
    assert.deepEqual(billRate(g, bill), { rate: builtinEur, source: 'builtin', date: BUILTIN_RATES.date });
    r = computeExpense(g, bill);
    assert.deepEqual([r.total, r.rate, r.rateSource, r.rateDate], [11251, builtinEur, 'builtin', BUILTIN_RATES.date]);
    assertSums(r);
  });

  test('a rate fixed against another currency is carried over to the group\'s currency', () => {
    // The bill says 1 EUR = 0.85 GBP; the group settles in USD.
    const bill = { currency: 'EUR', fx: { rate: '0.85', base: 'GBP' } };
    assert.deepEqual(billRate(group(), bill), { rate: 0.85 * (1 / 0.756408), source: 'fixed' });
    const typed = group({ rates: { GBP: { rate: '1.3', base: 'USD' } } });
    assert.deepEqual(billRate(typed, bill), { rate: 0.85 * 1.3, source: 'fixed' });
    assert.deepEqual(billRate(group(), { currency: 'EUR', fx: { rate: '1.1' } }), { rate: 1.1, source: 'fixed' }, 'no base means the group\'s currency');
  });

  test('a fixed rate that cannot be used falls back to the next one', () => {
    for (const fx of [{ rate: '', base: 'USD' }, { rate: '0', base: 'USD' }, { rate: 'abc', base: 'USD' }, { rate: '0.85', base: 'XYZ' }, null]) {
      assert.equal(billRate(group(), { currency: 'EUR', fx }).source, 'builtin');
    }
  });

  test('fmtRate', () => {
    // Six significant digits and at least four decimals, so 780 x 1.12513 can be checked by hand.
    assert.equal(fmtRate(157.820352), '157.8204');
    assert.equal(fmtRate(16500.123456), '16500.1235');
    assert.equal(fmtRate(100), '100.0000');
    assert.equal(fmtRate(1.12513023), '1.12513');
    assert.equal(fmtRate(1.5), '1.5000');
    assert.equal(fmtRate(1), '1.0000');
    assert.equal(fmtRate(0.888786), '0.888786');
    assert.equal(fmtRate(0.0063363184), '0.00633632');
    assert.equal(fmtRate(0.5), '0.5000');
  });

  test('fmtDate', () => {
    assert.equal(fmtDate('2026-10-04', 'en-GB'), '4 Oct 2026');
    assert.equal(fmtDate('2026-10-04', 'en-US'), 'Oct 4, 2026');
    assert.equal(fmtDate('2026-01-01', 'en-GB'), '1 Jan 2026', 'not shifted by the time zone');
    assert.equal(fmtDate('2026-12-31', 'en-GB'), '31 Dec 2026');
    assert.equal(fmtDate('soon'), 'soon');
    assert.equal(fmtDate(undefined), '');
    assert.equal(fmtDate('2026-10-04', 'not a locale'), '2026-10-04');
  });

  test('fxNote says the rate and where it comes from', () => {
    const bill = expense({ amount: '100', currency: 'EUR', fx: { rate: '1.5', base: 'USD' } });
    const g = group({ rates: { EUR: { rate: '1.2', base: 'USD' } }, fx: { date: '2026-11-20', usd: { EUR: 0.8 } } });
    assert.equal(fxNote(g, computeExpense(g, bill), 'en-GB'), '1 EUR = 1.5000 USD, rate set for this bill');
    delete bill.fx;
    assert.equal(fxNote(g, computeExpense(g, bill), 'en-GB'), '1 EUR = 1.2000 USD, rate typed for this group');
    g.rates = {};
    assert.equal(fxNote(g, computeExpense(g, bill), 'en-GB'), '1 EUR = 1.2500 USD, rate from 20 Nov 2026');
    delete g.fx;
    assert.equal(fxNote(g, computeExpense(g, bill), 'en-GB'), '1 EUR = 1.12513 USD, built-in rate from 4 Oct 2026');
    assert.equal(fxNote(g, computeExpense(g, expense()), 'en-GB'), '', 'nothing to say when nothing was converted');
    assert.equal(fxNote(g, computeExpense(g, expense({ currency: 'XYZ' })), 'en-GB'), '', 'nor when there is no rate');
    const yen = group({ currency: 'JPY' });
    assert.equal(fxNote(yen, computeExpense(yen, expense({ currency: 'USD' })), 'en-GB'), '1 USD = 157.8204 JPY, built-in rate from 4 Oct 2026');
  });
});

/* ---------- group totals and the example ---------- */

describe('personTotals, usedCurrencies and the example group', () => {
  test('the example group is frozen, complete and has the expected ids', () => {
    const isDeepFrozen = o => Object.isFrozen(o) && Object.values(o).every(v => !v || typeof v !== 'object' || isDeepFrozen(v));
    assert.ok(isDeepFrozen(EXAMPLE_GROUP));
    assert.equal(EXAMPLE_GROUP.id, 'g-lisbon');
    assert.equal(EXAMPLE_GROUP.name, 'Lisbon trip (example)');
    assert.equal(EXAMPLE_GROUP.currency, 'USD');
    assert.equal(EXAMPLE_GROUP.example, true);
    assert.equal(EXAMPLE_GROUP.fx, undefined);
    assert.deepEqual(obj(Object.entries(EXAMPLE_GROUP.rates)), {});
    assert.deepEqual(EXAMPLE_GROUP.people.map(p => [p.id, p.name]), [['p-ana', 'Ana'], ['p-ben', 'Ben'], ['p-cy', 'Cy'], ['p-dee', 'Dee'], ['p-eli', 'Eli']]);
    assert.deepEqual(EXAMPLE_GROUP.expenses.map(e => e.id), ['e-1', 'e-2', 'e-3', 'e-4', 'e-5', 'e-6']);
    assert.deepEqual(EXAMPLE_GROUP.expenses.map(e => e.kind), ['expense', 'expense', 'expense', 'expense', 'expense', 'payment']);
    assert.deepEqual(EXAMPLE_GROUP.expenses.map(e => e.currency), ['EUR', 'EUR', 'EUR', 'USD', 'EUR', 'USD']);
    for (const x of [EXAMPLE_GROUP, ...EXAMPLE_GROUP.people, ...EXAMPLE_GROUP.expenses]) assert.match(x.id, /^[a-z]-[a-z0-9]{1,12}$/);
    const copy = structuredClone(EXAMPLE_GROUP);
    copy.expenses[0].split.who.pop();
    copy.name = 'Mine';
    assert.equal(EXAMPLE_GROUP.expenses[0].split.who.length, 5, 'a copy can be changed without touching the original');
  });

  test('every example bill is valid', () => {
    const totals = EXAMPLE_GROUP.expenses.map(bill => {
      const r = computeExpense(EXAMPLE_GROUP, bill);
      assert.equal(r.err, null);
      assert.equal(r.errTitle, null);
      assertSums(r);
      return r.total;
    });
    assert.deepEqual(totals, [87760, 23628, 17575, 48000, 8776, 5000]);
  });

  test('personTotals for the example group', () => {
    const t = personTotals(EXAMPLE_GROUP);
    assert.deepEqual([...t.keys()], ['p-ana', 'p-ben', 'p-cy', 'p-dee', 'p-eli']);
    assert.deepEqual(obj(t), {
      'p-ana': { paid: 58507, share: 46207 },   // paid most of the apartment; her share includes the 50.00 Cy sent her
      'p-ben': { paid: 33641, share: 44051 },
      'p-cy': { paid: 33016, share: 39925 },    // paid includes the 50.00 sent to Ana
      'p-dee': { paid: 17575, share: 41148 },
      'p-eli': { paid: 48000, share: 19408 }
    });
    const all = [...t.values()];
    assert.equal(all.reduce((s, x) => s + x.paid, 0), 190739);
    assert.equal(all.reduce((s, x) => s + x.share, 0), 190739, 'everything paid is somebody\'s share');
  });

  test('the debts of the example add up to the balances the settle-up plan must clear', () => {
    const net = new Map(EXAMPLE_GROUP.people.map(p => [p.id, 0]));
    for (const bill of EXAMPLE_GROUP.expenses) {
      for (const [debtor, creditor, v] of computeExpense(EXAMPLE_GROUP, bill).edges) {
        net.set(debtor, net.get(debtor) - v);
        net.set(creditor, net.get(creditor) + v);
      }
    }
    // The plan: Ben→Eli 104.10, Cy→Eli 69.09, Dee→Ana 123.00, Dee→Eli 112.73.
    assert.deepEqual(obj(net), { 'p-ana': 12300, 'p-ben': -10410, 'p-cy': -6909, 'p-dee': -12300 - 11273, 'p-eli': 10410 + 6909 + 11273 });
    // And that is, for every person, exactly what they paid minus their share.
    const totals = personTotals(EXAMPLE_GROUP);
    for (const [id, x] of totals) assert.equal(net.get(id), x.paid - x.share, id);
  });

  test('personTotals leaves out bills with a problem and people on no bill', () => {
    const g = group({ expenses: [
      expense({ id: 'e-ok' }),
      expense({ id: 'e-nopayer', paid: { who: [] } }),
      expense({ id: 'e-norate', currency: 'XYZ' }),
      payment({ id: 'e-bad', to: A }),
      payment({ id: 'e-pay', amount: '10', from: C, to: A })
    ] });
    assert.deepEqual(obj(personTotals(g)), {
      [A]: { paid: 12000, share: 5000 }, [B]: { paid: 0, share: 4000 }, [C]: { paid: 1000, share: 4000 }, [D]: { paid: 0, share: 0 }
    });
    assert.deepEqual(obj(personTotals(group())), { [A]: { paid: 0, share: 0 }, [B]: { paid: 0, share: 0 }, [C]: { paid: 0, share: 0 }, [D]: { paid: 0, share: 0 } });
  });

  test('personTotals balances for random groups', () => {
    const rnd = rng(31);
    for (let n = 0; n < 200; n++) {
      const g = group({ currency: pick(rnd, ['USD', 'EUR', 'JPY']) });
      const ids = g.people.map(p => p.id);
      let expected = 0;
      for (let k = 0; k < int(rnd, 1, 8); k++) {
        const cur = pick(rnd, ['USD', 'EUR', 'JPY', 'GBP', 'KRW']);
        const bill = rnd() < 0.2
          ? payment({ amount: fromMinor(int(rnd, 1, 90000), cur), currency: cur, from: ids[0], to: pick(rnd, ids.slice(1)) })
          : expense({ amount: fromMinor(int(rnd, 0, 90000), cur), currency: cur, paid: { mode: 'equal', who: ids.filter(() => rnd() < 0.5) }, split: { who: ids.filter(() => rnd() < 0.7) } });
        g.expenses.push(bill);
        const r = computeExpense(g, bill);
        if (!r.err) expected += r.total;
      }
      const all = [...personTotals(g).values()];
      assert.equal(all.reduce((s, x) => s + x.paid, 0), expected);
      assert.equal(all.reduce((s, x) => s + x.share, 0), expected);
    }
  });

  test('usedCurrencies lists the other currencies on the bills, first seen first', () => {
    assert.deepEqual(usedCurrencies(EXAMPLE_GROUP), ['EUR']);
    assert.deepEqual(usedCurrencies(group()), []);
    const g = group({ currency: 'EUR', rates: { CHF: { rate: '1.05', base: 'EUR' } }, expenses: [
      expense({ currency: 'JPY' }), expense({ currency: 'EUR' }), payment({ currency: 'USD' }), expense({ currency: 'JPY' }), expense({ currency: undefined })
    ] });
    assert.deepEqual(usedCurrencies(g), ['JPY', 'USD']);
  });
});
