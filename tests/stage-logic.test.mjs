/* Tests for the pure part of docs/js/stage.js: the words and markup it makes from steps and breakdowns,
   and the timing of the player. Nothing here needs a page. Amounts are compared through formatMoney, so
   the tests pass whatever the language of the machine is. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXAMPLE_GROUP, fmtDate, formatMoney } from '../docs/js/core.js';
import { balancesOf, buildSteps, edgeBreakdown, edgesOf, finalPayments, personBreakdown } from '../docs/js/simplify.js';
import {
  arrowBreakdown, billsLine, cardsHTML, createPlayer, panelSpot, personDetail, phaseStates, planText, ratesNote,
  signedMoney, statementOf, stepDuration, stepHold, summaryOf, tidyPieces, totalsHTML, totalsMoreHTML, totalsNote,
  totalsRows, trailHTML
} from '../docs/js/stage.js';

const MODES = ['fewest', 'keep'];
const usd = minor => formatMoney(minor, 'USD');
const count = (text, part) => text.split(part).length - 1;
const plain = html => html.replace(/<[^>]+>/g, '');
const example = () => structuredClone(EXAMPLE_GROUP);
const last = steps => steps.length - 1;

/* ---------- small hand-made groups ---------- */

const pid = name => 'p-' + name.toLowerCase();

// People by name (Ana gets the id 'p-ana'); bills get the ids e-1, e-2, ...
function tiny(names, bills, extra = {}) {
  return { id: 'g-tiny', name: 'Tiny', currency: 'USD', rev: 0, rates: {},
    people: names.map(name => ({ id: pid(name), name })),
    expenses: bills.map((bill, i) => ({ id: 'e-' + (i + 1), ...bill })), ...extra };
}

// "debtor owes creditor": the creditor paid a bill that only the debtor shares.
const owes = (debtor, creditor, amount, more = {}) => ({ kind: 'expense', title: debtor + ' owes ' + creditor, amount: String(amount), currency: 'USD',
  paid: { mode: 'single', who: [pid(creditor)], values: {} },
  split: { mode: 'equal', who: [pid(debtor)], values: {}, items: [], tax: '', tip: '' }, ...more });

const paidBack = (from, to, amount, more = {}) => ({ kind: 'payment', title: from + ' paid ' + to + ' back', amount: String(amount), currency: 'USD', from: pid(from), to: pid(to), ...more });

// A bill everyone listed shares equally, paid by one person.
const shared = (title, payer, sharers, amount, more = {}) => ({ kind: 'expense', title, amount: String(amount), currency: 'USD',
  paid: { mode: 'single', who: [pid(payer)], values: {} },
  split: { mode: 'equal', who: sharers.map(pid), values: {}, items: [], tax: '', tip: '' }, ...more });

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

const NAMES = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus'];

// 2 to 7 people and 1 to 14 valid bills: one or several payers, equal or weighted shares, payments, other currencies.
function randomGroup(seed) {
  const rnd = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = arr => arr[int(0, arr.length - 1)];
  const some = (arr, k) => {
    const pool = arr.slice(), out = [];
    while (out.length < k && pool.length) out.push(pool.splice(int(0, pool.length - 1), 1)[0]);
    return out;
  };
  const base = pick(['USD', 'USD', 'EUR', 'JPY']);
  const names = NAMES.slice(0, int(2, 7));
  const amountIn = cur => (cur === 'JPY' ? String(int(100, 60000)) : (int(100, 60000) / 100).toFixed(2));
  const bills = Array.from({ length: int(1, 14) }, (_, i) => {
    const currency = rnd() < 0.3 ? pick(['USD', 'EUR', 'JPY', 'GBP']) : base;
    if (rnd() < 0.15) {
      const [from, to] = some(names, 2);
      return paidBack(from, to, amountIn(currency), { currency });
    }
    const payers = some(names, rnd() < 0.6 ? 1 : int(2, Math.min(3, names.length)));
    const sharers = some(names, int(1, names.length));
    const weighted = rnd() < 0.3;
    return { kind: 'expense', title: 'Bill ' + (i + 1), amount: amountIn(currency), currency,
      paid: { mode: payers.length === 1 ? 'single' : 'equal', who: payers.map(pid), values: {} },
      split: { mode: weighted ? 'shares' : 'equal', who: sharers.map(pid),
        values: weighted ? Object.fromEntries(sharers.map(n => [pid(n), String(int(1, 4))])) : {}, items: [], tax: '', tip: '' } };
  });
  return tiny(names, bills, { currency: base });
}

/* ---------- words ---------- */

test('signedMoney: a plus, a real minus sign, and nothing for zero', () => {
  assert.equal(signedMoney(12300, 'USD'), '+' + usd(12300));
  assert.equal(signedMoney(-10410, 'USD'), '\u2212' + usd(10410));
  assert.equal(signedMoney(0, 'USD'), usd(0));
  assert.equal(signedMoney(-500, 'JPY'), '\u2212' + formatMoney(500, 'JPY'));
  assert.ok(!signedMoney(-1, 'USD').includes('-'), 'no hyphen in front of a negative amount');
});

/* ---------- pieces of an arrow ---------- */

const piece = (amount, redirects = [], more = {}) => ({ amount, bill: 'e-1', debtor: 'p-a', creditor: 'p-b', via: [], redirects, ...more });

test('tidyPieces: swaps that follow each other count as one', () => {
  const out = tidyPieces([piece(500, [{ from: 'p-b', to: 'p-c' }, { from: 'p-c', to: 'p-d' }])]);
  assert.deepEqual(out, [piece(500, [{ from: 'p-b', to: 'p-d' }])]);
});

test('tidyPieces: money that is back with its first payee has no swap left, and joins the piece that never moved', () => {
  const out = tidyPieces([piece(5508), piece(641, [{ from: 'p-b', to: 'p-c' }, { from: 'p-c', to: 'p-b' }])]);
  assert.deepEqual(out, [piece(6149)]);
});

test('tidyPieces: swaps that do not follow each other stay apart', () => {
  const redirects = [{ from: 'p-b', to: 'p-c' }, { from: 'p-x', to: 'p-y' }];
  assert.deepEqual(tidyPieces([piece(100, redirects)])[0].redirects, redirects);
});

test('tidyPieces: a longer way round still ends as one swap, or none', () => {
  const round = [{ from: 'p-b', to: 'p-c' }, { from: 'p-c', to: 'p-d' }, { from: 'p-d', to: 'p-b' }];
  assert.deepEqual(tidyPieces([piece(100, round)])[0].redirects, []);
  const there = [{ from: 'p-b', to: 'p-c' }, { from: 'p-c', to: 'p-b' }, { from: 'p-b', to: 'p-d' }];
  assert.deepEqual(tidyPieces([piece(100, there)])[0].redirects, [{ from: 'p-b', to: 'p-d' }]);
});

test('tidyPieces: different stories stay apart, largest first, and the input is left alone', () => {
  const input = [piece(100), piece(300, [], { bill: 'e-2' }), piece(200, [], { via: [{ bill: 'e-3', from: 'p-b', to: 'p-c' }] }),
    piece(50, [{ from: 'p-b', to: 'p-c' }])];
  const copy = structuredClone(input);
  const out = tidyPieces(input);
  assert.deepEqual(out.map(p => p.amount), [300, 200, 100, 50]);
  assert.deepEqual(input, copy);
  assert.equal(out.reduce((s, p) => s + p.amount, 0), 650);
});

/* ---------- the breakdown of an arrow ---------- */

test('arrowBreakdown: the built-in example, Ben owes Eli', () => {
  const group = example(), steps = buildSteps(group, 'fewest');
  const html = arrowBreakdown(steps, group, last(steps), 'p-ben>p-eli', true);
  assert.ok(html.startsWith(`<p class="breakdown__head"><span>Ben owes Eli</span><span class="num">${usd(10410)}</span></p><ul class="breakdown__rows">`));
  assert.equal(count(html, '<li class="breakdown__row">'), 3);
  // The 641 that went to Ana and came back is part of Ben's share of the surf lessons again.
  assert.ok(html.includes(`<span class="breakdown__amt">${usd(6149)}</span><span class="breakdown__what">Ben’s share of <b>Surf lessons</b>, paid by Eli</span>`));
  assert.ok(html.includes(`<span class="breakdown__amt">${usd(3962)}</span><span class="breakdown__what">Ben’s share of <b>Apartment in Alfama</b>, paid by Ana <span class="mute">(${formatMoney(78000, 'EUR')} bill)</span>` +
    '<span class="breakdown__via">Now goes to Eli instead of Ana, which saves a payment. Everyone’s totals stay the same.</span>'));
  assert.ok(html.includes(`<span class="breakdown__amt">${usd(299)}</span>`));
  assert.ok(html.includes('<span class="breakdown__via">Passed on via Ana, who owed Eli for <b>Surf lessons</b>.</span>'));
  assert.ok(html.endsWith(`<p class="breakdown__note">Already lowered by ${usd(5851)} that Eli owed Ben (<b>Apartment in Alfama</b>). Those cancelled out.</p>`));
  assert.equal(6149 + 3962 + 299, 10410);
});

test('arrowBreakdown: without the head it starts with the rows', () => {
  const group = example(), steps = buildSteps(group, 'fewest');
  const html = arrowBreakdown(steps, group, last(steps), 'p-ben>p-eli', false);
  assert.ok(html.startsWith('<ul class="breakdown__rows">'));
  assert.ok(!html.includes('breakdown__head'));
});

test('arrowBreakdown: a bill in the group\'s own currency gets no note about its currency', () => {
  const group = example(), steps = buildSteps(group, 'fewest');
  assert.ok(arrowBreakdown(steps, group, last(steps), 'p-cy>p-eli', true).includes('Cy’s share of <b>Surf lessons</b>, paid by Eli</span>'));
});

test('arrowBreakdown: it follows the step it is asked about', () => {
  const group = example(), steps = buildSteps(group, 'fewest');
  // After the first bill Dee owes Ana and Ben one piece each, straight from the bill.
  const first = arrowBreakdown(steps, group, 1, 'p-dee>p-ana', true);
  assert.equal(count(first, '<li class="breakdown__row">'), 1);
  assert.ok(first.includes('Dee’s share of <b>Apartment in Alfama</b>, paid by Ana'));
  assert.ok(!first.includes('breakdown__note'));
  assert.ok(first.includes(usd(steps[1].g.get('p-dee>p-ana'))));
});

test('arrowBreakdown: money passed along, and a loop that came off', () => {
  const group = tiny(['Ana', 'Ben', 'Cy'], [owes('Ana', 'Ben', 30), owes('Ben', 'Cy', 20), owes('Cy', 'Ana', 10)]);
  const steps = buildSteps(group, 'fewest');
  const loop = steps.findIndex(s => s.hl.kind === 'loop');
  assert.ok(loop > 0);
  const html = arrowBreakdown(steps, group, loop, 'p-ana>p-ben', true);
  assert.ok(html.includes(`<span>Ana owes Ben</span><span class="num">${usd(2000)}</span>`));
  assert.ok(html.includes(`<p class="breakdown__note">Already lowered by ${usd(1000)} from a loop (Ana, Ben, Cy, back to Ana) that cancelled out.</p>`));
  const end = arrowBreakdown(steps, group, last(steps), 'p-ana>p-cy', true);
  assert.ok(end.includes('Ana’s share of <b>Ana owes Ben</b>, paid by Ben<span class="breakdown__via">Passed on via Ben, who owed Cy for <b>Ben owes Cy</b>.</span>'));
});

test('arrowBreakdown: payments, as the start of a piece and as a debt it was passed along', () => {
  const alone = tiny(['Ana', 'Cy'], [paidBack('Cy', 'Ana', 50)]);
  const a = buildSteps(alone, 'fewest');
  // The name of the payment says it all, so it is not said twice.
  assert.ok(arrowBreakdown(a, alone, last(a), 'p-ana>p-cy', true).includes('<span class="breakdown__what"><b>Cy paid Ana back</b></span>'));

  const named = tiny(['Ana', 'Cy'], [paidBack('Cy', 'Ana', 50, { title: 'Tickets' })]);
  const n = buildSteps(named, 'fewest');
  assert.ok(arrowBreakdown(n, named, last(n), 'p-ana>p-cy', true).includes('<span class="breakdown__what"><b>Tickets</b>: Cy paid Ana back</span>'));

  const legacyName = tiny(['Ana', 'Cy'], [paidBack('Cy', 'Ana', 50, { title: 'Cy paid Ana' })]);
  const l = buildSteps(legacyName, 'fewest');
  assert.ok(arrowBreakdown(l, legacyName, last(l), 'p-ana>p-cy', true).includes('<span class="breakdown__what"><b>Cy paid Ana</b></span>'));

  const euro = tiny(['Ana', 'Cy'], [paidBack('Cy', 'Ana', 50, { currency: 'EUR' })]);
  const e = buildSteps(euro, 'fewest');
  assert.ok(arrowBreakdown(e, euro, last(e), 'p-ana>p-cy', true).includes(`<b>Cy paid Ana back</b> <span class="mute">(${formatMoney(5000, 'EUR')} payment)</span>`));

  // Ana owes Ben for a bill, and Ben owes Cy because Cy paid him too much: Ana's money goes on to Cy.
  const chain = tiny(['Ana', 'Ben', 'Cy'], [owes('Ana', 'Ben', 30), paidBack('Cy', 'Ben', 30)]);
  const c = buildSteps(chain, 'fewest');
  assert.ok(arrowBreakdown(c, chain, last(c), 'p-ana>p-cy', true)
    .includes('<span class="breakdown__via">Passed on via Ben, who got money from Cy (<b>Cy paid Ben back</b>).</span>'));
});

test('arrowBreakdown: a swap of payees is said once per piece', () => {
  // Ana and Ben both owe Cy and Dee: one of the four payments can go.
  const group = tiny(['Ana', 'Ben', 'Cy', 'Dee'], [owes('Ana', 'Cy', 10), owes('Ana', 'Dee', 20), owes('Ben', 'Cy', 30), owes('Ben', 'Dee', 5)]);
  const steps = buildSteps(group, 'fewest');
  assert.ok(steps.some(s => s.hl.kind === 'swap'));
  const plan = finalPayments(steps);
  assert.equal(plan.length, 3);
  const all = plan.map(([a, b]) => arrowBreakdown(steps, group, last(steps), a + '>' + b, true)).join('');
  assert.match(all, /Now goes to (Cy|Dee) instead of (Cy|Dee), which saves a payment\. Everyone’s totals stay the same\./);
});

test('arrowBreakdown: at most eight pieces, the rest in one line that adds up', () => {
  const bills = n => Array.from({ length: n }, (_, i) => owes('Ben', 'Ana', 10 + i, { title: 'Bill ' + (i + 1) }));
  const twelve = tiny(['Ana', 'Ben'], bills(12)), s12 = buildSteps(twelve, 'fewest');
  const html = arrowBreakdown(s12, twelve, last(s12), 'p-ben>p-ana', true);
  assert.equal(count(html, '<li class="breakdown__row">'), 9);
  // The eight largest are 21 down to 14; the four smallest are 10 + 11 + 12 + 13.
  assert.ok(html.includes(`<span class="breakdown__amt">${usd(4600)}</span><span class="breakdown__what">From 4 smaller pieces</span>`));
  assert.ok(html.includes('<b>Bill 12</b>') && html.includes('<b>Bill 5</b>') && !html.includes('<b>Bill 4</b>'));

  const nine = tiny(['Ana', 'Ben'], bills(9)), s9 = buildSteps(nine, 'fewest');
  assert.ok(arrowBreakdown(s9, nine, last(s9), 'p-ben>p-ana', true).includes(`${usd(1000)}</span><span class="breakdown__what">From 1 smaller piece</span>`));

  const eight = tiny(['Ana', 'Ben'], bills(8)), s8 = buildSteps(eight, 'fewest');
  const whole = arrowBreakdown(s8, eight, last(s8), 'p-ben>p-ana', true);
  assert.equal(count(whole, '<li class="breakdown__row">'), 8);
  assert.ok(!whole.includes('smaller'));
});

test('billsLine: the bills behind a payment, the largest part first', () => {
  const group = example(), steps = buildSteps(group, 'fewest');
  assert.equal(billsLine(steps, group, 'p-ben>p-eli'), 'For Surf lessons and Apartment in Alfama.');
  assert.equal(billsLine(steps, group, 'p-cy>p-eli'), 'For Surf lessons, Apartment in Alfama and Train to Sintra.');
  assert.equal(billsLine(steps, group, 'p-dee>p-eli'), 'For Groceries and Surf lessons.');
  assert.equal(billsLine(steps, group, 'p-eli>p-ben'), '', 'no such payment');
});

test('billsLine: more than four bills are counted, not listed', () => {
  const bills = n => Array.from({ length: n }, (_, i) => owes('Ben', 'Ana', 10 + i, { title: 'Bill ' + (i + 1) }));
  const four = tiny(['Ana', 'Ben'], bills(4)), s4 = buildSteps(four, 'fewest');
  assert.equal(billsLine(s4, four, 'p-ben>p-ana'), 'For Bill 4, Bill 3, Bill 2 and Bill 1.');
  const six = tiny(['Ana', 'Ben'], bills(6)), s6 = buildSteps(six, 'fewest');
  assert.equal(billsLine(s6, six, 'p-ben>p-ana'), 'For Bill 6, Bill 5, Bill 4 and 3 more bills.');
});

/* ---------- one person ---------- */

test('personDetail: every bill of the person, the totals and the plan', () => {
  const group = example(), steps = buildSteps(group, 'fewest'), b = personBreakdown(steps, group, 'p-eli');
  const html = personDetail(steps, group, 'p-eli', true);
  assert.ok(html.startsWith(`<p class="breakdown__head"><span>Eli</span><span class="num">gets ${usd(28592)}</span></p>`));
  assert.equal(count(html, '<li class="breakdown__row">'), b.rows.length);
  assert.ok(html.includes(`<span class="breakdown__amt">+${usd(48000)}</span><span class="breakdown__what"><b>Surf lessons</b><span class="breakdown__via">Paid ${usd(48000)}.</span>`));
  assert.ok(html.includes(`<b>Apartment in Alfama</b> <span class="mute">(${formatMoney(78000, 'EUR')} bill)</span><span class="breakdown__via">Share ${usd(17552)}.</span>`));
  assert.ok(html.endsWith(`<p class="breakdown__note">Paid ${usd(48000)} in all, share ${usd(19408)}. In the plan Eli gets ${usd(10410)} from Ben, ${usd(6909)} from Cy and ${usd(11273)} from Dee.</p>`));
});

test('personDetail: someone who owes, and a payment seen from both sides', () => {
  const group = example(), steps = buildSteps(group, 'fewest');
  const cy = personDetail(steps, group, 'p-cy', true);
  assert.ok(cy.includes(`<span>Cy</span><span class="num">owes ${usd(6909)}</span>`));
  assert.ok(cy.includes(`<span class="breakdown__amt">+${usd(5000)}</span><span class="breakdown__what"><b>Cy paid Ana back</b><span class="breakdown__via">Paid ${usd(5000)} to Ana.</span>`));
  assert.ok(cy.includes(`In the plan Cy pays Eli ${usd(6909)}.`));
  const ana = personDetail(steps, group, 'p-ana', false);
  assert.ok(ana.startsWith('<ul class="breakdown__rows">'));
  assert.ok(ana.includes(`<span class="breakdown__amt">\u2212${usd(5000)}</span><span class="breakdown__what"><b>Cy paid Ana back</b><span class="breakdown__via">Got ${usd(5000)} from Cy.</span>`));
});

test('personDetail: paying and getting in one plan, nothing to do, and nobody\'s bills', () => {
  const group = example(), keep = buildSteps(group, 'keep');
  assert.ok(personDetail(keep, group, 'p-dee', true).includes(`In the plan Dee pays Eli ${usd(15362)} and Ana ${usd(8211)}.`));

  const even = tiny(['Ana', 'Ben', 'Cy'], [shared('Lunch', 'Ana', ['Ana'], 12), owes('Ben', 'Cy', 5)]);
  const steps = buildSteps(even, 'fewest');
  const ana = personDetail(steps, even, 'p-ana', true);
  assert.ok(ana.includes('<span>Ana</span><span class="num">even</span>'));
  assert.ok(ana.includes(`<span class="breakdown__amt">${usd(0)}</span><span class="breakdown__what"><b>Lunch</b><span class="breakdown__via">Paid ${usd(1200)}. Share ${usd(1200)}.</span>`));
  assert.ok(ana.endsWith(`Paid ${usd(1200)} in all, share ${usd(1200)}. Nothing to pay or get.</p>`));

  const lonely = tiny(['Ana', 'Ben', 'Cy'], [owes('Ben', 'Cy', 5)]);
  const s = buildSteps(lonely, 'fewest');
  assert.equal(personDetail(s, lonely, 'p-ana', true), '<p class="breakdown__head"><span>Ana</span><span class="num">even</span></p><p class="mute">Not on any bill yet.</p>');
});

test('personDetail and trailHTML: every net is exactly paid minus share, with any number of payers', () => {
  for (const mode of MODES) {
    for (let seed = 1; seed <= 60; seed++) {
      const group = randomGroup(seed), steps = buildSteps(group, mode);
      for (const p of group.people) {
        const b = personBreakdown(steps, group, p.id);
        assert.equal(b.net, b.paid - b.share, `seed ${seed} ${p.name}`);
        b.rows.forEach(r => assert.equal(r.net, r.paid - r.share, `seed ${seed} ${p.name}, bill ${r.bill}`));
        if (!b.rows.length) continue;
        const result = b.net > 0 ? `gets back ${formatMoney(b.net, group.currency)}` : b.net < 0 ? `owes ${formatMoney(-b.net, group.currency)}` : 'is even';
        assert.ok(plain(trailHTML(steps, group, p.id)).includes(`, so ${p.name} ${result}.`), `seed ${seed} ${p.name}`);
        assert.ok(!personDetail(steps, group, p.id, true).includes('Rounding'));
      }
    }
  }
});

test('trailHTML: one sentence, then the steps that involve the person', () => {
  const group = example(), steps = buildSteps(group, 'fewest');
  const html = trailHTML(steps, group, 'p-eli');
  assert.ok(html.startsWith('<h4 class="title">Following Eli</h4><p>'));
  assert.equal(plain(html.slice(html.indexOf('<p>'), html.indexOf('</p>'))),
    `Eli paid ${usd(48000)} and Eli’s share of everything is ${usd(19408)}, so Eli gets back ${usd(28592)}. In the plan Eli gets ${usd(10410)} from Ben, ${usd(6909)} from Cy and ${usd(11273)} from Dee.`);
  const wanted = steps.map((s, i) => (s.people.has('p-eli') ? i : -1)).filter(i => i >= 0);
  assert.deepEqual([...html.matchAll(/data-step="(\d+)"/g)].map(m => +m[1]), wanted);
  assert.ok(html.includes('<li><button type="button" class="trail__step" data-step="1"><span class="trail__n">1</span><span>Add bills: Apartment in Alfama · ' + formatMoney(78000, 'EUR') + '</span></button></li>'));
  assert.ok(html.includes('<span>Cancel loops: ') === wanted.some(i => steps[i].phase === 3));
  assert.ok(!html.includes('is-current'), 'the page marks the step on screen itself');

  const dee = plain(trailHTML(steps, group, 'p-dee'));
  assert.ok(dee.includes(`so Dee owes ${usd(23573)}. In the plan Dee pays Ana ${usd(12300)} and Eli ${usd(11273)}.`));
});

test('trailHTML: someone who is even and on no step', () => {
  const group = tiny(['Ana', 'Ben', 'Cy'], [owes('Ben', 'Cy', 5)]), steps = buildSteps(group, 'fewest');
  assert.equal(trailHTML(steps, group, 'p-ana'),
    `<h4 class="title">Following Ana</h4><p>Ana paid <span class="amt">${usd(0)}</span> and Ana’s share of everything is <span class="amt">${usd(0)}</span>, so Ana is even.</p>`);
});

/* ---------- the result ---------- */

test('statementOf and summaryOf', () => {
  const group = example();
  assert.equal(statementOf(buildSteps(group, 'fewest')), '4 payments settle everything.');
  assert.equal(statementOf(buildSteps(group, 'keep')), '6 payments settle everything.');
  assert.equal(summaryOf(buildSteps(group, 'fewest')), '19 debts become 4 payments.');
  assert.equal(summaryOf(buildSteps(group, 'keep')), '19 debts become 6 payments.');

  const one = buildSteps(tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 5)]), 'fewest');
  assert.equal(statementOf(one), '1 payment settles everything.');
  assert.equal(summaryOf(one), '1 debt becomes 1 payment.');

  const even = buildSteps(tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 5), owes('Ana', 'Ben', 5)]), 'fewest');
  assert.equal(statementOf(even), 'Everyone is even.');
  assert.equal(summaryOf(even), '2 debts become nothing to pay.');

  const alone = buildSteps(tiny(['Ana', 'Ben'], [shared('Lunch', 'Ana', ['Ana'], 12)]), 'fewest');
  assert.equal(statementOf(alone), 'Everyone is even.');
  assert.equal(summaryOf(alone), '');

  const none = buildSteps(tiny(['Ana', 'Ben'], []), 'fewest');
  assert.equal(statementOf(none), 'Add a bill to see who pays whom.');
  assert.equal(summaryOf(none), '');

  const broken = buildSteps(tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 0)]), 'fewest');
  assert.equal(statementOf(broken), 'Add a bill to see who pays whom.', 'a bill that cannot be worked out is not counted');
  assert.equal(statementOf(buildSteps(tiny([], []), 'fewest')), 'Add a bill to see who pays whom.');
});

test('ratesNote: the currency, and where the rates come from', () => {
  const day = fmtDate('2026-10-04');
  const builtin = example();
  assert.equal(ratesNote(buildSteps(builtin, 'fewest'), builtin), `In USD. Built-in rates of ${day}.`);

  const pinned = { ...example(), fx: { date: '2026-11-20', usd: { EUR: 0.9 } } };
  assert.equal(ratesNote(buildSteps(pinned, 'fewest'), pinned), `In USD. Rates of ${fmtDate('2026-11-20')}.`);

  const same = tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 5)]);
  assert.equal(ratesNote(buildSteps(same, 'fewest'), same), 'In USD.');

  const typed = tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 5, { currency: 'EUR' })], { rates: { EUR: { rate: '1.2', base: 'USD' } } });
  assert.equal(ratesNote(buildSteps(typed, 'fewest'), typed), 'In USD. Rates typed for this group.');

  const mixed = tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 5, { currency: 'EUR', fx: { rate: '1.5', base: 'USD' } }), owes('Ben', 'Ana', 900, { currency: 'JPY' })]);
  assert.equal(ratesNote(buildSteps(mixed, 'fewest'), mixed), `In USD. Rates set on single bills and built-in rates of ${day}.`);

  const yen = tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 900, { currency: 'JPY' })], { currency: 'JPY' });
  assert.equal(ratesNote(buildSteps(yen, 'fewest'), yen), 'In JPY.');
});

test('planText: the group\'s name, then one line per payment', () => {
  const group = example();
  assert.equal(planText(buildSteps(group, 'fewest'), group),
    ['Lisbon trip (example): settle up', `Ben pays Eli ${usd(10410)}`, `Cy pays Eli ${usd(6909)}`, `Dee pays Ana ${usd(12300)}`, `Dee pays Eli ${usd(11273)}`].join('\n'));
  const none = tiny(['Ana'], []);
  assert.equal(planText(buildSteps(none, 'fewest'), none), 'Tiny: settle up');
  const odd = tiny(['Ana', 'Ben'], [shared('Tea', 'Ana', ['Ben'], 3)]);
  odd.people[0].name = '<Ana>';
  assert.equal(planText(buildSteps(odd, 'fewest'), odd), `Tiny: settle up\nBen pays <Ana> ${usd(300)}`, 'plain text is not escaped');
});

test('cardsHTML: one card per payment, in the order of the plan', () => {
  const group = example(), steps = buildSteps(group, 'fewest'), plan = finalPayments(steps);
  const html = cardsHTML(steps, group, new Set(), '');
  assert.equal(count(html, '<article class="card"'), 4);
  assert.deepEqual([...html.matchAll(/data-key="([^"]+)"/g)].map(m => m[1]), plan.map(([a, b]) => `${a}&gt;${b}`));
  assert.ok(html.startsWith('<article class="card" data-key="p-ben&gt;p-eli"><div class="card__top">' +
    `<p class="card__amount">${usd(10410)}</p><p class="card__who">Ben → Eli</p></div>` +
    '<div class="card__panel"><div class="card__summary"><h3 class="title title--dash"><button type="button" class="card__toggle" aria-expanded="false">Ben pays Eli</button></h3>' +
    '<p class="card__line" title="For Surf lessons and Apartment in Alfama.">For Surf lessons and Apartment in Alfama.</p></div><div class="breakdown"><ul class="breakdown__rows">'));
  assert.ok(!html.includes('breakdown__head'), 'the card shows the names and the amount itself');
  assert.ok(html.includes(arrowBreakdown(steps, group, last(steps), 'p-dee>p-ana', false)), 'the same breakdown as on the graph');
});

test('cardsHTML: open cards, and the cards that do not involve the person being followed', () => {
  const group = example(), steps = buildSteps(group, 'fewest');
  const html = cardsHTML(steps, group, new Set(['p-cy>p-eli']), 'p-ana');
  assert.ok(html.includes('<article class="card is-open is-dim" data-key="p-cy&gt;p-eli">'));
  assert.ok(html.includes('<article class="card" data-key="p-dee&gt;p-ana">'));
  assert.ok(html.includes('<article class="card is-dim" data-key="p-ben&gt;p-eli">'));
  assert.equal(count(html, 'aria-expanded="true"'), 1);
  assert.equal(count(html, 'aria-expanded="false"'), 3);
});

test('cardsHTML: nothing to pay', () => {
  const even = tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 5), owes('Ana', 'Ben', 5)]);
  assert.equal(cardsHTML(buildSteps(even, 'fewest'), even, new Set(), ''), '<p class="empty">Nobody owes anybody.</p>');
  const none = tiny(['Ana', 'Ben'], []);
  assert.equal(cardsHTML(buildSteps(none, 'fewest'), none, new Set(), ''), '');
});

test('totalsRows: paid, share and the net the plan settles', () => {
  const group = example(), steps = buildSteps(group, 'fewest');
  const rows = totalsRows(steps, group);
  assert.deepEqual(rows.map(r => r.name), ['Ana', 'Ben', 'Cy', 'Dee', 'Eli']);
  assert.deepEqual(rows.map(r => r.net), [12300, -10410, -6909, -23573, 28592]);
  rows.forEach(r => assert.equal(r.net, r.paid - r.share, r.name));
  assert.deepEqual(rows.find(r => r.id === 'p-eli'), { id: 'p-eli', name: 'Eli', paid: 48000, share: 19408, net: 28592 });
});

test('totalsNote: the currency, and what net and the plus sign mean', () => {
  assert.equal(totalsNote('USD'), 'In USD. Net is paid minus share. A plus means they get money back.');
  assert.equal(totalsNote('EUR'), 'In EUR. Net is paid minus share. A plus means they get money back.');
});

test('totalsHTML: a row per person with a button, open rows, dimmed rows', () => {
  const group = example(), steps = buildSteps(group, 'fewest'), rows = totalsRows(steps, group);
  const html = totalsHTML(steps, group, rows, new Set(), '');
  assert.equal(count(html, '<tr class="total"'), 5);
  assert.ok(html.startsWith('<tr class="total" data-id="p-ana"><th scope="row"><button type="button" class="total__open" aria-expanded="false">Ana</button></th>' +
    `<td class="num">${usd(58507)}</td><td class="num">${usd(rows[0].share)}</td><td class="num">+${usd(12300)}</td></tr>`));
  assert.ok(html.includes(`<td class="num">\u2212${usd(10410)}</td>`));
  assert.ok(!html.includes('total__more'));

  const open = totalsHTML(steps, group, rows, new Set(['p-ben']), 'p-ben');
  assert.equal(count(open, '<tr class="total__more">'), 1);
  assert.ok(open.includes('aria-expanded="true">Ben</button>'));
  assert.ok(open.includes('</tr>' + totalsMoreHTML(steps, group, 'p-ben') + '<tr class="total is-dim" data-id="p-cy">'));
  assert.equal(count(open, '<tr class="total is-dim"'), 4);
  assert.ok(open.includes('<tr class="total" data-id="p-ben">'));
  assert.equal(totalsMoreHTML(steps, group, 'p-ben'), `<tr class="total__more"><td colspan="4"><div class="breakdown">${personDetail(steps, group, 'p-ben', false)}</div></td></tr>`);
});

test('totalsHTML: a net of zero has no sign, and a group with nobody has one line', () => {
  const group = tiny(['Ana', 'Ben', 'Cy'], [owes('Ben', 'Cy', 5)]), steps = buildSteps(group, 'fewest');
  assert.ok(totalsHTML(steps, group, totalsRows(steps, group), new Set(), '').includes(`Ana</button></th><td class="num">${usd(0)}</td><td class="num">${usd(0)}</td><td class="num">${usd(0)}</td></tr>`));
  const empty = tiny([], []), s = buildSteps(empty, 'fewest');
  assert.equal(totalsHTML(s, empty, totalsRows(s, empty), new Set(), ''), '<tr class="empty"><td colspan="4">No people yet.</td></tr>');
});

/* ---------- names and titles are never trusted ---------- */

test('every name and title is escaped wherever it goes into markup', () => {
  const bad = '<img src=x onerror=alert(1)>', worse = '</b><script>alert(2)</script>"\'&';
  const group = { id: 'g-bad', name: bad, currency: 'USD', rev: 0, rates: {},
    people: [{ id: 'p-a', name: bad }, { id: 'p-b', name: worse }, { id: 'p-c', name: 'Cy' }],
    expenses: [
      { id: 'e-1', kind: 'expense', title: worse, amount: '30', currency: 'EUR', paid: { mode: 'equal', who: ['p-a', 'p-c'], values: {} },
        split: { mode: 'equal', who: ['p-a', 'p-b', 'p-c'], values: {}, items: [], tax: '', tip: '' } },
      { id: 'e-2', kind: 'expense', title: bad, amount: '20', currency: 'USD', paid: { mode: 'single', who: ['p-b'], values: {} },
        split: { mode: 'equal', who: ['p-c'], values: {}, items: [], tax: '', tip: '' } },
      { id: 'e-3', kind: 'payment', title: worse, amount: '4', currency: 'USD', from: 'p-b', to: 'p-a' }] };
  for (const mode of MODES) {
    const steps = buildSteps(group, mode), rows = totalsRows(steps, group);
    const open = new Set(group.people.map(p => p.id));
    const all = [
      cardsHTML(steps, group, new Set(finalPayments(steps).map(([a, b]) => a + '>' + b)), 'p-a'),
      totalsHTML(steps, group, rows, open, 'p-b'),
      ...group.people.flatMap(p => [personDetail(steps, group, p.id, true), trailHTML(steps, group, p.id), totalsMoreHTML(steps, group, p.id)]),
      ...steps.flatMap((s, i) => edgesOf(s.g).map(([a, b]) => arrowBreakdown(steps, group, i, a + '>' + b, true)))
    ].join('\n');
    assert.ok(!/<img|<script|<\/script|onerror=alert\(1\)>/.test(all), 'no markup from a name or title');
    assert.ok(all.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(all.includes('&lt;/b&gt;&lt;script&gt;alert(2)&lt;/script&gt;&quot;&#39;&amp;'));
    // Whatever is inside a title="" stays inside it.
    for (const m of all.matchAll(/title="([^"]*)"/g)) assert.ok(!/[<>]/.test(m[1]));
  }
});

test('ids are escaped where they become attributes', () => {
  const group = { id: 'g-x', name: 'X', currency: 'USD', rev: 0, rates: {}, people: [{ id: 'p-"a', name: 'Ana' }, { id: 'p-<b', name: 'Ben' }],
    expenses: [{ id: 'e-1', kind: 'expense', title: 'Tea', amount: '3', currency: 'USD', paid: { mode: 'single', who: ['p-"a'], values: {} },
      split: { mode: 'equal', who: ['p-<b'], values: {}, items: [], tax: '', tip: '' } }] };
  const steps = buildSteps(group, 'fewest');
  assert.ok(cardsHTML(steps, group, new Set(), '').includes('data-key="p-&lt;b&gt;p-&quot;a"'));
  assert.ok(totalsHTML(steps, group, totalsRows(steps, group), new Set(), '').includes('data-id="p-&quot;a"'));
});

/* ---------- random groups ---------- */

test('random groups: the pieces shown for an arrow always add up to the arrow, at every step', () => {
  for (const mode of MODES) {
    for (let seed = 1; seed <= 120; seed++) {
      const group = randomGroup(seed), steps = buildSteps(group, mode);
      assert.ok(steps.ok);
      steps.forEach((s, i) => edgesOf(s.g).forEach(([a, b, v]) => {
        const raw = edgeBreakdown(steps, i, a + '>' + b).pieces, tidy = tidyPieces(raw);
        assert.equal(tidy.reduce((sum, p) => sum + p.amount, 0), v, `seed ${seed} ${mode} step ${i} ${a}>${b}`);
        assert.ok(tidy.length <= raw.length);
        tidy.forEach((p, k) => {
          assert.ok(p.amount > 0);
          if (k) assert.ok(tidy[k - 1].amount >= p.amount, 'largest first');
          p.redirects.forEach((r, j) => { if (j) assert.notEqual(p.redirects[j - 1].to, r.from, 'swaps that follow each other are one'); });
        });
      }));
    }
  }
});

test('random groups: the totals table agrees with the plan, and nothing unfinished reaches the page', () => {
  for (const mode of MODES) {
    for (let seed = 200; seed < 320; seed++) {
      const group = randomGroup(seed), steps = buildSteps(group, mode), plan = finalPayments(steps);
      const rows = totalsRows(steps, group), end = balancesOf(steps[last(steps)].g);
      assert.equal(rows.reduce((s, r) => s + r.net, 0), 0, `seed ${seed}: the nets cancel out`);
      rows.forEach(r => {
        const gets = plan.filter(p => p[1] === r.id).reduce((s, p) => s + p[2], 0), pays = plan.filter(p => p[0] === r.id).reduce((s, p) => s + p[2], 0);
        assert.equal(r.net, gets - pays, `seed ${seed} ${r.name}: net is what the plan pays`);
        assert.equal(r.net, end.get(r.id) || 0);
        assert.equal(r.net, r.paid - r.share, `seed ${seed} ${r.name}: net is paid minus share`);
      });
      const cards = cardsHTML(steps, group, new Set(), '');
      assert.equal(count(cards, '<article '), plan.length);
      const all = [cards, totalsHTML(steps, group, rows, new Set(rows.map(r => r.id)), ''), statementOf(steps), summaryOf(steps),
        ratesNote(steps, group), planText(steps, group), totalsNote(group.currency),
        ...group.people.map(p => trailHTML(steps, group, p.id) + personDetail(steps, group, p.id, true))].join('\n');
      assert.ok(!/undefined|NaN|\[object|null/.test(all), `seed ${seed} ${mode}`);
      assert.ok(!/\b(edge|node|provenance|fragment|parse)s?\b/i.test(plain(all)), 'no jargon');
      assert.equal(planText(steps, group).split('\n').length, plan.length + 1);
    }
  }
});

/* ---------- phases, timing, placing ---------- */

test('phaseStates: where each phase starts and whether anything moves in it', () => {
  const group = example();
  const fewest = phaseStates(buildSteps(group, 'fewest'));
  assert.deepEqual(fewest.map(s => s.first), [0, 1, 7, 16, 17, 20, 22]);
  assert.ok(fewest.every(s => s.moves));
  const keep = phaseStates(buildSteps(group, 'keep'));
  assert.deepEqual(keep[5], { first: -1, moves: false }, '"only existing debts" never swaps payees');
  assert.equal(keep[6].first, 21);

  // One debt: every phase has its step, but only "Add bills" moves anything.
  const one = phaseStates(buildSteps(tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 5)]), 'fewest'));
  assert.deepEqual(one.map(s => s.first), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(one.map(s => s.moves), [true, true, false, false, false, false, true]);

  const none = phaseStates(buildSteps(tiny(['Ana', 'Ben'], []), 'fewest'));
  assert.deepEqual(none.map(s => s.first), [0, -1, -1, -1, -1, -1, 1]);
  assert.deepEqual(none.map(s => s.moves), [true, false, false, false, false, false, true]);
});

test('stepDuration and stepHold: the timings of the first version', () => {
  const steps = buildSteps(example(), 'fewest');
  const add = steps[1], loop = steps.find(s => s.hl.kind === 'loop'), hop = steps.find(s => s.hl.kind === 'hop'), swap = steps.find(s => s.hl.kind === 'swap');
  assert.equal(stepDuration(add, 1), 1300);
  assert.equal(stepDuration(loop, 1), 2300, 'a dot travels the loop first');
  assert.equal(stepDuration(hop, 1), 2300);
  assert.equal(stepDuration(swap, 1), 1300);
  assert.equal(stepDuration(add, 2), 650);
  assert.equal(stepHold(steps[0], 1), 2600);
  assert.equal(stepHold(add, 1), 2600);
  assert.equal(stepHold(steps[last(steps)], 1), 2600);
  assert.equal(stepHold(add, 0.5), 5200);
  const quiet = buildSteps(tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 5)]), 'fewest')[2];
  assert.equal(quiet.hl.kind, undefined);
  assert.equal(stepHold(quiet, 1), 1100, 'a step that only says "nothing to do" stays shorter');
});

test('panelSpot: beside the pointer and always inside the band', () => {
  assert.deepEqual(panelSpot(100, 100, 1000, 600, 340, 200), { x: 116, y: 116 });
  assert.deepEqual(panelSpot(900, 100, 1000, 600, 340, 200), { x: 900 - 340 - 16, y: 116 }, 'no room on the right: to the left of the pointer');
  assert.deepEqual(panelSpot(100, 550, 1000, 600, 340, 200), { x: 116, y: 600 - 200 - 8 }, 'pushed up from the bottom');
  assert.deepEqual(panelSpot(250, 100, 500, 600, 340, 200), { x: 8, y: 116 }, 'a narrow band: as far left as it goes');
  assert.deepEqual(panelSpot(100, 100, 300, 150, 340, 200), { x: 8, y: 8 }, 'larger than the band: the top left corner');
  for (let px = 0; px <= 1000; px += 50) {
    for (let py = 0; py <= 600; py += 50) {
      const { x, y } = panelSpot(px, py, 1000, 600, 340, 200);
      assert.ok(x >= 8 && x + 340 <= 992 && y >= 8 && y + 200 <= 592, `inside at ${px},${py}`);
    }
  }
});

/* ---------- the player ---------- */

// A player on the example's steps with a clock, frames and timers that only move when the test says so.
function rig(opts = {}) {
  const steps = opts.steps || buildSteps(example(), 'fewest');
  const state = { still: false, speed: 1, clock: 0, ...opts };
  const log = [], frames = [], timers = new Map();
  let ids = 0;
  const player = createPlayer({
    draw: t => log.push(t), changed: () => log.push('changed'),
    still: () => state.still, speed: () => state.speed, now: () => state.clock,
    frame: fn => { frames.push(fn); return frames.length; },
    later: (fn, ms) => { timers.set(++ids, { fn, ms }); return ids; },
    cancel: id => { timers.delete(id); }
  });
  player.load(steps);
  return {
    player, steps, state, log, frames, timers,
    // Moves the clock on and runs the frame that was asked for.
    frame(ms) { state.clock += ms; const fn = frames.shift(); fn(state.clock); },
    // Runs the one timer that is waiting and says how long it was set for.
    timer() { const [[id, t]] = [...timers]; timers.delete(id); t.fn(); return t.ms; },
    take() { return log.splice(0); }
  };
}

test('player: new steps show the last one at rest, and nothing runs', () => {
  const r = rig();
  assert.equal(r.player.index, 22);
  assert.equal(r.player.from, 22);
  assert.equal(r.player.moving, false);
  assert.equal(r.player.playing, false);
  assert.deepEqual(r.log, [], 'the page draws after loading');
  assert.equal(r.frames.length, 0);
  assert.equal(r.timers.size, 0);
});

test('player: going back is a jump', () => {
  const r = rig();
  r.player.goTo(21, false);
  assert.equal(r.player.index, 21);
  assert.deepEqual(r.take(), [1, 'changed']);
  assert.equal(r.frames.length + r.timers.size, 0);
});

test('player: going to the next step is animated over the step\'s duration', () => {
  const r = rig();
  r.player.goTo(0, false);
  r.take();
  r.player.goTo(1, true);
  assert.deepEqual(r.take(), ['changed'], 'the words change at once, the picture with the first frame');
  assert.equal(r.player.index, 1);
  assert.equal(r.player.from, 0);
  assert.equal(r.player.moving, true);
  assert.equal(r.frames.length, 1);
  r.frame(650);
  assert.deepEqual(r.take(), [0.5]);
  assert.equal(r.frames.length, 1);
  r.frame(649);
  assert.ok(r.take()[0] < 1);
  r.frame(1);
  assert.deepEqual(r.take(), [1]);
  assert.equal(r.player.moving, false);
  assert.equal(r.player.from, 1);
  assert.equal(r.frames.length, 0, 'no frame is asked for once the step has arrived');
  assert.equal(r.timers.size, 0, 'and no timer, because nothing is playing');
});

test('player: a step along a path takes longer, and speed scales it', () => {
  const r = rig();
  const hop = r.steps.findIndex(s => s.hl.kind === 'hop');
  r.player.goTo(hop - 1, false);
  r.player.goTo(hop, true);
  r.take();
  r.frame(1150);
  assert.deepEqual(r.take(), [0.5]);
  r.frame(1150);
  assert.deepEqual(r.take(), [1]);

  r.state.speed = 2;
  r.player.goTo(0, false);
  r.player.goTo(1, true);
  r.take();
  r.frame(325);
  assert.deepEqual(r.take(), [0.5]);
});

test('player: a frame that is earlier than the start draws the start', () => {
  const r = rig();
  r.player.goTo(0, false);
  r.player.goTo(1, true);
  r.take();
  r.frame(-5);
  assert.deepEqual(r.take(), [0]);
});

test('player: next pressed during a move starts the following move from the step just reached', () => {
  const r = rig();
  r.player.goTo(0, false);
  r.player.goTo(1, true);
  r.frame(100);
  r.player.goTo(2, true);
  assert.equal(r.player.from, 1);
  assert.equal(r.player.index, 2);
  assert.equal(r.frames.length, 1, 'still one frame waiting, not two');
  r.take();
  r.frame(650);
  assert.deepEqual(r.take(), [0.5], 'timed from the second press');
});

test('player: only the very next step is animated, and the ends hold', () => {
  const r = rig();
  r.player.goTo(0, false);
  r.player.goTo(2, true);
  assert.equal(r.player.moving, false);
  r.player.goTo(1, true);
  assert.equal(r.player.moving, false, 'backwards is a jump');
  r.player.goTo(-7, false);
  assert.equal(r.player.index, 0);
  r.player.goTo(999, true);
  assert.equal(r.player.index, 22);
  assert.equal(r.player.moving, false);
  assert.equal(r.frames.length, 0);
});

test('player: with reduced motion every step jumps', () => {
  const r = rig({ still: true });
  r.player.goTo(0, false);
  r.take();
  r.player.goTo(1, true);
  assert.deepEqual(r.take(), [1, 'changed']);
  assert.equal(r.player.moving, false);
  assert.equal(r.frames.length, 0);
});

test('player: play from the end starts over and runs to the last step, then stops', () => {
  const r = rig();
  r.player.play(true);
  assert.equal(r.player.playing, true);
  assert.equal(r.player.index, 0);
  assert.deepEqual(r.take(), [1, 'changed']);
  assert.equal(r.timers.size, 1);
  assert.equal(r.frames.length, 0, 'while a step is held only a timer waits');
  for (let i = 1; i <= 22; i++) {
    assert.equal(r.timer(), stepHold(r.steps[i - 1], 1));
    assert.equal(r.player.index, i);
    assert.equal(r.timers.size, 0, 'while a step moves only a frame waits');
    assert.equal(r.frames.length, 1);
    r.frame(stepDuration(r.steps[i], 1));
    assert.equal(r.frames.length, 0);
    assert.equal(r.timers.size, 1);
  }
  r.take();
  assert.equal(r.timer(), 2600);
  assert.equal(r.player.playing, false);
  assert.equal(r.player.index, 22);
  assert.deepEqual(r.take(), ['changed'], 'the page is told that playing ended');
  assert.equal(r.frames.length + r.timers.size, 0, 'nothing runs when idle');
});

test('player: play from the middle moves on at once', () => {
  const r = rig();
  r.player.goTo(5, false);
  r.take();
  r.player.play(true);
  assert.equal(r.player.index, 6);
  assert.equal(r.player.moving, true);
  assert.deepEqual(r.take(), ['changed']);
});

test('player: pause while a step is held cancels the timer', () => {
  const r = rig();
  r.player.play(true);
  r.take();
  r.player.play(false);
  assert.equal(r.timers.size, 0);
  assert.deepEqual(r.take(), ['changed']);
  r.player.play(false);
  assert.deepEqual(r.take(), [], 'pausing twice says nothing');
});

test('player: pause during a move lets the move finish and then waits', () => {
  const r = rig();
  r.player.goTo(3, false);
  r.player.play(true);
  r.player.play(false);
  assert.equal(r.player.moving, true);
  r.frame(5000);
  assert.equal(r.player.moving, false);
  assert.equal(r.player.index, 4);
  assert.equal(r.timers.size, 0);
  // Play again during a move does not skip a step.
  r.player.goTo(5, true);
  r.player.play(true);
  assert.equal(r.player.index, 5);
  r.frame(5000);
  assert.equal(r.timers.size, 1);
});

test('player: a jump while playing keeps playing from there, with one timer', () => {
  const r = rig();
  r.player.play(true);
  r.player.goTo(10, false);
  assert.equal(r.timers.size, 1);
  r.timer();
  assert.equal(r.player.index, 11);
});

test('player: with reduced motion playing still walks through the steps, on timers alone', () => {
  const r = rig({ still: true, steps: buildSteps(tiny(['Ana', 'Ben'], [owes('Ben', 'Ana', 5)]), 'fewest') });
  r.player.play(true);
  const holds = [];
  while (r.timers.size) {
    holds.push(r.timer());
    assert.equal(r.frames.length, 0);
  }
  assert.deepEqual(holds, [2600, 2600, 1100, 1100, 1100, 1100, 2600]);
  assert.equal(r.player.index, 6);
  assert.equal(r.player.playing, false);
});

test('player: loading new steps stops everything, and a frame left over draws nothing', () => {
  const r = rig();
  r.player.goTo(3, false);
  r.player.play(true);
  assert.equal(r.frames.length, 1);
  const fresh = buildSteps(example(), 'keep');
  r.player.load(fresh);
  r.take();
  assert.equal(r.player.playing, false);
  assert.equal(r.player.moving, false);
  assert.equal(r.player.index, 21);
  r.frame(16);
  assert.deepEqual(r.take(), []);
  assert.equal(r.frames.length + r.timers.size, 0);

  const held = rig();
  held.player.play(true);
  assert.equal(held.timers.size, 1);
  held.player.load(fresh);
  assert.equal(held.timers.size, 0);
});

/* ---------- the file itself ---------- */

test('stage.js keeps to the rules of the page', () => {
  const source = readFileSync(new URL('../docs/js/stage.js', import.meta.url), 'utf8');
  assert.ok(!/style\s*=\s*["'\\]/.test(source), 'no style attributes in markup');
  assert.ok(!/\son[a-z]+\s*=\s*["'\\]/.test(source), 'no inline handlers in markup');
  assert.ok(!/console\.|alert\(|confirm\(|prompt\(/.test(source));
  assert.ok(!/export default/.test(source));
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(source), 'no emoji');
});
