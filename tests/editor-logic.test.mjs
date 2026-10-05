import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_RATES, CURRENCIES, EXAMPLE_GROUP, computeExpense, formatMoney } from '../docs/js/core.js';
import { formatBill, parseText } from '../docs/js/parse.js';
import { sanitizeGroup } from '../docs/js/share.js';
import { createStore } from '../docs/js/store.js';
import { cleanBill, draftOf, duplicateOf, formHtml, initEditor, newExpense, newPayment, openEditor, readDraft, readNumber,
  setWho, switchMode, toggleItemWho, viewOf } from '../docs/js/editor.js';

/* Part 1 tests the editor's logic: drafts, typed numbers, the bill that is saved, carrying values over
   between ways to split, and what the form shows. Part 2 runs the dialog itself against a small stand-in
   for the page, to check the wiring: typing, redrawing, focus, save, delete, duplicate. */

const A = 'p-a', B = 'p-b', C = 'p-c';
const lisbon = () => structuredClone(EXAMPLE_GROUP);
// The example as the store keeps it: its rates pinned at the built-in numbers.
const pinned = () => ({ ...lisbon(), fx: { date: BUILTIN_RATES.date, usd: { EUR: BUILTIN_RATES.usd.EUR } } });
const trio = (currency = 'USD') => ({ id: 'g-trio', name: 'Trio', currency, rev: 0,
  people: [{ id: A, name: 'Ana' }, { id: B, name: 'Ben' }, { id: C, name: 'Cy' }], expenses: [], rates: {} });
// A draft of a bill in the trio: 120.00, paid by Ana, shared by all three.
const dinner = (group = trio(), more = {}) => ({ ...newExpense(group), title: 'Dinner', amount: '120', ...more });
const edges = (group, bill) => computeExpense(group, bill).edges;
// The same debts, whatever order the bill lists its people in.
const debts = (group, bill) => edges(group, bill).map(e => e.join(' ')).sort();
const billOf = (group, id) => group.expenses.find(b => b.id === id);

/* ================= Part 1: logic ================= */

/* ---------- new drafts ---------- */

test('a new bill: the group\'s currency, paid by the first person, shared by everyone', () => {
  assert.deepEqual(newExpense(trio()), { id: '', kind: 'expense', title: '', amount: '', currency: 'USD',
    paid: { mode: 'single', who: [A], values: {} },
    split: { mode: 'equal', who: [A, B, C], values: {}, items: [{ name: '', amount: '', who: [] }], tax: '', tip: '' } });
});

test('a new bill is paid by "me" when that is someone in the group', () => {
  assert.deepEqual(newExpense(trio(), C).paid.who, [C]);
  assert.deepEqual(newExpense(trio(), 'p-gone').paid.who, [A]);
  assert.deepEqual(newExpense(trio(), '').paid.who, [A]);
  assert.deepEqual(newExpense({ ...trio(), people: [] }).paid.who, []);
});

test('a new bill takes the currency of the most recent bill', () => {
  const g = lisbon();
  assert.equal(newExpense(g).currency, 'USD');           // the last one is the payment in USD
  g.expenses.pop();
  assert.equal(newExpense(g).currency, 'EUR');
  assert.equal(newPayment(g).currency, 'EUR');
  assert.equal(newExpense(trio('GBP')).currency, 'GBP');
});

test('a new payment goes from "me", or the first person, to the next person', () => {
  assert.deepEqual(newPayment(trio()), { id: '', kind: 'payment', title: '', amount: '', currency: 'USD', from: A, to: B });
  assert.deepEqual([newPayment(trio(), B).from, newPayment(trio(), B).to], [B, A]);
  assert.deepEqual([newPayment(trio(), C).from, newPayment(trio(), C).to], [C, A]);
  const alone = { ...trio(), people: [{ id: A, name: 'Ana' }] };
  assert.deepEqual([newPayment(alone).from, newPayment(alone).to], [A, '']);
});

test('new drafts do not share their lists with the group or with each other', () => {
  const g = trio(), d = newExpense(g), e = newExpense(g);
  d.split.who.pop();
  d.split.items[0].who.push(A);
  assert.equal(g.people.length, 3);
  assert.deepEqual(e.split.who, [A, B, C]);
  assert.deepEqual(e.split.items[0].who, []);
});

/* ---------- a draft of an existing bill ---------- */

test('a draft is a copy: the bill is not touched, even a frozen one', () => {
  for (const bill of EXAMPLE_GROUP.expenses) {
    const d = draftOf(EXAMPLE_GROUP, bill);
    d.title += '!';
    if (d.kind === 'expense') {
      d.paid.who.push('p-x');
      d.paid.values.x = '1';
      d.split.who.push('p-x');
      d.split.items[0].who.push('p-x');
      d.split.items.push({ name: 'x', amount: '1', who: [] });
    }
  }
  assert.deepEqual(lisbon(), structuredClone(EXAMPLE_GROUP));
});

test('a draft keeps what the bill says, and always has an item row to type in', () => {
  const g = lisbon();
  assert.deepEqual(draftOf(g, billOf(g, 'e-1')), { id: 'e-1', kind: 'expense', title: 'Apartment in Alfama', amount: '780', currency: 'EUR',
    paid: { mode: 'exact', who: ['p-ana', 'p-ben'], values: { 'p-ana': '520', 'p-ben': '260' } },
    split: { mode: 'equal', who: ['p-ana', 'p-ben', 'p-cy', 'p-dee', 'p-eli'], values: {}, items: [{ name: '', amount: '', who: [] }], tax: '', tip: '' } });
  assert.equal(draftOf(g, billOf(g, 'e-3')).split.items.length, 4);
  assert.equal(draftOf(g, billOf(g, 'e-3')).split.tip, '10');
});

test('a draft copes with a bill that has parts missing or numbers that are not text', () => {
  const g = trio();
  const d = draftOf(g, { id: 'e-x', kind: 'expense', title: null, amount: 120, paid: { mode: 'exact', who: [A], values: { [A]: 120 } } });
  assert.deepEqual(d, { id: 'e-x', kind: 'expense', title: '', amount: '120', currency: 'USD',
    paid: { mode: 'exact', who: [A], values: { [A]: '120' } },
    split: { mode: '', who: [], values: {}, items: [{ name: '', amount: '', who: [] }], tax: '', tip: '' } });
  assert.equal(draftOf(g, { id: 'e-y', kind: 'payment', amount: 5 }).amount, '5');
  assert.deepEqual(draftOf(g, { kind: 'expense', fx: { rate: 1.5 }, currency: 'EUR' }).fx, { rate: '1.5', base: 'USD' });
});

test('a payment note the page wrote itself is left empty, so it is written again on saving', () => {
  const g = lisbon(), pay = billOf(g, 'e-6');
  assert.equal(draftOf(g, pay).title, '');
  assert.equal(draftOf(g, { ...pay, title: 'Cy paid Ana' }).title, '');
  assert.equal(draftOf(g, { ...pay, title: 'Tickets' }).title, 'Tickets');
  // After a change of people the note follows.
  const d = draftOf(g, pay);
  d.from = 'p-dee';
  assert.equal(cleanBill(g, d).title, 'Dee paid Ana back');
  assert.equal(cleanBill(g, { ...d, title: '  Concert   tickets ' }).title, 'Concert tickets');
});

test('duplicate: a new bill with the same content and "(copy)" after its name', () => {
  const g = lisbon(), d = draftOf(g, billOf(g, 'e-3')), copy = duplicateOf(d);
  assert.equal(copy.id, '');
  assert.equal(copy.title, 'Dinner at the taberna (copy)');
  assert.deepEqual({ ...copy, id: d.id, title: d.title }, d);
  copy.split.items[0].who.push('p-ana');
  assert.deepEqual(d.split.items[0].who, ['p-ben']);
  assert.equal(duplicateOf({ ...d, title: 'x'.repeat(80) }).title, 'x'.repeat(73) + ' (copy)');
  assert.equal(duplicateOf({ ...d, title: '  ' }).title, '');
  assert.equal(duplicateOf(draftOf(g, billOf(g, 'e-6'))).title, '');
});

/* ---------- typed numbers ---------- */

test('readNumber: amounts of money, in every form that reads one way only', () => {
  const rows = [['', ''], ['   ', ''], [null, ''], [undefined, ''], [120, '120'], ['12', '12'], [' 12.50 ', '12.50'], ['12.', '12'], ['12,', '12'],
    ['.5', '0.5'], ['0.5', '0.5'], ['0', '0'], ['00', '0'], ['007', '7'], ['00.50', '0.50'], ['1.200', '1.200'],
    ['12,5', '12.5'], ['12,50', '12.50'], ['0,5', '0.5'], ['1,200', '1200'], ['1,200.50', '1200.50'], ['12,345,678', '12345678'],
    ['1.200,50', '1200.50'], ['1.234.567,8', '1234567.8']];
  for (const [typed, want] of rows) assert.equal(readNumber(typed, true), want, JSON.stringify(typed));
});

test('readNumber: percents, shares and rates are never grouped, and "1,125" is not guessed', () => {
  const rows = [['', ''], ['12', '12'], ['12.', '12'], ['12,', '12'], ['1.1251', '1.1251'], ['.5', '0.5'], ['1.200', '1.200'], ['007', '7'],
    ['12,5', '12.5'], ['33,33', '33.33'], ['1,1251', '1.1251'], ['0,00633994', '0.00633994'],
    ['1,125', null], ['17,888', null], ['1,200.50', null], ['1.200,50', null], ['12,345,678', null]];
  for (const [typed, want] of rows) assert.equal(readNumber(typed, false), want, JSON.stringify(typed));
  assert.equal(readNumber('1,1251'), '1.1251');      // not money unless said so
});

test('readNumber: anything else is refused, never guessed', () => {
  const junk = ['abc', '-5', '+5', '$45', '45 USD', '1e3', '0x10', '12..5', '12.5.1', '1,2,3', '1,20,000', '1234,567', '1 200', '1 200,50',
    '12%', '1.200.50', ',5', '.', ',', '--', '１２', '12 5', 'NaN', 'Infinity'];
  for (const typed of junk) for (const money of [true, false]) assert.equal(readNumber(typed, money), null, JSON.stringify(typed));
  assert.equal(readNumber('12,3456', true), null);
});

/* ---------- reading a draft ---------- */

test('readDraft writes numbers as plain decimals and keeps only what the bill uses', () => {
  const g = trio();
  const d = dinner(g, { amount: ' 1,200.50 ', title: '  Dinner   at Lupa ' });
  d.paid = { mode: 'exact', who: [B, A, 'p-gone', B], values: { [A]: '800,50', [B]: '400', [C]: '77' } };
  d.split = { ...d.split, mode: 'percent', who: [A, B, C], values: { [A]: '50%', [B]: '25 %', [C]: '25,0' } };
  d.split.items = [{ name: 'Left over', amount: '5', who: [A] }];
  d.split.tip = '10';
  const { bill, bad } = readDraft(g, d);
  assert.deepEqual(bad, {});
  assert.deepEqual(bill, { id: '', kind: 'expense', title: 'Dinner at Lupa', amount: '1200.50', currency: 'USD',
    paid: { mode: 'exact', who: [B, A], values: { [A]: '800.50', [B]: '400' } },
    split: { mode: 'percent', who: [A, B, C], values: { [A]: '50', [B]: '25', [C]: '25.0' }, items: [], tax: '', tip: '' } });
  assert.equal(computeExpense(g, bill).err, null);
});

test('readDraft keeps the order people are listed in, because the odd cent goes to whoever comes first', () => {
  const g = trio(), d = dinner(g, { amount: '100' });
  d.split.who = [C, A, B];
  d.split.items = [{ name: 'Wine', amount: '10', who: [B, C, A] }];
  assert.deepEqual(readDraft(g, d).bill.split.who, [C, A, B]);
  assert.deepEqual(computeExpense(g, cleanBill(g, d)).owedOrig, new Map([[C, 3334], [A, 3333], [B, 3333]]));
  // Another way to split does not reorder either: equal parts and one share each give the same amounts.
  switchMode(g, d, 'split', 'shares');
  assert.deepEqual(computeExpense(g, cleanBill(g, d)).owedOrig, new Map([[C, 3334], [A, 3333], [B, 3333]]));
  switchMode(g, d, 'split', 'items');
  d.split.items = [{ name: 'Wine', amount: '10', who: [B, C, A] }];
  assert.deepEqual(readDraft(g, d).bill.split.items[0].who, [B, C, A]);
});

test('readDraft: one payer means one person, and equal parts carry no numbers', () => {
  const g = trio(), d = dinner(g);
  d.paid = { mode: 'single', who: ['p-gone', C, B], values: { [C]: '9' } };
  d.split.values = { [A]: '3' };
  const { bill } = readDraft(g, d);
  assert.deepEqual(bill.paid, { mode: 'single', who: [C], values: {} });
  assert.deepEqual(bill.split.values, {});
  // The first person listed is the payer, as core.js reads it. The form shows that one and no other.
  const stored = { ...bill, paid: { mode: 'single', who: ['p-gone', C, B], values: {} } };
  assert.deepEqual(draftOf(g, stored).paid.who, [C]);
  assert.deepEqual(computeExpense(g, stored).paidOrig, computeExpense(g, cleanBill(g, draftOf(g, stored))).paidOrig);
});

test('readDraft says which number cannot be used, and in which part', () => {
  const g = trio();
  assert.deepEqual(readDraft(g, dinner(g, { amount: '12..5' })).bad, { total: '"12..5" cannot be used here. Write a plain number like 12.50.' });
  assert.deepEqual(readDraft(g, dinner(g, { amount: '-120' })).bad, { total: '"-120" cannot be used here. Write a plain number like 12.50.' });
  assert.deepEqual(readDraft(g, dinner(g, { amount: '12.345' })).bad, { total: '"12.345" has too many decimals. USD has 2.' });
  assert.deepEqual(readDraft(g, dinner(g, { amount: '1.200' })).bad, { total: '"1.200" has too many decimals. USD has 2.' });
  assert.deepEqual(readDraft(g, dinner(g, { amount: '12.5', currency: 'JPY' })).bad, { total: '"12.5" has decimals. JPY has none.' });
  assert.deepEqual(readDraft(g, dinner(g, { amount: 'x', currency: 'JPY' })).bad, { total: '"x" cannot be used here. Write a plain number like 1250.' });
  assert.equal(readDraft(g, dinner(g, { amount: '12..5' })).bill.amount, '');
  assert.match(readDraft(g, dinner(g, { amount: '9'.repeat(40) + 'x' })).bad.total, /^"9{24}…" cannot/);

  const d = dinner(g);
  d.paid = { mode: 'exact', who: [A, B], values: { [A]: '60', [B]: '6o' } };
  d.split = { ...d.split, mode: 'shares', values: { [A]: '1', [B]: 'two', [C]: 'x3' } };
  const { bill, bad } = readDraft(g, d);
  assert.deepEqual(bad, { paid: '"6o" cannot be used here. Write a plain number like 12.50.', split: '"two" cannot be used here. Write a plain number like 12.5.' });
  assert.deepEqual(bill.paid.values, { [A]: '60' });
  assert.deepEqual(bill.split.values, { [A]: '1' });
});

test('readDraft: numbers of people who are not ticked are not read at all', () => {
  const g = trio(), d = dinner(g);
  d.split = { ...d.split, mode: 'exact', who: [A, B], values: { [A]: '60', [B]: '60', [C]: 'junk' } };
  assert.deepEqual(readDraft(g, d).bad, {});
});

test('readDraft: item rows stay in place, and a named row without a price is pointed out', () => {
  const g = trio(), d = dinner(g);
  d.split = { ...d.split, mode: 'items', tax: '8,5', tip: '0',
    items: [{ name: ' Pizza ', amount: '12,50', who: [B, A, B] }, { name: '', amount: '', who: [] }, { name: 'Wine', amount: '', who: [] }, { name: '', amount: '3', who: [C, 'p-gone'] }] };
  const { bill, bad } = readDraft(g, d);
  assert.deepEqual(bad, { split: '"Wine" needs a price.' });
  assert.equal(bill.amount, '');
  assert.deepEqual(bill.split, { mode: 'items', who: [], values: {}, tax: '8.5', tip: '',
    items: [{ name: 'Pizza', amount: '12.50', who: [B, A] }, { name: '', amount: '', who: [] }, { name: 'Wine', amount: '', who: [] }, { name: '', amount: '3', who: [C] }] });
  d.split.items[2].amount = '2o';
  assert.deepEqual(readDraft(g, d).bad, { split: '"2o" cannot be used here. Write a plain number like 12.50.' });
  d.split.items[2].amount = '20';
  d.split.tip = 'ten';
  assert.deepEqual(readDraft(g, d).bad, { split: '"ten" cannot be used here. Write a plain number like 12.5.' });
});

test('readDraft: a fixed rate needs a number, and is dropped when the bill is in the group\'s currency', () => {
  const g = trio(), eur = more => dinner(g, { currency: 'EUR', ...more });
  assert.deepEqual(readDraft(g, eur({ fx: { rate: '1,5', base: 'USD' } })).bill.fx, { rate: '1.5', base: 'USD' });
  assert.deepEqual(readDraft(g, eur({ fx: { rate: '1.1251', base: 'GBP' } })).bill.fx, { rate: '1.1251', base: 'GBP' });
  assert.deepEqual(readDraft(g, eur({ fx: { rate: '1.1251', base: 'EUR' } })).bill.fx, { rate: '1.1251', base: 'USD' });
  assert.deepEqual(readDraft(g, eur({ fx: { rate: '1.1251', base: 'XXX' } })).bill.fx, { rate: '1.1251', base: 'USD' });
  for (const rate of ['', '0', '0.0']) {
    const { bill, bad } = readDraft(g, eur({ fx: { rate, base: 'USD' } }));
    assert.deepEqual(bad, { fx: 'Type the rate, or untick “Fix the rate”.' });
    assert.equal('fx' in bill, false);
  }
  assert.deepEqual(readDraft(g, eur({ fx: { rate: '1.1.2', base: 'USD' } })).bad, { fx: '"1.1.2" cannot be used here. Write a plain number like 1.1251.' });
  // 1.125 or 1125? Nobody can tell, so it is not taken.
  assert.deepEqual(readDraft(g, eur({ fx: { rate: '1,125', base: 'USD' } })).bad, { fx: '"1,125" cannot be used here. Write a plain number like 1.1251.' });
  assert.deepEqual(readDraft(g, eur({ fx: { rate: '1,1251', base: 'USD' } })).bill.fx, { rate: '1.1251', base: 'USD' });
  const same = readDraft(g, dinner(g, { fx: { rate: 'junk', base: 'USD' } }));
  assert.deepEqual(same.bad, {});
  assert.equal('fx' in same.bill, false);
  assert.equal(readDraft(g, dinner(g, { currency: 'XXX' })).bill.currency, 'USD');
});

test('readDraft: a payment keeps two people of the group and gets a note', () => {
  const g = trio(), d = { ...newPayment(g), amount: '50,5' };
  assert.deepEqual(readDraft(g, d), { bill: { id: '', kind: 'payment', title: 'Ana paid Ben back', amount: '50.5', currency: 'USD', from: A, to: B }, bad: {} });
  assert.deepEqual(readDraft(g, { ...d, to: 'p-gone' }).bill, { id: '', kind: 'payment', title: '', amount: '50.5', currency: 'USD', from: A, to: '' });
  assert.deepEqual(Object.keys(readDraft(g, { ...d, currency: 'EUR', fx: { rate: '1.2', base: 'USD' } }).bill), ['id', 'kind', 'title', 'amount', 'currency', 'fx', 'from', 'to']);
});

/* ---------- the bill that is saved ---------- */

test('cleanBill: every bill of the example comes out the same bill', () => {
  const g = lisbon();
  for (const bill of g.expenses) {
    const clean = cleanBill(g, draftOf(g, bill));
    assert.deepEqual(edges(g, clean), edges(g, bill), bill.id);
    assert.equal(computeExpense(g, clean).err, null, bill.id);
    // Saving it twice changes nothing more.
    assert.deepEqual(cleanBill(g, draftOf(g, clean)), clean, bill.id);
    // All but the dinner, which gets its total written down, are untouched.
    if (bill.id !== 'e-3') assert.deepEqual(clean, bill, bill.id);
  }
  assert.equal(cleanBill(g, draftOf(g, billOf(g, 'e-3'))).amount, '156.20');
});

test('cleanBill: what is saved passes the gate for links unchanged', () => {
  const g = lisbon(), extra = dinner(g, { id: 'e-9', currency: 'EUR', fx: { rate: '1,13', base: 'USD' } });
  extra.paid.who = ['p-ana'];
  extra.split.who = g.people.map(p => p.id);
  const cleaned = [...g.expenses.map(bill => cleanBill(g, draftOf(g, bill))), cleanBill(g, extra)];
  assert.deepEqual(sanitizeGroup({ ...g, expenses: cleaned }).expenses, cleaned);
});

test('cleanBill: the bill written as text reads back as the same bill', () => {
  const g = lisbon();
  for (const bill of g.expenses) {
    const clean = cleanBill(g, draftOf(g, bill)), drafts = parseText(formatBill(g, clean), g).drafts;
    assert.equal(drafts.length, 1, bill.id);
    assert.equal(drafts[0].ok, true, bill.id + ': ' + drafts[0].errors.join(' '));
    assert.deepEqual(edges(g, drafts[0].bill), edges(g, clean), bill.id);
    assert.equal(drafts[0].bill.title, clean.title, bill.id);
  }
});

test('cleanBill: item rows without a price go, and the total of the items is written down', () => {
  const g = trio('JPY'), d = dinner(g, { amount: '99999', currency: 'JPY' });
  d.split = { ...d.split, mode: 'items', tip: '10',
    items: [{ name: '', amount: '', who: [] }, { name: 'Ramen', amount: '1,000', who: [A, B] }, { name: '', amount: '0', who: [] }, { name: 'Gyoza', amount: '500', who: [C] }] };
  const bill = cleanBill(g, d);
  assert.deepEqual(bill.split.items, [{ name: 'Ramen', amount: '1000', who: [A, B] }, { name: 'Gyoza', amount: '500', who: [C] }]);
  assert.equal(bill.amount, '1650');
  assert.equal(computeExpense(g, bill).totalOrig, 1650);
  // The draft is left as it was typed.
  assert.equal(d.split.items.length, 4);
  assert.equal(d.amount, '99999');
  d.split.items = [{ name: '', amount: '', who: [] }];
  assert.equal(cleanBill(g, d).amount, '');
});

/* ---------- another way to pay or split ---------- */

test('percent starts as equal parts that make exactly 100', () => {
  for (let n = 1; n <= 12; n++) {
    const people = Array.from({ length: n }, (_, i) => ({ id: 'p-' + i, name: 'P' + i }));
    const g = { ...trio(), people }, d = dinner(g);
    switchMode(g, d, 'split', 'percent');
    assert.equal(d.split.mode, 'percent');
    assert.equal(Object.keys(d.split.values).length, n);
    assert.equal(computeExpense(g, cleanBill(g, d)).err, null, n + ' people');
    switchMode(g, d, 'paid', 'equal');
    d.paid.who = people.map(p => p.id);
    switchMode(g, d, 'paid', 'percent');
    assert.equal(computeExpense(g, cleanBill(g, d)).err, null, n + ' payers');
  }
  const d = dinner();
  switchMode(trio(), d, 'split', 'percent');
  assert.deepEqual(d.split.values, { [A]: '33.3333', [B]: '33.3333', [C]: '33.3334' });
});

test('percent is filled in again when coming back to it, but pressing it twice changes nothing', () => {
  const g = trio(), d = dinner(g);
  switchMode(g, d, 'split', 'percent');
  d.split.values = { [A]: '50', [B]: '30', [C]: '20' };
  switchMode(g, d, 'split', 'percent');
  assert.deepEqual(d.split.values, { [A]: '50', [B]: '30', [C]: '20' });
  switchMode(g, d, 'split', 'equal');
  switchMode(g, d, 'split', 'percent');
  assert.deepEqual(d.split.values, { [A]: '33.3333', [B]: '33.3333', [C]: '33.3334' });
});

test('shares start at 1 each, and numbers that are there stay', () => {
  const g = trio(), d = dinner(g);
  switchMode(g, d, 'split', 'shares');
  assert.deepEqual(d.split.values, { [A]: '1', [B]: '1', [C]: '1' });
  d.split.values = { [A]: '2', [B]: '0', [C]: 'x' };
  switchMode(g, d, 'split', 'equal');
  switchMode(g, d, 'split', 'shares');
  assert.deepEqual(d.split.values, { [A]: '2', [B]: '1', [C]: '1' });
});

test('from percent or amounts to shares keeps the same proportions', () => {
  const g = trio(), d = dinner(g);
  switchMode(g, d, 'split', 'percent');
  d.split.values = { [A]: '50%', [B]: '30', [C]: '20' };
  const before = computeExpense(g, cleanBill(g, d)).owedOrig;
  switchMode(g, d, 'split', 'shares');
  assert.deepEqual(computeExpense(g, cleanBill(g, d)).owedOrig, before);
  switchMode(g, d, 'split', 'exact');
  assert.deepEqual(d.split.values, { [A]: '60.00', [B]: '36.00', [C]: '24.00' });
  switchMode(g, d, 'split', 'shares');
  assert.deepEqual(computeExpense(g, cleanBill(g, d)).owedOrig, before);
});

test('amounts start as what each person\'s part comes to right now', () => {
  const g = trio(), d = dinner(g, { amount: '100' });
  switchMode(g, d, 'split', 'exact');
  assert.deepEqual(d.split.values, { [A]: '33.34', [B]: '33.33', [C]: '33.33' });
  assert.equal(computeExpense(g, cleanBill(g, d)).err, null);
  switchMode(g, d, 'paid', 'exact');
  assert.deepEqual(d.paid.values, { [A]: '100.00' });

  const yen = trio('JPY'), e = dinner(yen, { amount: '1000', currency: 'JPY' });
  switchMode(yen, e, 'split', 'exact');
  assert.deepEqual(e.split.values, { [A]: '334', [B]: '333', [C]: '333' });

  const shares = dinner(g, { amount: '90' });
  shares.split = { ...shares.split, mode: 'shares', who: [A, C], values: { [A]: '2', [C]: '1' } };
  switchMode(g, shares, 'split', 'exact');
  assert.deepEqual(shares.split.values, { [A]: '60.00', [C]: '30.00' });
});

test('amounts stay empty while there is nothing to work them out from', () => {
  const g = trio(), d = dinner(g, { amount: '' });
  d.split.values = { [A]: '5' };
  switchMode(g, d, 'split', 'exact');
  assert.deepEqual(d.split.values, { [A]: '', [B]: '', [C]: '' });
});

test('one payer: the first of those ticked, or the first person', () => {
  const g = trio(), d = dinner(g);
  d.paid = { mode: 'equal', who: [C, B, 'p-gone'], values: {} };
  switchMode(g, d, 'paid', 'single');
  assert.deepEqual(d.paid, { mode: 'single', who: [C], values: {} });
  d.paid = { mode: 'equal', who: [], values: {} };
  switchMode(g, d, 'paid', 'single');
  assert.deepEqual(d.paid.who, [A]);
  switchMode(g, d, 'paid', 'equal');
  assert.deepEqual(d.paid.who, [A]);
});

test('items start as one item for the whole total', () => {
  const g = trio(), d = dinner(g, { amount: '1,200.50' });
  d.split.who = [A, C];
  switchMode(g, d, 'split', 'items');
  assert.deepEqual(d.split.items, [{ name: 'Dinner', amount: '1200.50', who: [A, C] }]);
  assert.equal(cleanBill(g, d).amount, '1200.50');
  assert.deepEqual(computeExpense(g, cleanBill(g, d)).owedOrig, new Map([[A, 60025], [C, 60025]]));

  const untitled = dinner(g, { title: '' });
  switchMode(g, untitled, 'split', 'items');
  assert.equal(untitled.split.items[0].name, 'Item');

  const empty = dinner(g, { amount: '' });
  switchMode(g, empty, 'split', 'items');
  assert.deepEqual(empty.split.items, [{ name: '', amount: '', who: [] }]);
});

test('items that have a price already are kept', () => {
  const g = trio(), d = dinner(g);
  d.split.items = [{ name: 'Wine', amount: '30', who: [B] }];
  switchMode(g, d, 'split', 'items');
  assert.deepEqual(d.split.items, [{ name: 'Wine', amount: '30', who: [B] }]);
});

test('leaving items keeps the total the items came to and ticks the people who had something', () => {
  const g = lisbon(), d = draftOf(g, billOf(g, 'e-3'));
  switchMode(g, d, 'split', 'exact');
  assert.equal(d.amount, '156.20');
  assert.deepEqual(d.split.who, ['p-ana', 'p-ben', 'p-cy', 'p-dee', 'p-eli']);
  // Each person's amount is what the items came to for them, so nothing moves.
  assert.deepEqual(d.split.values, { 'p-ana': '35.58', 'p-ben': '60.86', 'p-cy': '24.20', 'p-dee': '19.06', 'p-eli': '16.50' });
  assert.deepEqual(debts(g, cleanBill(g, d)), debts(g, billOf(g, 'e-3')));
  // And back: the items are still there.
  switchMode(g, d, 'split', 'items');
  assert.equal(d.split.items.length, 4);
  assert.deepEqual(debts(g, cleanBill(g, d)), debts(g, billOf(g, 'e-3')));
});

test('leaving items: people ticked before stay ticked, and with no items everyone is', () => {
  const g = trio(), d = dinner(g);
  d.split = { ...d.split, mode: 'items', who: [B], items: [{ name: 'Wine', amount: '30', who: [A, C] }] };
  switchMode(g, d, 'split', 'equal');
  assert.deepEqual(d.split.who, [B]);
  assert.equal(d.amount, '30.00');
  const none = dinner(g);
  none.split = { ...none.split, mode: 'items', who: [] };
  switchMode(g, none, 'split', 'equal');
  assert.deepEqual(none.split.who, [A, B, C]);
  assert.equal(none.amount, '120');
});

/* ---------- ticking people ---------- */

test('ticking keeps people in the group\'s order, each once', () => {
  const g = trio(), d = dinner(g);
  d.split.who = [];
  setWho(g, d, 'split', C, true);
  setWho(g, d, 'split', A, true);
  setWho(g, d, 'split', A, true);
  setWho(g, d, 'split', 'p-gone', true);
  assert.deepEqual(d.split.who, [A, C]);
  setWho(g, d, 'split', A, false);
  assert.deepEqual(d.split.who, [C]);
  setWho(g, d, 'paid', B, true);
  assert.deepEqual(d.paid.who, [B]);      // one payer: the tick moves
  switchMode(g, d, 'paid', 'equal');
  setWho(g, d, 'paid', A, true);
  assert.deepEqual(d.paid.who, [A, B]);
});

test('a person ticked while splitting by shares gets one share', () => {
  const g = trio(), d = dinner(g);
  d.split = { ...d.split, mode: 'shares', who: [A], values: { [A]: '2', [C]: '3' } };
  setWho(g, d, 'split', B, true);
  setWho(g, d, 'split', C, true);
  assert.deepEqual(d.split.values, { [A]: '2', [B]: '1', [C]: '3' });
  const pct = dinner(g);
  pct.split = { ...pct.split, mode: 'percent', who: [A], values: { [A]: '100' } };
  setWho(g, pct, 'split', B, true);
  assert.deepEqual(pct.split.values, { [A]: '100' });
});

test('people on an item: a press adds or takes away, in the group\'s order', () => {
  const g = trio(), d = dinner(g);
  toggleItemWho(g, d, 0, C);
  toggleItemWho(g, d, 0, A);
  assert.deepEqual(d.split.items[0].who, [A, C]);
  toggleItemWho(g, d, 0, C);
  assert.deepEqual(d.split.items[0].who, [A]);
  toggleItemWho(g, d, 5, A);
  assert.equal(d.split.items.length, 1);
});

/* ---------- what the form shows ---------- */

test('view of an empty new bill: says what to do next, cannot be saved', () => {
  const g = trio(), v = viewOf(g, newExpense(g), 'en-US');
  assert.equal(v.canSave, false);
  assert.deepEqual(v.says, { paid: null, split: { fix: true, text: 'Enter the total.' }, title: null });
  assert.deepEqual(v.outs, { 'paid-p-a': '', 'split-p-a': '', 'paid-p-b': '', 'split-p-b': '', 'paid-p-c': '', 'split-p-c': '' });
  assert.deepEqual([v.fx, v.reads, v.text, v.total], ['', '', '', null]);
  assert.deepEqual(v.list, []);
  assert.equal(v.note, 'Fix the line marked FIX above to see who owes whom.');
});

test('view: a bill that adds up but has no name asks for the name, and only then', () => {
  const g = trio(), v = viewOf(g, dinner(g, { title: ' ' }), 'en-US');
  assert.equal(v.canSave, false);
  assert.deepEqual(v.says, { paid: { fix: false, text: 'Adds up to 120.00 USD.' }, split: { fix: false, text: 'Adds up to 120.00 USD.' }, title: { fix: true, text: 'Give the bill a name.' } });
  assert.deepEqual(v.list, [['Ben owes Ana', '$40.00', ''], ['Cy owes Ana', '$40.00', '']]);
  assert.equal(v.reads, 'Ana paid 120.00 USD. Split equally: Ana 40.00, Ben 40.00, Cy 40.00.');
  assert.equal(v.text, '');
});

test('view of a bill that is ready: amounts, sentence, text, and the bill to save', () => {
  const g = trio(), d = dinner(g), v = viewOf(g, d, 'en-US');
  assert.equal(v.canSave, true);
  assert.equal(v.says.title, null);
  assert.deepEqual(v.outs, { 'paid-p-a': '$120.00', 'split-p-a': '$40.00', 'paid-p-b': '', 'split-p-b': '$40.00', 'paid-p-c': '', 'split-p-c': '$40.00' });
  assert.equal(v.note, '');
  assert.equal(v.text, 'Dinner: 120.00 USD, paid by Ana, split between Ana, Ben and Cy');
  assert.deepEqual(v.bill, cleanBill(g, d));
  assert.equal(v.text, formatBill(g, v.bill));
});

test('view: a side that does not add up says by how much, and still shows what was typed', () => {
  const g = trio(), d = dinner(g);
  d.paid = { mode: 'exact', who: [A, B], values: { [A]: '80', [B]: '30' } };
  const v = viewOf(g, d, 'en-US');
  assert.equal(v.canSave, false);
  assert.deepEqual(v.says.paid, { fix: true, text: 'The amounts paid add up to 110.00 USD. The total is 120.00 USD, so 10.00 USD is left to assign.' });
  assert.deepEqual(v.says.split, { fix: false, text: 'Adds up to 120.00 USD.' });
  assert.equal(v.says.title, null);
  assert.deepEqual([v.outs['paid-p-a'], v.outs['paid-p-b'], v.outs['split-p-c']], ['$80.00', '$30.00', '$40.00']);
  assert.deepEqual(v.list, []);
  assert.equal(v.text, '');
});

test('view: a number that cannot be used is the message, in its own part', () => {
  const g = trio();
  const total = viewOf(g, dinner(g, { amount: '12o' }), 'en-US');
  assert.deepEqual(total.says.split, { fix: true, text: '"12o" cannot be used here. Write a plain number like 12.50.' });
  assert.equal(total.says.paid, null);
  assert.equal(total.canSave, false);
  const d = dinner(g);
  d.split = { ...d.split, mode: 'shares', values: { [A]: '1', [B]: '1', [C]: 'x' } };
  const v = viewOf(g, d, 'en-US');
  // The math alone would be fine with two shares. The bill is still not saved on a reading like that.
  assert.deepEqual(v.says.split, { fix: true, text: '"x" cannot be used here. Write a plain number like 12.5.' });
  assert.equal(v.canSave, false);
  assert.equal(v.text, '');
});

test('view: shares say how many there are, several payers get the note', () => {
  const g = lisbon();
  assert.deepEqual(viewOf(g, draftOf(g, billOf(g, 'e-2')), 'en-US').says.split, { fix: false, text: 'Adds up to 210.00 EUR. 5 shares in total.' });
  const v = viewOf(g, draftOf(g, billOf(g, 'e-1')), 'en-US');
  assert.equal(v.note, 'With several payers, each share is owed to them in proportion to what they paid. The cents are rounded so that each payer is covered exactly.');
  assert.equal(v.list.length, 8);
  // Ben's share is $175.52: $117.02 to Ana and $58.50 kept, so that Ana is owed exactly what she paid.
  assert.deepEqual(v.list[1], ['Ben owes Ana', '$117.02', '']);
  const own = dinner(trio());
  own.split.who = [A];
  assert.equal(viewOf(trio(), own, 'en-US').note, 'No debts. Everyone covered their own share.');
});

test('view of a bill with items: the total comes from the items, and the line says how', () => {
  const g = lisbon(), d = draftOf(g, billOf(g, 'e-3')), v = viewOf(g, d, 'en-US');
  assert.equal(v.total, '156.20');
  assert.deepEqual(v.says.split, { fix: false, text: 'Items 142.00 EUR plus tip 14.20 EUR make 156.20 EUR. The tip is shared in proportion to what each person had.' });
  assert.equal(v.reads, 'Dee paid 156.20 EUR. Split by items plus 10% tip: Ana 35.58, Ben 60.86, Cy 24.20, Dee 19.06, Eli 16.50.');
  assert.equal(v.text.split('\n').length, 5);
  d.split.tax = '5';
  assert.match(viewOf(g, d, 'en-US').says.split.text, /^Items 142\.00 EUR plus tax and tip 21\.30 EUR make 163\.30 EUR\. Tax and tip are shared/);
  d.split.tip = '';
  assert.match(viewOf(g, d, 'en-US').says.split.text, /^Items 142\.00 EUR plus tax 7\.10 EUR make 149\.10 EUR\. The tax is shared/);
  d.split.tax = '';
  assert.equal(viewOf(g, d, 'en-US').says.split.text, 'The items add up to 142.00 EUR.');
  d.split.items[1].who = [];
  assert.deepEqual(viewOf(g, d, 'en-US').says.split, { fix: true, text: '"Grilled sardines" needs at least one person.' });
  d.split.items = [{ name: '', amount: '', who: [] }];
  const none = viewOf(g, d, 'en-US');
  assert.deepEqual(none.says.split, { fix: true, text: 'Add at least one item.' });
  assert.equal(none.total, '');
});

test('view: a converted amount comes with its rate, where the rate is from, and its date', () => {
  const d = g => draftOf(g, billOf(g, 'e-1'));
  assert.equal(viewOf(pinned(), d(pinned()), 'en-US').fx, '$877.60 at 1 EUR = 1.12513 USD. Rate of Oct 4, 2026.');
  // A currency the group has no rate of its own for yet: the store looks one up on saving.
  assert.equal(viewOf(lisbon(), d(lisbon()), 'en-US').fx,
    '$877.60 at 1 EUR = 1.12513 USD. Built-in rate, Oct 4, 2026. Saving looks up the rate for EUR, so this can change a little.');
  const typed = { ...pinned(), rates: { EUR: { rate: '1.2', base: 'USD' } } };
  assert.equal(viewOf(typed, d(typed), 'en-US').fx, '$936.00 at 1 EUR = 1.2000 USD. Your rate.');
  const fixed = { ...d(pinned()), fx: { rate: '1,5', base: 'USD' } };
  assert.equal(viewOf(pinned(), fixed, 'en-US').fx, '$1,170.00 at 1 EUR = 1.5000 USD. Fixed for this bill.');
  assert.equal(viewOf(pinned(), fixed, 'en-US').bill.fx.rate, '1.5');
  assert.equal(viewOf(pinned(), d(pinned()), 'en-US').says.fx, null);
  assert.equal(viewOf(pinned(), draftOf(pinned(), billOf(pinned(), 'e-4')), 'en-US').fx, '');
});

test('view: without a total the rate is still shown, and a ticked box without a rate must be fixed', () => {
  const g = pinned(), d = { ...draftOf(g, billOf(g, 'e-1')), amount: '' };
  assert.equal(viewOf(g, d, 'en-US').fx, '1 EUR = 1.12513 USD. Rate of Oct 4, 2026.');
  const v = viewOf(g, { ...draftOf(g, billOf(g, 'e-1')), fx: { rate: '', base: 'USD' } }, 'en-US');
  assert.deepEqual(v.says.fx, { fix: true, text: 'Type the rate, or untick “Fix the rate”.' });
  assert.equal(v.canSave, false);
  assert.equal(v.note, 'Fix the line marked FIX above to see who owes whom.');
});

test('view of a payment', () => {
  const g = lisbon(), v = viewOf(g, draftOf(g, billOf(g, 'e-6')), 'en-US');
  assert.equal(v.canSave, true);
  assert.deepEqual(v.says, { pay: null });
  assert.deepEqual(v.list, [['Cy owes Ana', '$50.00', ' less.']]);
  assert.equal(v.reads, 'Cy paid Ana back 50.00 USD.');
  assert.equal(v.text, 'Cy paid Ana 50.00 USD');
  assert.equal(v.bill.title, 'Cy paid Ana back');
  const blank = viewOf(g, newPayment(g), 'en-US');
  assert.deepEqual(blank.says, { pay: { fix: true, text: 'Enter an amount.' } });
  assert.equal(blank.canSave, false);
  assert.deepEqual(viewOf(g, { ...newPayment(g), amount: '5', to: 'p-ana' }, 'en-US').says.pay, { fix: true, text: 'Pick two different people.' });
  assert.deepEqual(viewOf(g, { ...newPayment(g), amount: '5', to: '' }, 'en-US').says.pay, { fix: true, text: 'Choose who paid whom.' });
});

/* ================= Part 2: the dialog, on a stand-in for the page ================= */

/* Just enough of a page for editor.js: elements with attributes, innerHTML, a few selectors, events that
   bubble, focus, and a dialog. The reader of innerHTML is strict on purpose: it only takes well-formed
   tags with quoted attributes, so markup the editor should not write fails here. */

const VOID = new Set(['input']);
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': '\'' };
const decode = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (m, name) => ENTITY[name]);
const TAG = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"<>]*")?)*)\s*>|([^<]+)/g;

class Text {
  constructor(data) { this.nodeType = 3; this.data = data; this.parentNode = null; }
  get textContent() { return this.data; }
}

class El {
  constructor(doc, tag) {
    Object.assign(this, { doc, tag, nodeType: 1, nodeName: tag.toUpperCase(), attrs: new Map(), childNodes: [], parentNode: null, handlers: new Map(), props: {}, scrollTop: 0 });
  }

  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  flag(name, on) { if (on === undefined) return this.attrs.has(name); if (on) this.attrs.set(name, ''); else this.attrs.delete(name); return on; }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.attrs.set('class', String(v)); }
  get dataset() { return new Proxy({}, { get: (_, key) => this.attrs.get('data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase())) }); }
  get hidden() { return this.flag('hidden'); }
  set hidden(v) { this.flag('hidden', !!v); }
  get disabled() { return this.flag('disabled'); }
  set disabled(v) { this.flag('disabled', !!v); }
  get readOnly() { return this.flag('readonly'); }
  get open() { return this.flag('open'); }
  get checked() { return 'checked' in this.props ? this.props.checked : this.flag('checked'); }
  set checked(v) { this.props.checked = !!v; }
  get rows() { return Number(this.getAttribute('rows')); }
  set rows(v) { this.attrs.set('rows', String(v)); }

  get isTextField() { return this.tag === 'textarea' || (this.tag === 'input' && this.getAttribute('type') === 'text'); }
  get value() {
    if ('value' in this.props) return this.props.value;
    if (this.tag === 'select') {
      const options = this.querySelectorAll('option'), o = options.find(x => x.hasAttribute('selected')) || options[0];
      return !o ? '' : o.hasAttribute('value') ? o.getAttribute('value') : o.textContent;
    }
    return this.tag === 'textarea' ? this.textContent : this.getAttribute('value') || '';
  }
  set value(v) { this.props.value = String(v); delete this.props.caret; }
  get selectionStart() { return this.isTextField ? (this.props.caret || [this.value.length])[0] : null; }
  get selectionEnd() { return this.isTextField ? (this.props.caret || [0, this.value.length])[1] : null; }
  setSelectionRange(from, to) {
    assert.ok(this.isTextField, 'setSelectionRange throws on a ' + this.tag + ' of type ' + this.getAttribute('type'));
    this.props.caret = [from, to];
  }

  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get isConnected() { for (let n = this; n; n = n.parentNode) if (n === this.doc.body) return true; return false; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  append(node) { node.parentNode = this; this.childNodes.push(node); }
  all() { return this.childNodes.filter(n => n.nodeType === 1).flatMap(el => [el, ...el.all()]); }

  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) { this.clear(); if (String(v) !== '') this.append(new Text(String(v))); }
  set innerHTML(html) {
    this.clear();
    let at = this, last = 0;
    for (const m of html.matchAll(TAG)) {
      assert.equal(m.index, last, 'markup the stand-in cannot read: ' + html.slice(last, last + 80));
      last = m.index + m[0].length;
      if (m[4] !== undefined) { at.append(new Text(decode(m[4]))); continue; }
      if (m[1]) { assert.equal(at.tag, m[2], 'closing tag out of place'); at = at.parentNode; continue; }
      const el = new El(this.doc, m[2]);
      for (const a of m[3].matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) {
        assert.ok(!el.attrs.has(a[1]), 'attribute written twice: ' + a[1]);
        el.attrs.set(a[1], decode(a[2] || ''));
      }
      at.append(el);
      if (!VOID.has(m[2])) at = el;
    }
    assert.equal(last, html.length, 'markup the stand-in cannot read: ' + html.slice(last, last + 80));
    assert.equal(at, this, 'a tag was left open');
  }
  clear() {
    if (this.contains(this.doc.activeElement) && this.doc.activeElement !== this) this.doc.activeElement = this.doc.body;
    this.childNodes.forEach(n => { n.parentNode = null; });
    this.childNodes = [];
  }

  // Selectors: tag, #id, .class and [attr] or [attr="value"] in one step; steps separated by spaces.
  is(step) {
    const m = /^([a-z]+)?(?:#([\w-]+))?((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(step);
    assert.ok(m, 'selector the stand-in cannot read: ' + step);
    return (!m[1] || this.tag === m[1]) && (!m[2] || this.id === m[2]) &&
      m[3].split('.').filter(Boolean).every(c => this.className.split(' ').includes(c)) &&
      (!m[4] || (this.attrs.has(m[4]) && (m[5] === undefined || this.attrs.get(m[4]) === m[5])));
  }
  closest(step) { for (let n = this; n; n = n.parentNode) if (n.is(step)) return n; return null; }
  querySelectorAll(selector) {
    const steps = selector.trim().split(/\s+/);
    const under = (el, i) => { if (i < 0) return true; for (let n = el.parentNode; n; n = n.parentNode) if (n.is(steps[i]) && under(n, i - 1)) return true; return false; };
    return this.all().filter(el => el.is(steps[steps.length - 1]) && under(el, steps.length - 2));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  addEventListener(type, fn) { this.handlers.set(type, [...(this.handlers.get(type) || []), fn]); }
  fire(type, more = {}) {
    const e = { type, target: this, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, ...more };
    for (let n = this; n; n = n.parentNode) (n.handlers.get(type) || []).forEach(fn => fn(e));
    return e;
  }
  focus() {
    const was = this.doc.activeElement;
    if (this.disabled || !this.isConnected || was === this) return;
    this.doc.activeElement = this;
    if (was && was !== this.doc.body) was.fire('focusout');
  }

  // A dialog gives the focus to its first button, and hands it back on closing. "close" comes a moment later.
  showModal() {
    assert.ok(!this.open, 'showModal throws on a dialog that is open');
    this.props.before = this.doc.activeElement;
    this.flag('open', true);
    this.querySelector('button').focus();
  }
  close() {
    if (!this.open) return;
    this.flag('open', false);
    if (this.props.before && this.props.before.isConnected) this.props.before.focus(); else this.doc.activeElement = this.doc.body;
    setTimeout(() => this.fire('close'), 0);
  }
}

const settle = () => new Promise(done => setTimeout(done, 0));
const parse = html => {
  const doc = {}, body = new El(doc, 'body');
  doc.body = doc.activeElement = body;
  body.innerHTML = html;
  return body;
};

function memoryStorage() {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); } };
}

// A page with the example group, the bills table as app.js draws it, and the editor wired to it.
function makePage(opts = {}) {
  const rates = { result: 'success', time_last_update_unix: Date.UTC(2026, 9, 10) / 1000, rates: Object.fromEntries(CURRENCIES.map(c => [c, BUILTIN_RATES.usd[c] * (c === 'USD' ? 1 : 2)])) };
  const fetch = async () => { fetch.calls++; if (opts.offline) throw new Error('offline'); return { ok: true, json: async () => rates }; };
  fetch.calls = 0;
  const store = createStore({ storage: memoryStorage(), fetch, now: () => Date.UTC(2026, 9, 10, 12) });
  const body = parse('<table><tbody id="bills-body"></tbody></table><button type="button" id="bill-new">Add with a form</button><button type="button" id="payment-new">Add a payment</button>' +
    '<dialog id="editor"><div class="modal__head"><h2 id="editor-title">Bill</h2><button type="button" class="x" data-close aria-label="Close"></button></div><div class="modal__body" id="editor-body"></div></dialog>');
  const doc = body.doc, events = [];
  doc.getElementById = id => body.all().find(el => el.id === id) || null;
  doc.querySelectorAll = selector => body.querySelectorAll(selector);
  const draw = () => {
    doc.getElementById('bills-body').innerHTML = store.group.expenses.map(b => `<tr class="bill" data-id="${b.id}"><th><button type="button" class="bill__open">open</button></th></tr>`).join('');
  };
  store.subscribe(e => { events.push(e); draw(); });
  draw();
  globalThis.document = doc;
  initEditor(store);

  const dialog = doc.getElementById('editor'), form = doc.getElementById('editor-body');
  const $ = key => form.querySelectorAll('[data-k]').find(el => el.dataset.k === key) || null;
  const page = {
    store, doc, dialog, form, events, fetch, $,
    heading: () => doc.getElementById('editor-title').textContent,
    row: id => doc.querySelectorAll('#bills-body tr').find(tr => tr.dataset.id === id).querySelector('button'),
    bill: id => store.group.expenses.find(b => b.id === id),
    // What a person does.
    openRow(id) { page.row(id).focus(); openEditor(page.bill(id), page.bill(id).kind); },
    openNew(kind) { doc.getElementById(kind === 'payment' ? 'payment-new' : 'bill-new').focus(); openEditor(null, kind); },
    type(key, value) { const el = $(key); assert.ok(el && !el.disabled, 'cannot type in ' + key); el.focus(); el.value = value; el.fire('input'); },
    tick(key, on) { const el = $(key); el.focus(); el.checked = on; el.fire('input'); el.fire('change'); },
    choose(key, value) { const el = $(key); el.focus(); el.value = value; el.fire('input'); el.fire('change'); },
    press(key) { const el = $(key); assert.ok(el && !el.disabled, 'cannot press ' + key); el.focus(); el.fire('click'); },
    submit() { assert.equal($('save').disabled, false, 'SAVE is disabled'); return form.querySelector('form').fire('submit'); },
    out: key => form.querySelectorAll('[data-out]').find(el => el.dataset.out === key).textContent,
    say(name) { const el = form.querySelector('[data-say="' + name + '"]'); return !el || el.hidden ? null : [el.firstChild.textContent, el.lastChild.textContent, el.firstChild.className]; },
    live: name => form.querySelector('[data-live="' + name + '"]')
  };
  return page;
}

/* ---------- the form as markup ---------- */

test('the form: well-formed, no style attributes, no handlers, no ids written twice', () => {
  const g = pinned(), drafts = [...g.expenses.map(b => draftOf(g, b)), newExpense(g), newPayment(g), { ...draftOf(g, billOf(g, 'e-1')), fx: { rate: '1.1', base: 'USD' } }];
  for (const d of drafts) {
    for (const isNew of [true, false]) {
      const all = parse(formHtml(g, d, isNew)).all();
      for (const el of all) for (const name of el.attrs.keys()) assert.ok(name !== 'style' && !name.startsWith('on'), `${el.tag} has ${name}`);
      const ids = all.map(el => el.id).filter(Boolean), keys = all.map(el => el.dataset.k).filter(Boolean);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(new Set(keys).size, keys.length);
      assert.equal(all.filter(el => el.is('form')).length, 1);
      assert.equal(all.filter(el => el.is('button[type="submit"]')).length, 1);
      assert.ok(all.filter(el => el.tag === 'button').every(el => el.hasAttribute('type')));
    }
  }
});

test('the form: text from people is only ever text', () => {
  const evil = '<img src="x" onerror="alert(1)"> & "quotes" \'single\' </textarea><script>x</script>';
  const g = { ...trio('EUR'), people: [{ id: A, name: evil }, { id: B, name: 'Ben' }] };
  const d = dinner(g, { title: evil, amount: evil, currency: 'USD', fx: { rate: evil, base: 'EUR' } });
  d.split = { ...d.split, mode: 'items', items: [{ name: evil, amount: evil, who: [A] }], tax: evil, tip: evil };
  d.paid = { mode: 'exact', who: [A, B], values: { [A]: evil, [B]: '1' } };
  const form = parse(formHtml(g, d, false)), all = form.all();
  assert.deepEqual([...new Set(all.map(el => el.tag))].sort(), ['b', 'button', 'div', 'form', 'h3', 'input', 'label', 'option', 'p', 'select', 'span', 'textarea', 'ul']);
  const valueOf = key => all.find(el => el.dataset.k === key).value;
  assert.deepEqual([valueOf('title'), valueOf('amount'), valueOf('rate'), valueOf('it-name-0'), valueOf('it-amount-0'), valueOf('tax'), valueOf('tip'), valueOf('val-paid-' + A)], Array(8).fill(evil));
  assert.equal(all.find(el => el.dataset.k === 'who-paid-' + A).parentNode.textContent, evil);
  assert.equal(all.find(el => el.dataset.k === 'it-who-0-' + A).textContent, evil);
  assert.equal(all.find(el => el.dataset.k === 'val-paid-' + A).getAttribute('aria-label'), evil + ', USD');
  const pay = parse(formHtml(g, { ...newPayment(g), title: evil }, true));
  assert.deepEqual(pay.querySelectorAll('option').filter(o => o.getAttribute('value') === A).map(o => o.textContent), [evil, evil]);
  // And the worked-out parts: names in the list of who owes whom.
  const v = viewOf(g, dinner(g), 'en-US');
  assert.deepEqual(v.list, [['Ben owes ' + evil, '€60.00', '']]);
});

test('the form: every control has a name that can be read out', () => {
  const g = pinned(), labelled = (form, el) => !!(el.getAttribute('aria-label') || el.closest('label') || (el.tag === 'button' && el.textContent.trim()) ||
    (el.id && form.querySelectorAll('label').some(l => l.getAttribute('for') === el.id)));
  for (const d of [...g.expenses.map(b => draftOf(g, b)), { ...draftOf(g, billOf(g, 'e-1')), fx: { rate: '1.1', base: 'USD' } }]) {
    const form = parse(formHtml(g, d, false));
    for (const el of form.all().filter(x => ['input', 'select', 'textarea', 'button'].includes(x.tag))) assert.ok(labelled(form, el), el.tag + ' ' + el.dataset.k);
    for (const group of form.querySelectorAll('[role="group"]')) assert.ok(group.getAttribute('aria-label') || form.all().some(x => x.id === group.getAttribute('aria-labelledby')));
  }
});

test('the form of a bill: one way pressed on each side, rows that fit it', () => {
  const g = pinned(), form = parse(formHtml(g, draftOf(g, billOf(g, 'e-1')), false));
  const pressed = side => form.querySelectorAll('.modes button').filter(b => b.dataset.side === side && b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.mode);
  assert.deepEqual([pressed('paid'), pressed('split')], [['exact'], ['equal']]);
  assert.equal(form.querySelectorAll('.modes button').length, 10);
  const rows = form.querySelectorAll('.prows')[0].querySelectorAll('.prow');
  assert.deepEqual(rows.map(r => r.className), ['prow', 'prow', 'prow is-off', 'prow is-off', 'prow is-off']);
  assert.deepEqual(rows.map(r => r.querySelectorAll('input')[1].value), ['520', '260', '', '', '']);
  assert.deepEqual(rows.map(r => r.querySelectorAll('input')[1].disabled), [false, false, true, true, true]);
  assert.deepEqual(rows.map(r => r.childNodes.length), [3, 3, 3, 3, 3]);
  // Equal parts: a tick, an empty cell, the amount.
  const split = form.querySelectorAll('.prows')[1].querySelectorAll('.prow');
  assert.deepEqual(split.map(r => r.childNodes.map(n => n.tag)), Array(5).fill(['label', 'span', 'span']));
  assert.ok(split.every(r => r.querySelector('input').getAttribute('type') === 'checkbox' && r.querySelector('input').checked));
  assert.ok(form.querySelector('.fx'));
  assert.equal(form.querySelectorAll('.form__foot button').map(b => b.textContent).join('|'), 'Delete|Duplicate|Cancel|Save bill');
  assert.ok(form.querySelector('.form__foot [data-close]'));
});

test('the form: one payer is a radio group, a bill in the group\'s currency has no rate line, a new bill no DELETE', () => {
  const g = pinned(), form = parse(formHtml(g, draftOf(g, billOf(g, 'e-4')), true));
  const radios = form.querySelectorAll('.prows')[0].querySelectorAll('input');
  assert.ok(radios.every(r => r.getAttribute('type') === 'radio' && r.getAttribute('name') === 'ed-paid'));
  assert.deepEqual(radios.map(r => r.checked), [false, false, false, false, true]);
  assert.equal(form.querySelector('.fx'), null);
  assert.equal(form.querySelectorAll('.form__foot button').map(b => b.textContent).join('|'), 'Cancel|Save bill');
});

test('the form of a bill with items: the total is locked, each item has its people', () => {
  const g = pinned(), form = parse(formHtml(g, draftOf(g, billOf(g, 'e-3')), false));
  const total = form.all().find(el => el.dataset.k === 'amount');
  assert.equal(total.disabled, true);
  assert.equal(total.closest('label').querySelector('.field__label').textContent, 'Total, from items');
  assert.equal(form.querySelectorAll('.item').length, 4);
  assert.deepEqual(form.querySelectorAll('.item')[3].querySelectorAll('.item__who button').map(b => b.getAttribute('aria-pressed')), ['true', 'true', 'false', 'true', 'false']);
  assert.equal(form.querySelectorAll('.prows').length, 1);
  const full = draftOf(g, billOf(g, 'e-3'));
  full.split.items = Array.from({ length: 100 }, () => ({ name: 'x', amount: '1', who: ['p-ana'] }));
  assert.equal(parse(formHtml(g, full, false)).all().find(el => el.dataset.k === 'it-add').disabled, true);
});

test('the form of a payment: two people, and "Choose" only while one is missing', () => {
  const g = pinned(), form = parse(formHtml(g, draftOf(g, billOf(g, 'e-6')), false));
  const from = form.all().find(el => el.dataset.k === 'from'), to = form.all().find(el => el.dataset.k === 'to');
  assert.deepEqual([from.value, to.value], ['p-cy', 'p-ana']);
  assert.equal(from.querySelectorAll('option').length, 5);
  assert.equal(form.querySelectorAll('.side').length, 0);
  assert.equal(form.querySelectorAll('.form__foot button').map(b => b.textContent).join('|'), 'Delete|Duplicate|Cancel|Save payment');
  const lost = parse(formHtml(g, { ...draftOf(g, billOf(g, 'e-6')), to: '' }, false)).all().find(el => el.dataset.k === 'to');
  assert.equal(lost.value, '');
  assert.equal(lost.querySelectorAll('option')[0].textContent, 'Choose');
});

/* ---------- the dialog at work ---------- */

test('dialog: a new bill is typed in and saved through the store, with one undo', async () => {
  const p = makePage();
  p.openNew('expense');
  assert.equal(p.dialog.open, true);
  assert.equal(p.heading(), 'New bill');
  assert.equal(p.doc.activeElement, p.$('title'));
  assert.equal(p.$('save').disabled, true);
  assert.deepEqual(p.say('split'), ['Fix', 'Enter the total.', 'tag tag--fix']);
  assert.equal(p.say('paid'), null);
  assert.equal(p.$('delete'), null);

  p.type('amount', '90');
  assert.equal(p.$('save').disabled, true);
  assert.deepEqual(p.say('title'), ['Fix', 'Give the bill a name.', 'tag tag--fix']);
  assert.deepEqual(p.say('split'), ['OK', 'Adds up to 90.00 USD.', 'tag']);
  p.type('title', 'Lunch');
  assert.equal(p.say('title'), null);
  assert.equal(p.$('save').disabled, false);
  assert.equal(p.out('paid-p-ana'), formatMoney(9000, 'USD'));
  assert.equal(p.out('split-p-eli'), formatMoney(1800, 'USD'));
  assert.equal(p.live('text').value, 'Lunch: 90.00 USD, paid by Ana, split between Ana, Ben, Cy, Dee and Eli');
  assert.equal(p.live('reads').textContent, 'Ana paid 90.00 USD. Split equally: Ana 18.00, Ben 18.00, Cy 18.00, Dee 18.00, Eli 18.00.');
  assert.equal(p.live('list').childNodes.length, 4);
  assert.equal(p.live('list').hidden, false);
  // Nothing is saved until SAVE.
  assert.equal(p.store.group.expenses.length, 6);
  assert.equal(p.events.length, 0);

  const e = p.submit();
  assert.equal(e.defaultPrevented, true);
  await settle();
  assert.equal(p.dialog.open, false);
  assert.equal(p.form.childNodes.length, 0);
  assert.deepEqual(p.events.map(x => [x.type, x.label]), [['change', 'Bill added.']]);
  const saved = p.store.group.expenses[6];
  assert.match(saved.id, /^e-[a-z0-9]{7}$/);
  assert.deepEqual({ ...saved, id: '' }, { id: '', kind: 'expense', title: 'Lunch', amount: '90', currency: 'USD',
    paid: { mode: 'single', who: ['p-ana'], values: {} },
    split: { mode: 'equal', who: ['p-ana', 'p-ben', 'p-cy', 'p-dee', 'p-eli'], values: {}, items: [], tax: '', tip: '' } });
  assert.equal(p.doc.activeElement, p.doc.getElementById('bill-new'));
  assert.equal(p.store.undo(), true);
  assert.equal(p.store.group.expenses.length, 6);
});

test('dialog: a new bill is paid by "me"', () => {
  const p = makePage();
  p.store.setMe('p-dee');
  p.openNew('expense');
  assert.equal(p.$('who-paid-p-dee').checked, true);
  assert.equal(p.$('who-paid-p-ana').checked, false);
});

test('dialog: typing never redraws the form, so the field and its caret stay', () => {
  const p = makePage();
  p.openRow('e-1');
  assert.equal(p.heading(), 'Edit bill');
  assert.equal(p.doc.activeElement, p.dialog.querySelector('button'));     // an existing bill: the keyboard does not pop up
  const title = p.$('title'), value = p.$('val-paid-p-ana'), text = p.live('text');
  p.type('val-paid-p-ana', '500');
  p.type('title', 'Flat');
  assert.equal(p.$('title'), title);
  assert.equal(p.$('val-paid-p-ana'), value);
  assert.equal(p.live('text'), text);
  assert.equal(p.doc.activeElement, title);
  assert.deepEqual(p.say('paid'), ['Fix', 'The amounts paid add up to 760.00 EUR. The total is 780.00 EUR, so 20.00 EUR is left to assign.', 'tag tag--fix']);
  assert.equal(p.out('paid-p-ana'), formatMoney(50000, 'EUR'));
  assert.equal(p.$('save').disabled, true);
  assert.equal(p.live('list').hidden, true);
  assert.equal(p.live('note').textContent, 'Fix the line marked FIX above to see who owes whom.');
  assert.equal(text.value, '');
  // The bill in the store is the one from before.
  assert.equal(p.bill('e-1').title, 'Apartment in Alfama');
  assert.equal(p.bill('e-1').paid.values['p-ana'], '520');
});

test('dialog: a tick redraws the form and the focus comes back to the same control', () => {
  const p = makePage();
  p.openRow('e-1');
  const before = p.$('who-paid-p-cy');
  p.tick('who-paid-p-cy', true);
  assert.notEqual(p.$('who-paid-p-cy'), before);
  assert.equal(p.doc.activeElement, p.$('who-paid-p-cy'));
  assert.equal(p.$('who-paid-p-cy').checked, true);
  assert.equal(p.$('val-paid-p-cy').disabled, false);
  p.type('val-paid-p-cy', '0');
  p.tick('who-paid-p-cy', false);
  assert.equal(p.$('val-paid-p-cy').disabled, true);
  assert.equal(p.$('val-paid-p-cy').value, '');
  assert.equal(p.$('who-paid-p-cy').closest('.prow').className, 'prow is-off');
});

test('dialog: where a click does not move the focus, the field being typed in keeps it', () => {
  const p = makePage();
  p.openRow('e-1');
  p.type('title', 'Flat in Alfama');
  p.$('title').setSelectionRange(4, 4);
  // Safari leaves the focus where it was when a box is ticked with the mouse.
  p.$('who-paid-p-cy').checked = true;
  p.$('who-paid-p-cy').fire('change');
  assert.equal(p.$('who-paid-p-cy').checked, true);
  assert.equal(p.doc.activeElement, p.$('title'));
  assert.deepEqual([p.$('title').selectionStart, p.$('title').selectionEnd], [4, 4]);
  // When the field with the focus goes away, the control that was used takes it.
  p.tick('lock', true);
  p.$('rate').focus();
  p.$('lock').checked = false;
  p.$('lock').fire('change');
  assert.equal(p.$('rate'), null);
  assert.equal(p.doc.activeElement, p.$('lock'));
});

test('dialog: removing the last item row moves the focus to "Add an item"', () => {
  const p = makePage();
  p.openRow('e-3');
  p.press('it-del-3');
  assert.equal(p.$('it-del-3'), null);
  assert.equal(p.doc.activeElement, p.$('it-add'));
});

test('dialog: when the group changes under the form, it is redrawn with the caret where it was', async () => {
  const p = makePage();
  p.openRow('e-1');
  p.type('title', 'Apartment');
  p.$('title').setSelectionRange(2, 5);
  const before = p.$('title');
  assert.match(p.live('fx').textContent, /1 EUR = 1\.12513 USD\. Rate of /);
  p.store.setTypedRate('EUR', '1.2');
  assert.notEqual(p.$('title'), before);
  assert.equal(p.doc.activeElement, p.$('title'));
  assert.equal(p.$('title').value, 'Apartment');
  assert.deepEqual([p.$('title').selectionStart, p.$('title').selectionEnd], [2, 5]);
  assert.match(p.live('fx').textContent, /at 1 EUR = 1\.2000 USD\. Your rate\.$/);
  // An undo that takes the bill away closes the form.
  p.store.change('', g => { g.expenses = g.expenses.filter(b => b.id !== 'e-1'); });
  await settle();
  assert.equal(p.dialog.open, false);
});

test('dialog: another way to pay carries the numbers over and keeps the focus on the button', async () => {
  const p = makePage();
  p.openRow('e-1');
  p.press('mode-paid-percent');
  assert.equal(p.doc.activeElement, p.$('mode-paid-percent'));
  assert.equal(p.$('mode-paid-percent').getAttribute('aria-pressed'), 'true');
  assert.equal(p.$('mode-paid-exact').getAttribute('aria-pressed'), 'false');
  assert.deepEqual([p.$('val-paid-p-ana').value, p.$('val-paid-p-ben').value], ['50', '50']);
  assert.equal(p.out('paid-p-ana'), formatMoney(39000, 'EUR'));
  p.press('mode-split-items');
  assert.equal(p.$('amount').disabled, true);
  assert.equal(p.$('amount').value, '780.00');
  assert.deepEqual([p.$('it-name-0').value, p.$('it-amount-0').value], ['Apartment in Alfama', '780']);
  p.submit();
  await settle();
  assert.deepEqual(p.events.map(x => x.label), ['Bill saved.']);
  assert.deepEqual(p.bill('e-1').paid, { mode: 'percent', who: ['p-ana', 'p-ben'], values: { 'p-ana': '50', 'p-ben': '50' } });
  assert.deepEqual(p.bill('e-1').split.items, [{ name: 'Apartment in Alfama', amount: '780', who: ['p-ana', 'p-ben', 'p-cy', 'p-dee', 'p-eli'] }]);
  assert.equal(p.bill('e-1').amount, '780.00');
  assert.equal(p.store.group.expenses.length, 6);
  // The row was drawn again by the page, so the focus goes to the new row of the same bill.
  assert.equal(p.doc.activeElement, p.row('e-1'));
});

test('dialog: SAVE with nothing changed closes without touching the group', async () => {
  const p = makePage(), rev = p.store.group.rev;
  for (const id of ['e-1', 'e-2', 'e-3', 'e-4', 'e-5', 'e-6']) {
    p.openRow(id);
    const opener = p.row(id);
    p.submit();
    await settle();
    assert.equal(p.dialog.open, false);
    assert.equal(p.doc.activeElement, opener);
  }
  assert.equal(p.events.length, 0);
  assert.equal(p.store.group.rev, rev);
  assert.equal(p.store.group.example, true);
});

test('dialog: closing without saving changes nothing and gives the focus back', async () => {
  const p = makePage();
  p.openRow('e-2');
  p.type('title', 'Changed');
  p.dialog.close();     // CANCEL, the x and Escape all end here
  await settle();
  assert.equal(p.bill('e-2').title, 'Groceries');
  assert.equal(p.events.length, 0);
  assert.equal(p.doc.activeElement, p.row('e-2'));
  assert.equal(p.form.childNodes.length, 0);
  // Events that arrive late find no form and do nothing.
  p.form.fire('input');
  p.form.fire('click');
  p.store.setTypedRate('EUR', '1.3');
});

test('dialog: DELETE needs a second press, and anything else calls it off', async () => {
  const p = makePage();
  p.openRow('e-2');
  p.press('delete');
  assert.equal(p.$('delete').textContent, 'Delete this bill');
  assert.equal(p.live('confirm').textContent, 'Press again to delete this bill.');
  assert.equal(p.store.group.expenses.length, 6);
  p.type('title', 'Food');
  assert.equal(p.$('delete').textContent, 'Delete');
  assert.equal(p.live('confirm').textContent, '');
  p.press('delete');
  p.press('mode-split-equal');
  assert.equal(p.$('delete').textContent, 'Delete');
  p.press('delete');
  p.$('title').focus();          // moving on with the keyboard
  assert.equal(p.$('delete').textContent, 'Delete');
  // Where a click does not move the focus, typing or pressing something else still calls it off.
  p.$('title').focus();
  p.$('delete').fire('click');
  assert.equal(p.$('delete').textContent, 'Delete this bill');
  p.$('title').fire('input');
  assert.equal(p.$('delete').textContent, 'Delete');
  p.$('delete').fire('click');
  p.$('duplicate').parentNode.fire('click');
  assert.equal(p.$('delete').textContent, 'Delete');
  assert.equal(p.store.group.expenses.length, 6);

  p.press('delete');
  p.press('delete');
  await settle();
  assert.equal(p.dialog.open, false);
  assert.deepEqual(p.events.map(x => x.label), ['Bill deleted.']);
  assert.equal(p.bill('e-2'), undefined);
  assert.equal(p.doc.activeElement, p.doc.getElementById('bill-new'));
  assert.equal(p.store.undo(), true);
  assert.equal(p.bill('e-2').title, 'Groceries');
});

test('dialog: deleting a payment says payment', async () => {
  const p = makePage();
  p.openRow('e-6');
  assert.equal(p.heading(), 'Edit payment');
  p.press('delete');
  assert.equal(p.$('delete').textContent, 'Delete this payment');
  p.press('delete');
  await settle();
  assert.deepEqual(p.events.map(x => x.label), ['Payment deleted.']);
  assert.equal(p.doc.activeElement, p.doc.getElementById('payment-new'));
});

test('dialog: DUPLICATE opens a copy as a new bill and leaves the first one alone', async () => {
  const p = makePage();
  p.openRow('e-3');
  p.type('tip', '15');
  p.press('duplicate');
  assert.equal(p.dialog.open, true);
  assert.equal(p.heading(), 'New bill');
  assert.equal(p.$('title').value, 'Dinner at the taberna (copy)');
  assert.equal(p.doc.activeElement, p.$('title'));
  assert.equal(p.$('delete'), null);
  assert.equal(p.$('tip').value, '15');
  assert.equal(p.store.group.expenses.length, 6);
  p.submit();
  await settle();
  assert.deepEqual(p.events.map(x => x.label), ['Bill added.']);
  assert.equal(p.store.group.expenses.length, 7);
  assert.equal(p.bill('e-3').split.tip, '10');
  const copy = p.store.group.expenses[6];
  assert.notEqual(copy.id, 'e-3');
  assert.deepEqual([copy.title, copy.split.tip, copy.amount, copy.split.items.length], ['Dinner at the taberna (copy)', '15', '163.30', 4]);
  // Back to the row the editor was opened from.
  assert.equal(p.doc.activeElement, p.row('e-3'));
});

test('dialog: items are added, filled in and removed; Enter moves on and does not save', async () => {
  const p = makePage();
  p.openRow('e-3');
  assert.equal(p.$('amount').value, '156.20');
  p.press('it-add');
  assert.equal(p.doc.activeElement, p.$('it-name-4'));
  p.type('it-name-4', 'Coffee');
  assert.deepEqual(p.say('split'), ['Fix', '"Coffee" needs a price.', 'tag tag--fix']);
  let e = p.$('it-name-4').fire('keydown', { key: 'Enter' });
  assert.equal(e.defaultPrevented, true);
  assert.equal(p.doc.activeElement, p.$('it-amount-4'));
  p.type('it-amount-4', '8');
  assert.deepEqual(p.say('split'), ['Fix', '"Coffee" needs at least one person.', 'tag tag--fix']);
  p.press('it-who-4-p-eli');
  assert.equal(p.doc.activeElement, p.$('it-who-4-p-eli'));
  assert.equal(p.$('it-who-4-p-eli').getAttribute('aria-pressed'), 'true');
  assert.equal(p.$('amount').value, '165.00');
  assert.equal(p.say('split')[0], 'OK');
  // Enter on the last price adds a row and goes to it.
  p.$('it-amount-4').focus();
  e = p.$('it-amount-4').fire('keydown', { key: 'Enter' });
  assert.equal(e.defaultPrevented, true);
  assert.equal(p.doc.activeElement, p.$('it-name-5'));
  assert.equal(p.$('it-name-3').fire('keydown', { key: 'a' }).defaultPrevented, false);
  assert.equal(p.$('title').fire('keydown', { key: 'Enter' }).defaultPrevented, false);
  assert.equal(p.store.group.expenses.length, 6);

  p.press('it-del-0');
  assert.equal(p.$('it-name-0').value, 'Grilled sardines');
  assert.equal(p.doc.activeElement, p.$('it-del-0'));
  assert.equal(p.$('amount').value, '123.20');
  p.submit();
  await settle();
  const items = p.bill('e-3').split.items;
  assert.deepEqual(items.map(it => it.name), ['Grilled sardines', 'Shared petiscos', 'Vinho verde', 'Coffee']);
  assert.deepEqual(items[3], { name: 'Coffee', amount: '8', who: ['p-eli'] });
  assert.equal(p.bill('e-3').amount, '123.20');
});

test('dialog: the last item cannot be removed, only emptied', () => {
  const p = makePage();
  p.openRow('e-2');
  p.press('mode-split-items');
  assert.equal(p.$('it-name-0').value, 'Groceries');
  p.press('it-del-0');
  assert.deepEqual([p.$('it-name-0').value, p.$('it-amount-0').value, p.$('it-name-1')], ['', '', null]);
  assert.deepEqual(p.say('split'), ['Fix', 'Add at least one item.', 'tag tag--fix']);
  p.press('mode-split-equal');
  assert.equal(p.$('amount').disabled, false);
  assert.equal(p.$('amount').value, '210');
});

test('dialog: a payment', async () => {
  const p = makePage();
  p.openNew('payment');
  assert.equal(p.heading(), 'New payment');
  assert.deepEqual([p.$('from').value, p.$('to').value], ['p-ana', 'p-ben']);
  assert.deepEqual(p.say('pay'), ['Fix', 'Enter an amount.', 'tag tag--fix']);
  p.type('amount', '25,50');
  p.choose('from', 'p-ben');
  assert.deepEqual(p.say('pay'), ['Fix', 'Pick two different people.', 'tag tag--fix']);
  assert.equal(p.$('save').disabled, true);
  p.choose('to', 'p-eli');
  assert.equal(p.say('pay'), null);
  assert.equal(p.live('list').textContent, 'Ben owes Eli ' + formatMoney(2550, 'USD') + ' less.');
  assert.equal(p.live('text').value, 'Ben paid Eli 25.50 USD');
  p.submit();
  await settle();
  assert.deepEqual(p.events.map(x => x.label), ['Payment added.']);
  assert.deepEqual({ ...p.store.group.expenses[6], id: '' }, { id: '', kind: 'payment', title: 'Ben paid Eli back', amount: '25.50', currency: 'USD', from: 'p-ben', to: 'p-eli' });
  assert.equal(p.doc.activeElement, p.doc.getElementById('payment-new'));
});

test('dialog: another currency shows its rate, and the rate can be fixed for the bill', async () => {
  const p = makePage();
  p.openNew('expense');
  assert.equal(p.live('fx'), null);
  p.type('title', 'Tapas');
  p.type('amount', '100');
  p.choose('cur', 'EUR');
  assert.equal(p.doc.activeElement, p.$('cur'));
  assert.equal(p.$('cur').value, 'EUR');
  assert.equal(p.live('fx').textContent, formatMoney(11251, 'USD') + ' at 1 EUR = 1.12513 USD. Rate of ' + new Date('2026-10-04T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) + '.');
  assert.equal(p.$('rate'), null);
  assert.equal(p.fetch.calls, 0);          // EUR already has a rate in this group

  p.tick('lock', true);
  assert.equal(p.doc.activeElement, p.$('lock'));
  assert.equal(p.$('rate').value, '1.12513');
  p.type('rate', '');
  assert.deepEqual(p.say('fx'), ['Fix', 'Type the rate, or untick “Fix the rate”.', 'tag tag--fix']);
  assert.equal(p.$('save').disabled, true);
  p.type('rate', '1,2');
  assert.equal(p.say('fx'), null);
  assert.equal(p.live('fx').textContent, formatMoney(12000, 'USD') + ' at 1 EUR = 1.2000 USD. Fixed for this bill.');
  p.submit();
  await settle();
  const saved = p.store.group.expenses[6];
  assert.deepEqual(saved.fx, { rate: '1.2', base: 'USD' });
  assert.equal(computeExpense(p.store.group, saved).total, 12000);

  // Changing the currency lets go of the fixed rate.
  p.openRow(saved.id);
  assert.equal(p.$('lock').checked, true);
  p.choose('cur', 'USD');
  assert.equal(p.$('lock'), null);
  p.choose('cur', 'EUR');
  assert.equal(p.$('lock').checked, false);
  p.submit();
  await settle();
  assert.equal('fx' in p.bill(saved.id), false);
});

test('dialog: a currency new to the group gets its rate in the same step as the save', async () => {
  const p = makePage();
  p.openNew('expense');
  p.type('title', 'Pub');
  p.type('amount', '10');
  p.choose('cur', 'GBP');
  assert.equal(p.fetch.calls, 1);          // asked for as soon as the currency is chosen
  assert.match(p.live('fx').textContent, /Built-in rate, .* Saving looks up the rate for GBP, so this can change a little\.$/);
  p.submit();
  assert.equal(p.$('save').disabled, true);
  assert.equal(p.$('save').textContent, 'Getting rates');
  assert.equal(p.store.group.expenses.length, 6);
  await settle();
  await settle();
  assert.equal(p.dialog.open, false);
  assert.deepEqual(p.events.map(x => [x.type, x.label]), [['change', 'Bill added.']]);
  assert.equal(p.store.group.expenses[6].currency, 'GBP');
  assert.ok(p.store.group.fx.usd.GBP > 0);
  assert.equal(p.fetch.calls, 1);
  assert.equal(p.store.undo(), true);
  assert.equal('GBP' in p.store.group.fx.usd, false);
});

test('dialog: without a connection a new currency is still saved', async () => {
  const p = makePage({ offline: true });
  p.openNew('expense');
  p.type('title', 'Pub');
  p.type('amount', '10');
  p.choose('cur', 'GBP');
  p.submit();
  await settle();
  await settle();
  assert.equal(p.dialog.open, false);
  assert.equal(p.store.group.expenses[6].currency, 'GBP');
  assert.equal(computeExpense(p.store.group, p.store.group.expenses[6]).err, null);
});

test('dialog: closing while the rates are on their way saves nothing', async () => {
  const p = makePage();
  p.openNew('expense');
  p.type('title', 'Pub');
  p.type('amount', '10');
  p.choose('cur', 'GBP');
  p.submit();
  p.dialog.close();
  await settle();
  await settle();
  assert.equal(p.store.group.expenses.length, 6);
  assert.equal(p.events.length, 0);
});

test('dialog: when the store refuses the bill, the form stays open and says why', async () => {
  const p = makePage();
  // A link's version of a group that is also here: the store is read only until one of the two is chosen.
  // app.js never opens the editor then. If it is open anyway, saving is refused and what was typed stays.
  p.store.change('', g => { g.name = 'Mine'; });
  assert.equal(p.store.importGroup({ ...lisbon(), name: 'Theirs' }), 'differs');
  assert.equal(p.store.readOnly, true);
  p.events.length = 0;
  p.openNew('expense');
  p.type('title', 'Lunch');
  p.type('amount', '9');
  p.submit();
  await settle();
  assert.equal(p.dialog.open, true);
  assert.deepEqual(p.say('save'), ['Fix', 'This bill could not be saved.', 'tag tag--fix']);
  assert.equal(p.$('title').value, 'Lunch');
  assert.equal(p.$('save').disabled, false);
  p.type('title', 'Lunch 2');
  assert.equal(p.say('save'), null);
  p.dialog.close();
  await settle();
  assert.equal(p.events.length, 0);
});

test('dialog: a group that becomes read only under the open form closes it', async () => {
  const p = makePage();
  p.store.change('', g => { g.name = 'Mine'; });
  p.openRow('e-1');
  assert.equal(p.store.importGroup({ ...lisbon(), name: 'Theirs' }), 'differs');
  await settle();
  assert.equal(p.dialog.open, false);
});

test('dialog: events that arrive while nothing is open do nothing', () => {
  const p = makePage();
  p.form.fire('input');
  p.form.fire('change');
  p.form.fire('click');
  p.form.fire('keydown', { key: 'Enter' });
  p.form.fire('submit');
  assert.equal(p.dialog.open, false);
  assert.equal(p.events.length, 0);
});
