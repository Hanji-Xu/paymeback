/* Pay Me Back bill editor: the form in the #editor dialog, for one bill or one payment.

   initEditor(store)              wires the dialog, once
   openEditor(billOrNull, kind)   opens it for a bill of the group, or for a new 'expense' or 'payment'

   The form works on a draft: a copy that holds what was typed, as it was typed. Nothing reaches the store
   until SAVE. There are two kinds of redraw:
   - typing only refreshes the worked-out parts (each person's amount, the status lines, the preview), so
     the field being typed in is never touched;
   - anything that changes the shape of the form (a tick, another way to split, an item added) draws the
     form again and puts the focus and the caret back by the field's data-k.

   Everything above "the dialog" is pure and runs without a page: tests/editor-logic.test.mjs covers it. */

import { CURRENCIES, billRate, computeExpense, esc, fmtDate, fmtRate, formatMoney, fromMinor, minorDigits, personName, plainMoney, rateFor, tableRate, toMinor } from './core.js';
import { describeBill, formatBill } from './parse.js';

const MAX_TITLE = 80;   // names of bills and of items, as in share.js
const MAX_ITEMS = 100;
const PAID_MODES = [['single', 'One person'], ['equal', 'Equally'], ['exact', 'Amounts'], ['percent', 'Percent'], ['shares', 'Shares']];
const SPLIT_MODES = [['equal', 'Equally'], ['exact', 'Amounts'], ['percent', 'Percent'], ['shares', 'Shares'], ['items', 'Items']];
const VALUED = ['exact', 'percent', 'shares'];   // the ways to pay or split that take a number for each person

const text = v => (v == null ? '' : String(v));
const tidy = (v, max) => text(v).replace(/\s+/g, ' ').trim().slice(0, max).trim();
const idsOf = group => group.people.map(p => p.id);
/* The people of a list who are in the group, each once, in the order written. That is how core.js reads a
   list, and the order counts: when a split leaves a cent over, it goes to whoever comes first. So a list
   keeps its order until someone is ticked or unticked; then it takes the group's order (inOrder). */
const known = (group, who) => [...new Set(who || [])].filter(id => group.people.some(p => p.id === id));
const inOrder = (group, who) => idsOf(group).filter(id => who.includes(id));
const blankItem = () => ({ name: '', amount: '', who: [] });
const lastCurrency = group => (group.expenses.length && group.expenses[group.expenses.length - 1].currency) || group.currency;
// The note a payment gets when none is typed. parse.js writes the same one.
const paybackTitle = (group, from, to) => (personName(group, from) + ' paid ' + personName(group, to) + ' back').slice(0, MAX_TITLE);
// A rate fixed on a bill says what it is a rate to. That is the group's currency unless the bill says otherwise.
const fxBase = (group, d) => (d.fx && CURRENCIES.includes(d.fx.base) && d.fx.base !== d.currency ? d.fx.base : group.currency);
// True when the group has no rate of its own for this currency yet. The store looks one up when the bill is saved.
const unpinned = (group, cur) => cur !== group.currency && (tableRate(group, cur) || {}).source !== 'pinned';

/* ---------- drafts ---------- */

// A new bill: in the currency used last, paid by "me" (else the first person), shared by everyone.
export function newExpense(group, me) {
  const ids = idsOf(group), payer = ids.includes(me) ? me : ids[0];
  return { id: '', kind: 'expense', title: '', amount: '', currency: lastCurrency(group),
    paid: { mode: 'single', who: payer ? [payer] : [], values: {} },
    split: { mode: 'equal', who: ids, values: {}, items: [blankItem()], tax: '', tip: '' } };
}

export function newPayment(group, me) {
  const ids = idsOf(group), from = ids.includes(me) ? me : ids[0] || '';
  return { id: '', kind: 'payment', title: '', amount: '', currency: lastCurrency(group), from, to: ids.find(id => id !== from) || '' };
}

// A copy of one of the group's bills to work on. The bill itself is never touched.
export function draftOf(group, bill) {
  const strings = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, text(v)]));
  const d = { id: text(bill.id), kind: bill.kind === 'payment' ? 'payment' : 'expense', title: text(bill.title), amount: text(bill.amount),
    currency: CURRENCIES.includes(bill.currency) ? bill.currency : group.currency };
  if (bill.fx) d.fx = { rate: text(bill.fx.rate), base: bill.fx.base || group.currency };
  if (d.kind === 'payment') {
    d.from = text(bill.from);
    d.to = text(bill.to);
    // A note the page wrote itself is written again on saving, so it follows a change of people.
    const plain = personName(group, d.from) + ' paid ' + personName(group, d.to);
    if (d.title === plain || d.title === paybackTitle(group, d.from, d.to)) d.title = '';
    return d;
  }
  const paid = bill.paid || {}, split = bill.split || {};
  const items = (split.items || []).map(it => ({ name: text(it && it.name), amount: text(it && it.amount), who: [...((it && it.who) || [])] }));
  // One payer is the first person listed, as in core.js.
  d.paid = { mode: text(paid.mode), who: paid.mode === 'single' ? known(group, paid.who).slice(0, 1) : [...(paid.who || [])], values: strings(paid.values) };
  d.split = { mode: text(split.mode), who: [...(split.who || [])], values: strings(split.values),
    items: items.length ? items : [blankItem()], tax: text(split.tax), tip: text(split.tip) };
  return d;
}

// The draft as a new bill of its own, for DUPLICATE.
export function duplicateOf(draft) {
  const title = tidy(draft.title, MAX_TITLE - 7);
  return { ...structuredClone(draft), id: '', title: title ? title + ' (copy)' : '' };
}

/* ---------- numbers as people type them ---------- */

/* A typed number as plain digits with a dot, '' for an empty field, null when it is not a number or
   could be read two ways. core.js num() would still make something of '12,50' (1250) or '1e3' (13), and
   a bill must never be saved on a reading like that.
   An amount of money may be grouped, as in SPEC section 6: '1,200.50', '1.200,50', and '1,200' is twelve
   hundred. A comma with one or two digits after it is the decimal mark: '12,50'.
   A percent, a number of shares or a rate is never grouped. A comma is its decimal mark ('1,1251'),
   except with exactly three digits after it: '1,125' could be either, so it is refused. */
export function readNumber(typed, money) {
  const t = text(typed).trim();
  let s = null;
  if (t === '') return '';
  if (/^\d+[.,]?$/.test(t)) s = t.replace(/[.,]$/, '');                                                     // 12   12.   12,
  else if (/^\d*\.\d+$/.test(t)) s = t;                                                                     // 12.5   .5
  else if (/^\d+,\d+$/.test(t) && (money ? /,\d{1,2}$/ : /,(?!\d{3}$)/).test(t)) s = t.replace(',', '.');    // 12,5   12,50
  else if (money && /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) s = t.replace(/,/g, '');                      // 1,200   1,200.50
  else if (money && /^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(t)) s = t.replace(/\./g, '').replace(',', '.');    // 1.200,50
  if (s === null) return null;
  s = s.replace(/^0+(?=\d)/, '');
  return s.startsWith('.') ? '0' + s : s;
}

// What a field holds as a number of shares: what is there if it is a number above zero ('50%' counts as 50), else 1.
function sharesOf(typed) {
  const s = readNumber(text(typed).replace(/\s*%$/, ''), false);
  return Number(s) > 0 ? s : '1';
}

/* What the draft says, as a bill in the shape of SPEC section 3: `bill`. Its numbers are plain decimals,
   its people are people of the group, and only what the chosen way of paying and splitting uses is kept.
   Item rows stay in place, empty ones too, so "Item 2" in a message is the second row on screen.
   `bad` holds a message for each part with a number that cannot be used: total, paid, split, fx. */
export function readDraft(group, draft) {
  const base = group.currency, ids = idsOf(group), bad = {};
  const cur = CURRENCIES.includes(draft.currency) ? draft.currency : base, digits = minorDigits(cur);
  const flag = (part, message) => { if (!bad[part]) bad[part] = message; };
  // kind: 'money' (the bill's currency), 'percent', 'rate', or 'plain'
  const number = (typed, part, kind) => {
    const shown = text(typed).trim(), s = readNumber(kind === 'percent' ? shown.replace(/\s*%$/, '') : shown, kind === 'money');
    const quoted = '"' + (shown.length > 24 ? shown.slice(0, 24) + '…' : shown) + '"';
    if (s === null) {
      flag(part, quoted + ' cannot be used here. Write a plain number like ' + (kind === 'money' ? fromMinor(1250, cur) : kind === 'rate' ? '1.1251' : '12.5') + '.');
      return '';
    }
    if (kind === 'money' && (s.split('.')[1] || '').length > digits) {
      flag(part, quoted + (digits ? ' has too many decimals. ' + cur + ' has ' + digits + '.' : ' has decimals. ' + cur + ' has none.'));
      return '';
    }
    return s;
  };

  const bill = { id: text(draft.id), kind: draft.kind === 'payment' ? 'payment' : 'expense', title: tidy(draft.title, MAX_TITLE), amount: '', currency: cur };
  if (draft.fx && cur !== base) {
    const rate = number(draft.fx.rate, 'fx', 'rate');
    if (Number(rate) > 0) bill.fx = { rate, base: fxBase(group, { ...draft, currency: cur }) };
    else flag('fx', 'Type the rate, or untick “Fix the rate”.');
  }

  if (bill.kind === 'payment') {
    bill.amount = number(draft.amount, 'total', 'money');
    bill.from = ids.includes(draft.from) ? draft.from : '';
    bill.to = ids.includes(draft.to) ? draft.to : '';
    if (!bill.title && bill.from && bill.to) bill.title = paybackTitle(group, bill.from, bill.to);
    return { bill, bad };
  }

  const side = (s, part) => {
    const who = known(group, s.who), values = {};
    if (VALUED.includes(s.mode)) {
      who.forEach(id => {
        const v = number(s.values[id], part, s.mode === 'exact' ? 'money' : s.mode === 'percent' ? 'percent' : 'plain');
        if (v) values[id] = v;
      });
    }
    return { mode: s.mode, who: s.mode === 'single' ? who.slice(0, 1) : who, values };
  };
  bill.paid = side(draft.paid, 'paid');
  if (draft.split.mode !== 'items') {
    bill.amount = number(draft.amount, 'total', 'money');
    bill.split = { ...side(draft.split, 'split'), items: [], tax: '', tip: '' };
    return { bill, bad };
  }
  const items = draft.split.items.map(it => {
    const row = { name: tidy(it.name, MAX_TITLE), amount: number(it.amount, 'split', 'money'), who: known(group, it.who) };
    // core.js passes over a row with no price and no people. With a name on it, somebody meant it.
    if (row.name && toMinor(row.amount, cur) <= 0) flag('split', '"' + row.name + '" needs a price.');
    return row;
  });
  const percent = typed => { const s = number(typed, 'split', 'percent'); return Number(s) > 0 ? s : ''; };
  bill.split = { mode: 'items', who: [], values: {}, items, tax: percent(draft.split.tax), tip: percent(draft.split.tip) };
  return { bill, bad };
}

// Makes a bill from readDraft ready to keep: item rows without a price go, and the total the items come to is written down.
function finish(bill, total) {
  if (bill.kind === 'expense' && bill.split.mode === 'items') {
    bill.split.items = bill.split.items.filter(it => toMinor(it.amount, bill.currency) > 0);
    bill.amount = total > 0 ? fromMinor(total, bill.currency) : '';
  }
  return bill;
}

// The bill that SAVE stores.
export function cleanBill(group, draft) {
  const { bill } = readDraft(group, draft);
  return finish(bill, computeExpense(group, bill).totalOrig);
}

/* ---------- changing the draft ---------- */

/* Another way to pay (key 'paid') or to split (key 'split'). What is already there is carried over:
   - percent starts as equal parts that make exactly 100;
   - shares start at 1 each, and numbers that are already there stay, so going from percent or amounts to
     shares keeps the same proportions;
   - amounts start as what each person's part comes to right now;
   - items start as one item for the whole total, unless items with a price are there already;
   - leaving items keeps the total the items came to, and ticks the people who had something. */
export function switchMode(group, draft, key, mode) {
  const side = draft[key], was = side.mode;
  if (mode === was) return draft;
  const { bill } = readDraft(group, draft), cur = bill.currency, r = computeExpense(group, bill), ids = idsOf(group);
  side.who = known(group, side.who);
  if (was === 'items') {
    if (r.totalOrig > 0) draft.amount = fromMinor(r.totalOrig, cur);
    if (!side.who.length) side.who = ids.filter(id => r.owedOrig.get(id) > 0);
    if (!side.who.length) side.who = ids;
  }
  if (mode === 'single') side.who = side.who.length ? side.who.slice(0, 1) : ids.slice(0, 1);
  if (mode === 'percent' && side.who.length) {
    const n = side.who.length, each = +(100 / n).toFixed(4);
    side.who.forEach((id, i) => { side.values[id] = String(i === n - 1 ? +(100 - each * (n - 1)).toFixed(4) : each); });
  }
  if (mode === 'shares') side.who.forEach(id => { side.values[id] = sharesOf(side.values[id]); });
  if (mode === 'exact') {
    const now = key === 'paid' ? r.paidOrig : r.owedOrig;
    side.who.forEach(id => { side.values[id] = now.get(id) > 0 ? fromMinor(now.get(id), cur) : ''; });
  }
  if (mode === 'items' && toMinor(bill.amount, cur) > 0 && !side.items.some(it => toMinor(readNumber(it.amount, true), cur) > 0)) {
    side.items = [{ name: bill.title || 'Item', amount: bill.amount, who: [...side.who] }];
  }
  side.mode = mode;
  return draft;
}

// Ticks or unticks a person on one side. With one payer, the tick moves to that person.
export function setWho(group, draft, key, id, on) {
  const side = draft[key];
  side.who = inOrder(group, side.mode === 'single' ? [id] : on ? [...side.who, id] : side.who.filter(x => x !== id));
  if (on && side.mode === 'shares') side.values[id] = sharesOf(side.values[id]);
  return draft;
}

export function toggleItemWho(group, draft, index, id) {
  const item = draft.split.items[index];
  if (item) item.who = inOrder(group, item.who.includes(id) ? item.who.filter(x => x !== id) : [...item.who, id]);
  return draft;
}

/* ---------- what the form shows ---------- */

function itemsLine(bill, r) {
  const plain = v => plainMoney(v, bill.currency), tax = Number(bill.split.tax) > 0, tip = Number(bill.split.tip) > 0;
  if (!(r.extra > 0)) return 'The items add up to ' + plain(r.totalOrig) + '.';
  const what = tax && tip ? 'tax and tip' : tax ? 'tax' : 'tip';
  return 'Items ' + plain(r.subtotal) + ' plus ' + what + ' ' + plain(r.extra) + ' make ' + plain(r.totalOrig) + '. ' +
    (tax && tip ? 'Tax and tip are' : 'The ' + what + ' is') + ' shared in proportion to what each person had.';
}

/* Everything in the form that is worked out from the draft, as plain data:
   { bill      the bill SAVE would store
     canSave
     total     the text for the Total field when it comes from the items, else null
     outs      { 'paid-<personId>' | 'split-<personId>': that person's amount in the bill's currency, or '' }
     says      { title, fx, paid, split, pay }: each null or { fix, text }, a line marked OK or FIX
     fx        the converted amount with its rate, where the rate is from and its date; '' when not converted
     reads     the bill in one sentence (describeBill)
     list      [[words, amount, tail]]: who owes whom, in the group's currency
     note      a line under the list
     text }    the bill as it could be typed (formatBill) */
export function viewOf(group, draft, locale) {
  const { bill, bad } = readDraft(group, draft), r = computeExpense(group, bill);
  const cur = bill.currency, base = group.currency, pay = bill.kind === 'payment', items = !pay && bill.split.mode === 'items';
  const money = (v, code) => formatMoney(v, code, locale), name = id => personName(group, id);
  const fix = message => (message ? { fix: true, text: message } : null), ok = message => (message ? { fix: false, text: message } : null);
  const total = r.totalOrig, sum = total > 0 ? 'Adds up to ' + plainMoney(total, cur) + '.' : '';
  const blocked = !!r.err || Object.keys(bad).length > 0;
  const says = {}, outs = {};

  if (pay) says.pay = fix(bad.total || r.errPaid || r.errSplit);
  else {
    for (const p of group.people) {
      outs['paid-' + p.id] = r.paidOrig.get(p.id) > 0 ? money(r.paidOrig.get(p.id), cur) : '';
      outs['split-' + p.id] = r.owedOrig.get(p.id) > 0 ? money(r.owedOrig.get(p.id), cur) : '';
    }
    says.paid = fix(bad.paid || r.errPaid) || ok(sum);
    says.split = fix(bad.total || bad.split || r.errSplit) || ok(items ? itemsLine(bill, r) : sum && r.splitNote ? sum + ' ' + r.splitNote + '.' : sum);
    // A missing name is only pointed out once it is the last thing in the way.
    says.title = blocked ? null : fix(r.errTitle);
  }

  let fx = '';
  if (cur !== base) {
    const now = billRate(group, bill);
    if (now.rate) {
      const from = now.source === 'fixed' ? 'Fixed for this bill.' : now.source === 'manual' ? 'Your rate.'
        : now.source === 'pinned' ? 'Rate of ' + fmtDate(now.date, locale) + '.'
        : 'Built-in rate, ' + fmtDate(now.date, locale) + '. Saving looks up the rate for ' + cur + ', so this can change a little.';
      fx = (r.err ? '' : money(r.total, base) + ' at ') + '1 ' + cur + ' = ' + fmtRate(now.rate) + ' ' + base + '. ' + from;
    }
    says.fx = fix(bad.fx || r.errFx);
  }

  let list = [], note = '';
  if (blocked) note = 'Fix the line marked FIX above to see who owes whom.';
  else if (pay) list = [[name(bill.from) + ' owes ' + name(bill.to), money(r.total, base), ' less.']];
  else if (!r.edges.length) note = 'No debts. Everyone covered their own share.';
  else {
    list = r.edges.map(([debtor, payer, v]) => [name(debtor) + ' owes ' + name(payer), money(v, base), '']);
    if ([...r.paid.values()].filter(v => v > 0).length > 1) note = 'With several payers, each share is owed to them in proportion to what they paid. The cents are rounded so that each payer is covered exactly.';
  }

  const canSave = !blocked && (pay || !r.errTitle), clean = finish(bill, total);
  return { bill: clean, canSave, total: items ? (total > 0 ? fromMinor(total, cur) : '') : null, outs, says, fx, list, note,
    reads: blocked ? '' : describeBill(group, clean), text: canSave ? formatBill(group, clean) : '' };
}

/* ---------- the form as HTML ---------- */

const NUMBER = ' inputmode="decimal" maxlength="24" autocomplete="off"';
const field = (label, control) => `<label class="field"><span class="field__label">${label}</span>${control}</label>`;
// A status line. update() fills it in and shows it.
const say = name => `<p class="say" data-say="${name}" hidden><b class="tag"></b><span></span></p>`;

function topHtml(d, items) {
  const pay = d.kind === 'payment';
  return '<div class="form__sec fields">' +
    field(pay ? 'Note' : 'What was it', `<input type="text" data-k="title" value="${esc(d.title)}" placeholder="${pay ? 'Paid back for tickets' : 'Dinner at Lupa'}" maxlength="${MAX_TITLE}" autocomplete="off">`) +
    field(pay ? 'Amount' : items ? 'Total, from items' : 'Total', `<input type="text" data-k="amount" value="${esc(d.amount)}" placeholder="${fromMinor(0, d.currency)}"${NUMBER}${items ? ' disabled' : ''}>`) +
    field('Currency', `<select data-k="cur">${CURRENCIES.map(c => `<option${c === d.currency ? ' selected' : ''}>${c}</option>`).join('')}</select>`) +
    say('title') + '</div>';
}

function fxHtml(group, d) {
  const cur = esc(d.currency), to = esc(fxBase(group, d));
  if (d.currency === group.currency) return '';
  return '<div class="form__sec fx"><span class="fx__now" data-live="fx"></span>' +
    `<label class="check"><input type="checkbox" data-k="lock"${d.fx ? ' checked' : ''}>Fix the rate for this ${d.kind === 'payment' ? 'payment' : 'bill'}</label>` +
    (d.fx ? `<label class="fx__rate">1 ${cur} = <input type="text" data-k="rate" value="${esc(d.fx.rate)}" aria-label="${to} for 1 ${cur}"${NUMBER}> ${to}</label>` : '') +
    say('fx') + '</div>';
}

function rowsHtml(group, d, key) {
  const side = d[key], mode = side.mode, cur = esc(d.currency);
  const unit = { exact: [cur, cur], percent: ['%', 'percent'], shares: ['1', 'shares'] }[mode];   // [placeholder, word]
  return '<div class="prows">' + group.people.map(p => {
    const on = side.who.includes(p.id), id = esc(p.id), name = esc(p.name);
    const pick = `<input type="${mode === 'single' ? 'radio" name="ed-' + key : 'checkbox'}" data-k="who-${key}-${id}" data-side="${key}" data-pid="${id}"${on ? ' checked' : ''}>`;
    const value = unit
      ? `<input type="text" data-k="val-${key}-${id}" data-val="${key}" data-pid="${id}" value="${on ? esc(side.values[p.id]) : ''}" placeholder="${unit[0]}" aria-label="${name}, ${unit[1]}"${NUMBER}${on ? '' : ' disabled'}>`
      : '<span></span>';
    return `<div class="prow${on ? '' : ' is-off'}"><label>${pick}<span>${name}</span></label>${value}<span class="prow__out" data-out="${key}-${id}"></span></div>`;
  }).join('') + '</div>';
}

function itemsHtml(group, d) {
  const s = d.split, zero = fromMinor(0, d.currency);
  const rows = s.items.map((it, i) => '<div class="item">' +
    `<input type="text" data-k="it-name-${i}" data-item="${i}" data-f="name" value="${esc(it.name)}" placeholder="Item" aria-label="Item ${i + 1}, name" maxlength="${MAX_TITLE}" autocomplete="off">` +
    `<input type="text" class="item__amt" data-k="it-amount-${i}" data-item="${i}" data-f="amount" value="${esc(it.amount)}" placeholder="${zero}" aria-label="Item ${i + 1}, price"${NUMBER}>` +
    `<button type="button" class="x" data-k="it-del-${i}" data-act="item-del" data-item="${i}" aria-label="Remove item ${i + 1}"></button>` +
    `<div class="item__who" role="group" aria-label="Who had item ${i + 1}">` +
    group.people.map(p => `<button type="button" data-k="it-who-${i}-${esc(p.id)}" data-act="item-who" data-item="${i}" data-pid="${esc(p.id)}" aria-pressed="${it.who.includes(p.id)}">${esc(p.name)}</button>`).join('') +
    '</div></div>').join('');
  return `<div class="items">${rows}</div>` +
    `<div><button type="button" class="link" data-k="it-add" data-act="item-add"${s.items.length >= MAX_ITEMS ? ' disabled' : ''}>Add an item</button></div>` +
    '<div class="extras">' + field('Tax %', `<input type="text" data-k="tax" value="${esc(s.tax)}"${NUMBER}>`) + field('Tip %', `<input type="text" data-k="tip" value="${esc(s.tip)}"${NUMBER}>`) + '</div>';
}

function sideHtml(group, d, key) {
  const paid = key === 'paid', items = !paid && d.split.mode === 'items';
  const modes = (paid ? PAID_MODES : SPLIT_MODES).map(([mode, label]) =>
    `<button type="button" data-k="mode-${key}-${mode}" data-act="mode" data-side="${key}" data-mode="${mode}" data-text="${label}" aria-pressed="${d[key].mode === mode}">${label}</button>`).join('');
  return `<div class="form__sec side" role="group" aria-labelledby="ed-${key}"><div class="side__head"><h3 class="title" id="ed-${key}">${paid ? 'Paid by' : 'Split between'}</h3>` +
    `<div class="modes" role="group" aria-label="${paid ? 'How it was paid' : 'How it is split'}">${modes}</div></div>` +
    (items ? itemsHtml(group, d) : rowsHtml(group, d, key)) + say(key) + '</div>';
}

function peopleHtml(group, d) {
  // "Choose" is only offered while nobody of the group is chosen, so the field never shows a person the bill does not have.
  const options = chosen => (group.people.some(p => p.id === chosen) ? '' : '<option value="" selected>Choose</option>') +
    group.people.map(p => `<option value="${esc(p.id)}"${p.id === chosen ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  return '<div class="form__sec fields fields--two">' + field('Who paid', `<select data-k="from">${options(d.from)}</select>`) +
    field('Who got it', `<select data-k="to">${options(d.to)}</select>`) + say('pay') + '</div>';
}

function previewHtml(group, pay) {
  return '<div class="form__sec"><div class="preview">' +
    `<h3 class="title">${pay ? 'What this payment does' : 'What this bill adds'}, in ${esc(group.currency)}</h3>` +
    '<p data-live="reads" hidden></p><ul class="preview__list" data-live="list" hidden></ul><p class="preview__note" data-live="note" hidden></p></div>' +
    '<div class="field"><label class="field__label" for="ed-text">As text</label>' +
    '<textarea class="form__text" id="ed-text" data-k="text" data-live="text" rows="1" readonly aria-describedby="ed-text-note" placeholder="Shown once everything above is filled in."></textarea>' +
    '<p class="small mute" id="ed-text-note">The same bill, the way you could type it under WRITE IT DOWN.</p></div>' +
    say('save') + '<span class="sr" role="status" data-live="confirm"></span></div>';
}

function footHtml(pay, isNew) {
  return '<div class="form__foot">' +
    (isNew ? '' : '<button type="button" class="cell" data-k="delete" data-act="delete">Delete</button><button type="button" class="cell" data-k="duplicate" data-act="duplicate">Duplicate</button>') +
    '<span class="cell cell--grow"></span><button type="button" class="cell" data-k="cancel" data-close>Cancel</button>' +
    `<button type="submit" class="cell cell--solid" data-k="save">Save ${pay ? 'payment' : 'bill'}</button></div>`;
}

// The whole form for a draft. The worked-out parts are left empty: viewOf() has what goes in them.
export function formHtml(group, draft, isNew) {
  const pay = draft.kind === 'payment';
  return '<form class="form" novalidate>' + topHtml(draft, !pay && draft.split.mode === 'items') + fxHtml(group, draft) +
    (pay ? peopleHtml(group, draft) : sideHtml(group, draft, 'paid') + sideHtml(group, draft, 'split')) +
    previewHtml(group, pay) + footHtml(pay, isNew) + '</form>';
}

/* ---------- the dialog ---------- */

let page = null;     // { store, dialog, heading, body }, set once by initEditor
let state = null;    // what is open: { d, isNew, base, opener, homeId, armed, busy, refused }

const find = key => [...page.body.querySelectorAll('[data-k]')].find(el => el.dataset.k === key);
const live = name => page.body.querySelector('[data-live="' + name + '"]');
const noun = () => (state.d.kind === 'payment' ? 'payment' : 'bill');

// still: do not scroll to the field. For putting the focus back where it was.
function focusKey(key, still) {
  const el = find(key);
  if (el) el.focus({ preventScroll: !!still });
  return el;
}

// Fills in the worked-out parts. Fields that are typed in are left alone.
function update() {
  const { body, store } = page, s = state, v = viewOf(store.group, s.d);
  body.querySelectorAll('[data-out]').forEach(el => { el.textContent = v.outs[el.dataset.out] || ''; });
  body.querySelectorAll('[data-say]').forEach(el => {
    const line = el.dataset.say === 'save' ? (s.refused ? { fix: true, text: s.refused } : null) : v.says[el.dataset.say];
    el.hidden = !line;
    el.firstChild.className = line && line.fix ? 'tag tag--fix' : 'tag';
    el.firstChild.textContent = !line ? '' : line.fix ? 'Fix' : 'OK';
    el.lastChild.textContent = line ? line.text : '';
  });
  const show = (name, value) => { const el = live(name); if (el) { el.textContent = value; el.hidden = !value; } };
  show('reads', v.reads);
  show('note', v.note);
  if (live('fx')) live('fx').textContent = v.fx;
  live('list').innerHTML = v.list.map(([words, amount, tail]) => `<li>${esc(words)} <span class="num">${esc(amount)}</span>${esc(tail)}</li>`).join('');
  live('list').hidden = !v.list.length;
  // Where the browser does not size the box to its text, the number of rows is a fair guess.
  live('text').value = v.text;
  live('text').rows = v.text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 48)), 0);
  if (v.total !== null) find('amount').value = v.total;
  find('save').disabled = !v.canSave || s.busy;
  find('save').textContent = s.busy ? 'Getting rates' : 'Save ' + noun();
}

/* Draws the form again and puts the focus, the caret and the scroll position back. If the control that
   had the focus is gone, the focus goes to the one that was just used (`used`, a data-k), or to "Add an
   item" after the last item row was removed. */
function render(used) {
  const { body, store } = page, active = body.contains(document.activeElement) ? document.activeElement : null;
  const key = active ? active.dataset.k : '', caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const top = body.scrollTop;
  state.armed = false;
  body.innerHTML = formHtml(store.group, state.d, state.isNew);
  body.scrollTop = top;
  update();
  const same = key ? focusKey(key, true) : null;
  if (same && caret) same.setSelectionRange(caret[0], caret[1]);
  else if (key && !same && !(used && focusKey(used, true))) focusKey('it-add', true);
}

// DELETE asks for a second press. Anything else done in between calls it off.
function disarm() {
  if (!state || !state.armed) return;
  state.armed = false;
  const button = find('delete');
  if (button) button.textContent = 'Delete';
  live('confirm').textContent = '';
}

// The store said no. Its reason, or a plain line, shows above the buttons until something is changed.
function refuse(what) {
  state.refused = page.store.lastError || 'This ' + noun() + ' could not be ' + what + '.';
  update();
}

function pressDelete(button) {
  if (!state.armed) {
    state.armed = true;
    button.textContent = 'Delete this ' + noun();
    live('confirm').textContent = 'Press again to delete this ' + noun() + '.';
    return;
  }
  if (page.store.deleteBill(state.d.id)) page.dialog.close(); else refuse('deleted');
}

async function save() {
  const { store, dialog } = page, s = state;
  if (!s || s.busy || !viewOf(store.group, s.d).canSave) return;
  if (unpinned(store.group, s.d.currency)) {
    // A currency that is new to the group gets its rate when the bill is saved. With today's rates at
    // hand first, that happens in the same step, and the numbers do not move a moment later.
    s.busy = true;
    update();
    await store.fetchRates();
    s.busy = false;
    if (state !== s || !dialog.open) return;   // closed in the meantime
  }
  const v = viewOf(store.group, s.d), bill = v.bill;
  if (!v.canSave) { update(); return; }
  if (!s.isNew && JSON.stringify(bill) === s.base) { dialog.close(); return; }   // nothing was changed
  if (!bill.id) bill.id = store.newId('e');
  if (!store.saveBill(bill)) { refuse('saved'); return; }
  dialog.close();
  store.ensurePinned();
}

function onInput(e) {
  const t = e.target, d = state && state.d, k = t.dataset.k;
  if (!d) return;
  if (k === 'title' || k === 'amount') d[k] = t.value;
  else if (k === 'rate' && d.fx) d.fx.rate = t.value;
  else if (k === 'tax' || k === 'tip') d.split[k] = t.value;
  else if (t.dataset.val) d[t.dataset.val].values[t.dataset.pid] = t.value;
  else if (t.dataset.f) d.split.items[+t.dataset.item][t.dataset.f] = t.value;
  else return;
  disarm();
  state.refused = '';
  update();
}

function onChange(e) {
  const t = e.target, d = state && state.d, k = t.dataset.k, { store } = page;
  if (!d) return;
  if (k === 'from' || k === 'to') d[k] = t.value;
  else if (k === 'cur') {
    d.currency = t.value;
    delete d.fx;
    if (unpinned(store.group, d.currency)) store.fetchRates();   // so the rates are there when SAVE is pressed
  } else if (k === 'lock') {
    const now = t.checked ? rateFor(store.group, d.currency) : null;
    if (t.checked) d.fx = { rate: now ? fmtRate(now.rate) : '', base: store.group.currency }; else delete d.fx;
  } else if (t.dataset.side) setWho(store.group, d, t.dataset.side, t.dataset.pid, t.checked);
  else return;
  state.refused = '';
  render(k);
}

function onClick(e) {
  const b = e.target.closest('[data-act]'), d = state && state.d, { store } = page;
  if (!d) return;
  const act = b ? b.dataset.act : '', items = d.kind === 'payment' ? [] : d.split.items;
  if (act !== 'delete') disarm();
  if (act === 'delete') pressDelete(b);
  else if (act === 'duplicate') open(duplicateOf(d), true);
  else if (act === 'mode') switchMode(store.group, d, b.dataset.side, b.dataset.mode);
  else if (act === 'item-who') toggleItemWho(store.group, d, +b.dataset.item, b.dataset.pid);
  else if (act === 'item-add') items.push(blankItem());
  else if (act === 'item-del') items.splice(+b.dataset.item, 1, ...(items.length === 1 ? [blankItem()] : []));
  if (!act || act === 'delete' || act === 'duplicate') return;
  state.refused = '';
  render(b.dataset.k);
  if (act === 'item-add') focusKey('it-name-' + (items.length - 1));
}

// Enter in an item row goes on to the next field of the list, with a new row at the end. It does not save.
function onKey(e) {
  const t = e.target, items = state && state.d.kind !== 'payment' ? state.d.split.items : null;
  if (e.key !== 'Enter' || e.isComposing || !items || t.nodeName !== 'INPUT' || t.dataset.item == null) return;
  e.preventDefault();
  const i = +t.dataset.item;
  if (t.dataset.f === 'name') { focusKey('it-amount-' + i); return; }
  if (i === items.length - 1) {
    if (items.length >= MAX_ITEMS) return;
    items.push(blankItem());
    render();
  }
  focusKey('it-name-' + (i + 1));
}

// The group changed under the open form: an undo, another tab, rates that came in, or the editor's own save.
function onStore() {
  const { store, dialog } = page;
  if (!state || !dialog.open) return;
  if (store.readOnly || (!state.isNew && !store.group.expenses.some(bill => bill.id === state.d.id))) dialog.close();
  else render();
}

/* The browser gives the focus back to what opened the dialog. After a save the bills table is drawn again
   and that row's button is a new one, so the focus goes to the row of the same bill, or to the button
   that adds one. */
function onClose() {
  const s = state;
  state = null;
  page.body.innerHTML = '';
  if (!s) return;
  const row = [...document.querySelectorAll('#bills-body tr')].find(tr => tr.dataset.id && tr.dataset.id === s.homeId);
  const back = s.opener && s.opener.isConnected && s.opener !== document.body ? s.opener
    : (row && row.querySelector('button')) || document.getElementById(s.d.kind === 'payment' ? 'payment-new' : 'bill-new');
  if (back) back.focus();
}

function open(d, isNew) {
  const { store, dialog, heading, body } = page, was = state;
  state = { d, isNew, base: isNew ? '' : JSON.stringify(cleanBill(store.group, d)),
    opener: was ? was.opener : document.activeElement, homeId: was ? was.homeId : d.id, armed: false, busy: false, refused: '' };
  heading.textContent = (isNew ? 'New ' : 'Edit ') + noun();
  render();
  if (!dialog.open) dialog.showModal();
  body.scrollTop = 0;
  if (isNew) focusKey('title');
  if (unpinned(store.group, d.currency)) store.fetchRates();
}

// bill: one of the group's bills, or null for a new one. kind: 'expense' or 'payment', for a new one.
export function openEditor(bill, kind) {
  if (!page) return;
  const { store } = page, g = store.group;
  open(bill ? draftOf(g, bill) : kind === 'payment' ? newPayment(g, store.me) : newExpense(g, store.me), !bill);
}

export function initEditor(store) {
  const dialog = document.getElementById('editor'), body = document.getElementById('editor-body');
  page = { store, dialog, body, heading: document.getElementById('editor-title') };
  state = null;
  body.addEventListener('input', onInput);
  body.addEventListener('change', onChange);
  body.addEventListener('click', onClick);
  body.addEventListener('keydown', onKey);
  body.addEventListener('focusout', e => { if (e.target.dataset && e.target.dataset.k === 'delete') disarm(); });
  body.addEventListener('submit', e => { e.preventDefault(); save(); });
  dialog.addEventListener('close', onClose);
  store.subscribe(onStore);
}
