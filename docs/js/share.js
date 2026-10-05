/* Pay Me Back sharing: a whole group packed into a link, and the gate that checks everything that
   comes in from outside. Pure functions, no DOM. Every message thrown here is plain text for the reader. */

import { CURRENCIES, uid } from './core.js';

const MAX_PEOPLE = 200;
const MAX_BILLS = 2000;
const MAX_ITEMS = 100;
const MAX_GROUP_NAME = 60;
const MAX_PERSON_NAME = 40;
const MAX_TITLE = 80;                       // bill titles and item names
const MAX_BYTES = 1 << 20;                  // 1 MB: the most a link may unpack to
const MAX_LINK = Math.ceil(MAX_BYTES / 3) * 4 + 1024;   // a longer link cannot be within MAX_BYTES

const NOT_A_GROUP = 'This does not look like a group.';
const NO_GROUP = 'This link does not hold a group.';
const DAMAGED = 'This link is damaged or was cut short. Ask for it to be sent again.';
const TOO_BIG = 'This link holds more than this page can open.';
const NEWER = 'This link was made with a newer version of this page. Reload the page and try again.';
const OLD_BROWSER = 'This browser is too old to open this link. Try a newer one.';

// An error whose message was written for the reader.
class ShareError extends Error {}

const fail = message => { throw new ShareError(message); };

/* ---------- the gate ----------

   sanitizeGroup never keeps or copies what it is given. It reads the fields it knows (own fields only),
   checks each one and writes a new group, so unknown keys, __proto__ and the like cannot come through.

   Refused with a message: not an object; no list of people; bills that are not a list; a currency (the
   group's or a bill's) that is not in CURRENCIES; more than 200 people, 2000 bills or 100 items on a bill
   (cutting a list short would change what people owe without saying so).

   Cleaned without a word:
   - Text: anything but a string counts as empty. Control characters and marks that flip the reading
     direction become spaces; the ends are trimmed; it is cut to 60 (group), 40 (person) or 80 (title,
     item). HTML stays as typed: showing it safely is the page's job. A missing name becomes 'Group', or
     'Person 3' by place in the list, so bills keep that person.
   - Typed numbers: read the way core.js num() reads them ('1,200.50' -> '1200.50', '$45' -> '45'), so a
     bill works out the same on both ends. Negative, NaN, Infinity, over 15 digits before the dot or over
     64 characters become '', and the bill shows as one to fix.
   - Ids: one small letter, a dash, 1 to 12 small letters or digits, used once in the group. Any other id
     is replaced. Bills find people by the id as written, so they follow a replaced id; of two people
     written with one id, the first owns it.
   - People on a bill who are not in the group are removed, and nobody is listed twice.
   - An unknown way to pay or split is not guessed: that side comes back with nobody chosen.
   - Entries that are not objects, and item rows with nothing in them, are skipped. A bill is never
     dropped. A bill that is not marked as a payment is an expense, as in core.js.
   - Rates that cannot be used (on a bill, typed, pinned) are left out; core.js would ignore them too.
     A pinned table needs a real date, and USD in it is 1.
   - rev: a whole number from 0 up, else 0. example: only ever true. */

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);

const ID = /^[a-z]-[a-z0-9]{1,12}$/;
const validId = v => typeof v === 'string' && v.length <= 14 && ID.test(v);
const isCurrency = v => typeof v === 'string' && CURRENCIES.includes(v);

const unknownCurrency = code => (typeof code === 'string' && /^[A-Za-z]{3}$/.test(code)
  ? 'This page does not know the currency ' + code + '.'
  : 'This page does not know a currency used here.');

// Control characters, line breaks, and the marks that flip the direction text is read in.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const HALF_PAIR = /^[\ud800-\udfff]$/;

// One line of text of at most `max` characters, or ''. The cut never leaves half an emoji behind.
function text(v, max) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v.slice(0, max * 4).replace(UNSAFE, ' ').trim()) {
    if (out.length + ch.length > max) break;
    if (!HALF_PAIR.test(ch)) out += ch;
  }
  return out.trimEnd();
}

const DECIMAL = /^(?:\d{1,15}(?:\.\d*)?|\.\d+)$/;

// A typed number as a plain decimal, or ''. Read as core.js num() reads it: everything but digits, dots
// and minus signs is dropped, then the number at the front counts.
function decimal(v) {
  if (typeof v === 'number') return v >= 0 && DECIMAL.test(String(v)) ? String(v) : '';
  if (typeof v !== 'string' || v.length > 64) return '';
  const front = /^(?:\d+\.?\d*|\.\d+)/.exec(v.replace(/[^0-9.\-]/g, ''));
  return front && DECIMAL.test(front[0]) ? front[0] : '';
}

function freshId(prefix, taken) {
  let id;
  do id = uid(prefix); while (taken.has(id));
  taken.add(id);
  return id;
}

// A well-formed id that nothing else has is kept, any other is replaced. Kept ids are noted first, so a
// new id cannot clash with one further down the list.
function cleanIds(raws, prefix, taken) {
  const keep = raws.map(raw => {
    if (!validId(raw) || taken.has(raw)) return false;
    taken.add(raw);
    return true;
  });
  return raws.map((raw, i) => (keep[i] ? raw : freshId(prefix, taken)));
}

// The entries of a list that are objects. More than `max` of them is refused.
function objectsIn(list, max, tooMany) {
  const rows = [];
  for (const row of list) {
    if (!isObj(row)) continue;
    if (rows.length === max) fail(tooMany);
    rows.push(row);
  }
  return rows;
}

// Returns the people and `idOf`: the id as written -> the id that person has now. Bills are read through it.
function cleanPeople(list, taken) {
  const rows = objectsIn(list, MAX_PEOPLE, 'This group has too many people. The limit is ' + MAX_PEOPLE + '.');
  const raws = rows.map(row => own(row, 'id'));
  const ids = cleanIds(raws, 'p', taken);
  const idOf = new Map();
  raws.forEach((raw, i) => { if (typeof raw === 'string' && raw && !idOf.has(raw)) idOf.set(raw, ids[i]); });
  const people = rows.map((row, i) => ({ id: ids[i], name: text(own(row, 'name'), MAX_PERSON_NAME) || 'Person ' + (i + 1) }));
  return { people, idOf };
}

// The people of a list who are in the group, each once, in the order given.
function cleanWho(v, idOf) {
  const out = new Set();
  if (Array.isArray(v)) for (const raw of v) { const id = idOf.get(raw); if (id) out.add(id); }
  return [...out];
}

// The number typed next to each person, in the order of the people list. Empty ones are left out.
function cleanValues(v, idOf) {
  const out = {};
  if (isObj(v)) idOf.forEach((id, raw) => { const s = decimal(own(v, raw)); if (s) out[id] = s; });
  return out;
}

function cleanItems(v, idOf) {
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const row of v) {
    if (!isObj(row)) continue;
    const item = { name: text(own(row, 'name'), MAX_TITLE), amount: decimal(own(row, 'amount')), who: cleanWho(own(row, 'who'), idOf) };
    if (!item.name && !item.amount && !item.who.length) continue;   // a row with nothing in it
    if (out.length === MAX_ITEMS) fail('A bill has too many items. The limit is ' + MAX_ITEMS + '.');
    out.push(item);
  }
  return out;
}

const PAID_MODES = ['single', 'equal', 'exact', 'percent', 'shares'];
const SPLIT_MODES = ['equal', 'exact', 'percent', 'shares', 'items'];

function cleanPaid(v, idOf) {
  const mode = isObj(v) ? own(v, 'mode') : undefined;
  if (!PAID_MODES.includes(mode)) return { mode: 'single', who: [], values: {} };
  return { mode, who: cleanWho(own(v, 'who'), idOf), values: cleanValues(own(v, 'values'), idOf) };
}

function cleanSplit(v, idOf) {
  const mode = isObj(v) ? own(v, 'mode') : undefined;
  if (!SPLIT_MODES.includes(mode)) return { mode: 'equal', who: [], values: {}, items: [], tax: '', tip: '' };
  return { mode, who: cleanWho(own(v, 'who'), idOf), values: cleanValues(own(v, 'values'), idOf),
    items: cleanItems(own(v, 'items'), idOf), tax: decimal(own(v, 'tax')), tip: decimal(own(v, 'tip')) };
}

// A rate fixed on one bill: 1 of the bill's currency = rate x base. No base means the group's currency.
function cleanBillRate(v, groupCurrency) {
  if (!isObj(v)) return null;
  const rate = decimal(own(v, 'rate')), base = own(v, 'base') || groupCurrency;
  return Number(rate) > 0 && isCurrency(base) ? { rate, base } : null;
}

function cleanBill(raw, id, groupCurrency, idOf) {
  const currency = own(raw, 'currency') || groupCurrency;
  if (!isCurrency(currency)) fail(unknownCurrency(currency));
  const payment = own(raw, 'kind') === 'payment';
  const bill = { id, kind: payment ? 'payment' : 'expense', title: text(own(raw, 'title'), MAX_TITLE),
    amount: decimal(own(raw, 'amount')), currency };
  const fx = cleanBillRate(own(raw, 'fx'), groupCurrency);
  if (fx) bill.fx = fx;
  if (payment) {
    bill.from = idOf.get(own(raw, 'from')) || '';
    bill.to = idOf.get(own(raw, 'to')) || '';
  } else {
    bill.paid = cleanPaid(own(raw, 'paid'), idOf);
    bill.split = cleanSplit(own(raw, 'split'), idOf);
  }
  return bill;
}

function cleanBills(list, groupCurrency, idOf, taken) {
  const rows = objectsIn(list, MAX_BILLS, 'This group has too many bills. The limit is ' + MAX_BILLS + '.');
  const ids = cleanIds(rows.map(row => own(row, 'id')), 'e', taken);
  return rows.map((row, i) => cleanBill(row, ids[i], groupCurrency, idOf));
}

// Rates typed for the group: 1 code = rate x base.
function cleanRates(v) {
  const out = {};
  if (!isObj(v)) return out;
  for (const code of CURRENCIES) {
    const row = own(v, code);
    if (!isObj(row)) continue;
    const rate = decimal(own(row, 'rate')), base = own(row, 'base');
    if (Number(rate) > 0 && isCurrency(base) && base !== code) out[code] = { rate, base };
  }
  return out;
}

// '2026-10-04', and a day that exists.
function isDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(v + 'T00:00:00Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

// The pinned table: units of each currency per 1 USD on a date.
function cleanPinned(v) {
  if (!isObj(v)) return null;
  const date = own(v, 'date'), table = own(v, 'usd');
  if (!isDate(date) || !isObj(table)) return null;
  const usd = {};
  for (const code of CURRENCIES) {
    const n = own(table, code);
    if (typeof n === 'number' && n > 0 && Number.isFinite(n)) usd[code] = code === 'USD' ? 1 : n;
  }
  return Object.keys(usd).length ? { date, usd } : null;
}

const cleanRev = v => (typeof v === 'number' && v >= 0 && v <= 8.64e15 ? Math.floor(v) : 0);

export function sanitizeGroup(obj) {
  if (!isObj(obj)) fail(NOT_A_GROUP);
  const rawPeople = own(obj, 'people'), rawBills = own(obj, 'expenses') ?? [];
  if (!Array.isArray(rawPeople) || !Array.isArray(rawBills)) fail(NOT_A_GROUP);
  const currency = own(obj, 'currency');
  if (!isCurrency(currency)) fail(unknownCurrency(currency));

  const taken = new Set();   // every id in the group, so no two things share one
  const [id] = cleanIds([own(obj, 'id')], 'g', taken);
  const { people, idOf } = cleanPeople(rawPeople, taken);
  const group = { id, name: text(own(obj, 'name'), MAX_GROUP_NAME) || 'Group', currency, rev: cleanRev(own(obj, 'rev')) };
  if (own(obj, 'example') === true) group.example = true;
  group.people = people;
  group.expenses = cleanBills(rawBills, currency, idOf, taken);
  group.rates = cleanRates(own(obj, 'rates'));
  const fx = cleanPinned(own(obj, 'fx'));
  if (fx) group.fx = fx;
  return group;
}

// Both go through the gate first, so copies that differ only in clutter count as the same.
const contentOf = group => {
  const clean = sanitizeGroup(group);
  clean.rev = 0;
  delete clean.example;
  return JSON.stringify(clean);
};

export function sameContent(a, b) {
  try { return contentOf(a) === contentOf(b); }
  catch { return false; }
}

/* ---------- the packed form, version 1 (links that start with 'v1.' or 'u1.') ----------

   One JSON array. People are named by their place in the people list. Empty slots ('' or []) at the end
   of any array are left out.

     group    [id, name, currency, rev, people, bills, typed, pinned, example]
     people   [[id, name], ...]
     expense  [id, title, amount, PAID, SPLIT, currency, rate, rateBase]
     payment  [id, title, amount, from, to, currency, rate, rateBase]      from, to: a place, -1 for nobody
     PAID     [mode, who, values]                    mode: 0 single, 1 equal, 2 exact, 3 percent, 4 shares, 5 items
     SPLIT    [mode, who, values, items, tax, tip]   who: [place, ...]   values: [place, number, place, number, ...]
     items    [[name, amount, who], ...]
     typed    [[code, rate, base], ...]              rates typed for the group
     pinned   [date, [code, unitsPerUsd, ...]]
     example  1 on the built-in example

   An empty currency slot means the group's currency. Slot 3 tells the bills apart: a list for an expense,
   a number for a payment. A typed number is a JSON number when that reads back as the very same text
   ('780' -> 780), else a string ('120.00').

   Bytes: the JSON as UTF-8, then 4 check bytes (FNV-1a), so a link changed on the way is noticed instead
   of misread. 'v1.' is those bytes through deflate-raw, as base64url without padding; 'u1.' is the same
   without deflate. Version 1 must never change its meaning: a new layout gets a new prefix. */

const MODES = ['single', 'equal', 'exact', 'percent', 'shares', 'items'];

const isEmpty = v => v === '' || (Array.isArray(v) && v.length === 0);

function short(slots) {
  while (slots.length && isEmpty(slots[slots.length - 1])) slots.pop();
  return slots;
}

const packNumber = s => (String(Number(s)) === s ? Number(s) : s);

// Expects a group that has been through sanitizeGroup.
function pack(g) {
  const place = new Map(g.people.map((p, i) => [p.id, i]));
  const who = ids => ids.map(id => place.get(id));
  const values = v => Object.entries(v).flatMap(([id, s]) => [place.get(id), packNumber(s)]);
  const code = c => (c === g.currency ? '' : c);
  const paid = s => short([MODES.indexOf(s.mode), who(s.who), values(s.values)]);
  const split = s => short([MODES.indexOf(s.mode), who(s.who), values(s.values),
    s.items.map(it => short([it.name, packNumber(it.amount), who(it.who)])), packNumber(s.tax), packNumber(s.tip)]);
  const bill = b => short([b.id, b.title, packNumber(b.amount),
    ...(b.kind === 'payment' ? [place.get(b.from) ?? -1, place.get(b.to) ?? -1] : [paid(b.paid), split(b.split)]),
    code(b.currency), b.fx ? packNumber(b.fx.rate) : '', b.fx ? code(b.fx.base) : '']);
  return short([g.id, g.name, g.currency, g.rev, g.people.map(p => [p.id, p.name]), g.expenses.map(bill),
    Object.entries(g.rates).map(([c, r]) => short([c, packNumber(r.rate), code(r.base)])),
    g.fx ? [g.fx.date, Object.entries(g.fx.usd).flat()] : [],
    g.example ? 1 : '']);
}

const list = v => (Array.isArray(v) ? v : []);
const pick = (arr, i) => (Number.isInteger(i) && i >= 0 && i < arr.length ? arr[i] : undefined);

/* The packed array back in the shape of a group. Nothing is checked here: the result goes straight into
   sanitizeGroup. Tables have no prototype, so a key such as '__proto__' is just a key. */
function unpack(packed) {
  const [id, name, currency, rev, rawPeople, bills, typed, pinned, example] = packed;
  // An entry that is not a list stays as a gap, so the places of the people after it do not shift.
  const people = list(rawPeople).map(p => (Array.isArray(p) ? { id: p[0], name: p[1] } : null));
  const idAt = i => (pick(people, i) || {}).id;
  const who = v => list(v).map(idAt);
  const code = c => (c === undefined || c === '' ? currency : c);
  const table = (flat, keyOf) => {
    const out = Object.create(null);
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const key = keyOf(flat[i]);
      if (typeof key === 'string') out[key] = flat[i + 1];
    }
    return out;
  };
  const side = s => {
    const [mode, w, values, items, tax, tip] = list(s);
    return { mode: pick(MODES, mode), who: who(w), values: table(list(values), idAt),
      items: list(items).map(it => ({ name: list(it)[0], amount: list(it)[1], who: who(list(it)[2]) })), tax, tip };
  };
  const bill = b => {
    const [billId, title, amount, a, c, cur, rate, rateBase] = b;
    const fx = rate === undefined || rate === '' ? undefined : { rate, base: code(rateBase) };
    return Array.isArray(a)
      ? { id: billId, kind: 'expense', title, amount, currency: code(cur), fx, paid: side(a), split: side(c) }
      : { id: billId, kind: 'payment', title, amount, currency: code(cur), fx, from: idAt(a), to: idAt(c) };
  };
  return { id, name, currency, rev, example: example === 1, people, expenses: list(bills).filter(Array.isArray).map(bill),
    rates: table(list(typed).flatMap(t => [list(t)[0], { rate: list(t)[1], base: code(list(t)[2]) }]), c => c),
    fx: list(pinned).length ? { date: pinned[0], usd: table(list(pinned[1]), c => c) } : undefined };
}

/* ---------- bytes ---------- */

// FNV-1a over the bytes, as 4 bytes. Any single changed byte gives a different result.
function checkBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return [h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255];
}

function seal(bytes) {
  const out = new Uint8Array(bytes.length + 4);
  out.set(bytes);
  out.set(checkBytes(bytes), bytes.length);
  return out;
}

function unseal(bytes) {
  if (bytes.length > MAX_BYTES + 4) fail(TOO_BIG);
  if (bytes.length < 4) fail(DAMAGED);
  const body = bytes.subarray(0, bytes.length - 4), check = checkBytes(body);
  if (check.some((b, i) => b !== bytes[body.length + i])) fail(DAMAGED);
  return body;
}

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) fail(DAMAGED);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const SLICE = 1024;

/* Unpacks deflate data, giving up once more than `limit` bytes have come out. Input goes in small slices and
   output is read as it comes, so a short link that unpacks to gigabytes is stopped near the limit. */
async function inflate(bytes, limit) {
  let stream;
  try { stream = new DecompressionStream('deflate-raw'); }
  catch { fail(OLD_BROWSER); }
  const writer = stream.writable.getWriter(), reader = stream.readable.getReader();
  const feed = (async () => {
    for (let i = 0; i < bytes.length; i += SLICE) await writer.write(bytes.subarray(i, i + SLICE));
    await writer.close();
  })();
  feed.catch(() => {});   // the same failure is met again below, at the reader or at `await feed`
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) fail(TOO_BIG);
      chunks.push(value);
    }
    await feed;
  } catch (e) {
    reader.cancel().catch(() => {});
    writer.abort().catch(() => {});
    throw e;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/* ---------- links ---------- */

export async function encodeGroup(group) {
  const json = new TextEncoder().encode(JSON.stringify(pack(sanitizeGroup(group))));
  if (json.length > MAX_BYTES) fail('This group is too large to fit in a link.');
  const bytes = seal(json);
  try { return 'v1.' + toBase64Url(await deflate(bytes)); }
  catch { return 'u1.' + toBase64Url(bytes); }   // no CompressionStream here: a longer link that opens the same way
}

export async function decodeGroup(payload) {
  if (typeof payload !== 'string') fail(NO_GROUP);
  if (payload.length > MAX_LINK) fail(TOO_BIG);
  const link = payload.trim().replace(/^#/, '');
  const form = link.slice(0, 3);
  if (form !== 'v1.' && form !== 'u1.') fail(/^[a-z]\d+\./.test(link) ? NEWER : NO_GROUP);
  try {
    const bytes = fromBase64Url(link.slice(3));
    const body = unseal(form === 'v1.' ? await inflate(bytes, MAX_BYTES + 4) : bytes);
    const packed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!Array.isArray(packed)) fail(DAMAGED);
    return sanitizeGroup(unpack(packed));
  } catch (e) {
    throw e instanceof ShareError ? e : new ShareError(DAMAGED);
  }
}
