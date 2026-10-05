/* Pay Me Back core: money as whole minor units, currencies, exchange-rate lookup and bill math.
   Pure functions, no DOM. Anything that needs the group takes it as its first parameter.
   Every message returned here is plain text: escape it (or use textContent) before showing it. */

function deepFreeze(o) {
  Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(o);
}

/* ---------- currencies and built-in rates ---------- */

// Units per 1 USD on the date below. Used only when a group has no pinned or typed rate.
export const BUILTIN_RATES = deepFreeze({
  date: '2026-10-04',
  source: 'open.er-api.com',
  usd: { USD: 1, EUR: 0.888786, GBP: 0.756408, CAD: 1.423858, AUD: 1.439669, NZD: 1.781468, CHF: 0.828528,
    SGD: 1.279373, HKD: 7.846913, CNY: 6.72008, INR: 96.34955, MXN: 18.214153, BRL: 5.220525, ZAR: 16.660331,
    SEK: 10.044451, NOK: 9.623182, DKK: 6.64695, PLN: 3.890174, AED: 3.6725, THB: 33.564342, MYR: 4.084171,
    PHP: 62.599186, JPY: 157.820352, KRW: 1348.606131, TWD: 31.854061, IDR: 17888.613936, VND: 25939.856369,
    TRY: 49.136571, ILS: 3.053144, CZK: 21.726446, HUF: 327.477491 }
});

export const CURRENCIES = Object.freeze(Object.keys(BUILTIN_RATES.usd));

/* ---------- small helpers ---------- */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESCAPES[c]);
}

export function uid(prefix) {
  let s = '';
  // One random number can print as fewer than 7 base36 digits, so keep adding until there are enough.
  while (s.length < 7) s += Math.random().toString(36).slice(2);
  return (prefix || 'x') + '-' + s.slice(0, 7);
}

// Lenient: keeps digits, dots and minus signs, drops the rest. Anything unreadable is 0.
export function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function personName(group, id) {
  const p = (group.people || []).find(x => x.id === id);
  return p ? p.name : '?';
}

// ['A', 'B', 'C'] -> 'A, B and C'
export function listJoin(arr) {
  return arr.length <= 1 ? arr.join('') : arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
}

export function sumMap(map) {
  let s = 0;
  map.forEach(v => { s += v; });
  return s;
}

/* ---------- money ---------- */

const digitCache = new Map();
const NO_DECIMALS = ['JPY', 'KRW', 'VND'];

/* How many decimals a currency has: 2 for USD, 0 for JPY. For the currencies this page offers, the answer
   is written down here and not asked of the device, so that friends who open the same link split every bill
   in the same units whatever browser they use. */
export function minorDigits(code) {
  if (CURRENCIES.includes(code)) return NO_DECIMALS.includes(code) ? 0 : 2;
  let d = digitCache.get(code);
  if (d === undefined) {
    try { d = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits; }
    catch { d = 2; }
    if (!Number.isInteger(d) || d < 0) d = 2;
    digitCache.set(code, d);
  }
  return d;
}

export function toMinor(v, code) {
  return Math.round(num(v) * 10 ** minorDigits(code)) + 0;   // + 0 turns -0 into 0
}

// 12345, 'USD' -> '123.45'. Always the currency's own number of decimals, no grouping.
export function fromMinor(m, code) {
  const d = minorDigits(code), n = Number.isFinite(m) ? Math.round(m) : 0;
  const s = String(Math.abs(n)).padStart(d + 1, '0');
  return (n < 0 ? '-' : '') + (d ? s.slice(0, -d) + '.' + s.slice(-d) : s);
}

// 12000, 'EUR' -> '120.00 EUR'. The same in every locale, for messages and for text people can type back.
export function plainMoney(minor, code) {
  return fromMinor(minor, code) + ' ' + code;
}

const moneyFormats = new Map();

export function formatMoney(minor, code, locale) {
  const d = minorDigits(code), key = (locale || '') + '|' + code;
  let f = moneyFormats.get(key);
  if (f === undefined) {
    // The digits are set here so the display always matches the units the math uses.
    try { f = new Intl.NumberFormat(locale || undefined, { style: 'currency', currency: code, minimumFractionDigits: d, maximumFractionDigits: d }); }
    catch { f = null; }
    moneyFormats.set(key, f);
  }
  return f ? f.format(minor / 10 ** d) : code + ' ' + fromMinor(minor, code);
}

/* Split `total` minor units across [id, weight] pairs. Each gets the whole part of its exact share; the
   units left over go one each to the largest fractions (earlier entries win ties), so it always sums exactly. */
export function allocate(total, entries) {
  const out = new Map();
  const sumW = entries.reduce((s, e) => s + e[1], 0);
  entries.forEach(e => out.set(e[0], 0));
  if (sumW <= 0 || total === 0) return out;
  let given = 0;
  const rem = [];
  entries.forEach((e, i) => {
    const exact = total * e[1] / sumW, f = Math.floor(exact);
    out.set(e[0], f); given += f; rem.push([exact - f, i, e[0]]);
  });
  rem.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < total - given; k++) { const id = rem[k % rem.length][2]; out.set(id, out.get(id) + 1); }
  return out;
}

/* ---------- exchange rates ---------- */

const baseOf = group => (group && group.currency) || 'USD';
const goodRate = x => typeof x === 'number' && x > 0 && Number.isFinite(x);

// `usd` holds units per 1 USD. Returns how many `to` one `from` is worth, or null.
const crossRate = (usd, from, to) => {
  const per = c => (c === 'USD' ? 1 : Object.hasOwn(usd, c) ? usd[c] : null);
  const x = per(from), y = per(to);
  return goodRate(x) && goodRate(y) && goodRate(y / x) ? y / x : null;
};

// The rate nobody typed: from the group's pinned table, else the built-in one. 1 code = rate group.currency.
export function tableRate(group, code) {
  const base = baseOf(group);
  for (const [table, source] of [[group.fx, 'pinned'], [BUILTIN_RATES, 'builtin']]) {
    const rate = table && table.usd && typeof table.usd === 'object' ? crossRate(table.usd, code, base) : null;
    if (rate) return { rate, source, date: table.date };
  }
  return null;
}

// 1 code = rate group.currency. A rate typed for the group wins over the tables.
export function rateFor(group, code) {
  const base = baseOf(group);
  if (code === base) return { rate: 1, source: 'same' };
  const typed = (group.rates || {})[code];
  if (typed && typed.base === base && num(typed.rate) > 0) return { rate: num(typed.rate), source: 'manual' };
  return tableRate(group, code);
}

// The rate one bill converts at. A rate fixed on the bill wins; if it was fixed against another
// currency than the group's, it is carried over to the group's currency with rateFor.
export function billRate(group, bill) {
  const base = baseOf(group), cur = bill.currency || base;
  if (cur === base) return { rate: 1, source: 'same' };
  if (bill.fx && num(bill.fx.rate) > 0) {
    const bridge = rateFor(group, bill.fx.base || base);
    if (bridge && goodRate(num(bill.fx.rate) * bridge.rate)) return { rate: num(bill.fx.rate) * bridge.rate, source: 'fixed' };
  }
  return rateFor(group, cur) || { rate: null };
}

/* A rate with enough digits to check a converted amount by hand: six significant digits, and never fewer
   than four decimals. 1.12513023 -> '1.12513', 1.5 -> '1.5000', 157.820352 -> '157.8204',
   0.0063363184 -> '0.00633632'. */
export function fmtRate(r) {
  const digits = Math.min(12, Math.max(4, 5 - Math.floor(Math.log10(r))));
  return r.toFixed(digits).replace(/(\.\d{4}\d*?)0+$/, '$1');
}

// '2026-10-04' -> '4 Oct 2026' in the reader's locale.
export function fmtDate(iso, locale) {
  const d = new Date(iso + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return String(iso == null ? '' : iso);
  try { return d.toLocaleDateString(locale || undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
  catch { return String(iso); }
}

// The rate behind a converted bill, in words: '1 EUR = 1.12513 USD, rate from 4 Oct 2026'. '' when nothing was converted.
export function fxNote(group, r, locale) {
  if (!r.rate || r.rateSource === 'same') return '';
  const when = r.rateDate ? ' from ' + fmtDate(r.rateDate, locale) : '';
  const words = r.rateSource === 'fixed' ? 'rate set for this bill'
    : r.rateSource === 'manual' ? 'rate typed for this group'
    : r.rateSource === 'pinned' ? 'rate' + when
    : 'built-in rate' + when;
  return '1 ' + r.cur + ' = ' + fmtRate(r.rate) + ' ' + baseOf(group) + ', ' + words;
}

/* ---------- bill math ---------- */

// Above these, floating point could no longer promise exact sums, so the bill is refused instead.
const MAX_MINOR = 1e13;
const MAX_WEIGHT = 1e9;
const TOO_LARGE = 'That amount is too large.';

const PAID_MODES = ['single', 'equal', 'exact', 'percent', 'shares'];
const SPLIT_MODES = ['equal', 'exact', 'percent', 'shares'];

// The people of a list who are still in the group, each once.
const known = (ids, who) => [...new Set(Array.isArray(who) ? who : [])].filter(id => ids.has(id));

/* One side of a bill (who paid, or who shares) as a Map id -> minor units of the bill's currency.
   Returns { map } or { err }; 'exact' returns both so a preview can show what is filled in so far. */
function sideMap(ids, side, total, label, cur) {
  const paid = label === 'paid';
  const who = known(ids, side.who);
  const vals = side.values || {};
  if (!(paid ? PAID_MODES : SPLIT_MODES).includes(side.mode)) return { err: paid ? 'Choose how it was paid.' : 'Choose how to split it.' };
  if (!who.length) return { err: paid ? 'Choose who paid.' : 'Choose who shares it.' };
  if (side.mode === 'single') return { map: allocate(total, [[who[0], 1]]) };
  if (side.mode === 'equal') return { map: allocate(total, who.map(id => [id, 1])) };
  if (side.mode === 'exact') {
    const map = new Map(who.map(id => [id, Math.max(0, toMinor(vals[id], cur))]));
    const sum = sumMap(map);
    if (sum === total) return { map };
    const start = (paid ? 'The amounts paid add up to ' : 'The amounts add up to ') + plainMoney(sum, cur) + '. The total is ' + plainMoney(total, cur);
    return { map, err: start + (sum < total ? ', so ' + plainMoney(total - sum, cur) + ' is left to assign.' : ', so that is ' + plainMoney(sum - total, cur) + ' too much.') };
  }
  const entries = who.map(id => [id, Math.max(0, num(vals[id]))]);
  const sum = entries.reduce((s, e) => s + e[1], 0);
  if (side.mode === 'percent') {
    if (Math.abs(sum - 100) > 0.001) return { err: 'The percents add up to ' + +sum.toFixed(3) + '%. They need to make 100%.' };
    return { map: allocate(total, entries) };
  }
  if (sum <= 0) return { err: 'Give at least one person a share.' };
  if (entries.some(e => e[1] > MAX_WEIGHT)) return { err: 'Use smaller numbers for the shares.' };
  return { map: allocate(total, entries), note: +sum.toFixed(3) + ' shares in total' };
}

// Items mode: each item is split equally between its people, then tax and tip follow what each person ordered.
function itemsSide(ids, split, cur) {
  const sub = new Map();
  let subtotal = 0, err = null;
  (Array.isArray(split.items) ? split.items : []).forEach((item, i) => {
    const it = item || {};
    const c = toMinor(it.amount, cur), who = known(ids, it.who);
    if (c <= 0 && !who.length) return;   // an empty row
    if (c <= 0) { err = err || 'Item ' + (i + 1) + ' needs a price.'; return; }
    if (!who.length) { err = err || '"' + (it.name || 'Item ' + (i + 1)) + '" needs at least one person.'; return; }
    if (c > MAX_MINOR) { err = err || TOO_LARGE; return; }
    allocate(c, who.map(id => [id, 1])).forEach((v, id) => sub.set(id, (sub.get(id) || 0) + v));
    subtotal += c;
  });
  if (!err && subtotal <= 0) err = 'Add at least one item.';
  let extra = Math.round(subtotal * (Math.max(0, num(split.tax)) + Math.max(0, num(split.tip))) / 100);
  if (!(subtotal + extra <= MAX_MINOR)) { err = err || TOO_LARGE; extra = 0; }
  const share = allocate(extra, [...sub]);
  const map = new Map([...sub].map(([id, v]) => [id, v + share.get(id)]));
  return { map, subtotal, extra, err };
}

/* amount x rate, moved from a currency with `dFrom` decimals to one with `dTo`, rounded half up.
   Done in whole numbers on the rate's shortest decimal form (the digits a person typed), because floating
   point would round an exact half unit the wrong way now and then. */
function convertMinor(amount, rate, dFrom, dTo) {
  const [digits, exp] = rate.toExponential().split('e');
  const mantissa = digits.replace('.', '');
  const shift = Number(exp) - (mantissa.length - 1) + dTo - dFrom;   // result = amount x mantissa x 10^shift
  const n = BigInt(amount) * BigInt(mantissa);
  if (shift >= 0) return Number(n * 10n ** BigInt(shift));
  const div = 10n ** BigInt(-shift);
  return Number((n + div / 2n) / div);
}

/* Turn a bill worked out in its own currency into the group's currency. The total is converted once, then
   paid and owed are shared out again from the original amounts so both still sum exactly to it. */
function convert(group, bill, r) {
  const base = baseOf(group), fx = billRate(group, bill);
  if (!fx.rate) {
    r.err = r.errFx = 'No exchange rate for ' + r.cur + ' to ' + base + '. Type one under GROUP.';
    return false;
  }
  const same = fx.source === 'same';
  const total = same ? r.totalOrig : convertMinor(r.totalOrig, fx.rate, minorDigits(r.cur), minorDigits(base));
  if (!(total <= MAX_MINOR)) { r.err = r.errFx = TOO_LARGE; return false; }
  r.rate = fx.rate; r.rateSource = fx.source; r.rateDate = fx.date;
  r.total = total;
  r.paid = same ? new Map(r.paidOrig) : allocate(total, [...r.paidOrig]);
  r.owed = same ? new Map(r.owedOrig) : allocate(total, [...r.owedOrig]);
  return true;
}

/* Work out one bill. While `err` is set the group-currency fields stay empty (total 0, no paid, owed or
   edges); the ...Orig fields still hold whatever could be worked out, so an editor can show a preview. */
export function computeExpense(group, bill) {
  const cur = bill.currency || baseOf(group);
  const ids = new Set((group.people || []).map(p => p.id));
  const r = { cur, rate: null, rateSource: undefined, rateDate: undefined,
    total: 0, paid: new Map(), owed: new Map(),
    totalOrig: 0, paidOrig: new Map(), owedOrig: new Map(),
    edges: [], subtotal: undefined, extra: undefined, splitNote: undefined,
    err: null, errPaid: null, errSplit: null, errFx: null, errTitle: null };

  if (bill.kind === 'payment') {
    const amount = toMinor(bill.amount, cur);
    if (!ids.has(bill.from) || !ids.has(bill.to)) r.errPaid = 'Choose who paid whom.';
    else if (bill.from === bill.to) r.errPaid = 'Pick two different people.';
    else if (amount <= 0) r.errSplit = 'Enter an amount.';
    else if (amount > MAX_MINOR) r.errSplit = TOO_LARGE;
    r.err = r.errPaid || r.errSplit;
    if (r.err) return r;
    r.totalOrig = amount;
    r.paidOrig.set(bill.from, amount);
    r.owedOrig.set(bill.to, amount);
    // "from paid to" shows up as `to` owing `from`, which cancels against what `from` owes.
    if (convert(group, bill, r) && r.total > 0) r.edges.push([bill.to, bill.from, r.total]);
    return r;
  }

  const split = bill.split || {};
  if (split.mode === 'items') {
    const it = itemsSide(ids, split, cur);
    r.owedOrig = it.map; r.subtotal = it.subtotal; r.extra = it.extra;
    r.totalOrig = it.subtotal + it.extra;
    r.errSplit = it.err;
  } else {
    const amount = toMinor(bill.amount, cur);
    if (amount <= 0) r.errSplit = 'Enter the total.';
    else if (amount > MAX_MINOR) r.errSplit = TOO_LARGE;
    else {
      const side = sideMap(ids, split, amount, 'split', cur);
      r.totalOrig = amount;
      r.errSplit = side.err || null;
      if (side.map) r.owedOrig = side.map;
      r.splitNote = side.note;
    }
  }
  if (r.totalOrig > 0) {
    const side = sideMap(ids, bill.paid || {}, r.totalOrig, 'paid', cur);
    r.errPaid = side.err || null;
    if (side.map) r.paidOrig = side.map;
  } else if (!r.errSplit) r.errSplit = 'Enter the total.';
  // A missing name does not stop the math, so it is not part of `err`. The editor checks it before saving.
  if (!String(bill.title == null ? '' : bill.title).trim()) r.errTitle = 'Give the bill a name.';
  r.err = r.errSplit || r.errPaid;
  if (r.err || !convert(group, bill, r)) return r;

  /* Each person's share is owed to the payers in proportion to what each payer put in. The shares are
     taken one after the other, and what a payer has been promised so far is counted off before the next
     share is divided. So no cent is lost to rounding: every payer is owed exactly what they paid, and
     every person owes exactly their share. */
  const left = new Map([...r.paid].filter(([, v]) => v > 0));
  r.owed.forEach((share, debtor) => {
    if (share <= 0) return;
    allocate(share, [...left]).forEach((amt, payer) => {
      left.set(payer, left.get(payer) - amt);
      if (payer !== debtor && amt > 0) r.edges.push([debtor, payer, amt]);
    });
  });
  return r;
}

// What each person paid and what their share is, in the group's currency. Bills with a problem are left out.
export function personTotals(group) {
  const totals = new Map((group.people || []).map(p => [p.id, { paid: 0, share: 0 }]));
  for (const bill of group.expenses || []) {
    const r = computeExpense(group, bill);
    if (r.err) continue;
    r.paid.forEach((v, id) => { totals.get(id).paid += v; });
    r.owed.forEach((v, id) => { totals.get(id).share += v; });
  }
  return totals;
}

// Currencies on the bills other than the group's own, in the order they first appear.
export function usedCurrencies(group) {
  const base = baseOf(group), out = [];
  for (const bill of group.expenses || []) {
    const c = bill.currency || base;
    if (c !== base && !out.includes(c)) out.push(c);
  }
  return out;
}

/* ---------- the built-in example ---------- */

// Frozen. Callers take a copy with structuredClone before changing anything.
export const EXAMPLE_GROUP = deepFreeze({
  id: 'g-lisbon',
  name: 'Lisbon trip (example)',
  currency: 'USD',
  rev: 0,
  example: true,
  people: [
    { id: 'p-ana', name: 'Ana' },
    { id: 'p-ben', name: 'Ben' },
    { id: 'p-cy', name: 'Cy' },
    { id: 'p-dee', name: 'Dee' },
    { id: 'p-eli', name: 'Eli' }
  ],
  expenses: [
    { id: 'e-1', kind: 'expense', title: 'Apartment in Alfama', amount: '780', currency: 'EUR',
      paid: { mode: 'exact', who: ['p-ana', 'p-ben'], values: { 'p-ana': '520', 'p-ben': '260' } },
      split: { mode: 'equal', who: ['p-ana', 'p-ben', 'p-cy', 'p-dee', 'p-eli'], values: {}, items: [], tax: '', tip: '' } },
    { id: 'e-2', kind: 'expense', title: 'Groceries', amount: '210', currency: 'EUR',
      paid: { mode: 'single', who: ['p-cy'], values: {} },
      split: { mode: 'shares', who: ['p-ana', 'p-ben', 'p-cy', 'p-dee'],
        values: { 'p-ana': '1', 'p-ben': '1', 'p-cy': '1', 'p-dee': '2' }, items: [], tax: '', tip: '' } },
    { id: 'e-3', kind: 'expense', title: 'Dinner at the taberna', amount: '', currency: 'EUR',
      paid: { mode: 'single', who: ['p-dee'], values: {} },
      split: { mode: 'items', who: [], values: {},
        items: [
          { name: 'Bacalhau', amount: '38', who: ['p-ben'] },
          { name: 'Grilled sardines', amount: '22', who: ['p-cy'] },
          { name: 'Shared petiscos', amount: '30', who: ['p-ana', 'p-eli'] },
          { name: 'Vinho verde', amount: '52', who: ['p-ana', 'p-ben', 'p-dee'] }
        ],
        tax: '', tip: '10' } },
    { id: 'e-4', kind: 'expense', title: 'Surf lessons', amount: '480', currency: 'USD',
      paid: { mode: 'single', who: ['p-eli'], values: {} },
      split: { mode: 'percent', who: ['p-ana', 'p-ben', 'p-cy', 'p-dee'],
        values: { 'p-ana': '25', 'p-ben': '25', 'p-cy': '25', 'p-dee': '25' }, items: [], tax: '', tip: '' } },
    { id: 'e-5', kind: 'expense', title: 'Train to Sintra', amount: '78', currency: 'EUR',
      paid: { mode: 'percent', who: ['p-ben', 'p-cy'], values: { 'p-ben': '50', 'p-cy': '50' } },
      split: { mode: 'equal', who: ['p-ana', 'p-ben', 'p-cy'], values: {}, items: [], tax: '', tip: '' } },
    { id: 'e-6', kind: 'payment', title: 'Cy paid Ana back', amount: '50', currency: 'USD', from: 'p-cy', to: 'p-ana' }
  ],
  rates: {}
});
