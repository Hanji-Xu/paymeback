import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as parse from '../docs/js/parse.js';
import { CURRENCIES, EXAMPLE_GROUP, computeExpense, minorDigits, num, personTotals, toMinor } from '../docs/js/core.js';

const { parseText, formatBill, formatGroup, describeBill } = parse;

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
const shuffled = (rnd, arr) => arr.map(v => [rnd(), v]).sort((a, b) => a[0] - b[0]).map(e => e[1]);

const NAMES = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli'];
const idOf = name => 'p-' + name.toLowerCase().replace(/[^a-z0-9]/g, '');
const people = names => names.map(name => ({ id: idOf(name), name }));
const G = (over = {}) => ({ id: 'g-test', name: 'Test', currency: 'USD', rev: 0, people: people(NAMES), expenses: [], rates: {}, ...over });
const EMPTY = () => G({ people: [] });

// The group as it will be once the new people of a parsed text are added, with the ids drafts use.
const grown = (g, res) => ({ ...g, people: [...g.people, ...res.people.filter(p => p.isNew).map(p => ({ id: 'new:' + p.name, name: p.name }))] });

/* A bill in one line, by names, so a table row can say what a line must be read as.
   Expense:  title | amount CUR | who paid | who shares [| rate R BASE]
     who paid:   "Ana" (one payer), "Ana+Ben" (equal parts), "Ana 80.00, Ben 40.00", "Ana 60%, Ben 40%", "Ana x2, Ben x1"
     who shares: "all" (everyone in the group, in group order), "Ana+Ben", or the same pair forms,
                 or "items[name price: people; ...] tax T tip P"
   Payment:  from > to | amount CUR | title [| rate R BASE]
   A person who is not in the group yet has a star: "Fay*". */
function brief(g, bill) {
  const n = id => (String(id).startsWith('new:') ? id.slice(4) + '*' : (g.people.find(p => p.id === id) || { name: '?' + id }).name);
  const fx = bill.fx ? ' | rate ' + bill.fx.rate + ' ' + bill.fx.base : '';
  if (bill.kind === 'payment') return n(bill.from) + ' > ' + n(bill.to) + ' | ' + bill.amount + ' ' + bill.currency + ' | ' + bill.title + fx;
  const everyone = g.people.map(p => p.id).join();
  const side = (s, isSplit) => (s.mode === 'single' ? n(s.who[0])
    : s.mode === 'equal' ? (isSplit && s.who.join() === everyone ? 'all' : s.who.map(n).join('+'))
    : s.who.map(id => n(id) + ' ' + (s.mode === 'shares' ? 'x' : '') + s.values[id] + (s.mode === 'percent' ? '%' : '')).join(', '));
  const s = bill.split;
  const split = s.mode !== 'items' ? side(s, true)
    : 'items[' + s.items.map(it => (it.name + ' ' + it.amount).trim() + ': ' + (it.who.join() === everyone ? 'all' : it.who.map(n).join('+'))).join('; ') + ']' + (s.tax ? ' tax ' + s.tax : '') + (s.tip ? ' tip ' + s.tip : '');
  return bill.title + ' | ' + bill.amount + ' ' + bill.currency + ' | ' + side(bill.paid, false) + ' | ' + split + fx;
}

// Every ok bill of a parse has to pass the real math, and say nothing but strings about itself.
function assertSound(g, res) {
  const big = grown(g, res);
  for (const d of res.drafts) {
    assert.equal(d.ok, d.errors.length === 0, 'ok means no errors');
    assert.equal(d.bill !== undefined, d.ok && (d.kind === 'expense' || d.kind === 'payment'), 'a bill comes with ok bills only');
    assert.ok(d.errors.every(e => typeof e === 'string' && e.length > 8 && !/undefined|NaN|\[object/.test(e)), 'messages are sentences: ' + d.errors);
    assert.ok(!d.errors.some(e => e.startsWith('This line could not be read')), 'the parser itself tripped on: ' + d.source);
    if (!d.bill) continue;
    const r = computeExpense(big, d.bill);
    assert.equal(r.err, null, d.source + ' -> ' + r.err);
    assert.equal(r.errTitle, null);
    assert.ok(r.totalOrig > 0);
    assert.match(d.bill.id, /^e-[a-z0-9]{7}$/);
  }
}

// The draft of the last line. Lines before it set things up ("People: ...", "Currency: ...", "I am ...").
function lastDraft(text, g, opts) {
  const res = parseText(text, g, opts);
  assertSound(g, res);
  return res.drafts[res.drafts.length - 1];
}

/* rows: [text, brief]. Each row is one test: the last line must be read as the brief says, and the
   canonical text of that bill must read back as the very same bill. */
function reads(title, rows, makeGroup = G, opts) {
  describe(title, () => {
    for (const [text, want] of rows) {
      test(JSON.stringify(text), () => {
        const g = makeGroup(), res = parseText(text, g, opts), d = res.drafts[res.drafts.length - 1];
        assertSound(g, res);
        assert.deepEqual(d.errors, []);
        assert.equal(brief(g, d.bill), want);
        const big = grown(g, res), canonical = formatBill(g, d.bill), back = parseText(canonical, big).drafts;
        assert.deepEqual(back.map(b => b.errors), [[]], canonical);
        assert.deepEqual({ ...back[0].bill, id: '' }, { ...d.bill, id: '' }, canonical);
        assert.equal(formatBill(big, back[0].bill), canonical);
      });
    }
  });
}

// rows: [text, message or list of messages]. The line must be refused with exactly these words.
function refuses(title, rows, makeGroup = G, opts) {
  describe(title, () => {
    for (const [text, want] of rows) {
      test(JSON.stringify(text), () => {
        const d = lastDraft(text, makeGroup(), opts);
        assert.deepEqual(d.errors, [].concat(want));
        assert.equal(d.ok, false);
        assert.equal(d.bill, undefined);
      });
    }
  });
}

const ALL5 = 'Ana+Ben+Cy+Dee+Eli';

/* ---------- the module ---------- */

describe('parse.js', () => {
  test('exports exactly the four functions of the spec', () => {
    assert.deepEqual(Object.keys(parse).sort(), ['describeBill', 'formatBill', 'formatGroup', 'parseText']);
  });

  test('parseText returns drafts, people, the default currency and who "me" is', () => {
    const res = parseText('Dinner 120 paid by Ana', G());
    assert.deepEqual(Object.keys(res), ['drafts', 'people', 'defaultCurrency', 'me']);
    assert.deepEqual(res.people, NAMES.map(name => ({ name, isNew: false })));
    assert.equal(res.defaultCurrency, 'USD');
    assert.equal(res.me, null);
    assert.deepEqual(Object.keys(res.drafts[0]), ['line', 'lines', 'source', 'kind', 'ok', 'errors', 'warnings', 'newPeople', 'bill']);
  });

  test('the bill of a draft has the shape of the data model', () => {
    const [d] = parseText('Dinner 120 paid by Ana', G()).drafts;
    assert.deepEqual({ ...d.bill, id: 'e-x' }, { id: 'e-x', kind: 'expense', title: 'Dinner', amount: '120.00', currency: 'USD',
      paid: { mode: 'single', who: ['p-ana'], values: {} },
      split: { mode: 'equal', who: ['p-ana', 'p-ben', 'p-cy', 'p-dee', 'p-eli'], values: {}, items: [], tax: '', tip: '' } });
    const [p] = parseText('Cy paid Ana 50', G()).drafts;
    assert.deepEqual({ ...p.bill, id: 'e-x' }, { id: 'e-x', kind: 'payment', title: 'Cy paid Ana back', amount: '50.00', currency: 'USD', from: 'p-cy', to: 'p-ana' });
  });

  test('empty, missing and odd input gives no drafts and never throws', () => {
    for (const text of ['', '   ', '\n\n\n', null, undefined]) assert.deepEqual(parseText(text, G()).drafts, []);
    for (const text of [0, 120, true, {}, [], ['Dinner 120 paid by Ana']]) assert.doesNotThrow(() => parseText(text, G()));
    assert.deepEqual(parseText('Dinner 120 paid by Ana', {}).drafts[0].ok, true, 'a group without people: Ana becomes a new person');
    assert.equal(parseText('Dinner 120', undefined).drafts[0].ok, false);
  });

  test('the same text and group give the same result', () => {
    const text = 'People: Fay\nDinner 120 paid by Ana\nCy paid Ana 50\nDinner: paid by Dee, tip 10%\n  - Fish 20 Ana\nBad line';
    const plain = res => JSON.parse(JSON.stringify(res, (k, v) => (k === 'id' ? 'e-x' : v)));
    assert.deepEqual(plain(parseText(text, G())), plain(parseText(text, G())));
  });

  test('the group that is passed in is left alone', () => {
    const g = G(), before = JSON.stringify(g);
    parseText('People: Fay\nDinner 120 paid by Fay\nI am Ana\nCurrency: EUR', g, { me: 'p-ben' });
    assert.equal(JSON.stringify(g), before);
  });
});

/* ---------- lines, entries and what a draft carries ---------- */

describe('entries', () => {
  test('line numbers, line counts and sources', () => {
    const text = '# trip\r\n\r\nDinner 120 paid by Ana\r\nLunch, paid by Ben\r\n  - Soup 5 Ana\r\n  - Salad 6 Ben\r\n\r\nCy paid Ana 50';
    const drafts = parseText(text, G()).drafts;
    assert.deepEqual(drafts.map(d => [d.line, d.lines, d.kind, d.ok]), [[1, 1, 'comment', true], [3, 1, 'expense', true], [4, 3, 'expense', true], [8, 1, 'payment', true]]);
    assert.equal(drafts[2].source, 'Lunch, paid by Ben\n  - Soup 5 Ana\n  - Salad 6 Ben');
    assert.equal(drafts[0].bill, undefined);
  });

  test('old Mac line ends and trailing spaces', () => {
    const drafts = parseText('Dinner 120 paid by Ana   \rTaxi 45 paid by Ben\t', G()).drafts;
    assert.deepEqual(drafts.map(d => [d.line, d.ok]), [[1, true], [2, true]]);
    assert.equal(drafts[0].source, 'Dinner 120 paid by Ana   ');
  });

  test('a blank line ends a list of items', () => {
    const drafts = parseText('Lunch 5 paid by Ben\n\n  - Soup 5 Ana', G()).drafts;
    assert.deepEqual(drafts.map(d => [d.line, d.lines, d.ok]), [[1, 1, true], [3, 1, false]]);
    assert.deepEqual(drafts[1].errors, ['This line starts like an item, but no bill is right above it. Remove the dash, or move the line under its bill.']);
  });

  test('a line that is only indented, with no bill above it, is read as a line of its own', () => {
    const g = G(), drafts = parseText('   Dinner 120 paid by Ana', g).drafts;
    assert.equal(brief(g, drafts[0].bill), 'Dinner | 120.00 USD | Ana | all');
    const tabbed = parseText('\tDinner 120 paid by Ana', g).drafts;
    assert.equal(tabbed[0].ok, true);
  });

  test('item marks: dash, star, dot, long dashes, two spaces, a tab', () => {
    const g = G();
    for (const mark of ['- ', '-', '* ', '• ', '– ', '— ', '· ', '  ', '    ', '\t', ' - ', '   * ']) {
      const d = lastDraft('Lunch, paid by Ben\n' + mark + 'Soup 5 Ana', g);
      assert.equal(d.lines, 2, JSON.stringify(mark));
      assert.equal(brief(g, d.bill), 'Lunch | 5.00 USD | Ben | items[Soup 5.00: Ana]');
    }
    assert.equal(parseText('Lunch 5 paid by Ben\n Soup 5 paid by Ana', g).drafts.length, 2, 'one space is not an item');
  });

  test('a quote that is never closed is just a character', () => {
    const g = G();
    assert.equal(brief(g, lastDraft('"Dinner 12 paid by Ana', g).bill), '"Dinner | 12.00 USD | Ana | all');
    assert.equal(brief(g, lastDraft('“Dinner 12 paid by Ana', g).bill), '“Dinner | 12.00 USD | Ana | all');
    assert.deepEqual(parseText('People: "Fay, Gus', g).drafts[0].newPeople, ['"Fay', 'Gus']);
  });

  test('an arrow at the start of a line is not an item mark', () => {
    const d = parseText('Lunch 5 paid by Ben\n-> Ana 5', G()).drafts;
    assert.equal(d.length, 2);
    assert.equal(d[1].ok, false);
  });

  test('notes are kept as drafts and change nothing', () => {
    const drafts = parseText('# note\n// note\n   # indented note\n#\n//x: 5 paid by Ana', G()).drafts;
    assert.deepEqual(drafts.map(d => [d.kind, d.ok, d.errors.length, d.bill]), Array(5).fill(['comment', true, 0, undefined]));
  });

  test('a note between a bill and an indented line ends the bill', () => {
    const g = G(), drafts = parseText('Lunch 5 paid by Ben\n# note\n  Taxi 9 paid by Ana', g).drafts;
    assert.deepEqual(drafts.map(d => d.kind), ['expense', 'comment', 'expense']);
    assert.equal(brief(g, drafts[2].bill), 'Taxi | 9.00 USD | Ana | all');
  });

  test('items under a "People:" line or a note are refused when they start with a dash', () => {
    const drafts = parseText('People: Fay\n- Soup 5 Ana\n# note\n* Soup 5 Ana', G()).drafts;
    assert.deepEqual(drafts.map(d => d.ok), [true, false, true, false]);
  });
});

/* ---------- the grammar table, row by row ---------- */

reads('grammar: "Dinner 120 paid by Ana" (everyone shares, default currency)', [
  ['Dinner 120 paid by Ana', 'Dinner | 120.00 USD | Ana | all'],
  ['dinner 120 paid by ana', 'dinner | 120.00 USD | Ana | all'],
  ['Dinner 120, paid by Ana', 'Dinner | 120.00 USD | Ana | all'],
  ['Dinner 120 Paid By ANA.', 'Dinner | 120.00 USD | Ana | all'],
  ['Dinner - 120 - paid by Ana', 'Dinner | 120.00 USD | Ana | all'],
  ['Dinner   120   paid   by   Ana', 'Dinner | 120.00 USD | Ana | all'],
  ['Dinner at the taberna 120 paid by Ana', 'Dinner at the taberna | 120.00 USD | Ana | all'],
  ['Dinner 120 paid by Ana!', 'Dinner | 120.00 USD | Ana | all'],
  ['Dinner 120; paid by Ana;', 'Dinner | 120.00 USD | Ana | all']
]);

reads('grammar: the canonical form with a colon after the name', [
  ['Dinner: 120.00 EUR, paid by Ana, split between Ana, Ben and Cy', 'Dinner | 120.00 EUR | Ana | Ana+Ben+Cy'],
  ['Dinner: 120 EUR paid by Ana split between Ana, Ben, Cy', 'Dinner | 120.00 EUR | Ana | Ana+Ben+Cy'],
  ['Dinner:120eur, paid by Ana, split between Ana & Ben & Cy', 'Dinner | 120.00 EUR | Ana | Ana+Ben+Cy'],
  ['Dinner : 120 paid by Ana', 'Dinner | 120.00 USD | Ana | all'],
  ['Room 12: 45 paid by Ana', 'Room 12 | 45.00 USD | Ana | all'],
  ['Table for 2: 80 paid by Ana', 'Table for 2 | 80.00 USD | Ana | all'],
  ['Dinner with Ana: 80 paid by Ben', 'Dinner with Ana | 80.00 USD | Ben | all'],
  ['2 pizzas: 24 paid by Ana', '2 pizzas | 24.00 USD | Ana | all'],
  ['Dinner 120 total: 120 paid by Ana', 'Dinner 120 total | 120.00 USD | Ana | all'],
  ['Dinner: €120 paid by: Ana, split between: Ana, Ben', 'Dinner | 120.00 EUR | Ana | Ana+Ben']
]);

reads('grammar: payer first, "Ana paid 120 for dinner"', [
  ['Ana paid 120 for dinner', 'dinner | 120.00 USD | Ana | all'],
  ['ana paid 120 for dinner', 'dinner | 120.00 USD | Ana | all'],
  ['Ana paid 120 EUR for the dinner at Joe\'s', 'the dinner at Joe\'s | 120.00 EUR | Ana | all'],
  ['Ana paid for dinner 120', 'dinner | 120.00 USD | Ana | all'],
  ['Ana paid for the 3 tickets $80', 'the 3 tickets | 80.00 USD | Ana | all'],
  ['Ana paid 120 for 2 pizzas', '2 pizzas | 120.00 USD | Ana | all'],
  ['Ana and Ben paid 120 for dinner', 'dinner | 120.00 USD | Ana+Ben | all'],
  ['Ana, Ben and Cy paid 120 for dinner', 'dinner | 120.00 USD | Ana+Ben+Cy | all'],
  ['Everyone paid 100 for snacks', 'snacks | 100.00 USD | ' + ALL5 + ' | all'],
  ['Ana paid €120 for dinner, split with Ben and Cy', 'dinner | 120.00 EUR | Ana | Ana+Ben+Cy'],
  ['Ana paid 120 for dinner with Ben and Cy', 'dinner | 120.00 USD | Ana | Ana+Ben+Cy'],
  ['Ana paid 120 for dinner, split between Ben and Cy', 'dinner | 120.00 USD | Ana | Ben+Cy'],
  ['Ana paid 120 for dinner among Ben, Cy', 'dinner | 120.00 USD | Ana | Ben+Cy'],
  ['Ana paid 120 for dinner for Ben and Cy', 'dinner | 120.00 USD | Ana | Ben+Cy'],
  ['Ana paid 120 for Ben and Cy for dinner', 'dinner | 120.00 USD | Ana | Ben+Cy'],
  ['Ana paid 60 for dinner, split Ana 30, Ben 20, Cy 10', 'dinner | 60.00 USD | Ana | Ana 30.00, Ben 20.00, Cy 10.00'],
  ['Dinner: Ana paid 120', 'Dinner | 120.00 USD | Ana | all'],
  ['Dinner: Ana paid 120 for Ben and Cy', 'Dinner | 120.00 USD | Ana | Ben+Cy'],
  ['Ana paid 9 for banana split', 'banana split | 9.00 USD | Ana | all'],
  ['Ana paid 9 for banana split, with Ben', 'banana split | 9.00 USD | Ana | Ana+Ben'],
  ['Ana paid 30 for city tax', 'city tax | 30.00 USD | Ana | all'],
  ['Ana paid 5 for the tip', 'the tip | 5.00 USD | Ana | all'],
  ['Ana paid 50 for drinks for everyone', 'drinks | 50.00 USD | Ana | all'],
  ['Ana paid 50 for the whole group dinner', 'the whole group dinner | 50.00 USD | Ana | all'],
  ['Ana paid 30 for Ben\'s lunch', 'Ben\'s lunch | 30.00 USD | Ana | all'],
  ['Dee paid 60 for 7 nights, everyone but Dee', '7 nights | 60.00 USD | Dee | Ana+Ben+Cy+Eli']
]);

reads('grammar: "with" includes whoever paid', [
  ['Taxi 30 paid by Ben, split with Ana', 'Taxi | 30.00 USD | Ben | Ben+Ana'],
  ['Taxi 30 paid by Ben with Ana and Cy', 'Taxi | 30.00 USD | Ben | Ben+Ana+Cy'],
  ['Taxi 30 paid by Ben, with Ana and Ben', 'Taxi | 30.00 USD | Ben | Ben+Ana'],
  ['Taxi 30 paid by Ana and Ben, split with Cy', 'Taxi | 30.00 USD | Ana+Ben | Ana+Ben+Cy'],
  ['Taxi 30 paid by Ben, split with everyone', 'Taxi | 30.00 USD | Ben | all'],
  ['Taxi 30 with Ana paid by Ben', 'Taxi | 30.00 USD | Ben | Ben+Ana']
]);

reads('grammar: "between", "among" and "for" list exactly who shares', [
  ['Taxi $45 paid by Ben for Ana and Cy', 'Taxi | 45.00 USD | Ben | Ana+Cy'],
  ['Taxi 45 paid by Ben, for Ana & Cy', 'Taxi | 45.00 USD | Ben | Ana+Cy'],
  ['Taxi 45 for Ana, Cy paid by Ben', 'Taxi | 45.00 USD | Ben | Ana+Cy'],
  ['Taxi 45 paid by Ben for Ben', 'Taxi | 45.00 USD | Ben | Ben'],
  ['Taxi 45 paid by Ben between Ana and Cy', 'Taxi | 45.00 USD | Ben | Ana+Cy'],
  ['Taxi 45 paid by Ben, split between Cy, Ana', 'Taxi | 45.00 USD | Ben | Cy+Ana'],
  ['Taxi 45 paid by Ben among Ana + Cy', 'Taxi | 45.00 USD | Ben | Ana+Cy'],
  ['Taxi 45 paid by Ben, split amongst Ana Cy', 'Taxi | 45.00 USD | Ben | Ana+Cy'],
  ['Taxi 45 paid by Ben, split Ana, Cy', 'Taxi | 45.00 USD | Ben | Ana+Cy'],
  ['Taxi 45 paid by Ben, split between Ana and Cy equally', 'Taxi | 45.00 USD | Ben | Ana+Cy'],
  ['Taxi 45 paid by Ben, split equally between Ana and Cy', 'Taxi | 45.00 USD | Ben | Ana+Cy'],
  ['Taxi 45 paid by Ben, split evenly among Ana and Cy', 'Taxi | 45.00 USD | Ben | Ana+Cy']
]);

reads('grammar: everyone, and everyone except', [
  ['Lunch 60 paid by Ana for everyone', 'Lunch | 60.00 USD | Ana | all'],
  ['Lunch 60 paid by Ana for everybody', 'Lunch | 60.00 USD | Ana | all'],
  ['Lunch 60 paid by Ana for all', 'Lunch | 60.00 USD | Ana | all'],
  ['Lunch 60 paid by Ana for all of us', 'Lunch | 60.00 USD | Ana | all'],
  ['Lunch 60 paid by Ana for us', 'Lunch | 60.00 USD | Ana | all'],
  ['Lunch 60 paid by Ana for the group', 'Lunch | 60.00 USD | Ana | all'],
  ['Lunch 60 paid by Ana for the whole group', 'Lunch | 60.00 USD | Ana | all'],
  ['Lunch 60 paid by Ana for each', 'Lunch | 60.00 USD | Ana | all'],
  ['Lunch 60 paid by Ana, split between everyone', 'Lunch | 60.00 USD | Ana | all'],
  ['Lunch 60 paid by Ana, split among all of us', 'Lunch | 60.00 USD | Ana | all'],
  ['Lunch 60 paid by Ana for everyone except Dee', 'Lunch | 60.00 USD | Ana | Ana+Ben+Cy+Eli'],
  ['Lunch 60 paid by Ana for everyone but Dee', 'Lunch | 60.00 USD | Ana | Ana+Ben+Cy+Eli'],
  ['Lunch 60 paid by Ana for all but Dee', 'Lunch | 60.00 USD | Ana | Ana+Ben+Cy+Eli'],
  ['Lunch 60 paid by Ana for everybody except Dee and Eli', 'Lunch | 60.00 USD | Ana | Ana+Ben+Cy'],
  ['Lunch 60 paid by Ana, split between all of us except Dee', 'Lunch | 60.00 USD | Ana | Ana+Ben+Cy+Eli'],
  ['Lunch 60 paid by Ana for the group except for Dee', 'Lunch | 60.00 USD | Ana | Ana+Ben+Cy+Eli'],
  ['Lunch 60 paid by Ana for us but not Dee, Eli', 'Lunch | 60.00 USD | Ana | Ana+Ben+Cy'],
  ['Lunch 60 paid by Ana except Dee', 'Lunch | 60.00 USD | Ana | Ana+Ben+Cy+Eli'],
  ['Lunch 60 paid by Ana, split equally except Dee', 'Lunch | 60.00 USD | Ana | Ana+Ben+Cy+Eli'],
  ['Lunch 60 paid by Ana, split with everyone except Ana', 'Lunch | 60.00 USD | Ana | Ben+Cy+Dee+Eli'],
  ['Lunch 60 paid by everyone except Dee', 'Lunch | 60.00 USD | ' + ALL5 + ' | Ana+Ben+Cy+Eli']
]);

reads('grammar: several payers in equal parts', [
  ['Hotel 300 paid by Ana and Ben', 'Hotel | 300.00 USD | Ana+Ben | all'],
  ['Hotel 300 paid by Ana, Ben', 'Hotel | 300.00 USD | Ana+Ben | all'],
  ['Hotel 300 paid by Ana & Ben', 'Hotel | 300.00 USD | Ana+Ben | all'],
  ['Hotel 300 paid by Ana + Ben', 'Hotel | 300.00 USD | Ana+Ben | all'],
  ['Hotel 300 paid by Ana Ben', 'Hotel | 300.00 USD | Ana+Ben | all'],
  ['Hotel 300 paid by Ben, Ana and Cy', 'Hotel | 300.00 USD | Ben+Ana+Cy | all'],
  ['Hotel 300 paid by Ana and Ben and Cy', 'Hotel | 300.00 USD | Ana+Ben+Cy | all'],
  ['Hotel 300 paid by everyone', 'Hotel | 300.00 USD | ' + ALL5 + ' | all'],
  ['Hotel 300 paid by Ana+Ben', 'Hotel | 300.00 USD | Ana+Ben | all']
]);

reads('grammar: payers by amount, by percent, by shares', [
  ['Hotel 120 paid by Ana 80, Ben 40', 'Hotel | 120.00 USD | Ana 80.00, Ben 40.00 | all'],
  ['Hotel 120 paid by Ana 80 and Ben 40', 'Hotel | 120.00 USD | Ana 80.00, Ben 40.00 | all'],
  ['Hotel: 120 paid by Ana: 80, Ben: 40', 'Hotel | 120.00 USD | Ana 80.00, Ben 40.00 | all'],
  ['Hotel 120 paid by Ana $80, Ben $40', 'Hotel | 120.00 USD | Ana 80.00, Ben 40.00 | all'],
  ['Hotel 120 EUR paid by Ana 80.50 EUR, Ben 39,50 EUR', 'Hotel | 120.00 EUR | Ana 80.50, Ben 39.50 | all'],
  ['Hotel 120 paid by Ana 120, Ben 0', 'Hotel | 120.00 USD | Ana 120.00, Ben 0.00 | all'],
  ['Hotel 120 paid by Ana 60%, Ben 40%', 'Hotel | 120.00 USD | Ana 60%, Ben 40% | all'],
  ['Hotel 120 paid by Ana 60 %, Ben 40 %', 'Hotel | 120.00 USD | Ana 60%, Ben 40% | all'],
  ['Hotel 120 paid by Ana 60 percent, Ben 40 percent', 'Hotel | 120.00 USD | Ana 60%, Ben 40% | all'],
  ['Hotel 120 paid by Ana 62.5%, Ben 37,5%', 'Hotel | 120.00 USD | Ana 62.5%, Ben 37.5% | all'],
  ['Hotel 120 paid by Ana x2, Ben x1', 'Hotel | 120.00 USD | Ana x2, Ben x1 | all'],
  ['Hotel 120 paid by Ana 1 share, Ben 2 shares', 'Hotel | 120.00 USD | Ana x1, Ben x2 | all'],
  ['Hotel 120 paid by Ana 80, Ben 40, split between Ana and Ben', 'Hotel | 120.00 USD | Ana 80.00, Ben 40.00 | Ana+Ben']
]);

reads('grammar: split by set amounts', [
  ['Hotel 60 paid by Ana, split Ana 30, Ben 20, Cy 10', 'Hotel | 60.00 USD | Ana | Ana 30.00, Ben 20.00, Cy 10.00'],
  ['Hotel 60 paid by Ana, split between Ana 30, Ben 20, Cy 10', 'Hotel | 60.00 USD | Ana | Ana 30.00, Ben 20.00, Cy 10.00'],
  ['Hotel 60 paid by Ana for Ana 30, Ben 20 and Cy 10', 'Hotel | 60.00 USD | Ana | Ana 30.00, Ben 20.00, Cy 10.00'],
  ['Hotel 60 paid by Ana, split Ana 30.00, Ben 20.5, Cy 9,50', 'Hotel | 60.00 USD | Ana | Ana 30.00, Ben 20.50, Cy 9.50'],
  ['Hotel 60 split Ana 30, Ben 30 paid by Cy', 'Hotel | 60.00 USD | Cy | Ana 30.00, Ben 30.00'],
  ['Hotel 1500 paid by Ana, split Ana 1 200, Ben 300', 'Hotel | 1500.00 USD | Ana | Ana 1200.00, Ben 300.00'],
  ['Hotel 1500 paid by Ana, split Ana 1,200, Ben 300', 'Hotel | 1500.00 USD | Ana | Ana 1200.00, Ben 300.00'],
  ['Hotel 60 paid by Ana, split Ana 60, Ben 0', 'Hotel | 60.00 USD | Ana | Ana 60.00, Ben 0.00']
]);

reads('grammar: split by percent', [
  ['Hotel 60 paid by Ana, split Ana 50%, Ben 30%, Cy 20%', 'Hotel | 60.00 USD | Ana | Ana 50%, Ben 30%, Cy 20%'],
  ['Hotel 60 paid by Ana, split Ana 50 %, Ben 30 %, Cy 20 %', 'Hotel | 60.00 USD | Ana | Ana 50%, Ben 30%, Cy 20%'],
  ['Hotel 60 paid by Ana, split Ana 50 percent, Ben 30 pct, Cy 20%', 'Hotel | 60.00 USD | Ana | Ana 50%, Ben 30%, Cy 20%'],
  ['Hotel 60 paid by Ana, split between Ana 33.33%, Ben 33.33%, Cy 33.34%', 'Hotel | 60.00 USD | Ana | Ana 33.33%, Ben 33.33%, Cy 33.34%'],
  ['Hotel 60 paid by Ana, split Ana 12,5%, Ben 87,5%', 'Hotel | 60.00 USD | Ana | Ana 12.5%, Ben 87.5%'],
  ['Hotel 60 paid by Ana, split Ana 100%', 'Hotel | 60.00 USD | Ana | Ana 100%'],
  ['Hotel 60 paid by Ana, split Ana 100%, Ben 0%', 'Hotel | 60.00 USD | Ana | Ana 100%, Ben 0%'],
  ['Hotel 60 paid by Ana, split Ana 99.5%, Ben .5%', 'Hotel | 60.00 USD | Ana | Ana 99.5%, Ben 0.5%']
]);

reads('grammar: split by shares, and bare numbers are never shares', [
  ['Hotel 60 paid by Ana, split Ana x2, Ben x1', 'Hotel | 60.00 USD | Ana | Ana x2, Ben x1'],
  ['Hotel 60 paid by Ana, split Ana 2x, Ben 1x', 'Hotel | 60.00 USD | Ana | Ana x2, Ben x1'],
  ['Hotel 60 paid by Ana, split Ana ×2, Ben ×1', 'Hotel | 60.00 USD | Ana | Ana x2, Ben x1'],
  ['Hotel 60 paid by Ana, split Ana 2×, Ben 1×', 'Hotel | 60.00 USD | Ana | Ana x2, Ben x1'],
  ['Hotel 60 paid by Ana, split Ana 2 shares, Ben 1 share', 'Hotel | 60.00 USD | Ana | Ana x2, Ben x1'],
  ['Hotel 60 paid by Ana, split Ana x 2, Ben x 1', 'Hotel | 60.00 USD | Ana | Ana x2, Ben x1'],
  ['Hotel 60 paid by Ana, split Ana X2, Ben X1', 'Hotel | 60.00 USD | Ana | Ana x2, Ben x1'],
  ['Hotel 60 paid by Ana, split Ana x1.5, Ben x1', 'Hotel | 60.00 USD | Ana | Ana x1.5, Ben x1'],
  ['Hotel 60 paid by Ana, split Ana .5x, Ben 1,5x', 'Hotel | 60.00 USD | Ana | Ana x0.5, Ben x1.5'],
  ['Hotel 60 paid by Ana, split Ana x02, Ben x1.50', 'Hotel | 60.00 USD | Ana | Ana x2, Ben x1.5'],
  ['Hotel 60 paid by Ana, split between Ana x2, Ben x1, Cy x0', 'Hotel | 60.00 USD | Ana | Ana x2, Ben x1, Cy x0'],
  ['Hotel 3 paid by Ana, split Ana 2, Ben 1', 'Hotel | 3.00 USD | Ana | Ana 2.00, Ben 1.00']
]);

reads('grammar: split equally, and N ways when N is the whole group', [
  ['Hotel 60 paid by Ana, split equally', 'Hotel | 60.00 USD | Ana | all'],
  ['Hotel 60 paid by Ana, split evenly', 'Hotel | 60.00 USD | Ana | all'],
  ['Hotel 60 paid by Ana split equal', 'Hotel | 60.00 USD | Ana | all'],
  ['Hotel 60 paid by Ana, split 5 ways', 'Hotel | 60.00 USD | Ana | all'],
  ['Hotel 60 paid by Ana, split equally 5 ways', 'Hotel | 60.00 USD | Ana | all'],
  ['Hotel 60 split 5 ways, paid by Ana', 'Hotel | 60.00 USD | Ana | all'],
  ['Hotel 60 paid by Ana, split 2 ways between Ana and Ben', 'Hotel | 60.00 USD | Ana | Ana+Ben'],
  ['Hotel 60 paid by Ana, split 4 ways except Dee', 'Hotel | 60.00 USD | Ana | Ana+Ben+Cy+Eli'],
  ['People: Fay\nHotel 60 paid by Ana, split 6 ways', 'Hotel | 60.00 USD | Ana | Ana+Ben+Cy+Dee+Eli+Fay*']
]);

reads('grammar: a payment between two people', [
  ['Cy paid Ana back 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy paid Ana 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy sent Ana $50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy gave Ana 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy repaid Ana 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy -> Ana 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy → Ana 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy --> Ana 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy => Ana 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy->Ana 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['cy paid ana 50.', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy paid back Ana 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy paid Ana 50 back', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy paid Ana €50', 'Cy > Ana | 50.00 EUR | Cy paid Ana back'],
  ['Cy paid Ana 50 EUR', 'Cy > Ana | 50.00 EUR | Cy paid Ana back'],
  ['Cy paid Ana 1 200,50', 'Cy > Ana | 1200.50 USD | Cy paid Ana back'],
  ['Cy transferred Ana 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy refunded Ana 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy reimbursed Ana 50', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy sent 50 to Ana', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy paid 50 to Ana', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy paid 50 back to Ana', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy paid back 50 to Ana', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy gave $50 to Ana', 'Cy > Ana | 50.00 USD | Cy paid Ana back'],
  ['Cy paid Ana 50 for tickets', 'Cy > Ana | 50.00 USD | tickets'],
  ['Cy sent 50 to Ana for the tickets', 'Cy > Ana | 50.00 USD | the tickets'],
  ['Tickets refund: Cy paid Ana 50', 'Cy > Ana | 50.00 USD | Tickets refund'],
  ['"Refund: tickets": Cy paid Ana 50', 'Cy > Ana | 50.00 USD | Refund: tickets'],
  ['Cy paid Ana 50 EUR, rate 1.1251', 'Cy > Ana | 50.00 EUR | Cy paid Ana back | rate 1.1251 USD'],
  ['Cy paid Ana 5000 yen', 'Cy > Ana | 5000 JPY | Cy paid Ana back']
]);

reads('grammar: a rate fixed for one bill', [
  ['Lunch 20 EUR paid by Ana, rate 1.1251', 'Lunch | 20.00 EUR | Ana | all | rate 1.1251 USD'],
  ['Lunch 20 EUR paid by Ana rate 1,1251', 'Lunch | 20.00 EUR | Ana | all | rate 1.1251 USD'],
  ['Lunch €20 rate 1.1 paid by Ana', 'Lunch | 20.00 EUR | Ana | all | rate 1.1 USD'],
  ['Lunch: 20 EUR paid by Ana, rate: 1.1251', 'Lunch | 20.00 EUR | Ana | all | rate 1.1251 USD'],
  ['Lunch 20 EUR paid by Ana, rate 1.1251 USD', 'Lunch | 20.00 EUR | Ana | all | rate 1.1251 USD'],
  ['Lunch 20 EUR paid by Ana, rate 0.85 GBP', 'Lunch | 20.00 EUR | Ana | all | rate 0.85 GBP'],
  ['Lunch 3000 JPY paid by Ana, rate 0.0063', 'Lunch | 3000 JPY | Ana | all | rate 0.0063 USD'],
  ['Lunch 20 EUR paid by Ana, rate 1.10', 'Lunch | 20.00 EUR | Ana | all | rate 1.1 USD'],
  ['Lunch 20 EUR paid by Ana, rate 157,82', 'Lunch | 20.00 EUR | Ana | all | rate 157.82 USD'],
  ['Ana paid 20 EUR for lunch, rate 1.1251', 'lunch | 20.00 EUR | Ana | all | rate 1.1251 USD'],
  ['Lunch 20 GBP paid by Ana, rate 1.17 EUR', 'Lunch | 20.00 GBP | Ana | all | rate 1.17 EUR']
]);

/* ---------- names of bills ---------- */

reads('names: numbers, keywords and punctuation in the name', [
  ['Room 12 45 paid by Ana', 'Room 12 | 45.00 USD | Ana | all'],
  ['7 nights hotel 700 paid by Ana', '7 nights hotel | 700.00 USD | Ana | all'],
  ['Dinner at 19:30 80 paid by Ana', 'Dinner at 19:30 | 80.00 USD | Ana | all'],
  ['Breakfast 7:30 12 paid by Ana', 'Breakfast 7:30 | 12.00 USD | Ana | all'],
  ['Late show 23:59:59 12 paid by Ana', 'Late show 23:59:59 | 12.00 USD | Ana | all'],
  ['Room 12:300 paid by Ana', 'Room 12 | 300.00 USD | Ana | all'],
  ['Windows 8.1 licence: 40 paid by Ana', 'Windows 8.1 licence | 40.00 USD | Ana | all'],
  ['7-Eleven snacks 12.50 paid by Ana', '7-Eleven snacks | 12.50 USD | Ana | all'],
  ['50/50 raffle 10 paid by Ana', '50/50 raffle | 10.00 USD | Ana | all'],
  ['3rd round 24 paid by Ana', '3rd round | 24.00 USD | Ana | all'],
  ['Pizza €20 extra cheese paid by Ana', 'Pizza extra cheese | 20.00 EUR | Ana | all'],
  ['€20 pizza paid by Ana', 'pizza | 20.00 EUR | Ana | all'],
  ['H&M 40 paid by Ana', 'H&M | 40.00 USD | Ana | all'],
  ['Fish + chips 18 paid by Ana', 'Fish + chips | 18.00 USD | Ana | all'],
  ['Tickets for concert 80 paid by Ana', 'Tickets for concert | 80.00 USD | Ana | all'],
  ['Dinner with friends 80 paid by Ana', 'Dinner with friends | 80.00 USD | Ana | all'],
  ['Drinks for everyone 50 paid by Ana', 'Drinks for everyone | 50.00 USD | Ana | all'],
  ['Lunch between flights 25 paid by Ana', 'Lunch between flights | 25.00 USD | Ana | all'],
  ['Cake for my mom 30 paid by Ana', 'Cake for my mom | 30.00 USD | Ana | all'],
  ['Banana split 9 paid by Ana', 'Banana split | 9.00 USD | Ana | all'],
  ['Split pea soup 8 paid by Ana', 'Split pea soup | 8.00 USD | Ana | all'],
  ['Tip 5 paid by Ana', 'Tip | 5.00 USD | Ana | all'],
  ['City tax 12 paid by Ana', 'City tax | 12.00 USD | Ana | all'],
  ['Exchange rate fee 3 paid by Ana', 'Exchange rate fee | 3.00 USD | Ana | all'],
  ['Flowers sent to mum 40 paid by Ana', 'Flowers sent to mum | 40.00 USD | Ana | all'],
  ['Prepaid card 20 paid by Ana', 'Prepaid card | 20.00 USD | Ana | all'],
  ['Ana birthday cake: 30 paid by Ben', 'Ana birthday cake | 30.00 USD | Ben | all'],
  ['Ana\'s birthday 30 paid by Ben', 'Ana\'s birthday | 30.00 USD | Ben | all'],
  ['My birthday cake 30 paid by Ana', 'My birthday cake | 30.00 USD | Ana | all'],
  ['Sale 50% off shoes 40 paid by Ana', 'Sale 50% off shoes | 40.00 USD | Ana | all'],
  ['I am legend: 12 paid by Ana', 'I am legend | 12.00 USD | Ana | all'],
  ['Dinner (late) 30 paid by Ana', 'Dinner (late) | 30.00 USD | Ana | all'],
  ['Café “Lisboa” 30 paid by Ana', 'Café “Lisboa” | 30.00 USD | Ana | all'],
  ['St. Regis hotel 300 paid by Ana', 'St. Regis hotel | 300.00 USD | Ana | all']
]);

reads('names: quotes protect anything', [
  ['"Dinner: the sequel": 120 paid by Ana', 'Dinner: the sequel | 120.00 USD | Ana | all'],
  ['"Dinner: the sequel" 120 paid by Ana', 'Dinner: the sequel | 120.00 USD | Ana | all'],
  ['"Say ""cheese""": 12 paid by Ana', 'Say "cheese" | 12.00 USD | Ana | all'],
  ['“Dinner: the sequel”: 120 paid by Ana', 'Dinner: the sequel | 120.00 USD | Ana | all'],
  ['"Ben": 12 paid by Ana', 'Ben | 12.00 USD | Ana | all'],
  ['"People": 12 paid by Ana', 'People | 12.00 USD | Ana | all'],
  ['"# of nights": 3 paid by Ana', '# of nights | 3.00 USD | Ana | all'],
  ['"- dash": 3 paid by Ana', '- dash | 3.00 USD | Ana | all'],
  ['" spaced ": 3 paid by Ana', ' spaced  | 3.00 USD | Ana | all'],
  ['"2024": 50 paid by Ana', '2024 | 50.00 USD | Ana | all'],
  ['2024: 50 paid by Ana', '2024 | 50.00 USD | Ana | all'],
  ['"Lunch": Ana paid 12', 'Lunch | 12.00 USD | Ana | all']
]);

/* ---------- amounts ---------- */

reads('amounts: every number format of the spec', [
  ['Dinner 120 paid by Ana', 'Dinner | 120.00 USD | Ana | all'],
  ['Dinner 120.5 paid by Ana', 'Dinner | 120.50 USD | Ana | all'],
  ['Dinner 120.50 paid by Ana', 'Dinner | 120.50 USD | Ana | all'],
  ['Dinner 1,200.50 paid by Ana', 'Dinner | 1200.50 USD | Ana | all'],
  ['Dinner: 1 200,50 paid by Ana', 'Dinner | 1200.50 USD | Ana | all'],
  ['Dinner: 1 200 paid by Ana', 'Dinner | 1200.00 USD | Ana | all'],
  ['Dinner: 1 200 300.5 paid by Ana', 'Dinner | 1200300.50 USD | Ana | all'],
  ['Ana paid 1 200,50 for dinner', 'dinner | 1200.50 USD | Ana | all'],
  ['Dinner: 1 200,50 paid by Ana', 'Dinner | 1200.50 USD | Ana | all'],
  ['Dinner: 1 200,50 EUR paid by Ana', 'Dinner | 1200.50 EUR | Ana | all'],
  ['Dinner 1.200,50 paid by Ana', 'Dinner | 1200.50 USD | Ana | all'],
  ['Dinner 12,50 paid by Ana', 'Dinner | 12.50 USD | Ana | all'],
  ['Dinner 12,5 paid by Ana', 'Dinner | 12.50 USD | Ana | all'],
  ['Dinner 0,5 paid by Ana', 'Dinner | 0.50 USD | Ana | all'],
  ['Dinner 1,200 paid by Ana', 'Dinner | 1200.00 USD | Ana | all'],
  ['Dinner 12,345 paid by Ana', 'Dinner | 12345.00 USD | Ana | all'],
  ['Dinner 1,200,300 paid by Ana', 'Dinner | 1200300.00 USD | Ana | all'],
  ['Dinner 1,200,300.75 paid by Ana', 'Dinner | 1200300.75 USD | Ana | all'],
  ['Dinner 1.200.300 paid by Ana', 'Dinner | 1200300.00 USD | Ana | all'],
  ['Dinner 1.200.300,75 paid by Ana', 'Dinner | 1200300.75 USD | Ana | all'],
  ['Dinner 1\'200.50 paid by Ana', 'Dinner | 1200.50 USD | Ana | all'],
  ['Dinner 1’200 paid by Ana', 'Dinner | 1200.00 USD | Ana | all'],
  ['Dinner .50 paid by Ana', 'Dinner | 0.50 USD | Ana | all'],
  ['Dinner 0.05 paid by Ana', 'Dinner | 0.05 USD | Ana | all'],
  ['Dinner 007 paid by Ana', 'Dinner | 7.00 USD | Ana | all'],
  ['Dinner 120.00 paid by Ana', 'Dinner | 120.00 USD | Ana | all'],
  ['Dinner 1234.5 paid by Ana', 'Dinner | 1234.50 USD | Ana | all'],
  ['Dinner 19.99 paid by Ana', 'Dinner | 19.99 USD | Ana | all'],
  ['Dinner 100000000000 paid by Ana', 'Dinner | 100000000000.00 USD | Ana | all'],
  ['Dinner 1000 JPY paid by Ana', 'Dinner | 1000 JPY | Ana | all'],
  ['Dinner 1,000 JPY paid by Ana', 'Dinner | 1000 JPY | Ana | all'],
  ['Dinner 1000.00 JPY paid by Ana', 'Dinner | 1000 JPY | Ana | all'],
  ['Dinner 25000 KRW paid by Ana', 'Dinner | 25000 KRW | Ana | all'],
  ['Dinner 250,000 VND paid by Ana, split Ana 100%', 'Dinner | 250000 VND | Ana | Ana 100%'],
  ['Dinner 2.500.000 VND paid by Ana', 'Dinner | 2500000 VND | Ana | all']
]);

refuses('amounts: what is not accepted as an amount', [
  ['Dinner 0 paid by Ana', 'The amount needs to be more than 0.'],
  ['Dinner 0.00 paid by Ana', 'The amount needs to be more than 0.'],
  ['Dinner -5 paid by Ana', 'An amount cannot be negative. For money paid back, write: Cy paid Ana 50'],
  ['Dinner −5 paid by Ana', 'An amount cannot be negative. For money paid back, write: Cy paid Ana 50'],
  ['Dinner 1.200 paid by Ana', 'Is "1.200" over a thousand? Then write 1200. If not, write 1.20.'],
  ['Dinner 12.345 paid by Ana', 'Is "12.345" over a thousand? Then write 12345. If not, write 12.34.'],
  ['Dinner 120.505 paid by Ana', 'Is "120.505" over a thousand? Then write 120505. If not, write 120.50.'],
  ['Dinner 120.500 EUR paid by Ana', 'Is "120.500" over a thousand? Then write 120500. If not, write 120.50.'],
  ['Dinner 250.000 VND paid by Ana', 'Is "250.000" over a thousand? Then write 250000. If not, write 250.00.'],
  ['Dinner 1234.567 paid by Ana', '1234.567 has too many decimals. USD has 2, like 1234.56.'],
  ['Dinner 12.3456 paid by Ana', '12.3456 has too many decimals. USD has 2, like 12.34.'],
  ['Dinner 12,3456 paid by Ana', '12,3456 has too many decimals. USD has 2, like 12.34.'],
  ['Dinner 1000.5 JPY paid by Ana', 'JPY has no decimals. Write a whole number, like 1000.'],
  ['Dinner 12,5 KRW paid by Ana', 'KRW has no decimals. Write a whole number, like 12.'],
  ['Dinner 1,2,3 paid by Ana', '"1,2,3" is not a number this page can read. Write it like 1200.50'],
  ['Dinner 1.2.3 paid by Ana', '"1.2.3" is not a number this page can read. Write it like 1200.50'],
  ['Dinner 1,00,000 paid by Ana', '"1,00,000" is not a number this page can read. Write it like 1200.50'],
  ['Dinner 99999999999999999 paid by Ana', 'That amount is too large.'],
  ['Dinner 100000000000.01 paid by Ana', 'That amount is too large.'],
  ['Dinner 50% paid by Ana', '"50%" is not an amount. Write a plain number, like 120.'],
  ['Dinner x2 paid by Ana', '"x2" is not an amount. Write a plain number, like 120.'],
  ['Dinner 1 200,50 paid by Ana', '"1 200,50" can be read as one number or as two. Write 1200,50 without the space, or put a colon after the name.'],
  ['Room 12 300 paid by Ana', '"12 300" can be read as one number or as two. Write 12300 without the space, or put a colon after the name.'],
  ['Room €12 300 paid by Ana', '"12 300" can be read as one number or as two. Write 12300 without the space, or put a colon after the name.'],
  ['Flight 2 500 300 paid by Ana', '"500 300" can be read as one number or as two. Write 500300 without the space, or put a colon after the name.'],
  ['Dinner 120 total paid by Ana', 'Is 120 the amount? Then put it last. Or put a colon after the name, like: Dinner: 120 paid by Ana'],
  ['2 pizzas paid by Ana', 'Is 2 the amount? Then put it last. Or put a colon after the name, like: Dinner: 120 paid by Ana'],
  ['Tickets 30 each paid by Ana', '"30 each" is a price for one person. Write the total instead.'],
  ['Tickets 30 pp paid by Ana', '"30 each" is a price for one person. Write the total instead.'],
  ['Tickets 30 per person paid by Ana', '"30 each" is a price for one person. Write the total instead.'],
  ['Dinner €20 $30 paid by Ana', 'There are two amounts here, €20 and $30. Keep one.'],
  ['Hotel €700 room 12 paid by Ana', 'Is the amount €700 or 12? Put a colon after the name, then the amount.'],
  ['Dinner 7 JPY 1000 paid by Ana', 'Is the amount 7 JPY or 1000? Put a colon after the name, then the amount.'],
  ['Lunch 12,50 5 paid by Ana', 'Is the amount 5 or 12,50? Put a colon after the name, then the amount.'],
  ['Lunch 12,50,.5 paid by Ana', 'Is the amount .5 or 12,50? Put a colon after the name, then the amount.'],
  ['Banana split 0.99 1.200,50 paid by Ana', 'Is the amount 1.200,50 or 0.99? Put a colon after the name, then the amount.'],
  ['Ana paid for windows 8.1 licence 40', 'Is the amount 40 or 8.1? Put a colon after the name, then the amount.'],
  ['7 nights1,200 paid by Cy', 'Is 7 the amount? Then put it last. Or put a colon after the name, like: Dinner: 120 paid by Ana'],
  ['Dinnerx112,50 paid by Ben', 'How much was it? Add the amount after the name, like: Dinner 120 paid by Ana'],
  ['Room12,300 paid by Ana', 'How much was it? Add the amount after the name, like: Dinner 120 paid by Ana'],
  ['Score 3:2 20 paid by Ana', ['"20" is not clear here. After the amount comes "paid by" and a name.', 'The colon makes "Score 3" the name of the bill.']],
  ['Dinner 20 EUR 30 USD paid by Ana', 'There are two amounts here, 20 EUR and 30 USD. Keep one.'],
  ['Dinner € at Joe\'s 120 paid by Ana', '"€" is not next to a number. Write it with the amount, like €120.'],
  ['Dinner €120 EUR USD paid by Ana', '"€120 EUR USD" names two currencies. Keep one.'],
  ['Dinner USD €120 paid by Ana', '"USD €120" names two currencies. Keep one.'],
  ['Dinner €120 dollars paid by Ana', '"€120 dollars" names two currencies. Keep one.'],
  ['Dinner €120 USD paid by Ana', '"€120 USD" names two currencies. Keep one.'],
  ['Dinner 120paid', ['How much was it? Add the amount after the name, like: Dinner 120 paid by Ana', 'Who paid? Add: paid by <name>']],
  ['Dinner 5k paid by Ana', 'How much was it? Add the amount after the name, like: Dinner 120 paid by Ana'],
  ['2024 50 paid by Ana', 'Is "2024" the name of the bill? Then put a colon after it, like: 2024: 45 paid by Ana. If not, add a name in words.'],
  ['Ana paid 12,50 for 12', 'Is "12" the name of the bill? Then put a colon after it, like: 12: 45 paid by Ana. If not, add a name in words.']
]);

/* ---------- currencies ---------- */

describe('currencies: every code, in any case, after, before or glued to the number', () => {
  const g = G();
  for (const code of CURRENCIES) {
    test(code, () => {
      const amount = minorDigits(code) ? '12.00' : '12';
      const loose = ['TRY', 'PHP', 'CAD', 'AED'].includes(code);
      const forms = ['12 ' + code, '12 ' + code.toLowerCase(), '12' + code, '12' + code.toLowerCase(), code + '12', '12 ' + code[0] + code.slice(1).toLowerCase()];
      if (!loose) forms.push(code + ' 12', code.toLowerCase() + ' 12');
      for (const form of forms) {
        if (form === '12 try' || form === '12 Try') continue;   // asked about, see below
        const d = lastDraft('Dinner ' + form + ' paid by Ana', g);
        assert.deepEqual(d.errors, [], form);
        assert.equal(brief(g, d.bill), 'Dinner | ' + amount + ' ' + code + ' | Ana | all', form);
      }
      // After a colon nothing but the amount can stand there, so every form is taken.
      for (const form of [code + ' 12', code.toLowerCase() + ' 12', '12 ' + code.toLowerCase()]) {
        assert.equal(brief(g, lastDraft('Dinner: ' + form + ' paid by Ana', g).bill), 'Dinner | ' + amount + ' ' + code + ' | Ana | all', form);
        assert.equal(brief(g, lastDraft('Ana paid ' + form + ' for dinner', g).bill), 'dinner | ' + amount + ' ' + code + ' | Ana | all', form);
      }
    });
  }
});

reads('currencies: signs and words', [
  ['Dinner €12 paid by Ana', 'Dinner | 12.00 EUR | Ana | all'],
  ['Dinner 12€ paid by Ana', 'Dinner | 12.00 EUR | Ana | all'],
  ['Dinner 12 € paid by Ana', 'Dinner | 12.00 EUR | Ana | all'],
  ['Dinner € 12 paid by Ana', 'Dinner | 12.00 EUR | Ana | all'],
  ['Dinner £12 paid by Ana', 'Dinner | 12.00 GBP | Ana | all'],
  ['Dinner ₹1200 paid by Ana', 'Dinner | 1200.00 INR | Ana | all'],
  ['Dinner ₩12000 paid by Ana', 'Dinner | 12000 KRW | Ana | all'],
  ['Dinner ₫120000 paid by Ana', 'Dinner | 120000 VND | Ana | all'],
  ['Dinner ₺120 paid by Ana', 'Dinner | 120.00 TRY | Ana | all'],
  ['Dinner ₪120 paid by Ana', 'Dinner | 120.00 ILS | Ana | all'],
  ['Dinner ₱120 paid by Ana', 'Dinner | 120.00 PHP | Ana | all'],
  ['Dinner ฿120 paid by Ana', 'Dinner | 120.00 THB | Ana | all'],
  ['Dinner $12 paid by Ana', 'Dinner | 12.00 USD | Ana | all'],
  ['Dinner 12$ paid by Ana', 'Dinner | 12.00 USD | Ana | all'],
  ['Dinner ¥1200 paid by Ana', 'Dinner | 1200 JPY | Ana | all'],
  ['Dinner ￥1200 paid by Ana', 'Dinner | 1200 JPY | Ana | all'],
  ['Dinner US$12 paid by Ana', 'Dinner | 12.00 USD | Ana | all'],
  ['Dinner A$12 paid by Ana', 'Dinner | 12.00 AUD | Ana | all'],
  ['Dinner C$12 paid by Ana', 'Dinner | 12.00 CAD | Ana | all'],
  ['Dinner NZ$12 paid by Ana', 'Dinner | 12.00 NZD | Ana | all'],
  ['Dinner HK$12 paid by Ana', 'Dinner | 12.00 HKD | Ana | all'],
  ['Dinner S$12 paid by Ana', 'Dinner | 12.00 SGD | Ana | all'],
  ['Dinner NT$12 paid by Ana', 'Dinner | 12.00 TWD | Ana | all'],
  ['Dinner R$12 paid by Ana', 'Dinner | 12.00 BRL | Ana | all'],
  ['Dinner MX$12 paid by Ana', 'Dinner | 12.00 MXN | Ana | all'],
  ['Dinner 12 euro paid by Ana', 'Dinner | 12.00 EUR | Ana | all'],
  ['Dinner 12 euros paid by Ana', 'Dinner | 12.00 EUR | Ana | all'],
  ['Dinner 12 Euros paid by Ana', 'Dinner | 12.00 EUR | Ana | all'],
  ['Dinner 12euros paid by Ana', 'Dinner | 12.00 EUR | Ana | all'],
  ['Dinner 1 pound paid by Ana', 'Dinner | 1.00 GBP | Ana | all'],
  ['Dinner 12 pounds paid by Ana', 'Dinner | 12.00 GBP | Ana | all'],
  ['Dinner 1200 yen paid by Ana', 'Dinner | 1200 JPY | Ana | all'],
  ['Dinner 120 yuan paid by Ana', 'Dinner | 120.00 CNY | Ana | all'],
  ['Dinner 1 rupee paid by Ana', 'Dinner | 1.00 INR | Ana | all'],
  ['Dinner 120 rupees paid by Ana', 'Dinner | 120.00 INR | Ana | all'],
  ['Dinner 1 franc paid by Ana', 'Dinner | 1.00 CHF | Ana | all'],
  ['Dinner 120 francs paid by Ana', 'Dinner | 120.00 CHF | Ana | all'],
  ['Dinner 1 dollar paid by Ana', 'Dinner | 1.00 USD | Ana | all'],
  ['Dinner 120 dollars paid by Ana', 'Dinner | 120.00 USD | Ana | all'],
  ['Dinner 120 bucks paid by Ana', 'Dinner | 120.00 USD | Ana | all'],
  ['Dinner 1 buck paid by Ana', 'Dinner | 1.00 USD | Ana | all'],
  ['Dinner €120 EUR paid by Ana', 'Dinner | 120.00 EUR | Ana | all'],
  ['Euro trip snacks 12 paid by Ana', 'Euro trip snacks | 12.00 USD | Ana | all'],
  ['Pound cake 12 paid by Ana', 'Pound cake | 12.00 USD | Ana | all']
]);

reads('currencies: no mark means the last "Currency:" line, else the group\'s currency', [
  ['Dinner 12 paid by Ana', 'Dinner | 12.00 USD | Ana | all'],
  ['Currency: EUR\nDinner 12 paid by Ana', 'Dinner | 12.00 EUR | Ana | all'],
  ['currency: eur\nDinner 12 paid by Ana', 'Dinner | 12.00 EUR | Ana | all'],
  ['CURRENCY : €\nDinner 12 paid by Ana', 'Dinner | 12.00 EUR | Ana | all'],
  ['Currency: euros\nDinner 12 paid by Ana', 'Dinner | 12.00 EUR | Ana | all'],
  ['Currency: yen\nDinner 1200 paid by Ana', 'Dinner | 1200 JPY | Ana | all'],
  ['Currency: $\nDinner 12 paid by Ana', 'Dinner | 12.00 USD | Ana | all'],
  ['Currency: EUR\nCurrency: GBP\nDinner 12 paid by Ana', 'Dinner | 12.00 GBP | Ana | all'],
  ['Currency: EUR\nDinner 12 USD paid by Ana', 'Dinner | 12.00 USD | Ana | all'],
  ['Currency: EUR\nDinner $12 paid by Ana', 'Dinner | 12.00 USD | Ana | all'],
  ['Currency: EUR\nCy paid Ana 50', 'Cy > Ana | 50.00 EUR | Cy paid Ana back'],
  ['Currency: EUR\nLunch, paid by Ben\n  - Soup 5 Ana', 'Lunch | 5.00 EUR | Ben | items[Soup 5.00: Ana]'],
  ['Currency: xyz\nDinner 12 paid by Ana', 'Dinner | 12.00 USD | Ana | all'],
  ['Dinner 12 paid by Ana\nCurrency: EUR\nTaxi 9 paid by Ana', 'Taxi | 9.00 EUR | Ana | all']
]);

describe('currencies: "$" and "¥" depend on the group', () => {
  const read = (text, currency) => { const g = G({ currency }), d = lastDraft(text, g); return d.ok ? brief(g, d.bill) : d.errors[0]; };
  test('"$" is the group\'s own dollar, else USD', () => {
    for (const base of ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD']) {
      assert.equal(read('Dinner $45 paid by Ana', base), 'Dinner | 45.00 ' + base + ' | Ana | all');
      assert.equal(read('Dinner 45 dollars paid by Ana', base), 'Dinner | 45.00 ' + base + ' | Ana | all');
      assert.equal(read('Dinner 45 bucks paid by Ana', base), 'Dinner | 45.00 ' + base + ' | Ana | all');
    }
    for (const base of ['EUR', 'GBP', 'CHF', 'BRL', 'INR']) {
      assert.equal(read('Dinner $45 paid by Ana', base), 'Dinner | 45.00 USD | Ana | all');
      assert.equal(read('Dinner 45 dollars paid by Ana', base), 'Dinner | 45.00 USD | Ana | all');
    }
    assert.equal(read('Dinner $450 paid by Ana', 'JPY'), 'Dinner | 450.00 USD | Ana | all');
  });
  test('"¥" is CNY in a CNY group, else JPY', () => {
    assert.equal(read('Dinner ¥45 paid by Ana', 'CNY'), 'Dinner | 45.00 CNY | Ana | all');
    for (const base of ['JPY', 'USD', 'EUR']) assert.equal(read('Dinner ¥45 paid by Ana', base), 'Dinner | 45 JPY | Ana | all');
    assert.equal(read('Dinner 45 yen paid by Ana', 'CNY'), 'Dinner | 45 JPY | Ana | all');
    assert.equal(read('Dinner 45 yuan paid by Ana', 'JPY'), 'Dinner | 45.00 CNY | Ana | all');
  });
  test('two likely readings are refused, not guessed', () => {
    assert.equal(read('Currency: CAD\nDinner $45 paid by Ana', 'USD'), '"$" could mean USD or CAD here. Write the code after the amount, like 45 CAD.');
    assert.equal(read('Currency: CAD\nDinner 45 dollars paid by Ana', 'USD'), '"dollars" could mean USD or CAD here. Write the code after the amount, like 45 CAD.');
    assert.equal(read('Currency: CAD\nDinner $45 paid by Ana', 'EUR'), '"$" could mean USD or CAD here. Write the code after the amount, like 45 CAD.');
    assert.equal(read('Currency: USD\nDinner $45 paid by Ana', 'AUD'), '"$" could mean AUD or USD here. Write the code after the amount, like 45 USD.');
    assert.equal(read('Dinner $45 paid by Ana', 'MXN'), '"$" could mean USD or MXN here. Write the code after the amount, like 45 MXN.');
    assert.equal(read('Currency: MXN\nDinner $45 paid by Ana', 'USD'), '"$" could mean USD or MXN here. Write the code after the amount, like 45 MXN.');
    assert.equal(read('Currency: JPY\nDinner ¥45 paid by Ana', 'CNY'), '"¥" could mean CNY or JPY here. Write the code after the amount, like 45 JPY.');
    assert.equal(read('Currency: CNY\nDinner ¥45 paid by Ana', 'USD'), '"¥" could mean JPY or CNY here. Write the code after the amount, like 45 CNY.');
  });
  test('a "Currency:" line with a sign follows the same rule', () => {
    assert.equal(read('Currency: $\nDinner 45 paid by Ana', 'CAD'), 'Dinner | 45.00 CAD | Ana | all');
    assert.equal(read('Currency: $\nDinner 45 paid by Ana', 'EUR'), 'Dinner | 45.00 USD | Ana | all');
    assert.equal(read('Currency: dollars\nDinner 45 paid by Ana', 'AUD'), 'Dinner | 45.00 AUD | Ana | all');
    assert.equal(read('Currency: ¥\nDinner 45 paid by Ana', 'CNY'), 'Dinner | 45.00 CNY | Ana | all');
    assert.equal(read('Currency: ¥\nDinner 45 paid by Ana', 'USD'), 'Dinner | 45 JPY | Ana | all');
    assert.equal(parseText('Currency: £', G()).defaultCurrency, 'GBP');
  });
  test('one reading is taken', () => {
    assert.equal(read('Currency: CAD\nDinner $45 paid by Ana', 'CAD'), 'Dinner | 45.00 CAD | Ana | all');
    assert.equal(read('Currency: EUR\nDinner $45 paid by Ana', 'CAD'), 'Dinner | 45.00 CAD | Ana | all');
    assert.equal(read('Dinner 45 dollars paid by Ana', 'MXN'), 'Dinner | 45.00 USD | Ana | all');
    assert.equal(read('Dinner 45 paid by Ana', 'MXN'), 'Dinner | 45.00 MXN | Ana | all');
    assert.equal(read('Currency: USD\nDinner ¥45 paid by Ana', 'CNY'), 'Dinner | 45.00 CNY | Ana | all');
    assert.equal(read('Currency: CAD\nDinner US$45 paid by Ana', 'USD'), 'Dinner | 45.00 USD | Ana | all');
  });
});

refuses('currencies: marks that are not believed', [
  ['Dinner 120 RUB paid by Ana', '"RUB" is not a currency this page knows. It knows: ' + CURRENCIES.join(', ') + '.'],
  ['Dinner: 120 RUB paid by Ana', '"RUB" is not a currency this page knows. It knows: ' + CURRENCIES.join(', ') + '.'],
  ['Ana paid 120 RUB for dinner', '"RUB" is not a currency this page knows. It knows: ' + CURRENCIES.join(', ') + '.'],
  ['Currency: xyz', '"xyz" is not a currency this page knows. It knows: ' + CURRENCIES.join(', ') + '.'],
  ['Currency:', 'Add a currency code after the colon, like: Currency: EUR'],
  ['Second try 40 paid by Ana', 'Is "try 40" an amount in TRY? Then write 40 TRY. If not, put a colon after the name.'],
  ['Second 40 try paid by Ana', 'Is "40 try" an amount in TRY? Then write 40 TRY. If not, put a colon after the name.'],
  ['Second TRY 40 paid by Ana', 'Is "TRY 40" an amount in TRY? Then write 40 TRY. If not, put a colon after the name.'],
  ['Learn PHP 30 paid by Ana', 'Is "PHP 30" an amount in PHP? Then write 30 PHP. If not, put a colon after the name.'],
  ['Fusion cad 300 paid by Ana', 'Is "cad 300" an amount in CAD? Then write 300 CAD. If not, put a colon after the name.'],
  ['Buy AED 500 paid by Ana', 'Is "AED 500" an amount in AED? Then write 500 AED. If not, put a colon after the name.'],
  ['Dinner 120 paid by Ana, rate 1.1', 'This bill is in USD, the group\'s currency, so it needs no rate. Remove the rate, or add the bill\'s currency, like 120 EUR.'],
  ['Dinner 120 USD paid by Ana, rate 0.9 EUR', 'This bill is in USD, the group\'s currency, so it needs no rate. Remove the rate, or add the bill\'s currency, like 120 EUR.'],
  ['Dinner 7 JPY 1000 nights paid by Ana', '"7 JPY 1000" can be read two ways. Keep the amount and its currency together, away from other numbers.'],
  ['Dinner 7 € 1000 nights paid by Ana', '"7 € 1000" can be read two ways. Keep the amount and its currency together, away from other numbers.'],
  ['Ana paid 7 JPY 1000 for dinner', '"1000" is not clear here. To name the bill, write it like: Ana paid 30 for lunch'],
  ['Dinner 120 EUR paid by Ana, rate 1.1 EUR', 'A rate goes from one currency to another. Both are EUR here.'],
  ['Dinner 120 EUR paid by Ana, rate abc', 'Write the rate as a plain number with a dot, like: rate 1.1251'],
  ['Dinner 120 EUR paid by Ana, rate 0', 'Write the rate as a plain number with a dot, like: rate 1.1251'],
  ['Dinner 120 EUR paid by Ana, rate 1,125', 'Write the rate as a plain number with a dot, like: rate 1.1251'],
  ['Dinner 120 EUR paid by Ana, rate 10%', 'Write the rate as a plain number with a dot, like: rate 1.1251'],
  ['Dinner 120 EUR paid by Ana, rate €1.1', 'Write the rate as a plain number with a dot, like: rate 1.1251'],
  ['Dinner 120 EUR paid by Ana, rate 1.1 1.2', 'Write the rate as a plain number with a dot, like: rate 1.1251'],
  ['Dinner 120 EUR paid by Ana, rate 1.1, rate 1.2', 'This line has a rate twice. Keep one.']
]);

test('currencies: a colon keeps "PHP" and "try" in the name', () => {
  const g = G();
  assert.equal(brief(g, lastDraft('Learn PHP: 30 paid by Ana', g).bill), 'Learn PHP | 30.00 USD | Ana | all');
  assert.equal(brief(g, lastDraft('Second try: 40 paid by Ana', g).bill), 'Second try | 40.00 USD | Ana | all');
  assert.equal(brief(g, lastDraft('Dinner 40 TRY paid by Ana', g).bill), 'Dinner | 40.00 TRY | Ana | all');
  assert.equal(brief(g, lastDraft('Dinner 40try paid by Ana', g).bill), 'Dinner | 40.00 TRY | Ana | all');
  assert.equal(brief(g, lastDraft('Dinner: 40 try paid by Ana', g).bill), 'Dinner | 40.00 TRY | Ana | all');
});

test('currencies: without a rate for the pair, the line says where to type one', () => {
  const g = G({ currency: 'XTS' });   // a code no table knows
  assert.deepEqual(lastDraft('Dinner 120 EUR paid by Ana', g).errors, ['No exchange rate for EUR to XTS. Type one under GROUP.']);
  assert.equal(lastDraft('Dinner 120 EUR paid by Ana, rate 2', g).ok, true, 'a rate on the line is enough');
  assert.equal(lastDraft('Dinner 120 paid by Ana', g).ok, true, 'the group\'s own currency needs none');
});

/* ---------- people ---------- */

const CREW = () => G({ people: people(['Mary Ann', 'Mary', 'Ann', 'O\'Brien', 'José', 'Bernard', 'Al']) });

reads('people: names match in any case, whole words, longest first', [
  ['Dinner 30 paid by Mary Ann for Mary and Ann', 'Dinner | 30.00 USD | Mary Ann | Mary+Ann'],
  ['Dinner 30 paid by mary ann, split with ANN', 'Dinner | 30.00 USD | Mary Ann | Mary Ann+Ann'],
  ['Dinner 30 paid by Mary, Ann', 'Dinner | 30.00 USD | Mary+Ann | all'],
  ['Dinner 30 paid by Mary and Ann', 'Dinner | 30.00 USD | Mary+Ann | all'],
  ['Dinner 30 paid by Mary Ann and Mary', 'Dinner | 30.00 USD | Mary Ann+Mary | all'],
  ['Dinner 30 paid by O\'Brien', 'Dinner | 30.00 USD | O\'Brien | all'],
  ['Dinner 30 paid by O’Brien', 'Dinner | 30.00 USD | O\'Brien | all'],
  ['Dinner 30 paid by o\'brien, split with josé', 'Dinner | 30.00 USD | O\'Brien | O\'Brien+José'],
  ['Dinner 30 paid by José', 'Dinner | 30.00 USD | José | all'],
  ['Mary\'s dinner 30 paid by Al', 'Mary\'s dinner | 30.00 USD | Al | all'],
  ['Al dente pasta: 30 paid by Al', 'Al dente pasta | 30.00 USD | Al | all'],
  ['Mary Ann paid 30 for lunch', 'lunch | 30.00 USD | Mary Ann | all'],
  ['Mary Ann paid Mary 30', 'Mary Ann > Mary | 30.00 USD | Mary Ann paid Mary back'],
  ['Dinner 30 paid by Mary-Lou', 'Dinner | 30.00 USD | Mary-Lou* | Mary Ann+Mary+Ann+O\'Brien+José+Bernard+Al+Mary-Lou*'],
  ['Dinner 30 paid by Anna-Maria for Al', 'Dinner | 30.00 USD | Anna-Maria* | Al']
], CREW);

reads('people: a new person is one capitalised word between separators', [
  ['Dinner 120 paid by Fay', 'Dinner | 120.00 USD | Fay* | Ana+Ben+Cy+Dee+Eli+Fay*'],
  ['Dinner 120 paid by Ana for Fay and Ben', 'Dinner | 120.00 USD | Ana | Fay*+Ben'],
  ['Dinner 120 paid by Ana, split with Fay', 'Dinner | 120.00 USD | Ana | Ana+Fay*'],
  ['Dinner 120 paid by Ana, split Ana 60, Fay 60', 'Dinner | 120.00 USD | Ana | Ana 60.00, Fay* 60.00'],
  ['Dinner 120 paid by Ana 80, Fay 40', 'Dinner | 120.00 USD | Ana 80.00, Fay* 40.00 | Ana+Ben+Cy+Dee+Eli+Fay*'],
  ['Fay paid 30 for lunch', 'lunch | 30.00 USD | Fay* | Ana+Ben+Cy+Dee+Eli+Fay*'],
  ['Fay and Gus paid 30 for lunch', 'lunch | 30.00 USD | Fay*+Gus* | Ana+Ben+Cy+Dee+Eli+Fay*+Gus*'],
  ['Dinner 120 paid by Ana for Fay, Fay-Lynn and D\'Arcy', 'Dinner | 120.00 USD | Ana | Fay*+Fay-Lynn*+D\'Arcy*'],
  ['Dinner 120 paid by 小明', 'Dinner | 120.00 USD | 小明* | Ana+Ben+Cy+Dee+Eli+小明*'],
  ['Dinner 120 paid by Émile', 'Dinner | 120.00 USD | Émile* | Ana+Ben+Cy+Dee+Eli+Émile*'],
  ['Lunch, paid by Ben\n  - Soup 5 Fay', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: Fay*]'],
  ['Dinner 120 paid by Fay for everyone', 'Dinner | 120.00 USD | Fay* | Ana+Ben+Cy+Dee+Eli+Fay*'],
  ['Dinner 120 paid by Fay for everyone except Fay', 'Dinner | 120.00 USD | Fay* | all'],
  ['Dinner 120 paid by Fay\nTaxi 20 paid by fay', 'Taxi | 20.00 USD | Fay* | Ana+Ben+Cy+Dee+Eli+Fay*'],
  ['Dinner 120 paid by Fay\nTaxi 20 paid by Ana', 'Taxi | 20.00 USD | Ana | Ana+Ben+Cy+Dee+Eli+Fay*'],
  ['People: Fay\nTaxi 20 paid by Ana', 'Taxi | 20.00 USD | Ana | Ana+Ben+Cy+Dee+Eli+Fay*'],
  ['People: Fay\nFay paid Ana 5', 'Fay* > Ana | 5.00 USD | Fay paid Ana back'],
  ['People: Bne\nTaxi 20 paid by Bne for Ben', 'Taxi | 20.00 USD | Bne* | Ben'],
  ['People: fay\nTaxi 20 paid by Fay for Ben', 'Taxi | 20.00 USD | fay* | Ben']
]);

test('people: newPeople names who an entry adds, and the result lists everyone', () => {
  const res = parseText('Dinner 120 paid by Fay\nTaxi 20 paid by Fay for Gus\nPeople: Hal, Ana\nBroken paid by Ian\nI am Jo', G());
  assert.deepEqual(res.drafts.map(d => d.newPeople), [['Fay'], ['Gus'], ['Hal'], [], ['Jo']]);
  assert.deepEqual(res.drafts.map(d => d.ok), [true, true, true, false, true]);
  assert.deepEqual(res.drafts[2].warnings, ['Ana is already in the group.']);
  assert.deepEqual(res.people.filter(p => p.isNew).map(p => p.name), ['Fay', 'Gus', 'Hal', 'Jo'], 'a line that is not ok adds nobody');
  assert.equal(res.me, 'new:Jo');
  assert.deepEqual(res.drafts[1].bill.split.who, ['new:Gus']);
  assert.equal(res.drafts[1].bill.paid.who[0], 'new:Fay');
});

refuses('people: a name that looks like a typo is asked about', [
  ['Dinner 120 paid by Bne', 'Bne is not in the group. Did you mean Ben? To add a new person, write: People: Bne'],
  ['Dinner 120 paid by Bem', 'Bem is not in the group. Did you mean Ben? To add a new person, write: People: Bem'],
  ['Dinner 120 paid by Be', 'Be is not in the group. Did you mean Ben? To add a new person, write: People: Be'],
  ['Dinner 120 paid by Benn', 'Benn is not in the group. Did you mean Ben? To add a new person, write: People: Benn'],
  ['Dinner 120 paid by bne', 'bne is not in the group. Did you mean Ben? To add a new person, write: People: bne'],
  ['Dinner 120 paid by Ana for Ty', 'Ty is not in the group. Did you mean Cy? To add a new person, write: People: Ty'],
  ['Dinner 120 paid by Ana, split with Elli', 'Elli is not in the group. Did you mean Eli? To add a new person, write: People: Elli'],
  ['Bne paid 30 for lunch', 'Bne is not in the group. Did you mean Ben? To add a new person, write: People: Bne'],
  ['Cy paid Bne 30', '"Bne" is not a person in the group. For a bill, write its name first, like: Taxi 30 paid by Ana'],
  ['Ana paid 30 for Bne', 'Bne is not in the group. Did you mean Ben? If "Bne" is the name of the bill, start with it: Bne: 30 paid by Ana'],
  ['I am Bne', 'Bne is not in the group. Did you mean Ben? To add a new person, write: People: Bne'],
  ['Lunch, paid by Ben\n  - Soup 5 Bne', 'Line 2: Bne is not in the group. Did you mean Ben? To add a new person, write: People: Bne']
]);

describe('people: how near is near', () => {
  const g = CREW();
  const err = text => lastDraft(text, g).errors[0];
  test('one edit for short names, a swap counts as one', () => {
    assert.match(err('Dinner 30 paid by Mray'), /Did you mean Mary\?/);
    assert.match(err('Dinner 30 paid by Marry'), /Did you mean Mary\?/);
    assert.match(err('Dinner 30 paid by Mar'), /Did you mean Mary\?/);
    assert.match(err('Dinner 30 paid by Ali'), /Did you mean Al\?/);
    assert.match(err('Dinner 30 paid by Josè'), /Did you mean José\?/);
  });
  test('two edits for names of six letters or more', () => {
    assert.match(err('Dinner 30 paid by Bernrad'), /Did you mean Bernard\?/);
    assert.match(err('Dinner 30 paid by Benard'), /Did you mean Bernard\?/);
    assert.match(err('Dinner 30 paid by Bernhardt'), /Did you mean Bernard\?/);
    assert.match(err('Dinner 30 paid by Obrien'), /Did you mean O'Brien\?/);
  });
  test('further away is a new person', () => {
    assert.deepEqual(lastDraft('Dinner 30 paid by Marta', g).newPeople, ['Marta']);
    assert.deepEqual(lastDraft('Dinner 30 paid by Bert', g).newPeople, ['Bert']);
    assert.deepEqual(lastDraft('Dinner 30 paid by Alex', g).newPeople, ['Alex']);
  });
  test('of two near names, the nearest is offered, and the first on a tie', () => {
    const two = G({ people: people(['Bea', 'Ben', 'Bernard']) });
    assert.match(lastDraft('Dinner 30 paid by Bex', two).errors[0], /Did you mean Bea\?/);
    assert.match(lastDraft('Dinner 30 paid by Benn', two).errors[0], /Did you mean Ben\?/);
    assert.match(lastDraft('Dinner 30 paid by Bernar', two).errors[0], /Did you mean Bernard\?/);
  });
  test('"People:" is the way to add a name that looks like a typo', () => {
    const res = parseText('People: Mray\nDinner 30 paid by Mray', g);
    assert.deepEqual(res.drafts.map(d => d.ok), [true, true]);
    assert.deepEqual(res.drafts[0].newPeople, ['Mray']);
  });
});

refuses('people: who is not offered as a new person', [
  ['Dinner 120 paid by fay', '"fay" is not a person in the group.'],
  ['Dinner 120 paid by the waiter', '"the waiter" is not a person in the group.'],
  ['Dinner 120 paid by Mary Jane', '"Mary Jane" is not in the group. To add a new person, write: People: Mary Jane'],
  ['Dinner 120 paid by Ana Fay', '"Fay" is not in the group. To add a new person, write: People: Fay'],
  ['Dinner 120 paid by Fay Ana', '"Fay" is not in the group. To add a new person, write: People: Fay'],
  ['Dinner 120 paid by Ana for the airport', '"the airport" is not a person in the group. If it belongs to the name of the bill, put a colon after the name.'],
  ['Dinner 120 paid by Ana with wine', '"wine" is not a person in the group. If it belongs to the name of the bill, put a colon after the name.'],
  ['Dinner: 120 paid by Ana with wine', '"wine" is not a person in the group.'],
  ['Dinner 120 paid by Ana for everyone except Fay', '"Fay" is not in the group. To add a new person, write: People: Fay'],
  ['Dinner 120 paid by Ana for Fay\'s', '"Fay\'s" is not a person in the group. If it belongs to the name of the bill, put a colon after the name.'],
  ['Dinner 120 paid by EUR', '"EUR" is not a person in the group.'],
  ['Dinner 120 paid by Ana for Euro and Ben', '"Euro" is not a person in the group. If it belongs to the name of the bill, put a colon after the name.'],
  ['Dinner 120 paid by R2D2', '"R2D2" is not a person in the group.'],
  ['Dinner 120 paid by ' + 'A' + 'b'.repeat(40), '"A' + 'b'.repeat(40) + '" is not a person in the group.'],
  ['Cy paid Fay 50', '"Fay" is not a person in the group. For a bill, write its name first, like: Taxi 30 paid by Ana'],
  ['Fay paid Ana 50', 'Fay is not in the group yet. Add them first: People: Fay'],
  ['Cy sent 50 to Fay', 'Fay is not in the group yet. Add them first: People: Fay'],
  ['Cy sent 50 to the bank', '"the bank" is not a person in the group. For a bill, write its name first, like: Taxi 50 paid by Ana'],
  ['Dinner 120 paid by 45', '"45" is not clear here. A name belongs in this place.'],
  ['Dinner 120 paid by', 'Who paid? Add a name after "paid by".'],
  ['Dinner 120 paid by ,', 'Who paid? Add a name after "paid by".']
]);

reads('people: "I am", "I\'m" and "Me:" let you write I, me, my, myself', [
  ['I am Ana\nCoffee 4 paid by me', 'Coffee | 4.00 USD | Ana | all'],
  ['I\'m Ana\nCoffee 4 paid by me', 'Coffee | 4.00 USD | Ana | all'],
  ['I’m Ana\nCoffee 4 paid by me', 'Coffee | 4.00 USD | Ana | all'],
  ['Me: Ana\nCoffee 4 paid by me', 'Coffee | 4.00 USD | Ana | all'],
  ['i am ana.\nCoffee 4 paid by Me', 'Coffee | 4.00 USD | Ana | all'],
  ['me : ana\nCoffee 4 paid by myself', 'Coffee | 4.00 USD | Ana | all'],
  ['I am Ana\nI paid 30 for lunch', 'lunch | 30.00 USD | Ana | all'],
  ['I am Ana\ni paid 30 for lunch', 'lunch | 30.00 USD | Ana | all'],
  ['I am Ana\nCy paid me 5', 'Cy > Ana | 5.00 USD | Cy paid Ana back'],
  ['I am Ana\nI paid Cy 5', 'Ana > Cy | 5.00 USD | Ana paid Cy back'],
  ['I am Ana\nMe and Ben paid 40 for lunch', 'lunch | 40.00 USD | Ana+Ben | all'],
  ['I am Ana\nTaxi 10 paid by Ben for me and Cy', 'Taxi | 10.00 USD | Ben | Ana+Cy'],
  ['I am Ana\nTaxi 10 paid by Ben, split with me', 'Taxi | 10.00 USD | Ben | Ben+Ana'],
  ['I am Ana\nTaxi 10 paid by Ben, split me 4, Cy 6', 'Taxi | 10.00 USD | Ben | Ana 4.00, Cy 6.00'],
  ['I am Ana\nTaxi 10 paid by Ben for everyone except me', 'Taxi | 10.00 USD | Ben | Ben+Cy+Dee+Eli'],
  ['I am Ana\nI am Ben\nCoffee 4 paid by me', 'Coffee | 4.00 USD | Ben | all'],
  ['I am Fay\nCoffee 4 paid by me', 'Coffee | 4.00 USD | Fay* | Ana+Ben+Cy+Dee+Eli+Fay*'],
  ['I am Mary Jane\nCoffee 4 paid by me for Ana', 'Coffee | 4.00 USD | Mary Jane* | Ana'],
  ['I am Ana\nMy birthday cake 30 paid by me', 'My birthday cake | 30.00 USD | Ana | all'],
  ['I am Ana\nLunch, paid by me\n  - Soup 5 me, Ben', 'Lunch | 5.00 USD | Ana | items[Soup 5.00: Ana+Ben]']
]);

reads('people: opts.me says who "me" is, and an "I am" line wins over it', [
  ['Coffee 4 paid by me', 'Coffee | 4.00 USD | Eli | all'],
  ['I paid 30 for lunch', 'lunch | 30.00 USD | Eli | all'],
  ['Cy paid me 5', 'Cy > Eli | 5.00 USD | Cy paid Eli back'],
  ['Taxi 10 paid by Ana for me and Ben', 'Taxi | 10.00 USD | Ana | Eli+Ben'],
  ['I am Ana\nCoffee 4 paid by me', 'Coffee | 4.00 USD | Ana | all']
], G, { me: 'p-eli' });

refuses('people: "me" without knowing who that is', [
  ['Coffee 4 paid by me', 'Who is "me"? Add a line above this one, like: I am Ana'],
  ['I paid 30 for lunch', 'Who is "I"? Add a line above this one, like: I am Ana'],
  ['Cy paid me 5', 'Who is "me"? Add a line above this one, like: I am Ana'],
  ['Taxi 10 paid by Ana for myself', 'Who is "myself"? Add a line above this one, like: I am Ana'],
  ['Taxi 10 paid by Ana, split with my', 'Who is "my"? Add a line above this one, like: I am Ana'],
  ['Lunch, paid by Ben\n- Soup 5 me', 'Line 2: Who is "me"? Add a line above this one, like: I am Ana']
]);

test('people: opts.me for someone who is not in the group is ignored', () => {
  assert.deepEqual(lastDraft('Coffee 4 paid by me', G(), { me: 'p-nobody' }).errors, ['Who is "me"? Add a line above this one, like: I am Ana']);
  assert.equal(parseText('', G(), { me: 'p-nobody' }).me, null);
  assert.equal(parseText('', G(), { me: 'p-eli' }).me, 'p-eli');
  assert.equal(parseText('I am Ana', G(), { me: 'p-eli' }).me, 'p-ana');
});

test('people: an "I am" line only counts for the lines below it', () => {
  const drafts = parseText('Coffee 4 paid by me\nI am Ana\nCoffee 4 paid by me', G()).drafts;
  assert.deepEqual(drafts.map(d => d.ok), [false, true, true]);
});

refuses('people: the "People:", "I am" and "Me:" lines themselves', [
  ['People:', 'Add the names after the colon, like: People: Ana, Ben, Cy'],
  ['People: , ;', 'Add the names after the colon, like: People: Ana, Ben, Cy'],
  ['Group:', 'Add the names after the colon, like: People: Ana, Ben, Cy'],
  ['People: me, Jo', 'Write your own name in place of "me". After that you can add a line like: I am Ana'],
  ['People: Jo and I', 'Write your own name in place of "I". After that you can add a line like: I am Ana'],
  ['People: Kim, kim', 'kim is in this list twice.'],
  ['People: Ana, Ana', 'Ana is in this list twice.'],
  ['People: ' + 'x'.repeat(41), '"' + 'x'.repeat(20) + '…" is long for a name. Keep it to 40 letters.'],
  ['People: Jo, ???', '"???" does not look like a name.'],
  ['People: ' + Array.from({ length: 196 }, (_, i) => 'P' + i).join(', '), 'A group can have up to 200 people.'],
  ['I am', 'Write your name after it, like: I am Ana'],
  ['I\'m', 'Write your name after it, like: I am Ana'],
  ['Me:', 'Write your name after it, like: I am Ana'],
  ['I am broke', '"broke" is not a person in the group. To add a new person, write: People: broke'],
  ['I am the one who paid', '"the one who paid" is not a person in the group. To add a new person, write: People: the one who paid'],
  ['Me: Everyone', '"Everyone" is not a person in the group. To add a new person, write: People: Everyone']
]);

describe('people: the "People:" line', () => {
  const add = text => parseText(text, G()).drafts[0];
  test('separators: comma, and, &, +, semicolon', () => {
    for (const text of ['People: Fay, Gus, Hal', 'people: Fay and Gus and Hal', 'Group: Fay & Gus & Hal', 'PEOPLE : Fay + Gus + Hal', 'People: Fay; Gus; Hal', 'People: Fay, Gus and Hal', 'People:Fay,Gus,Hal', 'People: Fay, and Gus, and Hal']) {
      const d = add(text);
      assert.equal(d.kind, 'people', text);
      assert.equal(d.ok, true, text);
      assert.deepEqual(d.newPeople, ['Fay', 'Gus', 'Hal'], text);
    }
  });
  test('names keep their spelling, spaces and odd letters', () => {
    assert.deepEqual(add('People: mary jane,  Jean-Luc ,  O\'Neil, 小明, R2D2').newPeople, ['mary jane', 'Jean-Luc', 'O\'Neil', '小明', 'R2D2']);
    assert.deepEqual(add('People: Andy, Sandy and Randy').newPeople, ['Andy', 'Sandy', 'Randy'], '"and" inside a name is not a separator');
  });
  test('quotes keep a comma or "and" inside one name', () => {
    assert.deepEqual(add('People: "Lee, Jr.", Kim, "Bo and Co", "Say ""hi"""').newPeople, ['Lee, Jr.', 'Kim', 'Bo and Co', 'Say "hi"']);
    assert.deepEqual(add('People: "me", "I"').newPeople, ['me', 'I'], 'quotes say it is a name');
  });
  test('people who are in the group already are noted, not added', () => {
    const d = add('People: ana, Fay, BEN');
    assert.deepEqual([d.ok, d.newPeople, d.warnings], [true, ['Fay'], ['Ana is already in the group.', 'Ben is already in the group.']]);
  });
  test('a name can be used on the lines below, with or without spaces in it', () => {
    const g = G(), d = lastDraft('People: Mary Jane, "Lee, Jr."\nDinner 30 paid by mary jane for Lee, Jr. and Ana', g);
    assert.equal(brief(g, d.bill), 'Dinner | 30.00 USD | Mary Jane* | Lee, Jr.*+Ana');
  });
  test('a line that is refused adds nobody', () => {
    const res = parseText('People: Fay, me\nDinner 30 paid by Ana', G());
    assert.deepEqual(res.people.filter(p => p.isNew), []);
    assert.deepEqual(res.drafts[0].warnings, []);
  });
  test('up to 200 people', () => {
    const names = Array.from({ length: 195 }, (_, i) => 'P' + i).join(', ');
    assert.equal(add('People: ' + names).ok, true);
    const res = parseText('People: ' + names + '\nDinner 5 paid by Zed', G());
    assert.deepEqual(res.drafts[1].errors, ['A group can have up to 200 people.']);
    assert.deepEqual(parseText('People: ' + names + '\nI am Zed', G()).drafts[1].errors, ['A group can have up to 200 people.']);
  });
});

refuses('people: the same person twice in one list', [
  ['Dinner 120 paid by Ana, split between Ana, Ana', 'Ana is in this list twice.'],
  ['Dinner 120 paid by Ana and ana', 'Ana is in this list twice.'],
  ['Dinner 120 paid by Ana, split Ana 60, Ben 30, Ana 30', 'Ana is in this list twice.'],
  ['Dinner 120 paid by Ana for Fay, Ben and Fay', 'Fay is in this list twice.'],
  ['Dinner 120 paid by Ana for everyone except Dee and Dee', 'Dee is in this list twice.'],
  ['Ana and Ana paid 12 for lunch', 'Ana is in this list twice.'],
  ['I am Ben\nMe and Ben paid 40 for lunch', 'Ben is in this list twice.'],
  ['Lunch, paid by Ben\n  - Soup 5 Ana, Ana', 'Line 2: Ana is in this list twice.'],
  ['Dinner 120 paid by Ana, everyone', 'Write "everyone" or a list of names, not both. To say who shares it, start with "for", like: for everyone'],
  ['Dinner 120 paid by Ana for Ben and everyone', 'Write "everyone" or a list of names, not both. To say who shares it, start with "for", like: for everyone']
]);

test('people: two people with the same name cannot be told apart in text', () => {
  const g = G({ people: [...people(NAMES), { id: 'p-ana2', name: 'ANA' }] });
  assert.deepEqual(lastDraft('Dinner 120 paid by Ana', g).errors, ['Two people in the group are called Ana. Rename one under GROUP.']);
  assert.deepEqual(lastDraft('I am ana', g).errors, ['Two people in the group are called Ana. Rename one under GROUP.']);
  const d = lastDraft('Dinner 120 paid by Ben', g);
  assert.equal(d.bill.split.who.length, 6, 'everyone still means all six');
});

test('people: with nobody in the group, "everyone" has to wait', () => {
  assert.deepEqual(lastDraft('Dinner 120 paid by everyone', EMPTY()).errors, ['There is nobody in the group yet. Add people first, like: People: Ana, Ben, Cy']);
  const g = EMPTY(), d = lastDraft('Dinner 120 paid by Ana', g);
  assert.equal(brief(g, d.bill), 'Dinner | 120.00 USD | Ana* | Ana*');
});

test('people: a person called like a currency keeps the name, and the line says so', () => {
  const g = G({ people: people(['Ana', 'Yen', 'Cad']) });
  assert.deepEqual(lastDraft('Dinner 3000 yen paid by Ana', g).errors, ['Yen is a person in this group, so "yen" is not read as a currency. Use a code or a sign, like 3000 EUR.']);
  assert.deepEqual(lastDraft('Dinner 30 CAD paid by Ana', g).errors, ['Cad is a person in this group, so "CAD" is not read as a currency. Use a code or a sign, like 30 EUR.']);
  assert.equal(brief(g, lastDraft('Dinner 3000 JPY paid by Yen', g).bill), 'Dinner | 3000 JPY | Yen | all');
  assert.equal(brief(g, lastDraft('Dinner ¥3000 paid by Ana for Yen and Cad', g).bill), 'Dinner | 3000 JPY | Ana | Yen+Cad');
});

/* ---------- required parts and the messages for them ---------- */

refuses('messages: a bill needs a name, an amount and a payer', [
  ['Dinner 120', 'Who paid? Add: paid by <name>'],
  ['Dinner 120 EUR', 'Who paid? Add: paid by <name>'],
  ['Dinner 120 split between Ana and Ben', 'Who paid? Add: paid by <name>'],
  ['Dinner: 120', 'Who paid? Add: paid by <name>'],
  ['120 paid by Ana', 'What was it for? Add a name before the amount.'],
  ['€120 paid by Ana', 'What was it for? Add a name before the amount.'],
  [': 120 paid by Ana', 'What was it for? Add a name before the amount.'],
  ['"": 120 paid by Ana', 'What was it for? Add a name before the amount.'],
  ['"  ": 120 paid by Ana', 'What was it for? Add a name before the amount.'],
  ['Dinner paid by Ana', 'How much was it? Add the amount after the name, like: Dinner 120 paid by Ana'],
  ['Dinner: paid by Ana', 'How much was it? Add the amount after the name, like: Dinner 120 paid by Ana'],
  ['Dinner paid by Ana 120', 'How much was it in total? Put the total right after the name, like: Dinner 120 paid by Ana 80, Ben 40'],
  ['Dinner paid by Ana 80, Ben 40', 'How much was it in total? Put the total right after the name, like: Dinner 120 paid by Ana 80, Ben 40'],
  ['Dinner', ['How much was it? Add the amount after the name, like: Dinner 120 paid by Ana', 'Who paid? Add: paid by <name>']],
  ['120', ['What was it for? Add a name before the amount.', 'Who paid? Add: paid by <name>']],
  ['paid by Ana', ['What was it for? Add a name before the amount.', 'How much was it? Add the amount after the name, like: Dinner 120 paid by Ana']],
  ['!!!', 'A bill needs a name, an amount and who paid, like: Dinner 120 paid by Ana'],
  ['...', 'A bill needs a name, an amount and who paid, like: Dinner 120 paid by Ana'],
  [':', 'A bill needs a name, an amount and who paid, like: Dinner 120 paid by Ana'],
  ['Ana paid 30', 'What was it for? Add it after the amount, like: Ana paid 30 for lunch'],
  ['Ana paid 30 for Ben', 'What was it for? Add it after the amount, like: Ana paid 30 for lunch'],
  ['Ana paid 30 for everyone', 'What was it for? Add it after the amount, like: Ana paid 30 for lunch'],
  ['Ana paid 30, split with Ben', 'What was it for? Add it after the amount, like: Ana paid 30 for lunch'],
  ['Ana paid for dinner', 'How much was it? Add the amount after the name, like: Dinner 120 paid by Ana'],
  ['Ana paid', 'How much, and what for? Write it like: Ana paid 30 for lunch'],
  ['Ana paid 30 lunch', '"lunch" is not clear here. To name the bill, write it like: Ana paid 30 for lunch'],
  ['Ana paid lunch 30', '"lunch" is not a person in the group. For a bill, write its name first, like: Taxi 30 paid by Ana'],
  ['Ana paid Uber 30', '"Uber" is not a person in the group. For a bill, write its name first, like: Taxi 30 paid by Ana'],
  ['Ana paid 30 for', 'Something is missing after "for".'],
  ['Hotel paid 300', 'What was it for? Add it after the amount, like: Ana paid 30 for lunch'],
  ['Dinner ' + 'x'.repeat(80) + ' 12 paid by Ana', 'That name is long. Keep it to 80 letters.'],
  ['"' + 'x'.repeat(81) + '": 12 paid by Ana', 'That name is long. Keep it to 80 letters.']
]);

refuses('messages: where the name ends is not ours to guess', [
  ['Lunch for Ana 30 paid by Ben', 'Is "for Ana" part of the name, or who shares it? For the name, put a colon after it: Lunch for Ana: 30. For who shares it, put the amount first: Lunch 30 for Ana'],
  ['Dinner with Ana 120 paid by Ben', 'Is "with Ana" part of the name, or who shares it? For the name, put a colon after it: Dinner with Ana: 120. For who shares it, put the amount first: Dinner 120 with Ana'],
  ['Coffee for me 4 paid by Ana', 'Is "for me" part of the name, or who shares it? For the name, put a colon after it: Coffee for me: 4. For who shares it, put the amount first: Coffee 4 for me'],
  ['Cake for everyone except Dee 30 paid by Ana', 'Is "for everyone except Dee" part of the name, or who shares it? For the name, put a colon after it: Cake for everyone except Dee: 30. For who shares it, put the amount first: Cake 30 for everyone except Dee'],
  ['For Ana 30 paid by Ben', 'Is "For Ana" part of the name, or who shares it? For the name, put a colon after it: For Ana: 30'],
  ['Dinner for Ana and Ben paid by Cy', 'It is not clear where the name of the bill ends. Put a colon after the name, like: Dinner with Ana: 120 paid by Ben'],
  ['Taxi 20 Ana Dinner 30 paid by Ben', 'Is "Taxi 20 Ana Dinner" the whole name of the bill? Then put a colon after it. If it also says who paid or who shares it, put that after the amount, like: Dinner 30 paid by Ana for Ben'],
  ['Ana birthday cake 30 paid by Ben', 'Is "Ana birthday cake" the whole name of the bill? Then put a colon after it. If it also says who paid or who shares it, put that after the amount, like: Dinner 30 paid by Ana for Ben'],
  ['Dinner Ana and Ben 80 paid by Cy', 'Is "Dinner Ana and Ben" the whole name of the bill? Then put a colon after it. If it also says who paid or who shares it, put that after the amount, like: Dinner 30 paid by Ana for Ben'],
  ['Dinner Ana 120', 'Is "Dinner Ana" the whole name of the bill? Then put a colon after it. If it also says who paid or who shares it, put that after the amount, like: Dinner 30 paid by Ana for Ben'],
  ['Dinner 120paid by Ana', 'Is "Dinner 120paid by Ana" the whole name of the bill? Then put a colon after it. If it also says who paid or who shares it, put that after the amount, like: Dinner 30 paid by Ana for Ben'],
  ['Coffee me 4 paid by Ana', 'Is "Coffee me" the whole name of the bill? Then put a colon after it. If it also says who paid or who shares it, put that after the amount, like: Dinner 30 paid by Ana for Ben'],
  ['Ana paid 7 for taxi home Ana and Ben', 'Is "taxi home Ana and Ben" the whole name of the bill? Then start with it: taxi home Ana and Ben: 30 paid by Ana. If part of it says who shares it, put "for" before those names.'],
  ['Ana paid 7 for Ben lunch', 'Is "Ben lunch" the whole name of the bill? Then start with it: Ben lunch: 30 paid by Ana. If part of it says who shares it, put "for" before those names.'],
  ['Ben 12 paid by Ana', 'Is "Ben" the name of the bill, or who shares it? For the name, use quotes: "Ben": 12 paid by Ana. For who shares it, start with what it was for: Lunch 12 paid by Ana for Ben'],
  ['Ana and Ben 80 paid by Cy', 'Is "Ana and Ben" the name of the bill, or who shares it? For the name, use quotes: "Ana and Ben": 12 paid by Ana. For who shares it, start with what it was for: Lunch 12 paid by Ana for Ana and Ben'],
  ['Ben: 12 paid by Ana', 'Is "Ben" the name of the bill, or who shares it? For the name, use quotes: "Ben": 12 paid by Ana. For who shares it, start with what it was for: Lunch 12 paid by Ana for Ben'],
  ['Everyone: 12 paid by Ana', 'Is "Everyone" the name of the bill, or who shares it? For the name, use quotes: "Everyone": 12 paid by Ana. For who shares it, start with what it was for: Lunch 12 paid by Ana for Everyone'],
  ['Ana: Cy paid Ben 5', 'Is "Ana" the name of the bill, or who shares it? For the name, use quotes: "Ana": 12 paid by Ana. For who shares it, start with what it was for: Lunch 12 paid by Ana for Ana'],
  ['Ana paid 30 for Ben and Fay', 'Is "Ben and Fay" the name of the bill, or who shares it? For people, first add: People: Fay. For a name, start with it: Ben and Fay: 30 paid by Ana'],
  ['Ana paid 9 for banana split with Ben', 'Is "split" part of the name? Then start with the name, like: Banana split: 9 paid by Ana. If not, put a comma before "split".'],
  ['Ana paid 9 for dinner split between Ana and Ben', 'Is "split" part of the name? Then start with the name, like: Banana split: 9 paid by Ana. If not, put a comma before "split".'],
  ['Dinner: 120 total paid by Ana', '"total" is not clear here. After the amount comes "paid by" and a name.'],
  ['Dinner: about 120 paid by Ana', '"about" is not clear here. After the colon comes the amount, like: Dinner: 120 paid by Ana'],
  ['Dinner 120 paid by: Ana', ['"Ana" is not clear here. After the colon comes the amount, like: Dinner: 120 paid by Ana', 'The colon makes "Dinner 120 paid by" the name of the bill.']],
  ['Hotel 60 paid by Ana, split: Ana 30, Ben 30', ['"Ana" is not clear here. After the colon comes the amount, like: Dinner: 120 paid by Ana', 'The colon makes "Hotel 60 paid by Ana, split" the name of the bill.']],
  ['Lunch 20 EUR paid by Ana, rate: 1.12', ['Who paid? Add: paid by <name>', 'The colon makes "Lunch 20 EUR paid by Ana, rate" the name of the bill.']],
  ['Cy → Ana: 50', ['Who paid? Add: paid by <name>', 'The colon makes "Cy → Ana" the name of the bill.']],
  ['Room 12: 45 paid by Bne', ['Bne is not in the group. Did you mean Ben? To add a new person, write: People: Bne', 'The colon makes "Room 12" the name of the bill.']]
]);

refuses('messages: a keyword typed onto a name', [
  ['Eli paid 60 for banana split, everyone butDee', '"butDee" needs a space: but Dee'],
  ['Cy and Ben paid 45.50 for 7 nights, splitAna 100%', '"splitAna" needs a space: split Ana'],
  ['Lunch 30 paid by Ben forAna', '"forAna" needs a space: for Ana'],
  ['Lunch 30 paid by Ben, split withAna', '"withAna" needs a space: with Ana'],
  ['Lunch 30 paid byAna', '"byAna" needs a space: by Ana'],
  ['Lunch 30 paid by Ben andAna', '"andAna" needs a space: and Ana'],
  ['Lunch: 30 paid by Ben, split betweenAna and Ben', '"betweenAna" needs a space: between Ana'],
  ['Cy sent 5 toAna', '"toAna" needs a space: to Ana'],
  ['Lunch, paid by Ben\n- Soup 5 forAna', 'Line 2: "forAna" needs a space: for Ana'],
  ['Lunch, paid by Ben\n- Soup 5 everyone exceptAna', 'Line 2: "exceptAna" needs a space: except Ana']
]);

test('a keyword typed onto a name: only when it is a person of the group, with a capital', () => {
  const g = G({ people: people(['Ana', 'Ron', 'Rest']) });
  assert.deepEqual(lastDraft('Byron paid 30 for lunch', g).newPeople, ['Byron']);
  assert.deepEqual(lastDraft('Forrest paid 30 for lunch', g).newPeople, ['Forrest']);
  assert.equal(brief(g, lastDraft('forAna: 30 paid by Ron', g).bill), 'forAna | 30.00 USD | Ron | all');
  assert.deepEqual(lastDraft('Lunch 30 paid by Ana forRon', g).errors, ['"forRon" needs a space: for Ron']);
});

refuses('messages: who paid and who shares', [
  ['Dinner 120 paid by Ana paid by Ben', 'This line says who paid twice. Keep one.'],
  ['Ana paid 120 for dinner, paid by Ben', 'This line says who paid twice. Keep one.'],
  ['Dinner 120 paid by Ana, split between Ana and Ben, for Cy', 'This line says who shares it twice. Keep one.'],
  ['Dinner 120 paid by Ana with Ben between Cy and Dee', 'This line says who shares it twice. Keep one.'],
  ['Dinner 120 paid by Ana, split Ana 60, Ben 60, split equally between Cy and Dee', 'This line says who shares it twice. Keep one.'],
  ['Dinner 120 paid by Ana between', 'Add names after "between", like: between Ana and Ben'],
  ['Dinner 120 paid by Ana, split with', 'Add names after "with", like: with Ana and Ben'],
  ['Dinner 120 paid by Ana for', 'Something is missing after "for".'],
  ['Dinner 120 paid by Ana except', 'Add names after "except", like: everyone except Dee'],
  ['Dinner 120 paid by Ana except everyone', 'Add names after "except", like: everyone except Dee'],
  ['Dinner 120 paid by Ana except Dee except Eli', 'This line says "except" twice. Keep one.'],
  ['Dinner 120 paid by Ana, split between Ana, Ben except Ben', '"except" works after "everyone", like: for everyone except Dee'],
  ['Dinner 120 paid by Ana, split with Ben except Ben', '"except" works after "everyone", like: for everyone except Dee'],
  ['Dinner 120 paid by Ana except Ana, Ben, Cy, Dee and Eli', 'That leaves nobody to share it.'],
  ['Dinner 120 paid by Ana, split with Ben 20', '"with" takes names only. To give each person a number, write it like: split Ana 30, Ben 20'],
  ['Hotel 60 paid by Ana, split 3 ways', '"3 ways" does not match the group of 5. Say who shares it, like: split between Ana and Ben'],
  ['Hotel 60 paid by Ana, split 3 ways between Ana and Ben', '"3 ways" does not match the 2 people listed.'],
  ['Hotel 60 paid by Ana, split 5 ways except Dee', '"5 ways" does not match the group of 5. Say who shares it, like: split between Ana and Ben'],
  ['Hotel 60 paid by Ana, split 2 ways Ana 40, Ben 20', '"2 ways" does not match the 2 people listed.'],
  ['Hotel 60 paid by Ana, split 2.5 ways', '"2.5 ways" does not match the group of 5. Say who shares it, like: split between Ana and Ben'],
  ['Hotel 60 paid by Ana, split 3', '"3" is not clear here. A name belongs in this place.'],
  ['Dinner 120 paid by Ana tip', 'Write the tip as a percent, like: tip 10%'],
  ['Dinner 120 paid by Ana, tax', 'Write the tax as a percent, like: tax 8.5%'],
  ['Dinner 120 EUR paid by Ana, rate', 'Write the rate as a plain number with a dot, like: rate 1.1251']
]);

refuses('messages: numbers in a list', [
  ['Dinner 120 paid by Ana 80, Ben 30', 'The amounts paid add up to 110.00 USD. The total is 120.00 USD, so 10.00 USD is left to assign.'],
  ['Dinner 120 paid by Ana 80, Ben 50', 'The amounts paid add up to 130.00 USD. The total is 120.00 USD, so that is 10.00 USD too much.'],
  ['Dinner 120 paid by Ana, split Ana 60, Ben 50', 'The amounts add up to 110.00 USD. The total is 120.00 USD, so 10.00 USD is left to assign.'],
  ['Dinner 120 paid by Ana, split Ana 2, Ben 1', 'The amounts add up to 3.00 USD. The total is 120.00 USD, so 117.00 USD is left to assign. If these are shares, write: Ana x2, Ben x1'],
  ['Dinner 120 paid by Ana 2, Ben 1', 'The amounts paid add up to 3.00 USD. The total is 120.00 USD, so 117.00 USD is left to assign. If these are shares, write: Ana x2, Ben x1'],
  ['Dinner 1200 JPY paid by Ana, split Ana 1, Ben 1, Cy 2', 'The amounts add up to 4 JPY. The total is 1200 JPY, so 1196 JPY is left to assign. If these are shares, write: Ana x1, Ben x1, Cy x2'],
  ['Dinner 120 paid by Ana, split Ana 60%, Ben 30%', 'The percents add up to 90%. They need to make 100%.'],
  ['Dinner 120 paid by Ana 60%, Ben 50%', 'The percents add up to 110%. They need to make 100%.'],
  ['Dinner 120 paid by Ana, split Ana 33.3%, Ben 33.3%, Cy 33.3%', 'The percents add up to 99.9%. They need to make 100%.'],
  ['Dinner 120 paid by Ana, split Ana x0, Ben x0', 'Give at least one person a share.'],
  ['Dinner 120 paid by Ana, split Ana x9999999999, Ben x1', 'Use smaller numbers for the shares.'],
  ['Dinner 120 paid by Ana, split Ana 60, Ben 50%', 'Use one kind of number in a list: amounts (30), percents (50%) or shares (x2).'],
  ['Dinner 120 paid by Ana, split Ana x2, Ben 50%', 'Use one kind of number in a list: amounts (30), percents (50%) or shares (x2).'],
  ['Dinner 120 paid by Ana, split Ana 60, Ben', 'Give every person a number, or none of them. Ben has none.'],
  ['Dinner 120 paid by Ana 60%, Ben', 'Give every person a number, or none of them. Ben has none.'],
  ['Dinner 120 paid by Ana, split Ana 100, Ben 20 EUR', 'Use one currency for the whole bill. This one has USD and EUR.'],
  ['Dinner 120 EUR paid by Ana $100, Ben $20', 'Use one currency for the whole bill. This one has EUR and USD.'],
  ['Dinner 120 paid by Ana, split Ana 60.555, Ben 59.445', 'Is "60.555" over a thousand? Then write 60555. If not, write 60.55.'],
  ['Dinner 120 paid by Ana, split Ana -60, Ben 180', 'An amount cannot be negative. For money paid back, write: Cy paid Ana 50'],
  ['Dinner 120 paid by Ana, split Ana 1,2,3, Ben 1', '"1,2,3" is not a number this page can read. Write it like 1200.50'],
  ['Dinner 120 paid by Ana, split Ana 50.1234567%, Ben 49.8765433%', '"50.1234567%" is not a number this page can read.'],
  ['Dinner 120 paid by Ana, split Ana x1.2.3, Ben x1', '"x1.2.3" is not a number this page can read.'],
  ['Dinner 120 paid by Ana, split Ana 50% x2, Ben 50%', '"x2" is not clear here. A name belongs in this place.'],
  ['Dinner 120 paid by Ana, split Ana x2%, Ben x1', '"x2%" is not clear. Write an amount (30), a percent (50%) or shares (x2).'],
  ['Dinner 120 paid by Ana, split Ana 50% shares, Ben 50%', '"50%" is not clear. Write an amount (30), a percent (50%) or shares (x2).'],
  ['Dinner 120 paid by Ana, split Ana €2 shares, Ben 1 share', '"€2" is not clear. Write an amount (30), a percent (50%) or shares (x2).'],
  ['Dinner 120 paid by Ana, split Ana x, Ben x1', 'A number is missing after "x".'],
  ['Dinner: 120 paid by Ana, split Ana:, Ben: 120', 'A number is missing after ":".'],
  ['Dinner 120 paid by Ana and Ben 60 each', '"60 each" is not clear. Give each person their own number, like: Ana 40, Ben 40'],
  ['Dinner 120 paid by Ana, split Ana 60 Ben 60 Cy', 'Give every person a number, or none of them. Cy has none.']
]);

/* ---------- items ---------- */

const TABERNA = 'Dinner at the taberna, paid by Dee, tip 10%\n  - Bacalhau 38 Ben\n  - Shared petiscos 30 Ana, Eli\n  - Vinho verde 52: Ana, Ben, Dee';

reads('items: a first line, then one line for each item', [
  [TABERNA, 'Dinner at the taberna | 132.00 USD | Dee | items[Bacalhau 38.00: Ben; Shared petiscos 30.00: Ana+Eli; Vinho verde 52.00: Ana+Ben+Dee] tip 10'],
  ['Currency: EUR\n' + TABERNA, 'Dinner at the taberna | 132.00 EUR | Dee | items[Bacalhau 38.00: Ben; Shared petiscos 30.00: Ana+Eli; Vinho verde 52.00: Ana+Ben+Dee] tip 10'],
  ['Lunch, paid by Ben\n- Soup 5 Ana', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: Ana]'],
  ['Lunch paid by Ben\n- Soup 5', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: all]'],
  ['Lunch: paid by Ben\n- Soup 5 everyone', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: all]'],
  ['Lunch, paid by Ben\n- Soup 5 everyone except Ben', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: Ana+Cy+Dee+Eli]'],
  ['Lunch, paid by Ben\n- Soup 5 all but Ben and Cy', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: Ana+Dee+Eli]'],
  ['Lunch, paid by Ben\n- Soup 5: Ana and Ben', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: Ana+Ben]'],
  ['Lunch, paid by Ben\n- Soup: 5 Ana & Ben', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: Ana+Ben]'],
  ['Lunch, paid by Ben\n- Soup: 5: Ana, Ben', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: Ana+Ben]'],
  ['Lunch, paid by Ben\n- Soup 5 for Ana and Ben', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: Ana+Ben]'],
  ['Lunch, paid by Ben\n- Soup: 5.00 for Ana and Ben', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: Ana+Ben]'],
  ['Lunch, paid by Ben\n- Soup 5 between Ana Ben', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: Ana+Ben]'],
  ['Lunch, paid by Ben\n- Soup 5, Ana', 'Lunch | 5.00 USD | Ben | items[Soup 5.00: Ana]'],
  ['Lunch, paid by Ben\n- 5 Ana', 'Lunch | 5.00 USD | Ben | items[5.00: Ana]'],
  ['Lunch, paid by Ben\n- 5', 'Lunch | 5.00 USD | Ben | items[5.00: all]'],
  ['Lunch, paid by Ben\n- Pizza 2 slices 8 Ana', 'Lunch | 8.00 USD | Ben | items[Pizza 2 slices 8.00: Ana]'],
  ['Lunch, paid by Ben\n- Wine 2019: 30 Ana', 'Lunch | 30.00 USD | Ben | items[Wine 2019 30.00: Ana]'],
  ['Lunch, paid by Ben\n- 2 for 1: 12 Ana', 'Lunch | 12.00 USD | Ben | items[2 for 1 12.00: Ana]'],
  ['Lunch, paid by Ben\n- "Table 5: wine" 12 Ana', 'Lunch | 12.00 USD | Ben | items[Table 5: wine 12.00: Ana]'],
  ['Lunch, paid by Ben\n- "Ben": 12', 'Lunch | 12.00 USD | Ben | items[Ben 12.00: all]'],
  ['Lunch, paid by Ben\n- Ben wine: 12 Ana', 'Lunch | 12.00 USD | Ben | items[Ben wine 12.00: Ana]'],
  ['Lunch, paid by Ben\n- Ben: 12 Ana', 'Lunch | 12.00 USD | Ben | items[Ben 12.00: Ana]'],
  ['Lunch, paid by Ben\n- Wine for Ben: 12', 'Lunch | 12.00 USD | Ben | items[Wine for Ben 12.00: all]'],
  ['Lunch, paid by Ben\n- Ana\'s soup 5', 'Lunch | 5.00 USD | Ben | items[Ana\'s soup 5.00: all]'],
  ['Lunch, paid by Ben\n- Wine: 1 200 for Ana', 'Lunch | 1200.00 USD | Ben | items[Wine 1200.00: Ana]'],
  ['Lunch, paid by Ben\n- Wine 1,200.50 Ana', 'Lunch | 1200.50 USD | Ben | items[Wine 1200.50: Ana]'],
  ['Lunch, paid by Ben\n- Soup €5 Ana\n- Salad 6 Ben', 'Lunch | 11.00 EUR | Ben | items[Soup 5.00: Ana; Salad 6.00: Ben]'],
  ['Lunch, paid by Ben\n- Soup 5 EUR Ana\n- Salad €6 Ben', 'Lunch | 11.00 EUR | Ben | items[Soup 5.00: Ana; Salad 6.00: Ben]'],
  ['Lunch €11 paid by Ben\n- Soup 5 Ana\n- Salad 6 Ben', 'Lunch | 11.00 EUR | Ben | items[Soup 5.00: Ana; Salad 6.00: Ben]'],
  ['Lunch: 11.00 EUR, paid by Ben\n  - Soup: 5.00 for Ana\n  - Salad: 6.00 for Ben', 'Lunch | 11.00 EUR | Ben | items[Soup 5.00: Ana; Salad 6.00: Ben]'],
  ['Lunch 12.10 paid by Ben, tip 10%\n- Soup 5 Ana\n- Salad 6 Ben', 'Lunch | 12.10 USD | Ben | items[Soup 5.00: Ana; Salad 6.00: Ben] tip 10'],
  ['Lunch, paid by Ben, tax 8.5%, tip 15%\n- Soup 100 Ana', 'Lunch | 123.50 USD | Ben | items[Soup 100.00: Ana] tax 8.5 tip 15'],
  ['Lunch, paid by Ben, 10% tip, 8,5% tax\n- Soup 100 Ana', 'Lunch | 118.50 USD | Ben | items[Soup 100.00: Ana] tax 8.5 tip 10'],
  ['Lunch, paid by Ben, tip 10 %\n- Soup 100 Ana', 'Lunch | 110.00 USD | Ben | items[Soup 100.00: Ana] tip 10'],
  ['Lunch, paid by Ben, tip 10 percent\n- Soup 100 Ana', 'Lunch | 110.00 USD | Ben | items[Soup 100.00: Ana] tip 10'],
  ['Lunch: paid by Ben, tip: 10%\n- Soup 100 Ana', 'Lunch | 110.00 USD | Ben | items[Soup 100.00: Ana] tip 10'],
  ['Lunch, tip 10%, paid by Ben\n- Soup 100 Ana', 'Lunch | 110.00 USD | Ben | items[Soup 100.00: Ana] tip 10'],
  ['Lunch tip 10% paid by Ben\n- Soup 100 Ana', 'Lunch | 110.00 USD | Ben | items[Soup 100.00: Ana] tip 10'],
  ['Lunch, paid by Ben, tip 0%\n- Soup 100 Ana', 'Lunch | 100.00 USD | Ben | items[Soup 100.00: Ana]'],
  ['Lunch, paid by Ben, tax 0.0%, tip 5%\n- Soup 100 Ana', 'Lunch | 105.00 USD | Ben | items[Soup 100.00: Ana] tip 5'],
  ['Lunch, paid by Ana and Ben\n- Soup 100 Cy', 'Lunch | 100.00 USD | Ana+Ben | items[Soup 100.00: Cy]'],
  ['Lunch, paid by Ana 70, Ben 30\n- Soup 100 Cy', 'Lunch | 100.00 USD | Ana 70.00, Ben 30.00 | items[Soup 100.00: Cy]'],
  ['Ben paid for lunch, tip 10%\n- Soup 100 Ana', 'lunch | 110.00 USD | Ben | items[Soup 100.00: Ana] tip 10'],
  ['Ben paid 110 for lunch, tip 10%\n- Soup 100 Ana', 'lunch | 110.00 USD | Ben | items[Soup 100.00: Ana] tip 10'],
  ['Lunch 1000 JPY paid by Ben, tip 10%\n- Soup 909 Ana', 'Lunch | 1000 JPY | Ben | items[Soup 909: Ana] tip 10'],
  ['Lunch 20 EUR paid by Ben, rate 1.2\n- Soup 20 Ana', 'Lunch | 20.00 EUR | Ben | items[Soup 20.00: Ana] | rate 1.2 USD'],
  ['Lunch, paid by Ben\n- Soup 5 Fay\n- Salad 6', 'Lunch | 11.00 USD | Ben | items[Soup 5.00: Fay*; Salad 6.00: Ana+Ben+Cy+Dee+Eli+Fay*]']
]);

refuses('items: what is refused, with the line it is on', [
  ['Dinner 150 EUR paid by Dee, tax 8.5%, tip 10%\n- Bacalhau 38 Ben\n* Bread 4\n• Wine: 52.00 for Ana and Ben\n  Water 3 everyone except Dee', 'The first line says 150.00 EUR, but the items with tax and tip add up to 114.95 EUR. Change one of them, or leave the amount out of the first line.'],
  ['Dinner 100 paid by Dee, 10% tip\n - Fish 50 Ana\n - Meat 40 Ben', 'The first line says 100.00 USD, but the items with tip add up to 99.00 USD. Change one of them, or leave the amount out of the first line.'],
  ['Dinner 100 paid by Dee, tax 5%\n - Fish 50 Ana', 'The first line says 100.00 USD, but the items with tax add up to 52.50 USD. Change one of them, or leave the amount out of the first line.'],
  ['Dinner 100 paid by Dee\n - Fish 50 Ana', 'The first line says 100.00 USD, but the items add up to 50.00 USD. Change one of them, or leave the amount out of the first line.'],
  ['Lunch paid by Ana\n  - Soup €5 Ana\n  - Salad $6 Ben', 'Use one currency for the whole bill. This one has EUR and USD.'],
  ['Lunch 11 USD paid by Ana\n  - Soup €5 Ana\n  - Salad 6 Ben', 'Use one currency for the whole bill. This one has USD and EUR.'],
  ['Lunch paid by Ana, split between Ana and Ben\n  - Soup 5 Ana', 'The items already say who shares what. Remove the "split" part from the first line.'],
  ['Lunch paid by Ana for Ben\n  - Soup 5 Ana', 'The items already say who shares what. Remove the "split" part from the first line.'],
  ['Lunch paid by Ana, split 5 ways\n  - Soup 5 Ana', 'The items already say who shares what. Remove the "split" part from the first line.'],
  ['Lunch paid by Ana except Dee\n  - Soup 5 Ana', 'The items already say who shares what. Remove the "split" part from the first line.'],
  ['Dinner 120 paid by Ana, tip 10%', 'Tip and tax go with a list of items. Put each item on its own line below this one, starting with a dash.'],
  ['Dinner 120 paid by Ana, tax 8%', 'Tip and tax go with a list of items. Put each item on its own line below this one, starting with a dash.'],
  ['Ana paid 120 for dinner, 10% tip', 'Tip and tax go with a list of items. Put each item on its own line below this one, starting with a dash.'],
  ['Lunch, paid by Ben, tip 10\n- Soup 5 Ana', 'Write the tip as a percent, like: tip 10%'],
  ['Lunch, paid by Ben, tax 5 EUR\n- Soup 5 Ana', 'Write the tax as a percent, like: tax 8.5%'],
  ['Lunch, paid by Ben, tip 150%\n- Soup 5 Ana', 'Write the tip as a percent, like: tip 10%'],
  ['Lunch, paid by Ben, tip 10% 5%\n- Soup 5 Ana', 'Write the tip as a percent, like: tip 10%'],
  ['Lunch, paid by Ben, tip 10%, tip 5%\n- Soup 5 Ana', 'This line has tip twice. Keep one.'],
  ['Lunch, paid by Ben, tip 0%, tip 5%\n- Soup 5 Ana', 'This line has tip twice. Keep one.'],
  ['Lunch, paid by Ben, tax 10%, tax 5%\n- Soup 5 Ana', 'This line has tax twice. Keep one.'],
  ['Lunch\n- Soup 5 Ana', 'Who paid? Add: paid by <name>'],
  ['Lunch, paid by Ben\n- Soup Ana', 'Line 2: This item needs a price, like: - Wine 20 Ana, Ben'],
  ['Lunch, paid by Ben\n-', 'Line 2: This item needs a price, like: - Wine 20 Ana, Ben'],
  ['Lunch, paid by Ben\n- Soup: Ana', 'Line 2: This item needs a price, like: - Wine 20 Ana, Ben'],
  ['Lunch, paid by Ben\n- "Soup" Ana', 'Line 2: This item needs a price, like: - Wine 20 Ana, Ben'],
  ['Lunch, paid by Ben\n- Soup 0 Ana', 'Line 2: The amount needs to be more than 0.'],
  ['Lunch, paid by Ben\n- Soup -5 Ana', 'Line 2: An amount cannot be negative. For money paid back, write: Cy paid Ana 50'],
  ['Lunch, paid by Ben\n- Soup 5% Ana', 'Line 2: "5%" is not an amount. Write a plain number, like 120.'],
  ['Lunch, paid by Ben\n- Soup 5.123 Ana', 'Line 2: Is "5.123" over a thousand? Then write 5123. If not, write 5.12.'],
  ['Lunch, paid by Ben\n- Soup 5 Ana\n- Cake 12 300 Ben', 'Line 3: "12 300" can be read as one number or as two. Write it without the space, or put a colon after the name of the item.'],
  ['Lunch, paid by Ben\n- Beer €5 €6', 'Line 2: There are two prices here, €5 and €6. Keep one.'],
  ['Lunch, paid by Ben\n- Beer € 5 6 Ana', 'Line 2: "6" is not clear here. A name belongs in this place.'],
  ['Lunch, paid by Ben\n- € Beer 5 Ana', 'Line 2: "€" is not next to a number. Write it with the price, like €20.'],
  ['Lunch, paid by Ben\n- Bread: everyone 12 everyone', 'Line 2: In an item, a colon goes right after the name or right after the price, like: - Wine: 20 Ana'],
  ['Lunch, paid by Ben\n- Ben 12', 'Line 2: Is "Ben" the name of the item? Then put a colon after it: - Ben: 12. People who share it go after the price: - Wine 12 Ben'],
  ['Lunch, paid by Ben\n- Wine for Ben 12', 'Line 2: Is "Wine for Ben" the name of the item? Then put a colon after it: - Wine for Ben: 12. People who share it go after the price: - Wine 12 Ben'],
  ['Lunch, paid by Ben\n- Cake for everyone 12', 'Line 2: Is "Cake for everyone" the name of the item? Then put a colon after it: - Cake for everyone: 12. People who share it go after the price: - Wine 12 Ben'],
  ['Lunch, paid by Ben\n- Ben: 12', 'Line 2: Is "Ben" the name of the item, or who shares it? For the name, use quotes: - "Ben": 12. For who shares it, put them after the price: - Wine 12 Ben'],
  ['Lunch, paid by Ben\n- Ana and Ben: 12', 'Line 2: Is "Ana and Ben" the name of the item, or who shares it? For the name, use quotes: - "Ana and Ben": 12. For who shares it, put them after the price: - Wine 12 Ana and Ben'],
  ['Lunch, paid by Ben\n- Soup 5 Ana 6', 'Line 2: Is "Soup 5 Ana" the name of the item? Then put a colon after it: - Soup 5 Ana: 12. People who share it go after the price: - Wine 12 Ben'],
  ['Lunch, paid by Ben\n- Soup 5 Ana 6 Ben', 'Line 2: Is "Soup 5 Ana" the name of the item? Then put a colon after it: - Soup 5 Ana: 12. People who share it go after the price: - Wine 12 Ben'],
  ['Lunch, paid by Ben\n- Ben wine 12 Ana', 'Line 2: Is "Ben wine" the name of the item? Then put a colon after it: - Ben wine: 12. People who share it go after the price: - Wine 12 Ben'],
  ['Lunch, paid by Ben\n- Soup 5 Ana paid by Ben', 'Line 2: "paid by" is not a person in the group.'],
  ['Lunch, paid by Ben\n- Soup 5 the kids', 'Line 2: "the kids" is not a person in the group.'],
  ['Lunch, paid by Ben\n- Soup 5:', 'Line 2: Add who shares this item, or leave the end open for everyone.'],
  ['Lunch, paid by Ben\n- Soup 5 for', 'Line 2: Add who shares this item, or leave the end open for everyone.'],
  ['Lunch, paid by Ben\n- Soup 5 Ana except Ben', 'Line 2: "except" works after "everyone", like: everyone except Dee'],
  ['Lunch, paid by Ben\n- Soup 5 except Ben', 'Line 2: "except" works after "everyone", like: everyone except Dee'],
  ['Lunch, paid by Ben\n- Soup 5 everyone except', 'Line 2: "except" works after "everyone", like: everyone except Dee'],
  ['Lunch, paid by Ben\n- Soup 5 everyone except Fay', 'Line 2: "Fay" is not in the group. To add a new person, write: People: Fay'],
  ['Lunch, paid by Ben\n- Soup 5 everyone except Ana, Ben, Cy, Dee, Eli', 'Line 2: That leaves nobody to share this item.'],
  ['Lunch, paid by Ben\n- ' + 'x'.repeat(81) + ' 5 Ana', 'Line 2: That item name is long. Keep it to 80 letters.'],
  ['Lunch, paid by Ben\n- Soup 5 Ana\n- Salad\n- Bread 2 Bne\n- Tea 1', ['Line 3: This item needs a price, like: - Wine 20 Ana, Ben', 'Line 4: Bne is not in the group. Did you mean Ben? To add a new person, write: People: Bne']],
  ['Lunch, paid by Ben\n- Soup 5.5 JPY Ana\n- Tea 100 Ana', 'Line 2: JPY has no decimals. Write a whole number, like 5.'],
  ['Lunch, paid by Ben\n' + '- Tea 1 Ana\n'.repeat(101), 'A bill can have up to 100 items.'],
  ['Cy paid Ana 50\n  - Soup 5 Ana', 'A payment cannot have items. Remove the lines under it.'],
  ['- Soup 5 Ana', 'This line starts like an item, but no bill is right above it. Remove the dash, or move the line under its bill.'],
  ['* Dinner 120 paid by Ana', 'This line starts like an item, but no bill is right above it. Remove the dash, or move the line under its bill.']
]);

test('items: the example of the spec, in euros, comes to 156.20 with the four items', () => {
  const g = G(), text = 'Dinner at the taberna, paid by Dee, tip 10%\n  - Bacalhau 38 Ben\n  - Grilled sardines 22 Cy\n  - Shared petiscos 30 Ana, Eli\n  - Vinho verde 52: Ana, Ben, Dee';
  const d = lastDraft('Currency: EUR\n' + text, g), want = EXAMPLE_GROUP.expenses[2];
  assert.equal(d.lines, 5);
  assert.equal(d.bill.amount, '156.20');
  assert.deepEqual(d.bill.split.items, want.split.items.map(it => ({ ...it, amount: it.amount + '.00' })));
  assert.equal(d.bill.split.tip, '10');
  const a = computeExpense(g, d.bill), b = computeExpense(EXAMPLE_GROUP, want);
  assert.deepEqual([...a.owed].sort(), [...b.owed].sort());
  assert.equal(a.total, b.total);
});

test('items: 100 items are fine', () => {
  const d = lastDraft('Lunch, paid by Ben\n' + '- Tea 1 Ana\n'.repeat(100), G());
  assert.equal(d.ok, true);
  assert.equal(d.bill.amount, '100.00');
  assert.equal(d.lines, 101);
});

/* ---------- payments, and lines that look like them ---------- */

describe('payments and their look-alikes', () => {
  const g = G();
  const kindOf = text => { const d = lastDraft(text, g); return d.kind + (d.ok ? ' ok' : ' fix'); };
  test('"Ana paid Ben 30" is a payment, "Ana paid 30 for Ben" is an expense', () => {
    assert.equal(kindOf('Ana paid Ben 30'), 'payment ok');
    assert.equal(kindOf('Ana paid 30 for Ben'), 'expense fix');
    assert.equal(kindOf('Ana paid 30 for lunch for Ben'), 'expense ok');
    assert.equal(brief(g, lastDraft('Ana paid 30 for lunch for Ben', g).bill), 'lunch | 30.00 USD | Ana | Ben');
    assert.equal(kindOf('Ana paid 30 to Ben'), 'payment ok');
    assert.equal(kindOf('Lunch 30 paid by Ana for Ben'), 'expense ok');
    assert.equal(kindOf('Ana paid 30 for Ben\'s lunch'), 'expense ok');
    assert.equal(brief(g, lastDraft('Ana paid 30 for Ben\'s lunch', g).bill), 'Ben\'s lunch | 30.00 USD | Ana | all');
  });
  test('both end with Ben owing Ana the same', () => {
    const pay = computeExpense(g, lastDraft('Ana paid Ben 30', g).bill), bill = computeExpense(g, lastDraft('Lunch 30 paid by Ana for Ben', g).bill);
    assert.deepEqual(pay.edges, [['p-ben', 'p-ana', 3000]]);
    assert.deepEqual(bill.edges, [['p-ben', 'p-ana', 3000]]);
  });
  test('kinds of lines', () => {
    assert.equal(kindOf('Ben paid 30 for taxi'), 'expense ok');
    assert.equal(kindOf('Taxi 30 paid by Ben'), 'expense ok');
    assert.equal(kindOf('Ben sent Ana 30'), 'payment ok');
    assert.equal(kindOf('Ben sent 30'), 'expense fix');
    assert.equal(kindOf('Ben sent flowers 30'), 'expense fix');
    assert.equal(kindOf('Ben -> Ana 30'), 'payment ok');
    assert.equal(kindOf('Ben -> Ana'), 'payment fix');
    assert.equal(kindOf('Ana paid Ana 30'), 'payment fix');
    assert.equal(kindOf('Ana and Ben paid Cy 30'), 'payment fix');
    assert.equal(kindOf('Ana and Ben paid 30 for taxi'), 'expense ok');
    assert.equal(kindOf('Bills paid 300 paid by Ana'), 'expense fix');
    assert.equal(kindOf('Flowers sent to mum 40 paid by Ana'), 'expense ok');
    assert.equal(kindOf('Money sent home 40 paid by Ana'), 'expense ok');
    assert.equal(kindOf('Paid Ana 50'), 'expense fix');
    assert.equal(kindOf('lunch paid 30'), 'expense fix');
    assert.deepEqual(lastDraft('lunch paid 30', g).errors, ['Who paid? Add: paid by <name>'], 'a small word in front is a name of a bill, not a person');
  });
});

refuses('payments: what is refused', [
  ['Ana paid Ana 30', 'Pick two different people.'],
  ['Ana and Ben paid Cy 30', 'A payment goes from one person to one person. Write one line for each.'],
  ['Everyone paid Cy 30', 'A payment goes from one person to one person. Write one line for each.'],
  ['Cy paid Ana', 'How much? Put the amount after the names, like: Cy paid Ana 50'],
  ['Cy paid Ana back', 'How much? Put the amount after the names, like: Cy paid Ana 50'],
  ['Cy -> Ana', 'How much? Put the amount after the names, like: Cy paid Ana 50'],
  ['Cy paid Ana fifty', 'How much? Put the amount after the names, like: Cy paid Ana 50'],
  ['Cy sent 50', 'Who got the money? Write it like: Cy sent Ana 50'],
  ['Cy gave 50 for the gift', 'Who got the money? Write it like: Cy sent Ana 50'],
  ['Cy -> 50', 'Who got the money? Write it like: Cy sent Ana 50'],
  ['Cy sent 50 to', 'Who got the money? Write it like: Cy sent Ana 50'],
  ['Cy sent flowers', '"flowers" is not a person in the group. For a bill, write its name first, like: Taxi 30 paid by Ana'],
  ['Cy paid Ana 0', 'The amount needs to be more than 0.'],
  ['Cy paid Ana -5', 'An amount cannot be negative. For money paid back, write: Cy paid Ana 50'],
  ['Cy paid Ana 50%', '"50%" is not an amount. Write a plain number, like 120.'],
  ['Cy paid Ana 50 thanks', '"thanks" is not clear here. A payment is two people and an amount, like: Cy paid Ana 50'],
  ['Cy paid Ana 50 60', '"60" is not clear here. A payment is two people and an amount, like: Cy paid Ana 50'],
  ['Cy paid Ana 50, split with Ben', 'This part is not clear. A payment is two people and an amount, like: Cy paid Ana 50'],
  ['Cy paid Ana 50 paid by Ben', 'This part is not clear. A payment is two people and an amount, like: Cy paid Ana 50'],
  ['Cy paid Ana 50 for tickets for Ben', 'This part is not clear. A payment is two people and an amount, like: Cy paid Ana 50'],
  ['Cy paid Ana 50 for Ben', 'This part is not clear. A payment is two people and an amount, like: Cy paid Ana 50'],
  ['Cy paid Ana 50 for everyone', 'This part is not clear. A payment is two people and an amount, like: Cy paid Ana 50'],
  ['Refund: Cy paid Ana 50 for tickets', 'This part is not clear. A payment is two people and an amount, like: Cy paid Ana 50'],
  ['Cy paid Ana 50 for', 'This part is not clear. A payment is two people and an amount, like: Cy paid Ana 50'],
  ['Cy paid Ana 50, rate 1.1', 'This bill is in USD, the group\'s currency, so it needs no rate. Remove the rate, or add the bill\'s currency, like 120 EUR.'],
  ['Cy paid Ana 50 for ' + 'x'.repeat(81), 'That note is long. Keep it to 80 letters.'],
  ['Cy owes Ana 50', '"owes" cannot be added as it is. Write who paid, like: Loan 50 paid by Ana for Cy'],
  ['Ana and Ben owe Cy 50', '"owe" cannot be added as it is. Write who paid, like: Loan 50 paid by Ana for Cy']
]);

test('payments: names of two people with long names still give a note that fits', () => {
  const long = ['A' + 'b'.repeat(39), 'C' + 'd'.repeat(39)], g = G({ people: people(long) });
  const d = lastDraft(long[0] + ' paid ' + long[1] + ' 5', g);
  assert.equal(d.ok, true);
  assert.equal(d.bill.title.length, 80);
});

/* ---------- describeBill ---------- */

describe('describeBill', () => {
  const g = G();
  const say = (text, group = g, opts) => describeBill(group, lastDraft(text, group, opts).bill);
  const rows = [
    ['Dinner 120 EUR paid by Ana, split between Ana, Ben and Cy', 'Ana paid 120.00 EUR. Split equally: Ana 40.00, Ben 40.00, Cy 40.00.'],
    ['Cy paid Ana back 50', 'Cy paid Ana back 50.00 USD.'],
    ['Dinner 120 paid by Ana', 'Ana paid 120.00 USD. Split equally: Ana 24.00, Ben 24.00, Cy 24.00, Dee 24.00, Eli 24.00.'],
    ['Dinner 100 paid by Ana, split between Cy, Ana, Ben', 'Ana paid 100.00 USD. Split equally: Ana 33.33, Ben 33.33, Cy 33.34.'],
    ['Dinner 100 paid by Ana, split between Ana, Ben, Cy', 'Ana paid 100.00 USD. Split equally: Ana 33.34, Ben 33.33, Cy 33.33.'],
    ['Hotel 300 paid by Ben and Ana', 'Ana and Ben paid 300.00 USD: Ana 150.00, Ben 150.00. Split equally: Ana 60.00, Ben 60.00, Cy 60.00, Dee 60.00, Eli 60.00.'],
    ['Hotel 120 paid by Ana 80, Ben 40 for Cy', 'Ana and Ben paid 120.00 USD: Ana 80.00, Ben 40.00. Split equally: Cy 120.00.'],
    ['Hotel 120 paid by Ana 60%, Ben 40% for Cy', 'Ana and Ben paid 120.00 USD: Ana 72.00, Ben 48.00. Split equally: Cy 120.00.'],
    ['Hotel 60 paid by Ana, split Ana 30, Ben 20, Cy 10', 'Ana paid 60.00 USD. Split by amounts: Ana 30.00, Ben 20.00, Cy 10.00.'],
    ['Hotel 60 paid by Ana, split Ana 50%, Ben 30%, Cy 20%', 'Ana paid 60.00 USD. Split by percent: Ana 30.00 (50%), Ben 18.00 (30%), Cy 12.00 (20%).'],
    ['Hotel 60 paid by Ana, split Ana x2, Ben x1', 'Ana paid 60.00 USD. Split by shares: Ana 40.00 (2 shares), Ben 20.00 (1 share).'],
    ['Hotel 100 paid by Ana, split Ana x1.5, Ben x1, Cy x0', 'Ana paid 100.00 USD. Split by shares: Ana 60.00 (1.5 shares), Ben 40.00 (1 share), Cy 0.00 (0 shares).'],
    ['Dinner 1000 JPY paid by Ana, split between Ana, Ben and Cy', 'Ana paid 1000 JPY. Split equally: Ana 334, Ben 333, Cy 333.'],
    ['Lunch 20 EUR paid by Ana for Ben, rate 1.1251', 'Ana paid 20.00 EUR. Split equally: Ben 20.00. Rate set for this bill: 1 EUR = 1.1251 USD.'],
    ['Cy paid Ana 50 EUR, rate 1.5', 'Cy paid Ana back 50.00 EUR. Rate set for this bill: 1 EUR = 1.5 USD.'],
    ['Cy paid Ana 5000 yen', 'Cy paid Ana back 5000 JPY.'],
    [TABERNA, 'Dee paid 132.00 USD. Split by items plus 10% tip: Ana 35.58, Ben 60.86, Dee 19.06, Eli 16.50.'],
    ['Lunch, paid by Ben, tax 8.5%, tip 15%\n- Soup 100 Ana', 'Ben paid 123.50 USD. Split by items plus 8.5% tax and 15% tip: Ana 123.50.'],
    ['Lunch, paid by Ben, tax 8.5%\n- Soup 100 Ana', 'Ben paid 108.50 USD. Split by items plus 8.5% tax: Ana 108.50.'],
    ['Lunch, paid by Ben\n- Soup 5 Ana\n- Salad 6', 'Ben paid 11.00 USD. Split by items: Ana 6.20, Ben 1.20, Cy 1.20, Dee 1.20, Eli 1.20.'],
    ['Dinner 120 paid by Fay', 'Fay paid 120.00 USD. Split equally: Ana 20.00, Ben 20.00, Cy 20.00, Dee 20.00, Eli 20.00, Fay 20.00.']
  ];
  for (const [text, want] of rows) test(JSON.stringify(text), () => assert.equal(say(text), want));

  test('the bills of the example group', () => {
    assert.deepEqual(EXAMPLE_GROUP.expenses.map(b => describeBill(EXAMPLE_GROUP, b)), [
      'Ana and Ben paid 780.00 EUR: Ana 520.00, Ben 260.00. Split equally: Ana 156.00, Ben 156.00, Cy 156.00, Dee 156.00, Eli 156.00.',
      'Cy paid 210.00 EUR. Split by shares: Ana 42.00 (1 share), Ben 42.00 (1 share), Cy 42.00 (1 share), Dee 84.00 (2 shares).',
      'Dee paid 156.20 EUR. Split by items plus 10% tip: Ana 35.58, Ben 60.86, Cy 24.20, Dee 19.06, Eli 16.50.',
      'Eli paid 480.00 USD. Split by percent: Ana 120.00 (25%), Ben 120.00 (25%), Cy 120.00 (25%), Dee 120.00 (25%).',
      'Ben and Cy paid 78.00 EUR: Ben 39.00, Cy 39.00. Split equally: Ana 26.00, Ben 26.00, Cy 26.00.',
      'Cy paid Ana back 50.00 USD.'
    ]);
  });

  test('the amounts are the ones computeExpense gives, to the last cent', () => {
    const d = lastDraft('Dinner 100 paid by Ana 33.33, Ben 66.67, split Ana x1, Ben x1, Cy x1', g), r = computeExpense(g, d.bill);
    assert.deepEqual([...r.owedOrig.values()], [3334, 3333, 3333]);
    assert.equal(describeBill(g, d.bill), 'Ana and Ben paid 100.00 USD: Ana 33.33, Ben 66.67. Split by shares: Ana 33.34 (1 share), Ben 33.33 (1 share), Cy 33.33 (1 share).');
  });

  test('a bill with a problem is described by its problem', () => {
    const bill = { id: 'e-1', kind: 'expense', title: 'X', amount: '10', currency: 'USD', paid: { mode: 'single', who: ['p-ana'], values: {} },
      split: { mode: 'exact', who: ['p-ana', 'p-ben'], values: { 'p-ana': '4', 'p-ben': '5' }, items: [], tax: '', tip: '' } };
    assert.equal(describeBill(g, bill), 'The amounts add up to 9.00 USD. The total is 10.00 USD, so 1.00 USD is left to assign.');
    assert.equal(describeBill(g, { ...bill, paid: { mode: 'single', who: [], values: {} }, split: { ...bill.split, mode: 'equal' } }), 'Choose who paid.');
    assert.equal(describeBill(g, { id: 'e-2', kind: 'payment', title: '', amount: '5', currency: 'USD', from: 'p-ana', to: 'p-ana' }), 'Pick two different people.');
  });

  test('it never mentions the name of the bill, so the text of a link cannot sneak in', () => {
    assert.ok(!say('<b>Dinner</b> 120 paid by Ana').includes('<'));
  });
});

/* ---------- formatBill and the round trip ---------- */

/* What two bills must agree on to be the same bill: everything but the id and the spelling of numbers.
   Item rows that are empty do not count, because the math skips them too. Neither does a rate on a bill
   in the group's own currency: it has no effect, so formatBill leaves it out. A payment whose note is
   empty or the usual "Cy paid Ana (back)" is written without a note and comes back with the usual one. */
function canon(g, bill) {
  const cur = bill.currency, money = v => toMinor(v, cur);
  const fx = bill.fx && cur !== g.currency ? [num(bill.fx.rate), bill.fx.base] : null;
  const name = id => (g.people.find(p => p.id === id) || {}).name;
  // A payment without a note of its own gets the usual one, with or without "back".
  const usual = bill.kind === 'payment' && ['', name(bill.from) + ' paid ' + name(bill.to), name(bill.from) + ' paid ' + name(bill.to) + ' back'].includes(bill.title.trim());
  if (bill.kind === 'payment') return { kind: 'payment', title: usual ? '(usual)' : bill.title, amount: money(bill.amount), cur, fx, from: bill.from, to: bill.to };
  const side = s => {
    const mode = s.mode === 'equal' && s.who.length === 1 ? 'single' : s.mode;   // one payer in "equal parts" is one payer
    return { mode, who: s.who, values: mode === 'exact' ? s.who.map(id => money(s.values[id])) : mode === 'percent' || mode === 'shares' ? s.who.map(id => num(s.values[id])) : [] };
  };
  const s = bill.split, items = s.mode === 'items';
  return { kind: 'expense', title: bill.title, amount: items ? computeExpense(g, bill).totalOrig : money(bill.amount), cur, fx, paid: side(bill.paid),
    split: items ? { mode: 'items', items: s.items.filter(it => money(it.amount) > 0 || it.who.length).map(it => [it.name, money(it.amount), it.who]), tax: num(s.tax), tip: num(s.tip) } : { ...side(s), mode: s.mode } };
}

// Writes the bill as text, reads the text back, and checks nothing changed. Returns the text.
function roundTrip(g, bill, message) {
  const text = formatBill(g, bill), res = parseText(text, g), [d] = res.drafts;
  assert.equal(res.drafts.length, 1, 'one entry: ' + text);
  assert.deepEqual(d.errors, [], text);
  assert.deepEqual(canon(g, d.bill), canon(g, bill), message || text);
  assert.equal(formatBill(g, d.bill), text, 'writing it again gives the same text');
  const a = computeExpense(g, bill), b = computeExpense(g, d.bill);
  assert.deepEqual([[...b.paid], [...b.owed], b.total, b.edges], [[...a.paid], [...a.owed], a.total, a.edges], 'the math is the same');
  return text;
}

const [A, B, C, D, E] = NAMES.map(idOf);
const expense = (over = {}) => {
  const { paid, split, ...rest } = over;
  return { id: 'e-test001', kind: 'expense', title: 'Dinner', amount: '120.00', currency: 'USD',
    paid: { mode: 'single', who: [A], values: {}, ...paid },
    split: { mode: 'equal', who: [A, B, C], values: {}, items: [], tax: '', tip: '', ...split }, ...rest };
};
const payment = (over = {}) => ({ id: 'e-pay0001', kind: 'payment', title: 'Cy paid Ana back', amount: '50', currency: 'USD', from: C, to: A, ...over });

describe('formatBill: the canonical text', () => {
  const g = G();
  const rows = [
    [expense(), 'Dinner: 120.00 USD, paid by Ana, split between Ana, Ben and Cy'],
    [expense({ amount: '120', currency: 'EUR' }), 'Dinner: 120.00 EUR, paid by Ana, split between Ana, Ben and Cy'],
    [expense({ amount: '1234567.5' }), 'Dinner: 1234567.50 USD, paid by Ana, split between Ana, Ben and Cy'],
    [expense({ amount: '1000', currency: 'JPY' }), 'Dinner: 1000 JPY, paid by Ana, split between Ana, Ben and Cy'],
    [expense({ split: { who: [B] } }), 'Dinner: 120.00 USD, paid by Ana, split between Ben'],
    [expense({ split: { who: [C, A] } }), 'Dinner: 120.00 USD, paid by Ana, split between Cy and Ana'],
    [expense({ paid: { mode: 'equal', who: [A, B] } }), 'Dinner: 120.00 USD, paid by Ana and Ben, split between Ana, Ben and Cy'],
    [expense({ paid: { mode: 'equal', who: [A] } }), 'Dinner: 120.00 USD, paid by Ana, split between Ana, Ben and Cy'],
    [expense({ paid: { mode: 'exact', who: [A, B], values: { [A]: '80', [B]: '40' } } }), 'Dinner: 120.00 USD, paid by Ana 80.00, Ben 40.00, split between Ana, Ben and Cy'],
    [expense({ paid: { mode: 'percent', who: [A, B], values: { [A]: '60', [B]: '40' } } }), 'Dinner: 120.00 USD, paid by Ana 60%, Ben 40%, split between Ana, Ben and Cy'],
    [expense({ paid: { mode: 'shares', who: [A, B], values: { [A]: '2', [B]: '1' } } }), 'Dinner: 120.00 USD, paid by Ana x2, Ben x1, split between Ana, Ben and Cy'],
    [expense({ split: { mode: 'exact', who: [A, B], values: { [A]: '100', [B]: '20.5' } }, amount: '120.50' }), 'Dinner: 120.50 USD, paid by Ana, split Ana 100.00, Ben 20.50'],
    [expense({ split: { mode: 'percent', who: [A, B], values: { [A]: '62.5', [B]: '37.5' } } }), 'Dinner: 120.00 USD, paid by Ana, split Ana 62.5%, Ben 37.5%'],
    [expense({ split: { mode: 'shares', who: [A, B, C], values: { [A]: '1', [B]: '1.5', [C]: '0' } } }), 'Dinner: 120.00 USD, paid by Ana, split Ana x1, Ben x1.5, Cy x0'],
    [expense({ currency: 'EUR', fx: { rate: '1.1251', base: 'USD' } }), 'Dinner: 120.00 EUR, paid by Ana, split between Ana, Ben and Cy, rate 1.1251 USD'],
    [expense({ currency: 'EUR', fx: { rate: '0.85', base: 'GBP' } }), 'Dinner: 120.00 EUR, paid by Ana, split between Ana, Ben and Cy, rate 0.85 GBP'],
    [expense({ currency: 'JPY', amount: '3000', fx: { rate: '0.0000063', base: 'USD' } }), 'Dinner: 3000 JPY, paid by Ana, split between Ana, Ben and Cy, rate 0.0000063 USD'],
    [payment(), 'Cy paid Ana 50.00 USD'],
    [payment({ title: 'Cy paid Ana' }), 'Cy paid Ana 50.00 USD'],
    [payment({ title: '' }), 'Cy paid Ana 50.00 USD'],
    [payment({ title: 'Tickets' }), 'Tickets: Cy paid Ana 50.00 USD'],
    [payment({ title: 'Ana' }), '"Ana": Cy paid Ana 50.00 USD'],
    [payment({ currency: 'EUR', fx: { rate: '1.2', base: 'USD' } }), 'Cy paid Ana 50.00 EUR, rate 1.2 USD'],
    [payment({ currency: 'JPY', amount: '5000' }), 'Cy paid Ana 5000 JPY'],
    [expense({ title: 'Dinner: the sequel' }), '"Dinner: the sequel": 120.00 USD, paid by Ana, split between Ana, Ben and Cy'],
    [expense({ title: 'Say "cheese"' }), 'Say "cheese": 120.00 USD, paid by Ana, split between Ana, Ben and Cy'],
    [expense({ title: '"Quoted"' }), '"""Quoted""": 120.00 USD, paid by Ana, split between Ana, Ben and Cy'],
    [expense({ title: 'Ben' }), '"Ben": 120.00 USD, paid by Ana, split between Ana, Ben and Cy'],
    [expense({ title: 'People' }), '"People": 120.00 USD, paid by Ana, split between Ana, Ben and Cy'],
    [expense({ title: '# nights' }), '"# nights": 120.00 USD, paid by Ana, split between Ana, Ben and Cy'],
    [expense({ title: 'Two\nlines' }), 'Two lines: 120.00 USD, paid by Ana, split between Ana, Ben and Cy'],
    [expense({ title: 'Dinner 120 paid by Ana for Ben, tip 10%' }), 'Dinner 120 paid by Ana for Ben, tip 10%: 120.00 USD, paid by Ana, split between Ana, Ben and Cy'],
    [structuredClone(EXAMPLE_GROUP.expenses[2]), 'Dinner at the taberna: 156.20 EUR, paid by Dee, tip 10%\n  - Bacalhau: 38.00 for Ben\n  - Grilled sardines: 22.00 for Cy\n  - Shared petiscos: 30.00 for Ana and Eli\n  - Vinho verde: 52.00 for Ana, Ben and Dee'],
    [expense({ split: { mode: 'items', who: [], items: [{ name: '', amount: '5', who: [A] }, { name: 'Table 5: wine', amount: '12', who: [A, B] }, { name: 'Ben', amount: '3', who: [C] }, { name: '', amount: '', who: [] }], tax: '8.5', tip: '15' } }),
      'Dinner: 24.70 USD, paid by Ana, tax 8.5%, tip 15%\n  - 5.00 for Ana\n  - "Table 5: wine": 12.00 for Ana and Ben\n  - Ben: 3.00 for Cy']
  ];
  for (const [bill, want] of rows) {
    test(want.split('\n')[0], () => {
      assert.equal(formatBill(g, bill), want);
      if (!/\n/.test(bill.title)) roundTrip(g, bill);   // a line break in a name becomes a space, the one thing that changes
    });
  }

  test('a bill that is broken stays broken when its text is read back', () => {
    const broken = [
      expense({ paid: { who: [] } }),
      expense({ paid: { who: ['p-gone'] } }),
      expense({ split: { who: [] } }),
      expense({ split: { mode: 'single' } }),
      expense({ split: { mode: 'nonsense' } }),
      expense({ paid: { mode: 'items' } }),
      expense({ amount: '' }),
      expense({ amount: '0' }),
      expense({ title: '' }),
      expense({ title: '   ' }),
      expense({ split: { mode: 'exact', who: [A, B], values: { [A]: '1', [B]: '2' } } }),
      expense({ split: { mode: 'percent', who: [A, B], values: { [A]: '10', [B]: '20' } } }),
      expense({ split: { mode: 'items', items: [{ name: 'Soup', amount: '5', who: [] }] } }),
      expense({ split: { mode: 'items', items: [{ name: 'Soup', amount: '', who: [A] }] } }),
      expense({ split: { mode: 'items', items: [] } }),
      expense({ currency: 'EUR', fx: { rate: '2', base: 'EUR' } }),
      payment({ from: 'p-gone' }),
      payment({ to: C }),
      payment({ amount: '' })
    ];
    for (const bill of broken) {
      const text = formatBill(g, bill), drafts = parseText(text, g).drafts;
      assert.ok(drafts.length >= 1 && drafts.every(d => !d.ok), JSON.stringify(text));
    }
  });

  test('people who left the group are left out, like the math does', () => {
    const bill = expense({ paid: { mode: 'equal', who: [A, 'p-gone'] }, split: { who: [A, B, 'p-gone', A] } });
    assert.equal(formatBill(g, bill), 'Dinner: 120.00 USD, paid by Ana, split between Ana and Ben');
  });

  test('drafts with new people can be written and described before they are added', () => {
    const d = lastDraft('Dinner 120 paid by Fay, split with Gus', g);
    assert.equal(formatBill(g, d.bill), 'Dinner: 120.00 USD, paid by Fay, split between Fay and Gus');
    assert.equal(describeBill(g, d.bill), 'Fay paid 120.00 USD. Split equally: Fay 60.00, Gus 60.00.');
    const p = lastDraft('People: Fay\nFay paid Ana 5', g);
    assert.equal(formatBill(g, p.bill), 'Fay paid Ana 5.00 USD');
    assert.equal(describeBill(g, p.bill), 'Fay paid Ana back 5.00 USD.');
  });

  test('bills and groups with parts missing are written and described without a throw', () => {
    const bare = { id: 'g-1', name: 'x', currency: 'USD' };
    for (const bill of [{ kind: 'expense' }, { kind: 'payment' }, {}, { kind: 'expense', title: null, paid: {}, split: {} }, { kind: 'expense', split: { mode: 'items' } },
      { kind: 'expense', split: { mode: 'items', items: [null, {}, { who: 'p-ana' }] } }, { kind: 'expense', paid: { who: 'p-ana' }, split: { who: null, values: null } }, expense({ fx: {} }), payment({ fx: { rate: '2' }, currency: 'EUR' })]) {
      for (const group of [g, bare, {}]) {
        assert.equal(typeof formatBill(group, bill), 'string');
        assert.equal(typeof describeBill(group, bill), 'string');
      }
    }
    assert.equal(formatBill(g, { kind: 'expense' }), '"": 0.00 USD, paid by ?, split ?');
    assert.equal(formatBill(g, { kind: 'payment' }), '? paid ? 0.00 USD');
    assert.equal(describeBill(g, { kind: 'expense' }), 'Enter the total.');
    assert.equal(describeBill({}, payment({ currency: 'EUR', fx: { rate: '2' } })), 'Choose who paid whom.');
    assert.equal(formatGroup({}), '');
  });

  test('odd stored numbers are written the way the math reads them', () => {
    const bill = expense({ amount: ' 1,200.5 ', paid: { mode: 'shares', who: [A, B], values: { [A]: '1e3', [B]: '-2' } }, split: { mode: 'percent', who: [A, B], values: { [A]: '50.0', [B]: '050' } } });
    assert.equal(formatBill(g, bill), 'Dinner: 1200.50 USD, paid by Ana x13, Ben x0, split Ana 50%, Ben 50%');
    assert.equal(formatBill(g, expense({ currency: 'EUR', fx: { rate: '0.00000012', base: 'USD' } })), 'Dinner: 120.00 EUR, paid by Ana, split between Ana, Ben and Cy, rate 0.00000012 USD');
  });
});

describe('round trip: every mode on both sides, by hand', () => {
  const g = G();
  const sides = {
    single: { mode: 'single', who: [B], values: {} },
    equal: { mode: 'equal', who: [C, A, E], values: {} },
    exact: { mode: 'exact', who: [A, D], values: { [A]: '100.25', [D]: '19.75' } },
    percent: { mode: 'percent', who: [B, A, C], values: { [B]: '33.34', [A]: '33.33', [C]: '33.33' } },
    shares: { mode: 'shares', who: [E, D], values: { [E]: '3', [D]: '1.5' } }
  };
  for (let [p, paid] of Object.entries(sides)) {
    for (const [s, split] of Object.entries(sides)) {
      if (s === 'single') continue;
      test('paid ' + p + ', split ' + s, () => { roundTrip(g, expense({ paid, split })); });
    }
    test('paid ' + p + ', split by items with tax and tip', () => {
      // 38 + 52.10 + 7 = 97.10, plus 18.5% (17.96) = 115.06
      if (p === 'exact') paid = { ...paid, values: { [A]: '100.25', [D]: '14.81' } };
      roundTrip(g, expense({ paid, amount: '', currency: 'EUR', split: { mode: 'items', who: [], items: [{ name: 'Bacalhau', amount: '38', who: [B] }, { name: 'Vinho verde', amount: '52.10', who: [A, B, D] }, { name: '', amount: '7', who: [E] }], tax: '8.5', tip: '10' } }));
    });
  }
  test('a fixed rate, against the group\'s currency and against another one', () => {
    assert.match(roundTrip(g, expense({ currency: 'EUR', fx: { rate: '1.1251', base: 'USD' } })), /rate 1\.1251 USD$/);
    assert.match(roundTrip(g, expense({ currency: 'EUR', fx: { rate: '0.85', base: 'GBP' } })), /rate 0\.85 GBP$/);
    assert.match(roundTrip(g, expense({ currency: 'GBP', fx: { rate: '1.17', base: 'EUR' } })), /rate 1\.17 EUR$/);
    assert.doesNotMatch(roundTrip(g, expense({ currency: 'USD', fx: { rate: '0.9', base: 'EUR' } })), /rate/, 'a rate that does nothing is not written');
  });
  test('payments', () => {
    roundTrip(g, payment());
    roundTrip(g, payment({ title: 'Tickets refund', currency: 'EUR', amount: '12.34', fx: { rate: '1.3', base: 'USD' } }));
    roundTrip(g, payment({ title: 'Refund: part 2', from: E, to: D }));
  });
  test('currencies without decimals', () => {
    for (const currency of ['JPY', 'KRW', 'VND']) {
      roundTrip(g, expense({ currency, amount: '10001', split: { mode: 'equal', who: [A, B, C] } }));
      roundTrip(g, expense({ currency, amount: '10000', split: { mode: 'exact', who: [A, B], values: { [A]: '3333', [B]: '6667' } } }));
      roundTrip(g, expense({ currency, amount: '', split: { mode: 'items', who: [], items: [{ name: 'Ramen', amount: '980', who: [A, B] }], tax: '10', tip: '' } }));
      roundTrip(g, payment({ currency, amount: '5000' }));
    }
  });
  test('every currency', () => {
    for (const currency of CURRENCIES) roundTrip(g, expense({ currency, amount: '1234' }));
  });
  test('a group in another currency', () => {
    for (const currency of ['EUR', 'JPY', 'CAD', 'MXN', 'CNY']) {
      const other = G({ currency });
      roundTrip(other, expense({ currency: 'USD' }));
      roundTrip(other, expense({ currency }));
      roundTrip(other, payment({ currency: 'JPY', amount: '900' }));
    }
  });
});

describe('round trip: names of bills that try to break out', () => {
  const g = G();
  const titles = ['Dinner', 'Room 12', '2 pizzas', '2024', '12', '1 200', '12 300', '120.00 EUR', '€20', '50%', 'x2', '-5', '.5',
    'Dinner for two', 'Dinner with Ana', 'Lunch for Ana and Ben', 'Gift for everyone except Dee', 'Tip', 'tip 10%', 'tax 8.5%', 'rate 1.5', 'Exchange rate',
    'Banana split', 'split', 'Split between Ana and Ben', 'paid by Ana', 'Dinner paid by Ben', 'Ana paid 120 for dinner', 'Cy paid Ana 50', 'Cy -> Ana 50',
    'Ana', 'ana', 'Ana and Ben', 'Ana, Ben', 'Everyone', 'me', 'I', 'us', 'the group', 'All of us', 'Ana\'s birthday', 'Ana-Maria', 'Anabel',
    'People', 'people', 'Group', 'Currency', 'Me', 'I am Ana', 'I\'m Ana', 'People: Fay', 'Currency: EUR',
    '# not a note', '// not a note', '#', '- not an item', '* star', '• dot', '– dash', '->', '→',
    'Dinner: the sequel', 'a:b:c', ':', 'Time 19:30', '19:30', 'Say "cheese"', '"', '""', '"quoted"', '“curly”', '“', 'It\'s', '’',
    ' leading', 'trailing ', '  both  ', 'two  spaces', 'tab\there', 'Dinner, drinks; more', 'Fish & chips', 'A+B', 'a.b.c', 'Really?!', '...', '?', '!',
    'EUR', 'eur 120', 'try', 'PHP', 'Learn PHP 30', 'Second try 40', 'yen', 'dollars', '120 bucks', '$', '€', '$ € ¥',
    'Café “Lisboa”', 'Crème brûlée', '小明の誕生日', 'Ужин', 'عشاء', '🍕 night', 'José'.normalize('NFC'),
    '<script>alert(1)</script>', '__proto__', 'constructor', 'x'.repeat(80), '7-Eleven', '50/50', 'A' + ' b'.repeat(39)];
  for (const title of titles) {
    test(JSON.stringify(title), () => {
      roundTrip(g, expense({ title }));
      roundTrip(g, expense({ title, currency: 'EUR', amount: '', paid: { mode: 'equal', who: [A, B] }, split: { mode: 'items', who: [], items: [{ name: title, amount: '5', who: [A] }, { name: 'Tea', amount: '3', who: [B, C] }], tax: '', tip: '10' } }));
      roundTrip(g, payment({ title }));
    });
  }
});

describe('round trip: names of people with spaces and marks in them', () => {
  const odd = ['Mary Ann', 'Mary', 'Ann', 'O\'Brien', 'Jean-Luc', 'Lee, Jr.', 'Ben & Jerry', 'Dr. Who', 'José', '小明', 'R2-D2', 'Mary Ann Smith', 'van der Berg', 'Yen', 'Al'];
  const g = G({ people: people(odd) }), ids = odd.map(idOf);
  test('ids of the test group are distinct', () => assert.equal(new Set(ids).size, ids.length));
  for (let k = 0; k < ids.length; k++) {
    const a = ids[k], b = ids[(k + 1) % ids.length], c = ids[(k + 5) % ids.length];
    test(odd[k], () => {
      roundTrip(g, expense({ paid: { mode: 'single', who: [a] }, split: { mode: 'equal', who: [a, b, c] } }));
      roundTrip(g, expense({ paid: { mode: 'equal', who: [b, a] }, split: { mode: 'exact', who: [c, a], values: { [c]: '20', [a]: '100' } } }));
      roundTrip(g, expense({ paid: { mode: 'percent', who: [a, c], values: { [a]: '75', [c]: '25' } }, split: { mode: 'shares', who: [a, b], values: { [a]: '2', [b]: '3' } } }));
      roundTrip(g, expense({ paid: { mode: 'single', who: [c] }, amount: '', split: { mode: 'items', who: [], items: [{ name: 'Soup', amount: '5', who: [a, b] }, { name: 'Tea', amount: '2', who: [c] }], tax: '', tip: '' } }));
      roundTrip(g, payment({ from: a, to: b, title: odd[k] + ' paid ' + odd[(k + 1) % ids.length] + ' back' }));
    });
  }
  test('formatGroup writes them so that an empty group can read them', () => {
    const text = formatGroup({ ...g, expenses: [expense({ paid: { mode: 'single', who: [ids[5]] }, split: { mode: 'equal', who: ids } })] });
    assert.equal(text.split('\n')[0], 'People: Mary Ann, Mary, Ann, O\'Brien, Jean-Luc, "Lee, Jr.", "Ben & Jerry", Dr. Who, José, 小明, R2-D2, Mary Ann Smith, van der Berg, Yen, Al');
    const res = parseText(text, EMPTY());
    assert.deepEqual(res.drafts.map(d => d.errors), [[], []]);
    assert.deepEqual(res.people.map(p => p.name), odd);
    assert.deepEqual(res.drafts[1].bill.split.who, odd.map(name => 'new:' + name));
    assert.equal(res.drafts[1].bill.paid.who[0], 'new:Lee, Jr.');
  });
});

// A random valid bill for the group: any mode on either side, items, rates, payments.
function randomBill(rnd, g) {
  const ids = g.people.map(p => p.id), cur = pick(rnd, ['USD', 'EUR', 'JPY', 'GBP', 'KRW', 'CHF', g.currency]), d = minorDigits(cur);
  const money = () => (d ? int(rnd, 1, 500000) / 100 : int(rnd, 1, 500000)).toFixed(d);
  const some = min => shuffled(rnd, ids).slice(0, int(rnd, min, ids.length));
  const fx = cur !== g.currency && rnd() < 0.3 ? { fx: { rate: pick(rnd, ['1.1251', '0.0063', '157.82', '2', '0.5']), base: g.currency } } : {};
  const title = pick(rnd, ['Dinner', 'Room 12', 'Taxi for two', 'Ana', 'Tip', '2 for 1', 'Dinner: late', 'Banana split', 'Learn PHP 30', '# 5']);
  if (rnd() < 0.15) {
    const [from, to] = shuffled(rnd, ids);
    return { id: 'e-r', kind: 'payment', title: rnd() < 0.5 ? title : g.people.find(p => p.id === from).name + ' paid ' + g.people.find(p => p.id === to).name + ' back', amount: money(), currency: cur, from, to, ...fx };
  }
  const total = toMinor(money(), cur);
  const side = (modes, min) => {
    const mode = pick(rnd, modes), who = mode === 'single' ? some(1).slice(0, 1) : some(min), values = {};
    if (mode === 'exact') { let left = total; who.forEach((id, k) => { const v = k === who.length - 1 ? left : int(rnd, 0, left); left -= v; values[id] = (v / 10 ** d).toFixed(d); }); }
    if (mode === 'percent') { let left = 1000; who.forEach((id, k) => { const v = k === who.length - 1 ? left : int(rnd, 0, left); left -= v; values[id] = String(v / 10); }); }
    if (mode === 'shares') who.forEach((id, k) => { values[id] = String(k === 0 ? int(rnd, 1, 5) : int(rnd, 0, 8) / 2); });
    return { mode, who, values };
  };
  const paid = side(['single', 'single', 'equal', 'exact', 'percent', 'shares'], 1);
  if (rnd() < 0.25) {
    const items = Array.from({ length: int(rnd, 1, 5) }, () => ({ name: pick(rnd, ['Soup', 'Wine 2019', '', 'Ben', 'Table 5: wine', 'Fish & chips']), amount: money(), who: some(1) }));
    return { id: 'e-r', kind: 'expense', title, amount: '', currency: cur, paid: { ...paid, ...(paid.mode === 'exact' ? { mode: 'equal', values: {} } : {}) },
      split: { mode: 'items', who: [], values: {}, items, tax: pick(rnd, ['', '8.5', '7']), tip: pick(rnd, ['', '10', '12.5']) }, ...fx };
  }
  return { id: 'e-r', kind: 'expense', title, amount: (total / 10 ** d).toFixed(d), currency: cur, paid, split: { ...side(['equal', 'equal', 'exact', 'percent', 'shares'], 1), items: [], tax: '', tip: '' }, ...fx };
}

test('round trip: 1500 random bills in three groups', () => {
  const groups = [G(), G({ currency: 'EUR' }), G({ currency: 'JPY', people: people(['Mary Ann', 'Mary', 'Al', 'José', 'Dee Dee', 'Yuki']) })];
  let done = 0;
  for (let seed = 1; seed <= 1500; seed++) {
    const rnd = rng(seed), g = groups[seed % 3], bill = randomBill(rnd, g);
    if (computeExpense(g, bill).err) continue;   // a random bill can come out invalid, e.g. no shares at all
    roundTrip(g, bill, 'seed ' + seed);
    done++;
  }
  assert.ok(done > 1300, 'most random bills are valid: ' + done);
});

/* ---------- formatGroup ---------- */

describe('formatGroup', () => {
  test('the example group as text', () => {
    assert.equal(formatGroup(EXAMPLE_GROUP), [
      'People: Ana, Ben, Cy, Dee, Eli',
      'Apartment in Alfama: 780.00 EUR, paid by Ana 520.00, Ben 260.00, split between Ana, Ben, Cy, Dee and Eli',
      'Groceries: 210.00 EUR, paid by Cy, split Ana x1, Ben x1, Cy x1, Dee x2',
      'Dinner at the taberna: 156.20 EUR, paid by Dee, tip 10%',
      '  - Bacalhau: 38.00 for Ben',
      '  - Grilled sardines: 22.00 for Cy',
      '  - Shared petiscos: 30.00 for Ana and Eli',
      '  - Vinho verde: 52.00 for Ana, Ben and Dee',
      'Surf lessons: 480.00 USD, paid by Eli, split Ana 25%, Ben 25%, Cy 25%, Dee 25%',
      'Train to Sintra: 78.00 EUR, paid by Ben 50%, Cy 50%, split between Ana, Ben and Cy',
      'Cy paid Ana 50.00 USD'
    ].join('\n'));
  });

  test('read into an empty group, it gives the same totals for every person', () => {
    const empty = { id: 'g-new', name: 'New', currency: 'USD', rev: 0, people: [], expenses: [], rates: {} };
    const res = parseText(formatGroup(EXAMPLE_GROUP), empty);
    assertSound(empty, res);
    assert.deepEqual(res.drafts.map(d => [d.kind, d.ok]), [['people', true], ['expense', true], ['expense', true], ['expense', true], ['expense', true], ['expense', true], ['payment', true]]);
    assert.deepEqual(res.drafts[0].newPeople, NAMES);
    assert.deepEqual(res.people, NAMES.map(name => ({ name, isNew: true })));
    const rebuilt = { ...grown(empty, res), expenses: res.drafts.filter(d => d.bill).map(d => d.bill) };
    const byName = g => [...personTotals(g)].map(([id, t]) => [g.people.find(p => p.id === id).name, t.paid, t.share]);
    assert.deepEqual(byName(rebuilt), byName(EXAMPLE_GROUP));
    assert.deepEqual(byName(EXAMPLE_GROUP), [['Ana', 58507, 46207], ['Ben', 33641, 44051], ['Cy', 33016, 39925], ['Dee', 17575, 41148], ['Eli', 48000, 19408]]);
  });

  test('read back into the same group, every bill is the same bill', () => {
    const drafts = parseText(formatGroup(EXAMPLE_GROUP), EXAMPLE_GROUP).drafts;
    assert.deepEqual(drafts[0].newPeople, []);
    assert.equal(drafts[0].warnings.length, 5);
    drafts.slice(1).forEach((d, k) => assert.deepEqual(canon(EXAMPLE_GROUP, d.bill), canon(EXAMPLE_GROUP, EXAMPLE_GROUP.expenses[k])));
  });

  test('no people, no bills', () => {
    assert.equal(formatGroup(EMPTY()), '');
    assert.equal(formatGroup(G()), 'People: Ana, Ben, Cy, Dee, Eli');
    assert.equal(formatGroup({ id: 'g-1', name: 'x', currency: 'USD' }), '');
  });

  test('random groups survive the trip into an empty group', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = rng(seed), g = G({ currency: pick(rnd, ['USD', 'EUR', 'JPY']) });
      g.expenses = Array.from({ length: int(rnd, 1, 8) }, () => randomBill(rnd, g)).filter(b => !computeExpense(g, b).err);
      const empty = { ...EMPTY(), currency: g.currency }, res = parseText(formatGroup(g), empty);
      assert.ok(res.drafts.every(d => d.ok), 'seed ' + seed + ': ' + JSON.stringify(res.drafts.filter(d => !d.ok).map(d => [d.source, d.errors])));
      const rebuilt = { ...grown(empty, res), expenses: res.drafts.filter(d => d.bill).map(d => d.bill) };
      assert.deepEqual([...personTotals(rebuilt).values()], [...personTotals(g).values()], 'seed ' + seed);
    }
  });
});

/* ---------- fuzz ---------- */

const SOUP = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'ana', 'Bne', 'Fay', 'Mary Jane', 'I', 'me', 'my', 'myself', 'everyone', 'everybody', 'all', 'all of us', 'us', 'the group', 'each',
  'paid', 'by', 'paid by', 'split', 'between', 'among', 'with', 'for', 'except', 'but', 'tip', 'tax', 'rate', 'back', 'to', 'sent', 'gave', 'repaid', 'owes', 'and', '&', '+', ',', ';', ':', '.', '-', '->', '→', '%',
  'x', 'x2', '2x', '×3', '2 shares', 'ways', '5 ways', 'equally', 'evenly', '120', '45', '0', '12.50', '12,50', '1,200.50', '1.200,50', '1 200', '1.200', '-5', '.5', '1e9', '99999999999999999999',
  '10%', '8.5%', '100%', '50%', '€', '$', '¥', '£', 'EUR', 'eur', 'USD', 'JPY', 'try', 'TRY', 'PHP', 'RUB', '€120', '$45', '120€', '120eur', 'euros', 'dollars', 'yen', 'bucks',
  'Dinner', 'Lunch', 'taxi', 'the', 'at', 'People:', 'Currency:', 'Me:', 'I am', 'I\'m', '#', '//', '"', '""', '“', '”', '19:30', '7-Eleven', 'Room 12', '\t', '  ', '\n', '\n  - ', '\n- ', '\n  ', '\n\n',
  '*', '•', '(', ')', '?', '!', '\'', '’s', 'é', '小明', ' ', ' ', '🙂', '<b>', '__proto__', 'constructor', 'toString', '\u0000', '\ud83d', 'İ', 'ß'];

// A line that follows the grammar, built from random parts.
function grammarLine(rnd) {
  const some = min => shuffled(rnd, NAMES).slice(0, int(rnd, min, NAMES.length));
  const amount = () => pick(rnd, ['120', '45.50', '12,50', '1,200', '€80', '80 EUR', '$33', '99 dollars', '7', '1000 JPY', '0.99', '300 try', '60']);
  const title = () => pick(rnd, ['Dinner', 'Taxi home', 'Room 12', 'Tickets for the show', 'Tip', 'Banana split', 'Lunch', '7 nights']);
  const list = w => pick(rnd, [w.join(', '), w.join(' and '), w.slice(0, -1).join(', ') + (w.length > 1 ? ' and ' : '') + w[w.length - 1], w.join(' & '), w.join(' ')]);
  const pairs = (w, kind) => w.map((n, i) => n + ' ' + (kind === 'pct' ? (i === 0 ? 100 - 10 * (w.length - 1) : 10) + '%' : kind === 'sh' ? pick(rnd, ['x', '×']) + int(rnd, 1, 3) : (i === 0 ? 60 - 10 * (w.length - 1) : 10))).join(', ');
  const who = () => pick(rnd, ['', '', ', split equally', ', split 5 ways', ' for ' + list(some(1)), ', split between ' + list(some(1)), ' among ' + list(some(2)), ', split with ' + list(some(1)),
    ' for everyone except ' + pick(rnd, NAMES), ', split ' + pairs(some(1), 'pct'), ', split ' + pairs(some(1), 'sh'), ', split ' + pairs(some(1), 'ex'), ' for everyone', ', everyone but Dee']);
  const payer = () => pick(rnd, [pick(rnd, NAMES), pick(rnd, NAMES), list(some(2)), pairs(some(2), 'pct'), pairs(some(2), 'sh'), pairs(some(2), 'ex'), 'everyone', 'me']);
  const rate = () => (rnd() < 0.15 ? ', rate ' + pick(rnd, ['1.1251', '0.0063', '157,82', '1.36 CAD']) : '');
  const item = () => pick(rnd, ['  - ', '- ', '* ', '  ']) + pick(rnd, ['Fish', 'Wine 2019', 'Bread', '']) + pick(rnd, [' ', ': ']) + pick(rnd, ['12', '8.50', '€30', '5 500'])
    + pick(rnd, ['', ' ' + list(some(1)), ': ' + list(some(1)), ' for ' + list(some(1)), ' everyone', ' everyone except Ben']);
  switch (int(rnd, 0, 6)) {
    case 0: return title() + pick(rnd, [' ', ': ']) + amount() + pick(rnd, [' ', ', ']) + 'paid by ' + payer() + who() + rate();
    case 1: return pick(rnd, NAMES) + ' paid ' + amount() + ' for ' + title().toLowerCase() + who() + rate();
    case 2: return pick(rnd, NAMES) + pick(rnd, [' paid ', ' sent ', ' gave ', ' repaid ', ' -> ', ' → ', ' paid back ']) + pick(rnd, NAMES) + ' ' + amount() + pick(rnd, ['', ' back', '', ' for tickets']) + rate();
    case 3: return title() + pick(rnd, [', ', ': ', ' ']) + (rnd() < 0.3 ? amount() + ' ' : '') + 'paid by ' + pick(rnd, NAMES) + pick(rnd, ['', ', tip 10%', ', tax 8.5%, tip 15%', ', 10% tip']) + '\n' + Array.from({ length: int(rnd, 1, 3) }, item).join('\n');
    case 4: return pick(rnd, NAMES) + ' sent ' + amount() + pick(rnd, [' to ', ' back to ']) + pick(rnd, NAMES);
    case 5: return pick(rnd, ['People: Fay, Gus', 'Currency: EUR', 'I am Ana', 'Me: Ben', '# note']) + '\n' + title() + ' ' + amount() + ' paid by ' + payer() + who();
    default: return pick(rnd, NAMES) + ' and ' + pick(rnd, NAMES) + ' paid ' + amount() + ' for ' + title() + who();
  }
}

// One small change: a word added, dropped, replaced, moved or respelled, or a separator swapped.
function mutate(rnd, text) {
  const words = text.split(/( )/), k = int(rnd, 0, words.length - 1), junk = pick(rnd, SOUP);
  const op = int(rnd, 0, 6);
  if (op === 0) words.splice(k, 0, junk, ' ');
  else if (op === 1) words.splice(k, 1);
  else if (op === 2) words[k] = junk;
  else if (op === 3) { const j = int(rnd, 0, words.length - 1); [words[k], words[j]] = [words[j], words[k]]; }
  else if (op === 4) words[k] = pick(rnd, [words[k].toUpperCase(), words[k].toLowerCase(), words[k] + pick(rnd, ['.', ',', ';', '!'])]);
  else if (op === 5) words[k] = words[k] === ' ' ? pick(rnd, ['  ', '\t', ' , ', ' - ']) : words[k];
  else return text.replace(pick(rnd, [', ', ' and ', ' & ', ' for ', ' paid by ']), pick(rnd, [', ', ' and ', ' & ', ' + ', ' for ', ' with ', ' between ', ', paid by ']));
  return words.join('');
}

/* What must hold for any text at all: no throw, sound drafts, and every ok bill passes computeExpense,
   can be written as text, and reads back from that text as the very same bill. */
function fuzzCheck(text, g, opts, label) {
  let res;
  assert.doesNotThrow(() => { res = parseText(text, g, opts); }, label + ' threw on ' + JSON.stringify(text));
  assertSound(g, res);
  const big = grown(g, res), same = bill => JSON.stringify({ ...bill, id: '' });
  let ok = 0;
  for (const d of res.drafts) {
    assert.ok(Number.isInteger(d.line) && d.line >= 1 && d.lines >= 1 && typeof d.source === 'string');
    assert.ok(['expense', 'payment', 'people', 'currency', 'me', 'comment'].includes(d.kind));
    assert.ok(Array.isArray(d.warnings) && Array.isArray(d.newPeople));
    if (!d.bill) continue;
    ok++;
    const where = label + ': ' + JSON.stringify(text);
    assert.ok(!/\?|undefined|NaN/.test(describeBill(g, d.bill)), where);
    const back = parseText(formatBill(g, d.bill), big).drafts;
    assert.equal(back.length, 1, where);
    assert.deepEqual(back[0].errors, [], where + ' -> ' + formatBill(g, d.bill));
    assert.equal(same(back[0].bill), same(d.bill), where);
  }
  return ok;
}

describe('fuzz', () => {
  const groupFor = rnd => (rnd() < 0.25 ? G({ currency: pick(rnd, ['JPY', 'EUR', 'CAD', 'MXN', 'CNY']) }) : G());

  test('6000 random word soups never throw and never give a bad bill', () => {
    for (let seed = 1; seed <= 6000; seed++) {
      const rnd = rng(seed), words = Array.from({ length: int(rnd, 1, 14) }, () => pick(rnd, SOUP));
      fuzzCheck(words.join(rnd() < 0.85 ? ' ' : ''), groupFor(rnd), rnd() < 0.5 ? { me: 'p-eli' } : undefined, 'soup ' + seed);
    }
  });

  test('8000 lines of the grammar, as they are and with up to three slips', () => {
    let clean = 0, cleanOk = 0, slipped = 0;
    for (let seed = 1; seed <= 8000; seed++) {
      const rnd = rng(seed);
      let text = grammarLine(rnd);
      const slips = rnd() < 0.3 ? 0 : int(rnd, 1, 3);
      for (let k = 0; k < slips; k++) text = mutate(rnd, text);
      const ok = fuzzCheck(text, groupFor(rnd), rnd() < 0.5 ? { me: 'p-eli' } : undefined, 'line ' + seed);
      if (slips) slipped += ok; else { clean++; cleanOk += ok; }
    }
    assert.ok(cleanOk > clean * 0.5, 'most clean lines are bills: ' + cleanOk + ' of ' + clean);
    assert.ok(slipped > 800, 'lines with slips still give bills to check: ' + slipped);
  });

  test('random characters', () => {
    const chars = 'AnaBe Cyd 0123456789.,:;-+&%$€¥"\'\n\t#/*x×→()!?àé小 ';
    for (let seed = 1; seed <= 2000; seed++) {
      const rnd = rng(seed), text = Array.from({ length: int(rnd, 0, 60) }, () => chars[int(rnd, 0, chars.length - 1)]).join('');
      fuzzCheck(text, G(), undefined, 'chars ' + seed);
    }
  });

  test('hostile sizes finish quickly', () => {
    const g = G(), started = Date.now();
    const texts = ['x'.repeat(200000) + ' 5 paid by Ana', '1,'.repeat(50000) + ' paid by Ana', 'Ana, '.repeat(20000) + ' paid 5', '"'.repeat(50000), 'People: ' + 'a,'.repeat(50000),
      'Dinner paid by Ana\n' + '  - Wine 5 Ana\n'.repeat(5000), 'for '.repeat(20000) + 'paid 5', '9'.repeat(100000) + ' paid by Ana', ('Dinner 12 paid by Ana\n').repeat(3000), ': '.repeat(50000), '- '.repeat(50000), '\n'.repeat(100000)];
    for (const text of texts) fuzzCheck(text, g, undefined, 'size');
    assert.ok(Date.now() - started < 20000, 'took ' + (Date.now() - started) + ' ms');
  });

  test('names from a hostile group are only ever text', () => {
    const g = G({ people: people(NAMES).concat([{ id: 'p-x1', name: '<img src=x onerror=alert(1)>' }, { id: 'p-x2', name: '__proto__' }, { id: 'p-x3', name: 'paid by' }, { id: 'p-x4', name: 'and' }, { id: 'p-x5', name: '120' }, { id: 'p-x6', name: ':' }, { id: 'p-x7', name: '' }, { id: 'p-x8' }, null]) });
    for (let seed = 1; seed <= 1500; seed++) {
      const rnd = rng(seed);
      let text = grammarLine(rnd);
      for (let k = 0; k < 2; k++) text = mutate(rnd, text);
      let res;
      assert.doesNotThrow(() => { res = parseText(text + '\nDinner 5 paid by <img src=x onerror=alert(1)> for __proto__ and 120', g); });
      assert.ok(!res.drafts.some(d => d.errors[0] && d.errors[0].startsWith('This line could not be read')), text);
    }
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal({}.who, undefined);
  });
});
