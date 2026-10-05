/* Tests for docs/js/simplify.js: worked examples small enough to check by hand, the invariants of SPEC §5 on
   hundreds of random groups, and a step-by-step comparison with the earlier single-file app. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BUILTIN_RATES, CURRENCIES, EXAMPLE_GROUP, computeExpense, fromMinor, minorDigits, personTotals } from '../docs/js/core.js';
import { PHASES, buildSteps, edgeKey, edgesOf, balancesOf, edgeBreakdown, personBreakdown, finalPayments } from '../docs/js/simplify.js';
import { legacyAvailable, legacyPath, loadLegacy, toPlain } from './legacy-harness.mjs';

const MODES = ['fewest', 'keep'];
const US = 'en-US';

/* ---------- small hand-made groups ---------- */

const pid = name => 'p-' + name.toLowerCase();

// People by name (Ana gets the id 'p-ana'); bills get the ids e-1, e-2, ...
function tiny(names, bills) {
  return { id: 'g-tiny', name: 'Tiny', currency: 'USD', rev: 0, rates: {},
    people: names.map(name => ({ id: pid(name), name })),
    expenses: bills.map((bill, i) => ({ id: 'e-' + (i + 1), ...bill })) };
}

// "debtor owes creditor": the creditor paid a bill that only the debtor shares.
const owes = (debtor, creditor, amount) => ({ kind: 'expense', title: debtor + ' owes ' + creditor, amount: String(amount), currency: 'USD',
  paid: { mode: 'single', who: [pid(creditor)], values: {} },
  split: { mode: 'equal', who: [pid(debtor)], values: {}, items: [], tax: '', tip: '' } });

const graphOf = step => Object.fromEntries(step.g);
const phasesOf = steps => steps.map(s => s.phase);
const titlesOf = steps => steps.map(s => s.title);
const plainText = html => html.replace(/<[^>]+>/g, '');
const lastOf = steps => steps[steps.length - 1];

/* ---------- random groups ---------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy'];
const ODD_NAMES = ['<i>Zed</i>', 'A&B', '"Q"', "O'Neil", 'x>y'];
const TITLES = ['Dinner', 'Taxi', 'Groceries', 'Hotel', 'Tickets', 'Coffee', 'Fuel', 'Museum', '<b>Bar</b> & grill'];
// The legacy app counts every currency in hundredths, so it can only be compared on these.
const LEGACY_CURRENCIES = CURRENCIES.filter(c => !['JPY', 'KRW', 'VND'].includes(c));

/* One random group per seed: 2 to 9 people, 1 to 25 bills, every way of paying and splitting, payments, other
   currencies, rates typed for the group or fixed on a bill, and a few bills that are not valid.
   opts.legacy keeps to what the legacy app also understands: no zero-decimal currencies, no pinned rate
   table, no unknown or repeated people in a list. opts.onePayer gives every bill a single payer.
   opts.people and opts.bills fix the sizes. */
function randomGroup(seed, opts = {}) {
  const rnd = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const chance = p => rnd() < p;
  const pick = arr => arr[int(0, arr.length - 1)];
  const sample = (arr, k) => {
    const pool = arr.slice(), out = [];
    while (out.length < k && pool.length) out.push(pool.splice(int(0, pool.length - 1), 1)[0]);
    return out;
  };
  const codes = opts.legacy ? LEGACY_CURRENCIES : CURRENCIES;
  const base = chance(0.5) ? 'USD' : pick(codes);
  const n = opts.people || int(2, 9);
  const people = Array.from({ length: n }, (_, i) => ({ id: 'p-' + i.toString(36) + int(0, 35).toString(36),
    name: chance(0.08) ? pick(ODD_NAMES) + i : NAMES[i] || 'P' + i }));
  const ids = people.map(p => p.id);
  const foreign = sample(codes.filter(c => c !== base), int(0, 3));
  const tidy = chance(0.25);   // round amounts split evenly: many equal debts, so the tie-breaks get used

  // Worth roughly 1 to 600 US dollars, in whole minor units of `cur`.
  const amountIn = cur => {
    const usdCents = tidy ? pick([10, 20, 30, 60]) * 100 : chance(0.06) ? int(1, 9) : int(100, 60000);
    return Math.max(1, Math.round(usdCents * BUILTIN_RATES.usd[cur] / 10 ** (2 - minorDigits(cur))));
  };
  // `total` cut into `k` whole parts that add up exactly.
  const cut = (total, k) => {
    const marks = Array.from({ length: k - 1 }, () => int(0, total)).sort((a, b) => a - b);
    return [...marks, total].map((m, i) => m - (i ? marks[i - 1] : 0));
  };
  const valuesFor = (mode, who, total, cur) => {
    const list = mode === 'exact' ? cut(total, who.length).map(v => fromMinor(v, cur))
      : mode === 'percent' ? (who.length === 3 && chance(0.3) ? ['33.3', '33.3', '33.4'] : cut(100, who.length).map(String))
      : mode === 'shares' ? who.map(() => (chance(0.1) ? '0.5' : String(int(1, 4))))
      : [];
    return Object.fromEntries(list.map((v, i) => [who[i], v]));
  };
  const side = (modes, maxWho, total, cur) => {
    const mode = tidy ? modes[0] : pick(modes);
    const who = sample(ids, mode === 'single' ? 1 : int(mode === 'equal' ? 1 : Math.min(2, n), Math.min(maxWho, n)));
    return { mode, who, values: valuesFor(mode, who, total, cur) };
  };
  const rateText = cur => (BUILTIN_RATES.usd[base] / BUILTIN_RATES.usd[cur] * (0.9 + rnd() * 0.2)).toPrecision(int(2, 5));

  const expenses = [];
  const count = opts.bills || int(1, 25);
  for (let i = 0; i < count; i++) {
    const cur = foreign.length && chance(0.4) ? pick(foreign) : base;
    const bill = { id: 'e-' + i.toString(36), currency: cur };
    if (cur !== base && chance(0.15)) bill.fx = { rate: rateText(cur), base };
    if (chance(0.2)) {
      const [from, to] = sample(ids, 2);
      Object.assign(bill, { kind: 'payment', title: 'Payment ' + i, amount: fromMinor(amountIn(cur), cur), from, to });
      if (chance(0.05)) bill.to = from;                                  // not valid: paid themselves
    } else {
      let total = amountIn(cur);
      const split = { ...side(['equal', 'equal', 'exact', 'percent', 'shares', 'items'], 9, total, cur), items: [], tax: '', tip: '' };
      Object.assign(bill, { kind: 'expense', title: pick(TITLES) + ' ' + i, amount: fromMinor(total, cur), split });
      if (split.mode === 'items') {
        Object.assign(split, { who: [], tax: chance(0.3) ? '8.5' : '', tip: chance(0.4) ? pick(['10', '12.5', '20']) : '',
          items: Array.from({ length: int(1, 5) }, (_, j) => ({ name: 'Item ' + j, amount: fromMinor(amountIn(cur), cur), who: sample(ids, int(1, n)) })) });
        bill.amount = '';
        // What the items come to with tax and tip, so payers "by amount" can add up to it.
        total = computeExpense({ currency: cur, people }, { ...bill, paid: { mode: 'single', who: [ids[0]], values: {} } }).totalOrig;
      }
      bill.paid = side(opts.onePayer ? ['single'] : ['single', 'single', 'single', 'equal', 'exact', 'percent', 'shares'], 3, total, cur);
      if (chance(0.04)) bill.amount = '0';                               // not valid: no total (ignored for items)
      if (chance(0.04) && split.mode === 'percent') split.values[split.who[0]] = '1';   // not valid: not 100%
      if (!opts.legacy && chance(0.05)) split.who.push('p-nobody');      // someone who has left the group
      if (!opts.legacy && chance(0.05)) bill.paid.who.push(bill.paid.who[0]);
    }
    expenses.push(bill);
  }

  const group = { id: 'g-' + seed.toString(36), name: 'Random ' + seed, currency: base, rev: 0, people, expenses, rates: {} };
  foreign.forEach(cur => { if (chance(0.25)) group.rates[cur] = { rate: rateText(cur), base: chance(0.9) ? base : 'USD' }; });
  if (!opts.legacy && chance(0.3)) {
    group.fx = { date: '2026-09-01', usd: Object.fromEntries([base, ...foreign].map(c => [c, BUILTIN_RATES.usd[c] * (0.95 + rnd() * 0.1)])) };
  }
  return group;
}

/* ---------- the basics ---------- */

test('PHASES are the seven phases, in order', () => {
  assert.deepEqual(PHASES.map(p => p.label), ['Start', 'Add bills', 'Net pairs', 'Cancel loops', 'Skip middlemen', 'Swap payees', 'Settled']);
  assert.deepEqual(PHASES.map(p => p.key), ['start', 'bills', 'pairs', 'loops', 'middle', 'swap', 'done']);
});

test('edgeKey, edgesOf and balancesOf read a graph', () => {
  const g = new Map([[edgeKey('p-a', 'p-b'), 700], [edgeKey('p-c', 'p-b'), 300], [edgeKey('p-b', 'p-d'), 100]]);
  assert.equal(edgeKey('p-a', 'p-b'), 'p-a>p-b');
  assert.deepEqual(edgesOf(g), [['p-a', 'p-b', 700], ['p-c', 'p-b', 300], ['p-b', 'p-d', 100]]);
  assert.deepEqual([...balancesOf(g)], [['p-a', -700], ['p-b', 900], ['p-c', -300], ['p-d', 100]]);
  assert.deepEqual([...balancesOf(new Map())], []);
});

test('a group with no bills gives a start and a closing step', () => {
  for (const mode of MODES) {
    const steps = buildSteps(tiny(['Ana', 'Ben'], []), mode, US);
    assert.deepEqual(phasesOf(steps), [0, 6]);
    assert.deepEqual(titlesOf(steps), ['How to read this graph', 'No bills yet']);
    assert.equal(lastOf(steps).text, 'Add a bill to see the graph.');
    assert.deepEqual([steps.rawCount, steps.ok, steps.maxV, steps.afterBills.size, steps.bills.size], [0, true, 1, 0, 0]);
    assert.deepEqual(finalPayments(steps), []);
  }
  const nobody = buildSteps({ id: 'g-x', name: 'Nobody', currency: 'USD', people: [], expenses: [], rates: {} }, 'fewest');
  assert.deepEqual(phasesOf(nobody), [0, 6]);
  assert.equal(lastOf(nobody).text, 'Add people and a bill to see the graph.');
});

test('one bill between two people: every phase says there is nothing to do', () => {
  const group = tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 30)]);
  const fewest = buildSteps(group, 'fewest', US);
  assert.deepEqual(phasesOf(fewest), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(titlesOf(fewest), ['How to read this graph', 'Ben owes Ana · $30.00', 'No back-and-forth debts', 'No loops', 'No middlemen',
    'No swaps needed', '1 payment settles everything']);
  assert.equal(plainText(fewest[1].text), 'Ben owes Ana cost $30.00. Ana paid. Split equally between Ben ($30.00 each). New debts: Ben owes Ana $30.00.');
  assert.deepEqual(fewest[1].hl, { edges: [['p-ben', 'p-ana']], kind: 'add', bill: 'Ben owes Ana' });
  assert.deepEqual([...fewest[1].people], ['p-ben', 'p-ana']);
  assert.equal(plainText(fewest[4].text), 'Nobody is both owed money and owing money, so no one is passing money along.');
  assert.equal(lastOf(fewest).text, 'After adding up the bills there was 1 debt. Now 1 payment covers all of it. ' +
    'Every person still ends up paying or receiving exactly what their bills say: what they paid minus their share.');
  fewest.slice(1).forEach(s => assert.deepEqual(graphOf(s), { 'p-ben>p-ana': 3000 }));
  assert.deepEqual([fewest.rawCount, fewest.ok, fewest.maxV], [1, true, 3000]);
  assert.deepEqual(fewest.order, ['p-ana', 'p-ben']);

  // "Only existing debts" has no swap phase.
  const keep = buildSteps(group, 'keep', US);
  assert.deepEqual(phasesOf(keep), [0, 1, 2, 3, 4, 6]);
  assert.equal(keep[4].text, 'No chain of debts can be shortened without creating a debt between two people who did not already owe each other.');
});

test('debts in both directions cancel, and the arrow remembers it', () => {
  const group = tiny(['Ana', 'Ben'], [owes('Ana', 'Ben', 30), owes('Ben', 'Ana', 10)]);
  for (const mode of MODES) {
    const steps = buildSteps(group, mode, US);
    assert.deepEqual(graphOf(steps[2]), { 'p-ana>p-ben': 3000, 'p-ben>p-ana': 1000 });
    const net = steps[3];
    assert.deepEqual([net.phase, net.title], [2, 'Ana and Ben cancel out']);
    assert.equal(net.text, '<b class="who">Ana</b> owed <b class="who">Ben</b> <span class="amt">$30.00</span> and <b class="who">Ben</b> owed ' +
      '<b class="who">Ana</b> <span class="amt">$10.00</span>. Paying each other back and forth is pointless, so <span class="amt">$10.00</span> ' +
      'comes off both: <b class="who">Ana</b> owes <b class="who">Ben</b> <span class="amt">$20.00</span>.');
    assert.deepEqual(net.hl, { edges: [['p-ana', 'p-ben'], ['p-ben', 'p-ana']], kind: 'net' });
    assert.deepEqual(graphOf(net), { 'p-ana>p-ben': 2000 });
    assert.deepEqual(edgeBreakdown(steps, 3, 'p-ana>p-ben'), { from: 'p-ana', to: 'p-ben', total: 2000,
      pieces: [{ amount: 2000, bill: 'e-1', debtor: 'p-ana', creditor: 'p-ben', via: [], redirects: [] }],
      notes: [{ kind: 'net', amount: 1000, other: 'p-ben', bills: ['e-2'] }] });
    assert.equal(steps.rawCount, 2);
    assert.equal(lastOf(steps).title, '1 payment settles everything');
  }
});

test('equal debts in both directions leave everyone even', () => {
  const steps = buildSteps(tiny(['Ana', 'Ben'], [owes('Ana', 'Ben', 10), owes('Ben', 'Ana', 10)]), 'fewest', US);
  assert.match(steps[3].text, /comes off both: they are even\.$/);
  assert.equal(lastOf(steps).title, 'Everyone is even');
  assert.match(lastOf(steps).text, /^After adding up the bills there were 2 separate debts\. Now no payments cover all of it\. /);
  assert.equal(lastOf(steps).g.size, 0);
  assert.deepEqual(finalPayments(steps), []);
  assert.deepEqual(personBreakdown(steps, tiny(['Ana', 'Ben'], [owes('Ana', 'Ben', 10), owes('Ben', 'Ana', 10)]), 'p-ana').plan, []);
});

test('a loop of three comes off every link', () => {
  const group = tiny(['Ana', 'Ben', 'Cy'], [owes('Ana', 'Ben', 10), owes('Ben', 'Cy', 20), owes('Cy', 'Ana', 30)]);
  for (const mode of MODES) {
    const steps = buildSteps(group, mode, US);
    const loop = steps.find(s => s.phase === 3);
    assert.equal(loop.title, 'A loop of 3');
    assert.equal(plainText(loop.text), 'Money goes around in a circle: Ana → Ben → Cy → Ana. Each of them would pay $10.00 and get $10.00 ' +
      'straight back, so $10.00 comes off every link in the loop. The Ana → Ben debt disappears.');
    assert.deepEqual(loop.hl, { path: ['p-ana', 'p-ben', 'p-cy', 'p-ana'], edges: [['p-ana', 'p-ben'], ['p-ben', 'p-cy'], ['p-cy', 'p-ana']], kind: 'loop' });
    assert.deepEqual(graphOf(loop), { 'p-ben>p-cy': 1000, 'p-cy>p-ana': 2000 });
    assert.deepEqual(edgeBreakdown(steps, steps.indexOf(loop), 'p-cy>p-ana').notes, [{ kind: 'loop', amount: 1000, ring: ['p-ana', 'p-ben', 'p-cy', 'p-ana'] }]);
    // Ben then pays Ana directly instead of through Cy, in both modes (Ana and Ben had a debt between them).
    assert.deepEqual(finalPayments(steps), [['p-ben', 'p-ana', 1000], ['p-cy', 'p-ana', 1000]]);
    assert.deepEqual(edgeBreakdown(steps, steps.length - 1, 'p-ben>p-ana').pieces,
      [{ amount: 1000, bill: 'e-2', debtor: 'p-ben', creditor: 'p-cy', via: [{ bill: 'e-3', from: 'p-cy', to: 'p-ana' }], redirects: [] }]);
  }
});

test('fewest payments skips the person in the middle; only existing debts does not', () => {
  const group = tiny(['Ana', 'Ben', 'Cy'], [owes('Ana', 'Ben', 10), owes('Ben', 'Cy', 10)]);
  const fewest = buildSteps(group, 'fewest', US);
  const hop = fewest.find(s => s.phase === 4);
  assert.equal(hop.title, 'Skip Ben as the middle');
  assert.equal(plainText(hop.text), 'Ana owes Ben $10.00, and Ben owes Cy $10.00. Ben would just be passing $10.00 along, so Ana pays Cy that $10.00 directly. ' +
    'Ben ends up exactly where they started: $10.00 less coming in and $10.00 less going out.');
  assert.deepEqual(hop.hl, { path: ['p-ana', 'p-ben', 'p-cy'], edges: [['p-ana', 'p-ben'], ['p-ben', 'p-cy'], ['p-ana', 'p-cy']], direct: ['p-ana', 'p-cy'], kind: 'hop' });
  assert.deepEqual(finalPayments(fewest), [['p-ana', 'p-cy', 1000]]);
  assert.deepEqual(edgeBreakdown(fewest, fewest.length - 1, 'p-ana>p-cy'), { from: 'p-ana', to: 'p-cy', total: 1000,
    pieces: [{ amount: 1000, bill: 'e-1', debtor: 'p-ana', creditor: 'p-ben', via: [{ bill: 'e-2', from: 'p-ben', to: 'p-cy' }], redirects: [] }], notes: [] });

  const keep = buildSteps(group, 'keep', US);
  assert.equal(keep.find(s => s.phase === 4).title, 'No middlemen');
  assert.deepEqual(finalPayments(keep), [['p-ana', 'p-ben', 1000], ['p-ben', 'p-cy', 1000]]);
});

test('skipping adds to a debt that is already there', () => {
  const steps = buildSteps(tiny(['Ana', 'Ben', 'Cy'], [owes('Ana', 'Ben', 10), owes('Ben', 'Cy', 10), owes('Ana', 'Cy', 5)]), 'fewest', US);
  assert.match(plainText(steps.find(s => s.phase === 4).text), /directly \(on top of the \$5\.00 Ana already owed Cy\)\. /);
  assert.deepEqual(finalPayments(steps), [['p-ana', 'p-cy', 1500]]);
});

test('only existing debts sends money straight along a longer chain', () => {
  const group = tiny(['Ana', 'Ben', 'Cy', 'Dee'], [owes('Ana', 'Ben', 10), owes('Ben', 'Cy', 10), owes('Cy', 'Dee', 10), owes('Ana', 'Dee', 5)]);
  const steps = buildSteps(group, 'keep', US);
  const hop = steps.find(s => s.phase === 4);
  assert.equal(hop.title, 'Send it straight to Dee');
  assert.equal(plainText(hop.text), 'Money flows Ana → Ben → Cy → Dee. Ana already deals with Dee directly, so $10.00 can skip everyone in between. ' +
    'Ben and Cy each receive $10.00 less and pay $10.00 less, so their balances do not move.');
  assert.deepEqual(hop.hl.path, ['p-ana', 'p-ben', 'p-cy', 'p-dee']);
  assert.deepEqual(hop.hl.direct, ['p-ana', 'p-dee']);
  assert.deepEqual(finalPayments(steps), [['p-ana', 'p-dee', 1500]]);
  assert.deepEqual(edgeBreakdown(steps, steps.length - 1, 'p-ana>p-dee').pieces, [
    { amount: 1000, bill: 'e-1', debtor: 'p-ana', creditor: 'p-ben',
      via: [{ bill: 'e-2', from: 'p-ben', to: 'p-cy' }, { bill: 'e-3', from: 'p-cy', to: 'p-dee' }], redirects: [] },
    { amount: 500, bill: 'e-4', debtor: 'p-ana', creditor: 'p-dee', via: [], redirects: [] }]);
  // Fewest payments gets to the same place in two shorter skips.
  assert.deepEqual(finalPayments(buildSteps(group, 'fewest', US)), [['p-ana', 'p-dee', 1500]]);
});

test('crossing payments are swapped until one drops out', () => {
  const group = tiny(['Ana', 'Ben', 'Cy', 'Dee'], [owes('Ana', 'Cy', 10), owes('Ana', 'Dee', 20), owes('Ben', 'Cy', 30), owes('Ben', 'Dee', 5)]);
  const steps = buildSteps(group, 'fewest', US);
  const swap = steps.find(s => s.phase === 5);
  assert.equal(swap.title, 'Swap who pays whom');
  assert.equal(plainText(swap.text), 'Ben and Ana all pay into Dee and Cy through crossing payments, which is more payments than needed. Shift $5.00: ' +
    'Ben pays Dee $5.00 less, Ben pays Cy $5.00 more, Ana pays Cy $5.00 less and Ana pays Dee $5.00 more. ' +
    'Everyone still pays or receives the same total, and Ben → Dee drops out.');
  assert.deepEqual(swap.hl, { edges: [['p-ben', 'p-dee'], ['p-ben', 'p-cy'], ['p-ana', 'p-cy'], ['p-ana', 'p-dee']],
    plus: [['p-ben', 'p-cy'], ['p-ana', 'p-dee']], kind: 'swap' });
  assert.deepEqual(finalPayments(steps), [['p-ana', 'p-dee', 2500], ['p-ana', 'p-cy', 500], ['p-ben', 'p-cy', 3500]]);
  assert.deepEqual(edgeBreakdown(steps, steps.length - 1, 'p-ben>p-cy').pieces, [
    { amount: 3000, bill: 'e-3', debtor: 'p-ben', creditor: 'p-cy', via: [], redirects: [] },
    { amount: 500, bill: 'e-4', debtor: 'p-ben', creditor: 'p-dee', via: [], redirects: [{ from: 'p-dee', to: 'p-cy' }] }]);
  assert.equal(steps.ok, true);

  // "Only existing debts" leaves the four payments alone.
  assert.equal(finalPayments(buildSteps(group, 'keep', US)).length, 4);
});

/* ---------- the example group (SPEC §5, invariant 5) ----------
   The amounts are a few cents away from the ones printed in the spec. Those came from the earlier app, which
   shared a bill out between several payers one person at a time and lost a cent here and there, so that the
   plan paid Ana $122.98 where her bills said $123.00. core.js now shares such a bill out exactly. */

test('the example group settles with exactly what the bills say', () => {
  const fewest = buildSteps(EXAMPLE_GROUP, 'fewest', US);
  assert.equal(fewest.length, 23);
  // In the order the arrows sit on the final graph, which is the order the earlier app produced too.
  assert.deepEqual(edgesOf(lastOf(fewest).g), [['p-dee', 'p-ana', 12300], ['p-ben', 'p-eli', 10410], ['p-cy', 'p-eli', 6909], ['p-dee', 'p-eli', 11273]]);
  assert.deepEqual(finalPayments(fewest), [['p-ben', 'p-eli', 10410], ['p-cy', 'p-eli', 6909], ['p-dee', 'p-ana', 12300], ['p-dee', 'p-eli', 11273]]);
  assert.equal(lastOf(fewest).title, '4 payments settle everything');
  assert.deepEqual([fewest.rawCount, fewest.ok], [19, true]);

  const keep = buildSteps(EXAMPLE_GROUP, 'keep', US);
  assert.equal(keep.length, 22);
  assert.deepEqual(edgesOf(lastOf(keep).g), [['p-ben', 'p-ana', 3962], ['p-dee', 'p-ana', 8211], ['p-ben', 'p-eli', 6448], ['p-cy', 'p-eli', 6782],
    ['p-dee', 'p-eli', 15362], ['p-cy', 'p-ana', 127]]);
  assert.deepEqual(finalPayments(keep), [['p-ben', 'p-eli', 6448], ['p-ben', 'p-ana', 3962], ['p-cy', 'p-eli', 6782], ['p-cy', 'p-ana', 127],
    ['p-dee', 'p-eli', 15362], ['p-dee', 'p-ana', 8211]]);
  assert.equal(keep.ok, true);

  // Either way every person pays or gets, in all, exactly what they paid minus their share.
  const totals = personTotals(EXAMPLE_GROUP);
  for (const steps of [fewest, keep]) {
    const settled = balancesOf(lastOf(steps).g);
    EXAMPLE_GROUP.people.forEach(({ id }) => assert.equal(settled.get(id) || 0, totals.get(id).paid - totals.get(id).share, id));
  }
});

test('the example group plays through the expected steps', () => {
  const steps = buildSteps(EXAMPLE_GROUP, 'fewest', US);
  assert.deepEqual(titlesOf(steps), ['How to read this graph',
    'Apartment in Alfama · €780.00', 'Groceries · €210.00', 'Dinner at the taberna · €156.20', 'Surf lessons · $480.00', 'Train to Sintra · €78.00', 'Cy paid Ana back · $50.00',
    'Ana and Ben cancel out', 'Ana and Cy cancel out', 'Ana and Dee cancel out', 'Ana and Eli cancel out', 'Ben and Cy cancel out', 'Ben and Dee cancel out',
    'Ben and Eli cancel out', 'Cy and Dee cancel out', 'Dee and Eli cancel out',
    'A loop of 3', 'Skip Cy as the middle', 'Skip Ana as the middle', 'Skip Ben as the middle', 'Swap who pays whom', 'Swap who pays whom',
    '4 payments settle everything']);
  assert.deepEqual(phasesOf(steps), [0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 4, 4, 4, 5, 5, 6]);
  assert.equal(plainText(steps[2].text), 'Groceries cost €210.00 (about $236.28 at 1 EUR = 1.12513 USD, built-in rate from Oct 4, 2026). Cy paid. ' +
    'Split by shares: Ana 1, Ben 1, Cy 1 and Dee 2. Cy covers their own share. New debts: Ana owes Cy $47.26, Ben owes Cy $47.26 and Dee owes Cy $94.51.');
  assert.equal(plainText(steps[3].text), 'Dinner at the taberna cost €156.20 (about $175.75 at 1 EUR = 1.12513 USD, built-in rate from Oct 4, 2026). Dee paid. ' +
    'Itemized: each person covers what they ordered, plus their part of €14.20 tax and tip. Dee covers their own share. ' +
    'New debts: Ben owes Dee $68.48, Cy owes Dee $27.23, Ana owes Dee $40.03 and Eli owes Dee $18.56.');
  assert.equal(plainText(steps[4].text), 'Surf lessons cost $480.00. Eli paid. Split by percent: Ana 25%, Ben 25%, Cy 25% and Dee 25%. ' +
    'New debts: Ana owes Eli $120.00, Ben owes Eli $120.00, Cy owes Eli $120.00 and Dee owes Eli $120.00.');
  // Two payers, three sharers: the shares are not all the same, so the text says "about".
  assert.equal(plainText(steps[5].text), 'Train to Sintra cost €78.00 (about $87.76 at 1 EUR = 1.12513 USD, built-in rate from Oct 4, 2026). ' +
    'Ben paid $43.88 and Cy paid $43.88. Split equally between Ana, Ben and Cy (about $29.26 each). ' +
    'Because more than one person paid, each share is owed to the payers in proportion to what they put in (Ben 50% and Cy 50%). ' +
    'The cents are rounded so that each payer is covered exactly. ' +
    'Ben and Cy cover their own shares. New debts: Ana owes Ben $14.63, Ana owes Cy $14.63, Ben owes Cy $14.62 and Cy owes Ben $14.62.');
  assert.equal(plainText(steps[6].text), 'Cy paid Ana $50.00. On the graph that shows up as Ana owing Cy $50.00, which cancels against what Cy already owes.');
  assert.match(plainText(steps[1].text), /New debts: .* and Dee owes Ben \$58\.50, plus 2 more\.$/);
});

test('the closing step says "what their bills say", and that is checked on every run', () => {
  // Two bills of the example have two payers each. Those are shared out to the cent as well.
  assert.match(lastOf(buildSteps(EXAMPLE_GROUP, 'fewest', US)).text,
    /Now 4 payments cover all of it\. Every person still ends up paying or receiving exactly what their bills say: what they paid minus their share\.$/);
  const onePayerEach = tiny(['Ana', 'Ben', 'Cy'], [owes('Ana', 'Ben', 10), owes('Ben', 'Cy', 7.5)]);
  assert.match(lastOf(buildSteps(onePayerEach, 'keep', US)).text, /exactly what their bills say: what they paid minus their share\.$/);
});

test('a payment in another currency says both amounts', () => {
  const group = tiny(['Ana', 'Ben'], [{ kind: 'payment', title: 'Ben paid Ana', amount: '100', currency: 'EUR', from: 'p-ben', to: 'p-ana' }]);
  const steps = buildSteps(group, 'fewest', US);
  assert.equal(steps[1].title, 'Ben paid Ana · €100.00');
  assert.equal(plainText(steps[1].text), 'Ben paid Ana €100.00 (about $112.51). On the graph that shows up as Ana owing Ben $112.51, which cancels against what Ben already owes.');
  assert.deepEqual(finalPayments(steps), [['p-ana', 'p-ben', 11251]]);
});

test('zero-decimal currencies are whole units from start to finish', () => {
  const group = { ...tiny(['Ana', 'Ben', 'Cy'], []), currency: 'JPY' };
  group.expenses = [{ id: 'e-1', kind: 'expense', title: 'Ramen', amount: '1000', currency: 'JPY', paid: { mode: 'single', who: ['p-ana'], values: {} },
    split: { mode: 'equal', who: ['p-ana', 'p-ben', 'p-cy'], values: {}, items: [], tax: '', tip: '' } }];
  const steps = buildSteps(group, 'fewest', US);
  assert.equal(steps[1].title, 'Ramen · ¥1,000');
  assert.deepEqual(finalPayments(steps), [['p-ben', 'p-ana', 333], ['p-cy', 'p-ana', 333]]);
  assert.match(plainText(steps[1].text), /^Ramen cost ¥1,000\. Ana paid\. Split equally between Ana, Ben and Cy \(about ¥334 each\)\./);
});

test('bills with a problem stay off the graph but are still listed in steps.bills', () => {
  const group = tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 12),
    { ...owes('Ben', 'Ana', 0), title: 'No total' },
    { kind: 'payment', title: 'To herself', amount: '5', currency: 'USD', from: 'p-ana', to: 'p-ana' },
    { ...owes('Ana', 'Ana', 9), title: 'Only for Ana' }]);
  const steps = buildSteps(group, 'fewest', US);
  assert.deepEqual(steps.filter(s => s.phase === 1).map(s => s.title), ['Ben owes Ana · $12.00']);
  assert.deepEqual([...steps.bills.keys()], ['e-1', 'e-2', 'e-3', 'e-4']);
  assert.equal(steps.bills.get('e-2').r.err, 'Enter the total.');
  assert.equal(steps.bills.get('e-1').e, group.expenses[0]);
  // The bill Ana paid only for herself is fine, it just creates no debt. It still shows in her list.
  assert.deepEqual(personBreakdown(steps, group, 'p-ana').rows, [
    { bill: 'e-1', paid: 1200, share: 0, net: 1200, isPayment: false },
    { bill: 'e-4', paid: 900, share: 900, net: 0, isPayment: false }]);
});

/* ---------- text is safe, input is left alone ---------- */

// Only <b class="who"> and <span class="amt">, properly closed, and no other < > or bare &.
function assertSafeHtml(html, label) {
  const tags = html.match(/<[^>]*>/g) || [];
  tags.forEach(tag => assert.ok(['<b class="who">', '</b>', '<span class="amt">', '</span>'].includes(tag), label + ': unexpected tag ' + tag));
  const count = tag => tags.filter(t => t === tag).length;
  assert.equal(count('<b class="who">'), count('</b>'), label);
  assert.equal(count('<span class="amt">'), count('</span>'), label);
  const rest = html.replace(/<[^>]*>/g, '');
  assert.ok(!/[<>]/.test(rest), label + ': stray angle bracket in ' + rest);
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|#39;)/.test(rest), label + ': bare & in ' + rest);
}

test('names and titles are escaped in step text and left as they are in titles', () => {
  const evil = '<img src=x onerror="alert(1)">', group = tiny(['Ana', 'Ben', 'Cy'], [owes('Ana', 'Ben', 10), owes('Ben', 'Cy', 10), owes('Cy', 'Ana', 4), owes('Ben', 'Ana', 3)]);
  group.people[0].name = evil;
  group.people[1].name = 'B&B <b class="who">';
  group.expenses[0].title = '</span><script>alert(2)</script>';
  for (const mode of MODES) {
    const steps = buildSteps(group, mode, US);
    steps.forEach((s, i) => assertSafeHtml(s.text, mode + ' step ' + i));
    assert.equal(steps[1].title, '</span><script>alert(2)</script> · $10.00');
    assert.equal(steps[1].hl.bill, '</span><script>alert(2)</script>');
    assert.ok(steps[1].text.startsWith('&lt;/span&gt;&lt;script&gt;alert(2)&lt;/script&gt; cost '));
    assert.ok(steps.some(s => s.text.includes('<b class="who">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</b>')));
    assert.ok(steps.some(s => s.phase === 2 && s.title === evil + ' and B&B <b class="who"> cancel out'));
  }
});

test('buildSteps leaves the group alone and gives the same answer every time', () => {
  // EXAMPLE_GROUP is deeply frozen, so any write to it would throw.
  const before = JSON.stringify(EXAMPLE_GROUP);
  for (const mode of MODES) {
    const a = buildSteps(EXAMPLE_GROUP, mode, US), b = buildSteps(EXAMPLE_GROUP, mode, US);
    assert.deepEqual(toPlain(a), toPlain(b));
    // A step is a snapshot: later steps do not reach back and change it.
    assert.notEqual(a[1].g, a[2].g);
    assert.deepEqual(graphOf(a[1]), { 'p-ana>p-ben': 5851, 'p-ben>p-ana': 11702, 'p-cy>p-ana': 11701, 'p-cy>p-ben': 5851, 'p-dee>p-ana': 11702,
      'p-dee>p-ben': 5850, 'p-eli>p-ana': 11701, 'p-eli>p-ben': 5851 });
  }
  assert.equal(JSON.stringify(EXAMPLE_GROUP), before);
});

test('the locale only changes how amounts are written', () => {
  const us = buildSteps(EXAMPLE_GROUP, 'fewest', US), de = buildSteps(EXAMPLE_GROUP, 'fewest', 'de-DE');
  assert.equal(us[1].title, 'Apartment in Alfama · €780.00');
  assert.match(de[1].title, /^Apartment in Alfama · 780,00\s€$/);
  assert.deepEqual(de.map(s => toPlain(s.g)), us.map(s => toPlain(s.g)));
  assert.equal(typeof buildSteps(EXAMPLE_GROUP, 'fewest')[1].title, 'string');   // no locale: the reader's own
});

/* ---------- breakdowns ---------- */

test('edgeBreakdown merges pieces with the same story and puts the largest first', () => {
  const hop = (f, t, b) => ({ f, t, b });
  const parts = [
    { c: 200, hops: [hop('p-a', 'p-b', 'e-1')], re: [] },
    { c: 900, hops: [hop('p-a', 'p-c', 'e-2'), hop('p-c', 'p-b', 'e-3')], re: [] },
    { c: 300, hops: [hop('p-a', 'p-b', 'e-1')], re: [] },
    { c: 500, hops: [hop('p-a', 'p-b', 'e-1')], re: [{ from: 'p-d', to: 'p-b' }] },
    { c: 500, hops: [hop('p-a', 'p-b', 'e-4')], re: [] }];
  const notes = [{ kind: 'net', c: 40, other: 'p-b', bills: ['e-9'] }, { kind: 'loop', c: 60, ring: ['p-a', 'p-b', 'p-c', 'p-a'] }];
  const steps = [{ g: new Map([['p-a>p-b', 2400]]), P: new Map([['p-a>p-b', { parts, notes }]]) }];
  const got = edgeBreakdown(steps, 0, 'p-a>p-b');
  assert.deepEqual(got, { from: 'p-a', to: 'p-b', total: 2400,
    pieces: [
      { amount: 900, bill: 'e-2', debtor: 'p-a', creditor: 'p-c', via: [{ bill: 'e-3', from: 'p-c', to: 'p-b' }], redirects: [] },
      { amount: 500, bill: 'e-1', debtor: 'p-a', creditor: 'p-b', via: [], redirects: [] },           // 200 + 300
      { amount: 500, bill: 'e-1', debtor: 'p-a', creditor: 'p-b', via: [], redirects: [{ from: 'p-d', to: 'p-b' }] },
      { amount: 500, bill: 'e-4', debtor: 'p-a', creditor: 'p-b', via: [], redirects: [] }],
    notes: [{ kind: 'net', amount: 40, other: 'p-b', bills: ['e-9'] }, { kind: 'loop', amount: 60, ring: ['p-a', 'p-b', 'p-c', 'p-a'] }] });
  // The answer is a copy: changing it does not touch the step.
  got.notes[0].bills.push('x');
  got.notes[1].ring.push('x');
  got.pieces[0].via.push('x');
  assert.deepEqual(notes, [{ kind: 'net', c: 40, other: 'p-b', bills: ['e-9'] }, { kind: 'loop', c: 60, ring: ['p-a', 'p-b', 'p-c', 'p-a'] }]);
  assert.equal(parts[1].hops.length, 2);
});

test('edgeBreakdown of an arrow or a step that is not there is empty', () => {
  const steps = buildSteps(EXAMPLE_GROUP, 'fewest', US), empty = { from: 'p-ana', to: 'p-dee', total: 0, pieces: [], notes: [] };
  assert.deepEqual(edgeBreakdown(steps, steps.length - 1, 'p-ana>p-dee'), empty);
  assert.deepEqual(edgeBreakdown(steps, 0, 'p-ana>p-dee'), empty);
  assert.deepEqual(edgeBreakdown(steps, 999, 'p-ana>p-dee'), empty);
});

test('edgeBreakdown on the example: where what Dee pays Eli comes from', () => {
  const steps = buildSteps(EXAMPLE_GROUP, 'fewest', US);
  assert.deepEqual(edgeBreakdown(steps, steps.length - 1, 'p-dee>p-eli'), { from: 'p-dee', to: 'p-eli', total: 11273,
    pieces: [
      { amount: 5730, bill: 'e-2', debtor: 'p-dee', creditor: 'p-cy', via: [{ bill: 'e-4', from: 'p-cy', to: 'p-eli' }], redirects: [] },
      { amount: 5543, bill: 'e-4', debtor: 'p-dee', creditor: 'p-eli', via: [], redirects: [] }],
    notes: [{ kind: 'net', amount: 1856, other: 'p-eli', bills: ['e-3'] }] });
  // Somewhere in the final plan there is money that was sent to a different payee.
  const redirected = finalPayments(steps).flatMap(([a, b]) => edgeBreakdown(steps, steps.length - 1, edgeKey(a, b)).pieces).filter(p => p.redirects.length);
  assert.ok(redirected.length > 0);
});

test('finalPayments lists payers in the group\'s order, largest payment first', () => {
  const steps = [{ g: new Map() }, { g: new Map([['p-c>p-a', 5], ['p-b>p-d', 10], ['p-a>p-d', 1], ['p-b>p-c', 30], ['p-b>p-a', 10]]) }];
  steps.order = ['p-a', 'p-b', 'p-c', 'p-d'];
  assert.deepEqual(finalPayments(steps), [['p-a', 'p-d', 1], ['p-b', 'p-c', 30], ['p-b', 'p-d', 10], ['p-b', 'p-a', 10], ['p-c', 'p-a', 5]]);
  assert.deepEqual([...steps[1].g.keys()], ['p-c>p-a', 'p-b>p-d', 'p-a>p-d', 'p-b>p-c', 'p-b>p-a']);   // the graph itself keeps its order
});

test('personBreakdown on the example', () => {
  const steps = buildSteps(EXAMPLE_GROUP, 'fewest', US);
  assert.deepEqual(personBreakdown(steps, EXAMPLE_GROUP, 'p-dee'), { paid: 17575, share: 41148, net: -23573,
    rows: [
      { bill: 'e-1', paid: 0, share: 17552, net: -17552, isPayment: false },
      { bill: 'e-2', paid: 0, share: 9451, net: -9451, isPayment: false },
      { bill: 'e-3', paid: 17575, share: 2145, net: 15430, isPayment: false },
      { bill: 'e-4', paid: 0, share: 12000, net: -12000, isPayment: false }],
    plan: [{ dir: 'pay', other: 'p-ana', amount: 12300 }, { dir: 'pay', other: 'p-eli', amount: 11273 }] });
  const eli = personBreakdown(steps, EXAMPLE_GROUP, 'p-eli');
  assert.deepEqual([eli.paid, eli.share, eli.net], [48000, 19408, 28592]);
  assert.deepEqual(eli.plan, [{ dir: 'get', other: 'p-ben', amount: 10410 }, { dir: 'get', other: 'p-cy', amount: 6909 }, { dir: 'get', other: 'p-dee', amount: 11273 }]);
  // A payment: the one who sent it "paid", the one who got it has it as their "share".
  const cy = personBreakdown(steps, EXAMPLE_GROUP, 'p-cy');
  assert.deepEqual(cy.rows[cy.rows.length - 1], { bill: 'e-6', paid: 5000, share: 0, net: 5000, isPayment: true });
  const ana = personBreakdown(steps, EXAMPLE_GROUP, 'p-ana');
  assert.deepEqual(ana.rows[ana.rows.length - 1], { bill: 'e-6', paid: 0, share: 5000, net: -5000, isPayment: true });
  // `net` follows the graph, so it always matches the plan. It is also exactly paid minus share, on the
  // apartment with its two payers too.
  assert.equal(ana.net, 12300);
  assert.equal(ana.paid - ana.share, 12300);
  assert.deepEqual(ana.rows[0], { bill: 'e-1', paid: 58507, share: 17552, net: 40955, isPayment: false });
  assert.deepEqual(personBreakdown(steps, EXAMPLE_GROUP, 'p-nobody'), { paid: 0, share: 0, net: 0, rows: [], plan: [] });
});

/* ---------- invariants on any group ---------- */

const sum = list => list.reduce((s, v) => s + v, 0);

// SPEC §5 invariant 1, plus: the story of every piece runs unbroken from the arrow's payer to its payee.
function checkStep(steps, i, ids, keepMode, label) {
  const step = steps[i], at = label + ', step ' + i;
  assert.ok(Number.isInteger(step.phase) && step.phase >= 0 && step.phase <= 6, at);
  assert.equal(typeof step.title, 'string', at);
  assertSafeHtml(step.text, at);
  assert.ok(step.text.length > 0, at);
  step.people.forEach(id => assert.ok(ids.has(id), at + ': unknown person highlighted'));
  (step.hl.edges || []).forEach(([a, b]) => assert.ok(ids.has(a) && ids.has(b), at + ': unknown person on a highlighted arrow'));
  assert.deepEqual([...step.P.keys()].sort(), [...step.g.keys()].sort(), at + ': every arrow has its sources and nothing else does');

  step.g.forEach((amount, key) => {
    const where = at + ', arrow ' + key, [from, to] = key.split('>');
    assert.ok(Number.isSafeInteger(amount) && amount > 0, where + ': amount ' + amount);
    assert.ok(ids.has(from) && ids.has(to) && from !== to, where);
    const rec = step.P.get(key);
    rec.parts.forEach(p => assert.ok(Number.isSafeInteger(p.c) && p.c > 0, where + ': part ' + p.c));
    assert.equal(sum(rec.parts.map(p => p.c)), amount, where + ': parts add up to the arrow');

    const bd = edgeBreakdown(steps, i, key);
    assert.deepEqual([bd.from, bd.to, bd.total], [from, to, amount], where);
    assert.equal(sum(bd.pieces.map(p => p.amount)), amount, where + ': pieces add up to the arrow');
    const stories = new Set();
    bd.pieces.forEach((piece, j) => {
      assert.ok(piece.amount > 0 && (j === 0 || piece.amount <= bd.pieces[j - 1].amount), where + ': largest first');
      const chain = [{ bill: piece.bill, from: piece.debtor, to: piece.creditor }, ...piece.via];
      chain.forEach((hop, k) => {
        assert.ok(steps.bills.has(hop.bill) && !steps.bills.get(hop.bill).r.err, where + ': bill ' + hop.bill);
        assert.ok(ids.has(hop.from) && ids.has(hop.to), where);
        if (k) assert.equal(hop.from, chain[k - 1].to, where + ': the chain is unbroken');
      });
      const ends = [chain[chain.length - 1].to, ...piece.redirects.map(r => r.to)];
      piece.redirects.forEach((r, k) => assert.equal(r.from, ends[k], where + ': each redirect starts where the money was'));
      assert.equal(piece.debtor, from, where + ': the money starts with the payer');
      assert.equal(ends[ends.length - 1], to, where + ': and ends with the payee');
      if (step.phase <= 1) assert.deepEqual([piece.via, piece.redirects, piece.creditor], [[], [], to], where + ': untouched while bills are added');
      if (keepMode) assert.deepEqual(piece.redirects, [], where + ': only fewest payments swaps payees');
      const story = JSON.stringify([piece.bill, piece.debtor, piece.creditor, piece.via, piece.redirects]);
      assert.ok(!stories.has(story), where + ': same story listed twice');
      stories.add(story);
    });
    bd.notes.forEach(note => {
      assert.ok(note.amount > 0, where);
      if (note.kind === 'net') { assert.equal(note.other, to, where); note.bills.forEach(b => assert.ok(steps.bills.has(b), where)); }
      else { assert.equal(note.kind, 'loop', where); assert.equal(note.ring[0], note.ring[note.ring.length - 1], where); }
    });
  });
}

// opts.every: look inside only every n-th step (for groups with thousands of steps).
function checkGroup(group, mode, label, opts = {}) {
  const steps = buildSteps(group, mode, US);
  const ids = new Set(group.people.map(p => p.id)), order = group.people.map(p => p.id);
  const final = lastOf(steps).g, at = label + ' (' + mode + ')';

  // Shape of the list.
  assert.equal(steps[0].phase, 0, at);
  assert.equal(lastOf(steps).phase, 6, at);
  steps.forEach((s, i) => { if (i) assert.ok(s.phase >= steps[i - 1].phase, at + ': phases in order'); });
  if (mode === 'keep') assert.ok(steps.every(s => s.phase !== 5), at + ': no swap phase');
  steps.forEach((_, i) => { if (i % (opts.every || 1) === 0 || i === steps.length - 1) checkStep(steps, i, ids, mode === 'keep', at); });

  // The graph after "Add bills" is the plain sum of the debts of every bill that has no problem.
  const added = new Map();
  let validBills = 0;
  group.expenses.forEach(bill => {
    const r = computeExpense(group, bill);
    assert.equal(steps.bills.get(bill.id).e, bill, at);
    if (r.err || !r.edges.length) return;
    validBills++;
    r.edges.forEach(([a, b, v]) => added.set(edgeKey(a, b), (added.get(edgeKey(a, b)) || 0) + v));
  });
  assert.deepEqual(toPlain(steps.afterBills), toPlain(added), at + ': the graph after the bills');
  assert.equal(steps.filter(s => s.phase === 1).length, validBills, at + ': one step per bill');
  assert.equal(steps.rawCount, added.size, at);
  assert.equal(steps.maxV, steps.reduce((most, s) => [...s.g.values()].reduce((m, v) => Math.max(m, v), most), 1), at);
  assert.equal(steps.bills.size, group.expenses.length, at);
  assert.deepEqual(steps.order, order, at);

  // Invariant 2: nobody's balance moves once the bills are in.
  const start = balancesOf(steps.afterBills);
  assert.equal(steps.ok, true, at);
  steps.forEach((s, i) => {
    if (s.phase < 2) return;
    const now = balancesOf(s.g);
    order.forEach(id => assert.equal(now.get(id) || 0, start.get(id) || 0, at + ', step ' + i + ': balance of ' + id));
  });
  assert.equal(sum([...start.values()]), 0, at);

  const pays = new Set(edgesOf(final).map(e => e[0])), gets = new Set(edgesOf(final).map(e => e[1]));
  if (mode === 'fewest') {
    // Invariant 3.
    const owing = order.filter(id => (start.get(id) || 0) !== 0).length;
    assert.ok(final.size <= Math.max(0, owing - 1), at + ': ' + final.size + ' payments for ' + owing + ' people');
    pays.forEach(id => assert.ok(!gets.has(id), at + ': ' + id + ' both pays and receives'));
  } else {
    // Invariant 4.
    const netted = steps.filter(s => s.phase === 2).pop();
    edgesOf(final).forEach(([a, b]) => assert.ok(netted.g.has(edgeKey(a, b)) || netted.g.has(edgeKey(b, a)), at + ': new debt between ' + a + ' and ' + b));
  }

  // finalPayments: the same arrows, payers in the group's order, largest first.
  const plan = finalPayments(steps);
  assert.deepEqual(plan.map(String).sort(), edgesOf(final).map(String).sort(), at);
  plan.forEach((p, i) => {
    if (!i) return;
    const prev = plan[i - 1], step = order.indexOf(p[0]) - order.indexOf(prev[0]);
    assert.ok(step > 0 || (step === 0 && p[2] <= prev[2]), at + ': order of the plan');
  });

  // personBreakdown: rows add up, net is the balance, the plan is that person's part of finalPayments.
  const totals = personTotals(group);
  group.people.forEach(({ id }) => {
    const pb = personBreakdown(steps, group, id), who = at + ', ' + id;
    assert.equal(pb.net, start.get(id) || 0, who + ': net is the balance');
    assert.equal(pb.net, pb.paid - pb.share, who + ': the balance is what the bills say, paid minus share');
    assert.deepEqual([pb.paid, pb.share], [totals.get(id).paid, totals.get(id).share], who + ': same totals as core');
    assert.deepEqual([sum(pb.rows.map(r => r.paid)), sum(pb.rows.map(r => r.share)), sum(pb.rows.map(r => r.net))], [pb.paid, pb.share, pb.net], who);
    assert.deepEqual(pb.plan, plan.filter(p => p[0] === id || p[1] === id).map(([a, b, v]) => (a === id ? { dir: 'pay', other: b, amount: v } : { dir: 'get', other: a, amount: v })), who);
    assert.equal(sum(pb.plan.map(p => (p.dir === 'get' ? p.amount : -p.amount))), pb.net, who + ': the plan settles the balance');
    assert.deepEqual(pb.rows.map(r => r.bill), group.expenses.map(e => e.id).filter(b => pb.rows.some(r => r.bill === b)), who + ': rows in bill order');
    pb.rows.forEach(row => {
      const { e, r } = steps.bills.get(row.bill);
      assert.ok(!r.err && (row.paid || row.share), who);
      assert.equal(row.isPayment, e.kind === 'payment', who);
      // The bill's effect on the balance is exactly paid minus share, with any number of payers.
      assert.equal(row.net, row.paid - row.share, who + ', bill ' + row.bill);
    });
  });
  return steps;
}

test('invariants hold on the example group', () => {
  MODES.forEach(mode => checkGroup(structuredClone(EXAMPLE_GROUP), mode, 'example'));
});

test('invariants hold on 400 random groups, in both modes', () => {
  const seen = { phases: new Set(), kinds: new Set(), paid: new Set(), split: new Set(), payments: 0, foreign: 0, pinned: 0, redirects: 0, longHops: 0 };
  for (let seed = 1; seed <= 400; seed++) {
    const group = randomGroup(seed);
    assert.ok(group.people.length >= 2 && group.people.length <= 9 && group.expenses.length >= 1 && group.expenses.length <= 25);
    for (const mode of MODES) {
      const steps = checkGroup(group, mode, 'seed ' + seed);
      steps.forEach(s => { seen.phases.add(s.phase); if (s.hl.kind) seen.kinds.add(s.hl.kind); if (s.hl.kind === 'hop' && s.hl.path.length > 3) seen.longHops++; });
      steps.bills.forEach(({ e, r }) => {
        if (r.err) return;
        if (e.kind === 'payment') seen.payments++; else { seen.paid.add(e.paid.mode); seen.split.add(e.split.mode); }
        if (r.cur !== group.currency) seen.foreign++;
        if (r.rateSource === 'pinned') seen.pinned++;
      });
      if (mode === 'fewest') seen.redirects += steps.filter(s => s.hl.kind === 'swap').length;
    }
  }
  // The random groups really do reach every corner.
  assert.deepEqual([...seen.phases].sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...seen.kinds].sort(), ['add', 'hop', 'loop', 'net', 'swap']);
  assert.deepEqual([...seen.paid].sort(), ['equal', 'exact', 'percent', 'shares', 'single']);
  assert.deepEqual([...seen.split].sort(), ['equal', 'exact', 'items', 'percent', 'shares']);
  assert.ok(seen.payments > 100 && seen.foreign > 100 && seen.pinned > 20 && seen.redirects > 50 && seen.longHops > 20, JSON.stringify(seen));
});

test('invariants hold on groups larger than the earlier app could finish', () => {
  // 45 people with 450 bills need more than the 400 loop cancellations the earlier app allowed itself.
  const steps = checkGroup(randomGroup(9045, { people: 45, bills: 450 }), 'fewest', '45 people', { every: 40 });
  assert.ok(steps.filter(s => s.phase === 3).length > 400);
  checkGroup(randomGroup(9030, { people: 30, bills: 250 }), 'keep', '30 people', { every: 40 });
});

/* ---------- step by step against the earlier app ---------- */

const noLegacy = legacyAvailable() ? false : 'the earlier app was not found at ' + legacyPath;

// Same content, in the same order. Compared as JSON because that is quick; the slow deepEqual only runs to
// describe a difference.
function assertSame(mine, theirs, message) {
  const json = v => JSON.stringify(Symbol.iterator in v ? [...v] : v);   // Maps and Sets as lists
  if (json(mine) !== json(theirs)) assert.deepEqual(toPlain(mine), toPlain(theirs), message);
}

function assertSameSteps(mine, theirs, label, compare) {
  assert.equal(mine.length, theirs.length, label + ': number of steps');
  mine.forEach((a, i) => {
    const b = theirs[i], at = label + ', step ' + i + ' (' + a.title + ')';
    assert.equal(a.phase, b.phase, at + ': phase');
    assertSame(a.g, b.g, at + ': graph');
    assertSame(a.P, b.P, at + ': where the money came from');
    assertSame(a.hl, b.hl, at + ': highlight');
    assertSame(a.people, b.people, at + ': people');
    if (compare.titles(a)) assert.equal(a.title, b.title, at + ': title');
    // The sentences for bills and for the closing step were reworded on purpose; the rest must be identical.
    if (compare.texts && a.phase >= 2 && a.phase <= 5) assert.equal(a.text, b.text, at + ': text');
  });
  assert.deepEqual([mine.rawCount, mine.ok, mine.maxV], [theirs.rawCount, theirs.ok, theirs.maxV], label);
  assertSame(mine.afterBills, theirs.afterBills, label + ': graph after the bills');
}

// Groups the earlier app can do: two-decimal currencies, no pinned rate table. The second lot has one payer on
// every bill, where core.js and the earlier app work out the same debts.
const legacyGroups = () => [
  ...Array.from({ length: 220 }, (_, i) => randomGroup(1000 + i, { legacy: true })),
  ...Array.from({ length: 120 }, (_, i) => randomGroup(3000 + i, { legacy: true, onePayer: true })),
  randomGroup(7001, { legacy: true, people: 14, bills: 60 }),
  randomGroup(7002, { legacy: true, people: 18, bills: 90 }),
  randomGroup(7003, { legacy: true, people: 22, bills: 120 })];

test('the example group simplifies exactly as in the earlier app', { skip: noLegacy }, () => {
  // Two bills of the example have two payers, so the earlier app is handed core.js's debts for each bill.
  const legacy = loadLegacy(structuredClone(EXAMPLE_GROUP), { compute: bill => computeExpense(EXAMPLE_GROUP, bill) });
  MODES.forEach(mode => assertSameSteps(buildSteps(EXAMPLE_GROUP, mode), legacy.buildSteps(mode), 'example, ' + mode, { titles: () => true, texts: true }));
});

/* The two places core.js is meant to differ from the earlier app on these groups.
   - A bill whose converted total lands exactly on half a unit. core.js converts in whole numbers and rounds
     the half up; the earlier app multiplied floats, could land a hair under the half, and then rounded down.
   - A bill with several payers. The earlier app shared each person's part between the payers on its own, and
     the rounding could leave a payer a cent or two short of what they paid. core.js counts off what each
     payer has been promised, so the debts move exactly paid minus share. Each debt stays within a few cents. */
const halfUnitApart = (mine, theirs) => Math.abs(mine.total - theirs.total) === 1 && Math.abs(mine.totalOrig * mine.rate % 1 - 0.5) < 1e-6;
const payersOf = r => [...r.paid.values()].filter(v => v > 0).length;

function assertCloseDebts(mine, theirs, at) {
  const a = new Map(mine.edges.map(([d, c, v]) => [edgeKey(d, c), v])), b = new Map(toPlain(theirs.edges).map(([d, c, v]) => [edgeKey(d, c), v]));
  const sharers = [...mine.owed.values()].filter(v => v > 0).length;
  new Set([...a.keys(), ...b.keys()]).forEach(key => {
    assert.ok(Math.abs((a.get(key) || 0) - (b.get(key) || 0)) <= sharers, at + ': ' + key + ' is ' + a.get(key) + ' here and ' + b.get(key) + ' in the earlier app');
  });
  const net = new Map();
  mine.edges.forEach(([d, c, v]) => { net.set(d, (net.get(d) || 0) - v); net.set(c, (net.get(c) || 0) + v); });
  new Set([...mine.paid.keys(), ...mine.owed.keys()]).forEach(id => {
    assert.equal(net.get(id) || 0, (mine.paid.get(id) || 0) - (mine.owed.get(id) || 0), at + ': ' + id + ' does not end up with paid minus share');
  });
}

test('over 300 random groups simplify exactly as in the earlier app, in both modes', { skip: noLegacy }, () => {
  let untouched = 0, steps = 0;
  legacyGroups().forEach(group => {
    const legacy = loadLegacy(group);
    // First make sure both agree on every bill, so a difference below can only come from the simplification.
    let own = 0;
    group.expenses.forEach(bill => {
      const mine = computeExpense(group, bill), theirs = legacy.computeExpense(bill), at = group.name + ', bill ' + bill.id;
      assert.equal(Boolean(mine.err), Boolean(theirs.err), at + ': core.js and the earlier app disagree on whether it is valid');
      if (mine.err) return;
      if (halfUnitApart(mine, theirs)) own++;
      else if (payersOf(mine) > 1) {
        assertCloseDebts(mine, theirs, at);
        if (JSON.stringify(mine.edges) !== JSON.stringify(toPlain(theirs.edges))) own++;
      } else assert.deepEqual(mine.edges, toPlain(theirs.edges), at + ': core.js and the earlier app work out different debts');
    });
    // A group with such a bill is still compared, with the earlier app using core.js's bill results.
    const reference = own ? loadLegacy(group, { compute: bill => computeExpense(group, bill) }) : legacy;
    if (!own) untouched++;
    MODES.forEach(mode => {
      const mine = buildSteps(group, mode);
      assertSameSteps(mine, reference.buildSteps(mode), group.name + ', ' + mode, { titles: () => true, texts: true });
      steps += mine.length;
    });
  });
  assert.ok(untouched >= 200, untouched + ' groups compared with the earlier app as it is');
  assert.ok(steps > 10000, steps + ' steps compared');
});

test('given the same bill results, 120 groups in any currency simplify exactly as in the earlier app', { skip: noLegacy }, () => {
  // Zero-decimal currencies and pinned rates are new, so here the earlier app is handed core.js's result for
  // each bill. That leaves only the simplification to compare. Its amounts are written differently in yen,
  // so the wording is only compared when the group's currency has two decimals.
  let zeroDecimal = 0;
  for (let seed = 5000; seed < 5120; seed++) {
    const group = randomGroup(seed);
    const legacy = loadLegacy(group, { compute: bill => computeExpense(group, bill) });
    const texts = minorDigits(group.currency) === 2;
    if (!texts) zeroDecimal++;
    MODES.forEach(mode => assertSameSteps(buildSteps(group, mode), legacy.buildSteps(mode), group.name + ', ' + mode, { titles: s => s.phase !== 1 && texts, texts }));
  }
  assert.ok(zeroDecimal >= 3, zeroDecimal + ' groups settle in a zero-decimal currency');
});

/* The earlier app is not part of this repository, so the three tests above skip themselves once the site is
   published on its own. This fingerprint of every graph at every step, for the same groups, was recorded
   while those tests passed. It fails if the simplification, the bill math or the random groups change.
   If that change is meant: run the tests above against the earlier app, then put the new value here. */
const GRAPH_FINGERPRINT = 'f072c74a1b4ee77be336f3eb4a4db96fdaf81662486324b46c1a3b132818d7ac';

test('the graphs for the comparison groups still match the recorded fingerprint', () => {
  const hash = createHash('sha256');
  [...legacyGroups(), ...Array.from({ length: 120 }, (_, i) => randomGroup(5000 + i))].forEach(group => {
    MODES.forEach(mode => hash.update(JSON.stringify(buildSteps(group, mode).map(s => [s.phase, ...s.g]))));
  });
  assert.equal(hash.digest('hex'), GRAPH_FINGERPRINT);
});
