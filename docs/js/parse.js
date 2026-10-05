/* Pay Me Back text input: typed lines -> bills, and bills -> lines. Pure, no DOM.
   A line is understood exactly, or refused with a message that says what to type. The steps: split the
   text into entries (a line plus the item lines under it); cut a line into tokens (numbers with their
   currency marks, names of people, words, punctuation); find the keywords that start a part (paid by,
   split, between, with, for, except, tip, tax, rate, or a verb such as "paid"); read each part; build
   the bill and let computeExpense confirm it. Where a line can be read two ways, it is refused.
   Every message is plain text: escape it, or use textContent, before showing it. */

import { CURRENCIES, computeExpense, fromMinor, listJoin, minorDigits, num, personName, plainMoney, toMinor, uid } from './core.js';

// Thrown where a line cannot be read. `list` is what to show: usually one message, sometimes a few.
class Stop extends Error {
  constructor(list) { super(list[0]); this.list = list; }
}
const stop = (...list) => { throw new Stop(list); };

const MAX_TITLE = 80, MAX_NAME = 40, MAX_ITEMS = 100, MAX_PEOPLE = 200, MAX_MINOR = 1e13;
const TOO_MANY = 'A group can have up to ' + MAX_PEOPLE + ' people.';
// Only shown if the code itself trips, which the tests keep from happening.
const UNREADABLE = 'This line could not be read. Try it like: Dinner 120 paid by Ana';

/* ---------- currency marks ---------- */

const CODES = new Set(CURRENCIES);
// '$' and '¥' are settled later, because they depend on the group.
const SIGNS = new Map(Object.entries({ '€': 'EUR', '£': 'GBP', '₹': 'INR', '₩': 'KRW', '₫': 'VND', '₺': 'TRY', '₪': 'ILS', '₱': 'PHP', '฿': 'THB', $: '$', '¥': '¥', '￥': '¥' }));
const DOLLAR_LETTERS = new Map(Object.entries({ US: 'USD', AU: 'AUD', A: 'AUD', CA: 'CAD', C: 'CAD', NZ: 'NZD', HK: 'HKD', S: 'SGD', NT: 'TWD', R: 'BRL', MX: 'MXN' }));
const MONEY_WORDS = new Map(Object.entries({ euro: 'EUR', euros: 'EUR', pound: 'GBP', pounds: 'GBP', yen: 'JPY', yuan: 'CNY', rupee: 'INR', rupees: 'INR',
  franc: 'CHF', francs: 'CHF', dollar: '$', dollars: '$', buck: '$', bucks: '$' }));
const DOLLARS = ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD'];
// Codes that are also everyday words. In front of a number ("Learn PHP 30") they are asked about.
const WORDY = ['TRY', 'PHP', 'CAD', 'AED'];

// A currency sign at text[i]: one character, or letters on a dollar sign such as US$ and A$.
function signAt(text, i) {
  const m = /^([A-Za-z]{1,2})\$/.exec(text.slice(i, i + 3));
  const cur = m ? DOLLAR_LETTERS.get(m[1].toUpperCase()) : SIGNS.get(text[i]);
  return cur ? { len: m ? m[0].length : 1, mark: { cur, kind: 'sign', loose: false } } : null;
}

// A currency code in any case or, after a number, a word such as "euros". `loose` marks one to ask about.
function wordMark(raw, after) {
  const code = raw.toUpperCase();
  if (raw.length === 3 && CODES.has(code)) return { cur: code, kind: 'code', loose: (code === 'TRY' && raw !== 'TRY') || (!after && WORDY.includes(code)) };
  const cur = after ? MONEY_WORDS.get(raw.toLowerCase()) : undefined;
  return cur ? { cur, kind: 'word', loose: false } : null;
}

const unknownCurrency = text => '"' + text + '" is not a currency this page knows. It knows: ' + CURRENCIES.join(', ') + '.';
// Three capital letters that are not one of our codes, such as RUB.
const isOtherCode = t => !!t && t.t === 'word' && /^[A-Z]{3}$/.test(t.raw) && !CODES.has(t.raw);

function oneOf(options, mark) {
  const list = [...options];
  if (list.length > 1) stop('"' + mark + '" could mean ' + list.slice(0, -1).join(', ') + ' or ' + list[list.length - 1] + ' here. Write the code after the amount, like 45 ' + list[list.length - 1] + '.');
  return list[0];
}

/* "$" is the group's currency when that is a dollar, else USD. It is refused when a "Currency:" line
   above names another dollar, and for the sign next to pesos: then two readings are likely. */
function dollar(ctx, sign) {
  const fits = c => DOLLARS.includes(c) || (sign && c === 'MXN');
  return oneOf(new Set([DOLLARS.includes(ctx.base) ? ctx.base : 'USD', ...[ctx.base, ctx.cur].filter(fits)]), sign ? '$' : 'dollars');
}

// "¥" is CNY in a CNY group, else JPY. Refused when a "Currency:" line above names the other one.
const yen = ctx => oneOf(new Set([ctx.base === 'CNY' ? 'CNY' : 'JPY', ...[ctx.cur].filter(c => c === 'CNY' || c === 'JPY')]), '¥');

/* ---------- number formats ---------- */

/* '1,200.50' -> { int: '1200', frac: '50' }. A comma or dot before exactly three digits is a thousands
   mark, before one or two digits a decimal mark. null when it is not a number; { unsure } for '1.200',
   which is 1200 in half the world and 1.2 in the other half. */
function readDigits(body) {
  let m;
  if (/^\d+$/.test(body)) return { int: body, frac: '' };
  if ((m = /^\.(\d+)$/.exec(body))) return { int: '0', frac: m[1] };
  if ((m = /^([1-9]\d{0,2}(?:[ '’]\d{3})+)(?:[.,](\d+))?$/.exec(body))) return { int: m[1].replace(/\D/g, ''), frac: m[2] || '' };
  if ((m = /^([1-9]\d{0,2}(?:,\d{3})+)(?:\.(\d+))?$/.exec(body))) return { int: m[1].replace(/,/g, ''), frac: m[2] || '' };
  if ((m = /^([1-9]\d{0,2}(?:\.\d{3})+),(\d+)$/.exec(body))) return { int: m[1].replace(/\./g, ''), frac: m[2] };
  if (/^[1-9]\d{0,2}(?:\.\d{3}){2,}$/.test(body)) return { int: body.replace(/\./g, ''), frac: '' };
  if ((m = /^(\d+)\.(\d+)$/.exec(body))) return /^[1-9]\d{0,2}$/.test(m[1]) && m[2].length === 3 ? { unsure: true } : { int: m[1], frac: m[2] };
  if ((m = /^(\d+),(\d+)$/.exec(body))) return { int: m[1], frac: m[2] };
  return null;
}

// '8,5' -> '8.5'. For percents, shares and rates, where a comma can only be a decimal comma.
function plainNumber(tok, maxDecimals) {
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(tok.body) || /^()\.(\d+)$/.exec(tok.body);
  const frac = m ? (m[2] || '').replace(/0+$/, '') : '';
  if (!m || tok.neg || frac.length > maxDecimals) return null;
  return (m[1].replace(/^0+(?=\d)/, '') || '0') + (frac ? '.' + frac : '');
}

/* ---------- tokens ---------- */

const LETTER = /[\p{L}\p{M}\p{N}_]/u;
const DIGITS = /\d+(?:[.,'’]\d+)*|\.\d+/y;
const LETTERS = /\p{L}+/uy;
const ARROW = /-{1,2}>|=>|[→⇒➜➔➝⟶]/y;
const TIME = /\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/y;
const GLUED = ['for', 'with', 'split', 'between', 'among', 'except', 'but', 'by', 'and', 'to'];
const isDigit = c => c >= '0' && c <= '9';
const isSpace = c => /\s/.test(c);
// Names are compared without regard to case, and a curly apostrophe counts as a straight one.
const fold = s => String(s).normalize('NFC').toLowerCase().replace(/’/g, '\'');

// True when a word cannot go on at text[i]. "Ana's" and "Ana-Maria" are not the person Ana.
function wordEnds(text, i) {
  const c = text[i], next = text[i + 1];
  return c === undefined || !(LETTER.test(c) || ('\'’-'.includes(c) && next !== undefined && LETTER.test(next)));
}

// After a number: the end, a space, or closing punctuation. "50/50" and "7-Eleven" are words.
function numberEnds(text, i) {
  const c = text[i], next = text[i + 1];
  if (c === undefined || isSpace(c)) return true;
  return c === '.' ? next === undefined || isSpace(next) : ',;:!?'.includes(c);
}

// A time of day such as "19:30" at text[i]: its length, or 0. Its colon is not the colon after a name.
function timeAt(text, i) {
  TIME.lastIndex = i;
  const m = TIME.exec(text);
  return m ? m[0].length : 0;
}

// The person whose name starts at text[i]. `low` is the folded line, `names` the people, longest first.
function nameAt(text, low, i, names) {
  const p = names.find(n => low.startsWith(n.key, i) && wordEnds(text, i + n.key.length));
  return p ? { t: 'name', s: i, e: i + p.key.length, person: p } : null;
}

/* A number with what is written onto it: a minus, a currency sign or code in front ("€120", "EUR120"),
   a share mark ("x2", "2x"), a percent sign, or a sign, code or currency word behind ("120eur"). */
function numberAt(text, i) {
  const tok = { t: 'num', s: i, e: i, body: '', neg: false, pct: false, mult: false, lead: false, tail: false, marks: [] };
  let j = i;
  if (timeAt(text, i)) return null;
  if (text[j] === '-' || text[j] === '−') { tok.neg = true; j++; }
  const sign = signAt(text, j), code = text.slice(j, j + 3).toUpperCase();
  if (sign) { tok.marks.push(sign.mark); tok.lead = true; j += sign.len; }
  else if ('xX×'.includes(text[j] || ' ') && isDigit(text[j + 1])) { tok.mult = true; j++; }
  else if (CODES.has(code) && isDigit(text[j + 3])) { tok.marks.push({ cur: code, kind: 'code', loose: false }); tok.lead = true; j += 3; }
  DIGITS.lastIndex = j;
  const m = DIGITS.exec(text);
  if (!m) return null;
  tok.body = m[0];
  j += m[0].length;
  const after = signAt(text, j);
  LETTERS.lastIndex = j;
  const word = LETTERS.exec(text);
  if (text[j] === '%') { tok.pct = tok.tail = true; j++; }
  else if ('xX×'.includes(text[j] || ' ') && numberEnds(text, j + 1)) { tok.mult = tok.tail = true; j++; }
  else if (after) { tok.marks.push(after.mark); tok.tail = true; j += after.len; }
  else if (word) {
    const mark = wordMark(word[0], true);
    if (!mark) return null;
    tok.marks.push({ ...mark, loose: false });   // written onto the number, so meant as its currency
    tok.tail = true;
    j += word[0].length;
  }
  if (!numberEnds(text, j)) return null;
  tok.e = j;
  return tok;
}

function punctAt(text, i) {
  const c = text[i], next = text[i + 1];
  ARROW.lastIndex = i;
  const arrow = ARROW.exec(text), sign = signAt(text, i);
  if (arrow) return { t: 'arrow', s: i, e: i + arrow[0].length };
  if (',;:&+%'.includes(c)) return { t: 'p', ch: c, s: i, e: i + 1 };
  if ('.!?'.includes(c)) return { t: 'p', ch: '.', s: i, e: i + 1 };
  if ('-–—'.includes(c) && (next === undefined || isSpace(next))) return { t: 'dash', s: i, e: i + 1 };
  return sign ? { t: 'sign', mark: sign.mark, s: i, e: i + sign.len } : null;
}

/* A word. A comma between two digits stays inside it: in "nights1,200" the 200 must not be taken for an
   amount. `spaced` is set for a keyword typed onto a name ("butDee"), with what was meant ("but Dee"). */
function wordAt(text, i, names) {
  let j = i + (timeAt(text, i) || 1);
  const inside = k => text[k] === ',' && isDigit(text[k - 1]) && isDigit(text[k + 1]);
  while (j < text.length && !isSpace(text[j]) && (!',;:&+'.includes(text[j]) || inside(j))) j++;
  while (j > i + 1 && '.!?'.includes(text[j - 1])) j--;
  const raw = text.slice(i, j), rest = k => raw.slice(k.length);
  const kw = GLUED.find(k => raw.startsWith(k) && /^\p{Lu}/u.test(rest(k)) && names.some(p => p.key === fold(rest(k))));
  return { t: 'word', s: i, e: j, raw, low: raw.toLowerCase().replace(/’/g, '\''), spaced: kw ? kw + ' ' + rest(kw) : '' };
}

const isWord = (t, ...lows) => !!t && t.t === 'word' && lows.includes(t.low);
const isP = (t, ch) => !!t && t.t === 'p' && t.ch === ch;
const isSoft = t => t.t === 'dash' || (t.t === 'p' && ',;.'.includes(t.ch));
const isSep = t => (t.t === 'p' && ',;.&+'.includes(t.ch)) || isWord(t, 'and');
const markOf = (t, after) => (t.t === 'sign' ? t.mark : t.t === 'word' ? wordMark(t.raw, after) : null);

/* Joins a number with the sign, code or word beside it ("120 EUR", "eur 120", "$ 45", "10 %",
   "50 percent"), and turns "10% tip" around so the keyword comes first. */
function attachMarks(toks) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], next = toks[i + 1], prev = toks[i - 1];
    if (t.t !== 'num') continue;
    if (next && !t.tail && (isP(next, '%') || isWord(next, 'percent', 'pct'))) { t.pct = t.tail = true; t.e = next.e; toks.splice(i + 1, 1); continue; }
    const after = next && !t.pct && !t.mult ? markOf(next, true) : null;
    const before = !after && prev && !t.marks.length && !t.neg && !t.mult ? markOf(prev, false) : null;
    if (after) {
      t.marks.push(after); t.tail = true; t.e = next.e; toks.splice(i + 1, 1);
      // "7 JPY 1000": the code could belong to either number. Remember how far the doubt reaches.
      if (toks[i + 1] && toks[i + 1].t === 'num' && !toks[i + 1].marks.length && !isP(toks[i + 2], '%')) t.torn = toks[i + 1].e;
    } else if (before) { t.marks.push(before); t.lead = true; t.s = prev.s; toks.splice(i - 1, 1); i--; }
  }
  for (let i = 0; i + 1 < toks.length; i++) {
    if (toks[i].t === 'num' && toks[i].pct && isWord(toks[i + 1], 'tip', 'tax') && !isWord(toks[i - 1], 'tip', 'tax')) toks.splice(i, 2, toks[i + 1], toks[i]);
  }
  return toks;
}

function lex(text, names) {
  const toks = [], folded = fold(text);
  // Folding keeps the length for all but a few rare letters. For those, names are not looked for.
  const low = folded.length === text.length ? folded : '';
  for (let i = 0; i < text.length;) {
    if (isSpace(text[i])) { i++; continue; }
    const t = (low && nameAt(text, low, i, names)) || numberAt(text, i) || punctAt(text, i) || wordAt(text, i, names);
    toks.push(t);
    i = t.e;
  }
  return attachMarks(toks);
}

const rawOf = (E, tok) => E.text.slice(tok.s, tok.e);
const tidy = s => s.replace(/\s+/g, ' ').replace(/^[\s,;–—-]+|[\s,;–—-]+$/g, '');

// A name in double quotes at the start, the way formatBill protects a name with a colon in it.
function quotedAt(text) {
  const curly = text[0] === '“' ? text.indexOf('”', 1) : -1;
  if (curly > 0) return { value: text.slice(1, curly), end: curly + 1 };
  let value = '';
  for (let i = 1; text[0] === '"' && i < text.length; i++) {
    if (text[i] !== '"') value += text[i];
    else if (text[i + 1] === '"') { value += '"'; i++; }
    else return { value, end: i + 1 };
  }
  return null;
}

/* ---------- amounts ---------- */

// "1 200,50" typed with spaces: a short number, then groups of exactly three digits.
const startsGroup = t => !!t && t.t === 'num' && !t.tail && !t.mult && !t.neg && /^[1-9]\d{0,2}$/.test(t.body);
const continuesGroup = t => !!t && t.t === 'num' && !t.lead && !t.mult && !t.neg && /^\d{3}(?:[.,]\d+)?$/.test(t.body);

/* The number at toks[i], with space-separated groups after it joined on. Only used where nothing but
   one number can stand (after a colon, a verb or a name), so joining cannot hide a second number. */
function numberFrom(toks, i, end) {
  let tok = toks[i], j = i + 1;
  while (startsGroup(toks[i]) && j < end && continuesGroup(toks[j])) {
    const part = toks[j++];
    tok = { ...tok, body: tok.body + ' ' + part.body, e: part.e, marks: tok.marks.concat(part.marks), pct: part.pct, tail: part.tail };
    if (part.tail || /[.,]/.test(part.body)) break;
  }
  return { tok, next: j };
}

// Where nothing but an amount can stand, a code beside it is its currency and is not asked about.
const firm = tok => { tok.marks.forEach(m => { m.loose = false; }); return tok; };

// The currency a number is marked with, or null when it has no mark.
function currencyOf(E, tok) {
  if (tok.torn) stop('"' + E.text.slice(tok.s, tok.torn) + '" can be read two ways. Keep the amount and its currency together, away from other numbers.');
  const found = new Set(tok.marks.map(m => {
    if (m.loose) stop('Is "' + rawOf(E, tok) + '" an amount in ' + m.cur + '? Then write ' + tok.body + ' ' + m.cur + '. If not, put a colon after the name.');
    return m.cur === '$' ? dollar(E.ctx, m.kind === 'sign') : m.cur === '¥' ? yen(E.ctx) : m.cur;
  }));
  if (found.size > 1) stop('"' + rawOf(E, tok) + '" names two currencies. Keep one.');
  return found.size ? [...found][0] : null;
}

// A typed amount as exact minor units and as the string a bill stores: { minor: 12050, str: '120.50' }.
function amountOf(E, tok, cur, zeroIsFine) {
  const raw = rawOf(E, tok), d = minorDigits(cur), n = readDigits(tok.body);
  if (tok.pct || tok.mult) stop('"' + raw + '" is not an amount. Write a plain number, like 120.');
  if (tok.neg) stop('An amount cannot be negative. For money paid back, write: Cy paid Ana 50');
  if (!n) stop('"' + raw + '" is not a number this page can read. Write it like 1200.50');
  if (n.unsure) stop('Is "' + tok.body + '" over a thousand? Then write ' + tok.body.replace('.', '') + '. If not, write ' + tok.body.slice(0, -1) + '.');
  const frac = n.frac.replace(/0+$/, ''), int = n.int.replace(/^0+(?=\d)/, '');
  if (frac.length > d) stop(d ? tok.body + ' has too many decimals. ' + cur + ' has ' + d + ', like ' + int + '.' + frac.slice(0, d) + '.' : cur + ' has no decimals. Write a whole number, like ' + int + '.');
  const minor = Number(int + frac.padEnd(d, '0'));
  if (minor > MAX_MINOR) stop('That amount is too large.');
  if (minor === 0 && !zeroIsFine) stop('The amount needs to be more than 0.');
  return { minor, str: int + (d ? '.' + frac.padEnd(d, '0') : '') };
}

/* Finds the amount among toks[from..to): the one number with a currency mark, else a number in last
   place. Returns its index, or -1 when there is no number. Anything unclear stops with a message:
   "2 pizzas paid by Ana" has no amount, and taking the 2 would make a wrong bill. */
function amountIndex(E, from, to) {
  const { toks } = E, raw = i => rawOf(E, toks[i]), nums = [];
  for (let i = from; i < to; i++) if (toks[i].t === 'num') nums.push(i);
  const marked = nums.filter(i => toks[i].marks.length), sign = toks.slice(from, to).find(t => t.t === 'sign');
  if (sign) stop('"' + rawOf(E, sign) + '" is not next to a number. Write it with the amount, like ' + rawOf(E, sign) + '120.');
  if (marked.length > 1) stop('There are two amounts here, ' + raw(marked[0]) + ' and ' + raw(marked[1]) + '. Keep one.');
  const a = marked.length ? marked[0] : nums.length && toks[to - 1].t === 'num' ? to - 1 : -1;
  if (a < 0 && nums.length) {
    const last = nums[nums.length - 1], after = toks[last + 1];   // there is one: the number is not in last place
    if (isOtherCode(after)) stop(unknownCurrency(after.raw));
    // A person called Yen or Cad: the name wins, so the word is not a currency in this group.
    if (after.t === 'name' && (CODES.has(after.person.key.toUpperCase()) || MONEY_WORDS.has(after.person.key))) stop(after.person.name + ' is a person in this group, so "' + rawOf(E, after) + '" is not read as a currency. Use a code or a sign, like ' + raw(last) + ' EUR.');
    if (isWord(after, 'each', 'pp') || (isWord(after, 'per') && isWord(toks[last + 2], 'person', 'head'))) stop('"' + raw(last) + ' each" is a price for one person. Write the total instead.');
    stop('Is ' + raw(last) + ' the amount? Then put it last. Or put a colon after the name, like: Dinner: 120 paid by Ana');
  }
  if (a < 0) return a;
  // "€120 EUR USD": a second code beside the amount.
  const isMark = (t, after) => t.t === 'sign' || (t.t === 'word' && (CODES.has(t.raw) || (after && MONEY_WORDS.has(t.low))));
  const beside = [toks[a - 1], toks[a + 1]].find((t, k) => !!t && (k ? a + 1 < to : a > from) && isMark(t, !!k));
  if (beside) stop('"' + E.text.slice(Math.min(beside.s, toks[a].s), Math.max(beside.e, toks[a].e)) + '" names two currencies. Keep one.');
  // "Room 12 300": 12300, or room 12 and 300?
  const g = a > from && startsGroup(toks[a - 1]) && continuesGroup(toks[a]) ? a - 1 : a + 1 < to && startsGroup(toks[a]) && continuesGroup(toks[a + 1]) ? a : -1;
  if (g >= 0) stop('"' + toks[g].body + ' ' + toks[g + 1].body + '" can be read as one number or as two. Write ' + toks[g].body + toks[g + 1].body + ' without the space, or put a colon after the name.');
  // "Hotel €700 room 12": the mark says 700, the last place says 12. "Lunch 12,50 5": two prices.
  const rival = marked.length && toks[to - 1].t === 'num' && a !== to - 1 ? to - 1 : nums.find(i => i !== a && /[.,]\d{1,2}$/.test(toks[i].body) && !toks[i].pct && !toks[i].mult);
  if (rival !== undefined) stop('Is the amount ' + raw(a) + ' or ' + raw(rival) + '? Put a colon after the name, then the amount.');
  return a;
}

// The words of toks[from..to) without the amount at index a: the name of the bill.
function titleFrom(E, from, to, a) {
  if (to <= from) return '';
  const { toks, text } = E, last = toks[to - 1].e;
  return tidy(a < 0 ? text.slice(toks[from].s, last) : text.slice(toks[from].s, toks[a].s) + ' ' + text.slice(toks[a].e, last));
}

/* A name worked out from the words around the amount has to look like one. "12" alone, as in
   "Ana paid 12,50 for 12", is more likely a slip. A colon after it makes it a name on purpose. */
function inferredTitle(title) {
  if (title && !/\p{L}/u.test(title)) stop('Is "' + title + '" the name of the bill? Then put a colon after it, like: ' + title + ': 45 paid by Ana. If not, add a name in words.');
  return title;
}

/* ---------- people ---------- */

const ME = new Set(['i', 'me', 'my', 'myself']);
const EVERYONE = new Set(['everyone', 'everybody', 'all', 'us', 'each']);
// A word that can be offered as a new person: it starts with a capital (or has no case, as in 小明).
const NEW_NAME = /^(?:\p{Lu}|\p{Lo})[\p{L}\p{M}'’.-]*$/u;
// Words the lines themselves use. None of them is taken for a new person, however it is written.
const TAKEN = new Set(['paid', 'by', 'split', 'between', 'among', 'amongst', 'with', 'for', 'except', 'but', 'not', 'tip', 'tax', 'rate', 'back', 'to', 'and',
  'sent', 'gave', 'repaid', 'transferred', 'refunded', 'reimbursed', 'owes', 'owe', 'equally', 'evenly', 'equal', 'ways', 'way', 'shares', 'share', 'percent', 'pct',
  'the', 'group', 'whole', 'of', 'x', ...ME, ...EVERYONE]);
const isMe = t => t.t === 'word' && ME.has(t.low);
const canBeName = w => NEW_NAME.test(w) && !/['’]s$/i.test(w) && !TAKEN.has(w.toLowerCase()) && !CODES.has(w.toUpperCase()) && !MONEY_WORDS.has(w.toLowerCase());
const TWICE = name => 'Two people in the group are called ' + name + '. Rename one under GROUP.';

function makeContext(group, opts) {
  const ctx = { group, base: group.currency || 'USD', cur: group.currency || 'USD', people: [], byKey: new Map(), sorted: null, me: null };
  (Array.isArray(group.people) ? group.people : []).forEach(p => { if (p && typeof p.name === 'string' && p.name) enroll(ctx, p.id, p.name, false); });
  if (opts.me && ctx.people.some(p => p.id === opts.me)) ctx.me = opts.me;
  return ctx;
}

function enroll(ctx, id, name, isNew) {
  const key = fold(name), seen = ctx.byKey.get(key), p = { id, name: String(name), key, isNew, twice: false };
  ctx.people.push(p);
  // Two people with one name cannot be told apart in text. The first keeps the name and is marked.
  if (seen) seen.twice = true; else ctx.byKey.set(key, p);
  ctx.sorted = null;
  return p;
}

// Longest names first, so "Mary Ann" is found before "Mary".
const lexNames = ctx => ctx.sorted || (ctx.sorted = [...ctx.byKey.values()].sort((a, b) => b.key.length - a.key.length));
const everyone = E => [...E.ctx.people, ...E.fresh.values()];
const nameOf = (E, id) => everyone(E).find(p => p.id === id).name;

// How many single-letter edits apart two words are. Swapping two neighbours counts as one.
function editDistance(a, b) {
  let prev2 = [], prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      row.push(v);
    }
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

// The person whose name is one typo away (two for names of six letters or more), or null.
function nearName(ctx, text) {
  const a = fold(text);
  let best = null;
  for (const p of ctx.byKey.values()) {
    const limit = p.key.length >= 6 ? 2 : 1;
    if (Math.abs(a.length - p.key.length) > limit || a.length > MAX_NAME + limit) continue;
    const d = editDistance(a, p.key);
    if (d <= limit && (!best || d < best.d)) best = { d, name: p.name };
  }
  return best && best.name;
}

/* A word that is not a known name, standing where a person belongs. One capitalised word between
   separators is offered as a new person, unless it looks like a typo of someone in the group. */
function stranger(E, text, lone) {
  const key = fold(text), met = E.fresh.get(key), near = nearName(E.ctx, text);
  if (met && lone) return met.id;   // named earlier on this line
  if (near) stop(text + ' is not in the group. Did you mean ' + near + '? To add a new person, write: People: ' + text);
  if (text.length > MAX_NAME || !text.split(/\s+/).every(canBeName)) stop('"' + text + '" is not a person in the group.' + E.hint);
  if (!lone || E.closed) stop('"' + text + '" is not in the group. To add a new person, write: People: ' + text);
  E.fresh.set(key, { id: 'new:' + text, name: text, key, isNew: true });
  return 'new:' + text;
}

// "everyone", "all of us", "the group" ... at toks[i]: how many tokens the phrase takes, or 0.
function everyoneAt(toks, i, end) {
  const w = k => (i + k < end && toks[i + k].t === 'word' ? toks[i + k].low : '');
  if (w(0) === 'the') return w(1) === 'group' ? 2 : w(1) === 'whole' && w(2) === 'group' ? 3 : 0;
  if (!EVERYONE.has(w(0))) return 0;
  return (w(0) === 'all' || w(0) === 'each') && w(1) === 'of' && w(2) === 'us' ? 3 : 1;
}

// One person at toks[i]: a name, "me", or a new name. `alone` says a separator stands before it.
function personAt(E, i, end, alone) {
  const { toks, ctx } = E, t = toks[i], filler = k => isWord(toks[k], 'x', '×', 'equally', 'evenly');
  if (t.t === 'name' && t.person.twice) stop(TWICE(t.person.name));
  if (t.t === 'name') return { id: t.person.id, next: i + 1 };
  if (isMe(t) && !ctx.me) stop('Who is "' + t.raw + '"? Add a line above this one, like: I am Ana');
  if (isMe(t)) return { id: ctx.me, next: i + 1 };
  if (t.t !== 'word') stop('"' + rawOf(E, t) + '" is not clear here. A name belongs in this place.');
  if (t.low === 'rate') stop(RATE_HOW);
  if (t.low === 'tip' || t.low === 'tax') stop(percentHow(t.low));
  let j = i + 1;
  while (j < end && toks[j].t === 'word' && !isSep(toks[j]) && !isMe(toks[j]) && !filler(j)) j++;
  const bounded = j === end || isSep(toks[j]) || toks[j].t === 'num' || isP(toks[j], ':') || filler(j);
  return { id: stranger(E, E.text.slice(t.s, toks[j - 1].e), alone && bounded && j === i + 1), next: j };
}

// The number that follows a person in a list: an amount, a percent, or shares ("x2", "2x", "2 shares").
function valueAt(E, i, end) {
  const { toks } = E;
  let j = i;
  if (j < end && isP(toks[j], ':')) j++;
  const times = j < end && isWord(toks[j], 'x', '×');
  if (times) j++;
  if (j >= end || toks[j].t !== 'num') return j > i ? stop('A number is missing after "' + rawOf(E, toks[j - 1]) + '".') : null;
  const { tok, next } = numberFrom(toks, j, end), raw = rawOf(E, tok);
  if (next < end && isWord(toks[next], 'each')) stop('"' + raw + ' each" is not clear. Give each person their own number, like: Ana 40, Ben 40');
  const shares = next < end && isWord(toks[next], 'shares', 'share');
  const kind = tok.pct ? 'percent' : tok.mult || times || shares ? 'shares' : 'exact';
  if ((tok.pct && (tok.mult || times || shares)) || (kind !== 'exact' && tok.marks.length)) stop('"' + raw + '" is not clear. Write an amount (30), a percent (50%) or shares (x2).');
  return { kind, tok, next: shares ? next + 1 : next };
}

/* A list of people in toks[i..end): names split by commas, "and", "&" or "+". With `values`, a name
   may carry a number. Returns { who: [ids], vals: [value or null], all }; `all` means "everyone". */
function readList(E, i, end, values) {
  const { toks } = E, out = { who: [], vals: [], all: false };
  let alone = true;
  while (i < end) {
    const t = toks[i], phrase = everyoneAt(toks, i, end);
    if (isSep(t)) { alone = true; i++; continue; }
    if (isWord(t, 'equally', 'evenly')) { i++; continue; }   // "between Ana and Ben equally": the default anyway
    if (phrase) { out.all = true; alone = false; i += phrase; continue; }
    const p = personAt(E, i, end, alone), v = values ? valueAt(E, p.next, end) : null;
    if (out.who.includes(p.id)) stop(nameOf(E, p.id) + ' is in this list twice.');
    out.who.push(p.id);
    out.vals.push(v);
    i = v ? v.next : p.next;
    alone = false;
  }
  if (out.all && out.who.length) stop('Write "everyone" or a list of names, not both. To say who shares it, start with "for", like: for everyone');
  return out;
}

// True when toks[from..to) is a list of people of the group; with `strangers`, new names may be in it.
function isList(toks, from, to, strangers) {
  let count = 0;
  for (let i = from; i < to;) {
    const phrase = everyoneAt(toks, i, to), t = toks[i];
    if (phrase || t.t === 'name' || isMe(t) || (strangers && t.t === 'word' && !isSep(t) && canBeName(t.raw))) { count++; i += phrase || 1; }
    else if (isSep(t)) i++;
    else return false;
  }
  return count > 0;
}

// True when someone of the group or "me" is named in toks[from..to). With `all`, "everyone" counts too.
function mentionsPerson(toks, from, to, all) {
  for (let i = from; i < to; i++) if (toks[i].t === 'name' || isWord(toks[i], 'i', 'me', 'myself') || (all && everyoneAt(toks, i, to))) return true;
  return false;
}

// Reads toks[from..to) as a list without keeping anything. Returns the new names it would add, or null.
function tryList(E, from, to) {
  const trial = { ...E, fresh: new Map(E.fresh), hint: '' };
  try { readList(trial, from, to, true); }
  catch (e) { if (e instanceof Stop) return null; throw e; }
  return [...trial.fresh.values()].filter(p => !E.fresh.has(p.key)).map(p => p.name);
}

/* ---------- keywords and parts of a line ---------- */

const VERBS = new Set(['paid', 'sent', 'gave', 'repaid', 'transferred', 'refunded', 'reimbursed', 'owes', 'owe']);
const RATE_HOW = 'Write the rate as a plain number with a dot, like: rate 1.1251';
const percentHow = word => 'Write the ' + word + ' as a percent, like: ' + word + (word === 'tip' ? ' 10%' : ' 8.5%');
const STRAY = {
  amount: ' After the amount comes "paid by" and a name.',
  colon: ' After the colon comes the amount, like: Dinner: 120 paid by Ana',
  sentence: ' To name the bill, write it like: Ana paid 30 for lunch',
  payment: ' A payment is two people and an amount, like: Cy paid Ana 50'
};

// "split" starts a part only when what follows fits. In "banana split" or "split pea soup" it is a word.
function splitFollows(toks, i) {
  const t = toks[i];
  if (!t) return false;
  if (t.t === 'name' || t.t === 'num' || isP(t, ':') || isMe(t) || everyoneAt(toks, i, toks.length)) return true;
  return t.t === 'word' && (['equally', 'evenly', 'equal', 'between', 'among', 'amongst', 'with', 'for', 'except'].includes(t.low) || canBeName(t.raw));
}

// The keyword at toks[j]: { k, len } or null.
function keywordAt(toks, j) {
  const t = toks[j], next = toks[j + 1], prev = toks[j - 1];
  if (t.t !== 'word') return null;
  const numberNext = !!next && (next.t === 'num' || (isP(next, ':') && !!toks[j + 2] && toks[j + 2].t === 'num'));
  switch (t.low) {
    case 'paid': return isWord(next, 'by') ? { k: 'paidby', len: 2 } : null;
    case 'split': return splitFollows(toks, j + 1) ? { k: 'split', len: 1 } : null;
    case 'between': case 'among': case 'amongst': return { k: 'between', len: 1 };
    case 'with': case 'for': return { k: t.low, len: 1 };
    case 'except': return { k: 'except', len: isWord(next, 'for') ? 2 : 1 };
    case 'but': return prev && prev.t === 'word' && (EVERYONE.has(prev.low) || prev.low === 'group') ? { k: 'except', len: isWord(next, 'not') ? 2 : 1 } : null;
    case 'tip': case 'tax': case 'rate': return numberNext ? { k: t.low, len: 1 } : null;
    default: return null;
  }
}

/* Cuts toks[from..] into parts at the keywords: [{ k, at, from, to }], where `at` is the keyword and
   from..to what belongs to it. Words before the first keyword stop the line. */
function splitParts(E, from, where) {
  const { toks } = E, parts = [];
  for (let j = from; j < toks.length;) {
    const k = keywordAt(toks, j);
    if (k) {
      if (parts.length) parts[parts.length - 1].to = j;
      parts.push({ k: k.k, at: j, from: j + k.len + (isP(toks[j + k.len], ':') ? 1 : 0), to: toks.length });
      j = parts[parts.length - 1].from;
    } else {
      if (!parts.length && isOtherCode(toks[j]) && j > 0 && toks[j - 1].t === 'num') stop(unknownCurrency(toks[j].raw));
      if (!parts.length && !isSoft(toks[j])) stop('"' + rawOf(E, toks[j]) + '" is not clear here.' + STRAY[where]);
      j++;
    }
  }
  parts.forEach(p => { while (p.to > p.from && isSoft(toks[p.to - 1])) p.to--; });
  return parts;
}

function setShare(B, list, kind, word) {
  if (B.share) stop('This line says who shares it twice. Keep one.');
  if (!list.all && !list.who.length) stop('Add names after "' + word + '", like: ' + word + ' Ana and Ben');
  B.share = { ...list, kind };
}

function readRate(E, part, already) {
  const t = E.toks[part.from], mark = t.marks[0];
  const clear = part.to - part.from === 1 && !t.pct && !t.mult && t.marks.length < 2 && (!mark || mark.kind === 'code') && !/^[1-9]\d{0,2},\d{3}$/.test(t.body);
  const rate = clear ? plainNumber(t, 10) : null;
  if (already) stop('This line has a rate twice. Keep one.');
  if (!rate || !(num(rate) > 0)) stop(RATE_HOW);
  return { rate, base: mark ? mark.cur : null };
}

function readPercent(E, part, word, already) {
  const t = E.toks[part.from];
  const value = part.to - part.from === 1 && t.pct && !t.mult && !t.marks.length ? plainNumber(t, 6) : null;
  if (already != null) stop('This line has ' + word + ' twice. Keep one.');
  if (value === null || num(value) > 100) stop(percentHow(word));
  return value === '0' ? '' : value;   // "tip 0%" is no tip
}

/* "Ana paid 30 for ...": what follows "for" is the name of the bill, unless it is a list of people of
   the group. A mix of both is refused, because it could be either. */
function readFor(E, B, part, exceptNext) {
  const { toks, text } = E, { from } = part;
  let to = part.to;
  if (from >= to) stop('Something is missing after "for".');
  // The new names this part would add if it were a list of people. null when it cannot be one.
  const names = B.title === null && mentionsPerson(toks, from, to, true) ? tryList(E, from, to) : null;
  if (B.title !== null || (names && !names.length)) { setShare(B, readList(E, from, to, true), 'only', 'for'); return; }
  const raw = tidy(text.slice(toks[from].s, toks[to - 1].e)), start = ' start with it: ' + raw + ': 30 paid by Ana';
  if (names) stop('Is "' + raw + '" the name of the bill, or who shares it? For people, first add: People: ' + names.join(', ') + '. For a name,' + start);
  const near = to - from === 1 && toks[from].t === 'word' && canBeName(raw) ? nearName(E.ctx, raw) : null;
  if (near) stop(raw + ' is not in the group. Did you mean ' + near + '? If "' + raw + '" is the name of the bill,' + start);
  // "for dinner, everyone but Dee": the word "everyone" belongs to what follows, not to the name.
  for (let k = from + 1; exceptNext && k < to; k++) if (everyoneAt(toks, k, to) === to - k) to = k;
  while (to > from && isSoft(toks[to - 1])) to--;
  // "for taxi home Ana and Ben": a name, or a name and then who shares it?
  if (mentionsPerson(toks, from, to, false)) stop('Is "' + raw + '" the whole name of the bill? Then' + start + '. If part of it says who shares it, put "for" before those names.');
  const a = B.amount ? -1 : amountIndex(E, from, to);
  if (a >= 0) B.amount = toks[a];
  B.title = inferredTitle(titleFrom(E, from, to, a));
  B.titleEnd = part.to;
}

// Reads the parts of an expense line after its name and amount into B.
function readParts(E, from, B, where) {
  const { toks } = E, parts = splitParts(E, from, where);
  for (const [n, part] of parts.entries()) {
    let i = part.from;
    const list = () => readList(E, i, part.to, true);
    // "Ana paid 9 for banana split with Ben": without a comma, "split" may belong to the name.
    if (part.k === 'split' && B.titleEnd === part.at) stop('Is "split" part of the name? Then start with the name, like: Banana split: 9 paid by Ana. If not, put a comma before "split".');
    E.hint = !E.named && ['for', 'with', 'between'].includes(part.k) ? ' If it belongs to the name of the bill, put a colon after the name.' : '';
    E.closed = part.k === 'except';
    switch (part.k) {
      case 'paidby':
        if (B.paid) stop('This line says who paid twice. Keep one.');
        B.paid = list();
        if (!B.paid.all && !B.paid.who.length) stop('Who paid? Add a name after "paid by".');
        break;
      case 'split':
        if (i < part.to && isWord(toks[i], 'equally', 'evenly', 'equal')) i++;
        if (i + 1 < part.to && toks[i].t === 'num' && isWord(toks[i + 1], 'ways', 'way')) { B.ways = toks[i]; i += 2; }
        if (i < part.to) setShare(B, list(), 'only', 'split');
        break;
      case 'between': setShare(B, list(), 'only', 'between'); break;
      case 'with': setShare(B, list(), 'with', 'with'); break;
      case 'for': readFor(E, B, part, !!parts[n + 1] && parts[n + 1].k === 'except'); break;
      case 'except':
        if (B.minus) stop('This line says "except" twice. Keep one.');
        B.minus = readList(E, i, part.to, false);
        if (B.minus.all || !B.minus.who.length) stop('Add names after "except", like: everyone except Dee');
        break;
      case 'rate': B.rate = readRate(E, part, B.rate); break;
      default: B[part.k] = readPercent(E, part, part.k, B[part.k]);
    }
  }
  E.hint = '';
  E.closed = false;
}

/* ---------- building and checking a bill ---------- */

const allIds = E => (E.ctx.people.length + E.fresh.size ? everyone(E).map(p => p.id) : stop('There is nobody in the group yet. Add people first, like: People: Ana, Ben, Cy'));

// One side of a bill from a list that was read: { mode, who, values }.
function sideOf(E, list, cur) {
  if (list.all) return { mode: 'equal', who: allIds(E), values: {} };
  const kinds = new Set(list.vals.map(v => (v ? v.kind : 'none')));
  if (kinds.has('none') && kinds.size > 1) stop('Give every person a number, or none of them. ' + nameOf(E, list.who[list.vals.indexOf(null)]) + ' has none.');
  if (kinds.size > 1) stop('Use one kind of number in a list: amounts (30), percents (50%) or shares (x2).');
  const mode = [...kinds][0], values = {};
  if (mode === 'none') return { mode: 'equal', who: list.who, values };
  list.who.forEach((id, k) => {
    const { tok } = list.vals[k], own = mode === 'exact' ? currencyOf(E, tok) : null;
    if (own && own !== cur) stop('Use one currency for the whole bill. This one has ' + cur + ' and ' + own + '.');
    const value = mode === 'exact' ? amountOf(E, tok, cur, true).str : plainNumber(tok, 6);
    if (value === null) stop('"' + rawOf(E, tok) + '" is not a number this page can read.');
    values[id] = value;
  });
  return { mode, who: list.who, values };
}

// Who shares a bill without items, from "split", "between", "with", "for", "except" and "N ways".
function shareOf(E, B, paid, cur) {
  const s = B.share;
  let side;
  if (!s || s.all) side = { mode: 'equal', who: allIds(E), values: {} };
  else if (s.kind !== 'with') side = sideOf(E, s, cur);
  else if (s.vals.some(Boolean)) stop('"with" takes names only. To give each person a number, write it like: split Ana 30, Ben 20');
  else side = { mode: 'equal', who: [...new Set([...paid.who, ...s.who])], values: {} };   // "with" includes whoever paid
  if (B.minus) {
    if (s && !s.all) stop('"except" works after "everyone", like: for everyone except Dee');
    side.who = side.who.filter(id => !B.minus.who.includes(id));
    if (!side.who.length) stop('That leaves nobody to share it.');
  }
  if (B.ways) {
    const ways = '"' + rawOf(E, B.ways) + ' ways" does not match the ', n = /^\d+$/.test(B.ways.body) && !B.ways.marks.length ? Number(B.ways.body) : -1;
    if (side.mode !== 'equal' || n !== side.who.length) stop(s && !s.all ? ways + side.who.length + ' people listed.' : ways + 'group of ' + everyone(E).length + '. Say who shares it, like: split between Ana and Ben');
  }
  return side;
}

// The group with the new people of this text added, so computeExpense can check a draft.
const groupWith = E => ({ ...E.ctx.group, people: everyone(E).map(p => ({ id: p.id, name: p.name })) });

// Bare numbers that do not add up may have been meant as shares. Say how to write those.
function sharesHint(E, r, bill) {
  const side = bill.kind === 'payment' ? {} : r.errSplit ? bill.split : bill.paid, d = minorDigits(bill.currency);
  if (!/^The amounts/.test(r.err) || side.mode !== 'exact') return '';
  const parts = side.who.map(id => [nameOf(E, id), toMinor(side.values[id], bill.currency) / 10 ** d]);
  return parts.every(p => Number.isInteger(p[1]) && p[1] > 0 && p[1] <= 20) ? ' If these are shares, write: ' + parts.map(p => p[0] + ' x' + p[1]).join(', ') : '';
}

function fixRate(E, bill, rate) {
  const base = rate && (rate.base || E.ctx.base), own = E.ctx.base;
  if (!rate) return;
  if (bill.currency === own) stop('This bill is in ' + own + ', the group\'s currency, so it needs no rate. Remove the rate, or add the bill\'s currency, like 120 EUR.');
  if (base === bill.currency) stop('A rate goes from one currency to another. Both are ' + base + ' here.');
  bill.fx = { rate: rate.rate, base };
}

/* The last word: a bill is only accepted when the math in core.js accepts it too, and its total is the
   number that was typed. For a bill with items, the typed total has to match what the items come to. */
function approve(E, bill, amount) {
  const r = computeExpense(groupWith(E), bill), cur = bill.currency, items = bill.kind === 'expense' && bill.split.mode === 'items';
  if (r.err) stop(r.err + sharesHint(E, r, bill));
  if (items && amount && r.totalOrig !== amount.minor) {
    const extras = [num(bill.split.tax) > 0 ? 'tax' : '', num(bill.split.tip) > 0 ? 'tip' : ''].filter(Boolean).join(' and ');
    stop('The first line says ' + plainMoney(amount.minor, cur) + ', but the items' + (extras ? ' with ' + extras : '') + ' add up to ' + plainMoney(r.totalOrig, cur) + '. Change one of them, or leave the amount out of the first line.');
  }
  if (amount && r.totalOrig !== amount.minor) stop('That amount is too large.');
  if (items) bill.amount = fromMinor(r.totalOrig, cur);
  return bill;
}

/* ---------- items ---------- */

const BULLET = /^\s*[-*•–—·](?!-?>)\s*/;

// Runs fn for one item line and puts the line number in front of whatever stops it.
function onRow(row, errors, fn) {
  try { return fn(); }
  catch (e) {
    if (!(e instanceof Stop)) throw e;
    errors.push(...e.list.map(m => 'Line ' + row.n + ': ' + m));
    return null;
  }
}

// "everyone butDee" would lose the "but" and count Dee in. Ask for the space instead.
function noGluedWords(toks) {
  const t = toks.find(w => w.spaced);
  if (t) stop('"' + t.raw + '" needs a space: ' + t.spaced);
}

/* One item line: "Bacalhau 38 Ben", "Vinho verde 52: Ana, Ben, Dee", "Wine: 52.00 for Ana and Ben".
   The price is the number right after a colon, else the last number. What follows it is who shares it. */
function readItem(E, raw) {
  const line = raw.replace(BULLET, '').trim(), quoted = quotedAt(line);
  const I = { ctx: E.ctx, fresh: E.fresh, text: quoted ? line.slice(quoted.end) : line, hint: '', closed: false };
  const toks = I.toks = lex(I.text, lexNames(E.ctx)), n = toks.length;
  const colon = quoted ? -1 : toks.findIndex((t, k) => isP(t, ':') && !!toks[k + 1] && toks[k + 1].t === 'num');
  const named = quoted || colon >= 0, marked = toks.filter(t => t.t === 'num' && t.marks.length), sign = toks.find(t => t.t === 'sign');
  let a = quoted ? (isP(toks[0], ':') ? 1 : 0) : colon + 1;
  noGluedWords(toks.slice(colon + 1));
  if (!named) {
    if (marked.length > 1) stop('There are two prices here, ' + rawOf(I, marked[0]) + ' and ' + rawOf(I, marked[1]) + '. Keep one.');
    a = marked.length ? toks.indexOf(marked[0]) : toks.findLastIndex(t => t.t === 'num');
    if (a > 0 && startsGroup(toks[a - 1]) && continuesGroup(toks[a])) stop('"' + toks[a - 1].body + ' ' + toks[a].body + '" can be read as one number or as two. Write it without the space, or put a colon after the name of the item.');
    if (sign) stop('"' + rawOf(I, sign) + '" is not next to a number. Write it with the price, like ' + rawOf(I, sign) + '20.');
    if (toks.slice(0, Math.max(a, 0)).some(t => isP(t, ':'))) stop('In an item, a colon goes right after the name or right after the price, like: - Wine: 20 Ana');
  }
  if (a < 0 || a >= n || toks[a].t !== 'num') stop('This item needs a price, like: - Wine 20 Ana, Ben');
  const price = named ? numberFrom(toks, a, n) : { tok: toks[a], next: a + 1 };
  const name = quoted ? quoted.value : colon >= 0 ? I.text.slice(0, toks[colon].s).trim() : tidy(I.text.slice(0, toks[a].s));
  if (name.length > MAX_TITLE) stop('That item name is long. Keep it to ' + MAX_TITLE + ' letters.');
  let i = price.next, said = false;
  if (i < n && isP(toks[i], ':')) { i++; said = true; }
  if (i < n && isWord(toks[i], 'for', 'between', 'among')) { i++; said = true; }
  // "- Ben 12" or "- Ben: 12": is Ben the item, or the one who had it?
  const whose = 'Is "' + name + '" the name of the item';
  if (colon >= 0 && i >= n && !said && isList(toks, 0, colon, false)) stop(whose + ', or who shares it? For the name, use quotes: - "' + name + '": 12. For who shares it, put them after the price: - Wine 12 ' + name);
  if (!named && mentionsPerson(toks, 0, a, true)) stop(whose + '? Then put a colon after it: - ' + name + ': 12. People who share it go after the price: - Wine 12 Ben');
  let cut = i;
  while (cut < n && (keywordAt(toks, cut) || {}).k !== 'except') cut++;
  const list = i < n || said ? readList(I, i, cut, false) : null;
  I.closed = true;
  const minus = cut < n ? readList(I, cut + keywordAt(toks, cut).len, n, false) : null;
  if (minus && (!list.all || minus.all || !minus.who.length)) stop('"except" works after "everyone", like: everyone except Dee');
  if (list && !list.all && !list.who.length) stop('Add who shares this item, or leave the end open for everyone.');
  return { I, name, tok: price.tok, list, minus };
}

/* ---------- expenses ---------- */

const NO_TITLE = 'What was it for? Add a name before the amount.';
const NO_TITLE_AFTER = 'What was it for? Add it after the amount, like: Ana paid 30 for lunch';
const NO_PAYER = 'Who paid? Add: paid by <name>';
const NO_AMOUNT = 'How much was it? Add the amount after the name, like: Dinner 120 paid by Ana';
const NO_TOTAL = 'How much was it in total? Put the total right after the name, like: Dinner 120 paid by Ana 80, Ben 40';
const NAME_END = 'It is not clear where the name of the bill ends. Put a colon after the name, like: Dinner with Ana: 120 paid by Ben';
// "Ben 12 paid by Ana": a bill called Ben, or 12 for Ben? Quotes say it is the name.
const peopleAsName = text => 'Is "' + text + '" the name of the bill, or who shares it? For the name, use quotes: "' + text + '": 12 paid by Ana. For who shares it, start with what it was for: Lunch 12 paid by Ana for ' + text;

// Turns what was read (B: title, amount, paid, share, minus, ways, tip, tax, rate) into an expense.
function finishExpense(E, B, rows) {
  const missing = [], errors = [];
  if (rows.length > MAX_ITEMS) stop('A bill can have up to ' + MAX_ITEMS + ' items.');
  const items = rows.length ? rows.map(row => ({ row, ...onRow(row, errors, () => readItem(E, row.raw)) })) : null;
  if (errors.length) stop(...errors);
  if (!items && (B.tip != null || B.tax != null)) stop('Tip and tax go with a list of items. Put each item on its own line below this one, starting with a dash.');
  if (items && (B.share || B.ways || B.minus)) stop('The items already say who shares what. Remove the "split" part from the first line.');
  if (!B.title || !B.title.trim()) missing.push(B.payerFirst ? NO_TITLE_AFTER : NO_TITLE);
  if (!B.amount && !items) missing.push(B.paid && B.paid.vals.some(Boolean) ? NO_TOTAL : NO_AMOUNT);
  if (!B.paid) missing.push(NO_PAYER);
  if (missing.length === 3) stop('A bill needs a name, an amount and who paid, like: Dinner 120 paid by Ana');
  if (missing.length) stop(...missing);
  if (B.title.length > MAX_TITLE) stop('That name is long. Keep it to ' + MAX_TITLE + ' letters.');

  const marks = new Set(B.amount ? [currencyOf(E, B.amount)] : []);
  (items || []).forEach(it => marks.add(onRow(it.row, errors, () => currencyOf(it.I, it.tok))));
  marks.delete(null);
  if (marks.size > 1) stop('Use one currency for the whole bill. This one has ' + listJoin([...marks]) + '.');
  const cur = marks.size ? [...marks][0] : E.ctx.cur, amount = B.amount ? amountOf(E, B.amount, cur) : null;
  const paid = sideOf(E, B.paid, cur);
  if (paid.mode === 'equal' && paid.who.length === 1 && !B.paid.all) paid.mode = 'single';

  const bill = { id: uid('e'), kind: 'expense', title: B.title, amount: amount ? amount.str : '', currency: cur, paid };
  if (items) {
    const list = items.map(it => onRow(it.row, errors, () => {
      const who = !it.list || it.list.all ? allIds(E).filter(id => !it.minus || !it.minus.who.includes(id)) : it.list.who;
      if (!who.length) stop('That leaves nobody to share this item.');
      return { name: it.name, amount: amountOf(it.I, it.tok, cur).str, who };
    }));
    if (errors.length) stop(...errors);
    bill.split = { mode: 'items', who: [], values: {}, items: list, tax: B.tax || '', tip: B.tip || '' };
  } else bill.split = { ...shareOf(E, B, paid, cur), items: [], tax: '', tip: '' };
  fixRate(E, bill, B.rate);
  return approve(E, bill, amount);
}

/* "Dinner 120 paid by Ana": the name comes first. It runs up to "paid by", or to the first keyword
   after a number, so "Tickets for the concert 80" keeps its "for". */
function readPlain(E, rows) {
  const { toks, text } = E;
  let h = 0, sawNumber = false, weak = -1;
  for (; h < toks.length; h++) {
    const k = keywordAt(toks, h);
    const percent = !!k && (k.k === 'tip' || k.k === 'tax') && toks.slice(h + 1, h + 3).some(t => t.t === 'num' && t.pct);
    if (k && (sawNumber || k.k === 'paidby' || percent)) break;
    if (k && weak < 0) weak = h;
    sawNumber = sawNumber || toks[h].t === 'num';
  }
  let end = h;
  while (end > 0 && isSoft(toks[end - 1])) end--;
  // "Lunch for Ana 30": is Ana part of the name, or the one who shares it? Not ours to pick.
  if (weak >= 0 && toks.slice(weak + 1, end).some((t, k) => t.t === 'name' || isWord(t, 'i', 'me', 'myself') || (keywordAt(toks, weak + 1 + k) || {}).k === 'except')) {
    const a = toks[end - 1].t === 'num' ? end - 1 : -1;
    const head = tidy(text.slice(toks[0].s, toks[weak].s)), tail = a < 0 ? '' : tidy(text.slice(toks[weak].s, toks[a].s));
    if (!tail) stop(NAME_END);
    const n = rawOf(E, toks[a]);
    stop('Is "' + tail + '" part of the name, or who shares it? For the name, put a colon after it: ' + (head ? head + ' ' : '') + tail + ': ' + n + (head ? '. For who shares it, put the amount first: ' + head + ' ' + n + ' ' + tail : ''));
  }
  const a = amountIndex(E, 0, end), title = titleFrom(E, 0, end, a);
  if (isList(toks, 0, a === end - 1 ? a : end, false)) stop(peopleAsName(title));
  // "Dinner Ana and Ben 80": a bill with people in its name, or a bill for those people?
  if (mentionsPerson(toks, 0, end, false)) stop('Is "' + title + '" the whole name of the bill? Then put a colon after it. If it also says who paid or who shares it, put that after the amount, like: Dinner 30 paid by Ana for Ben');
  const B = { title: inferredTitle(title), amount: a < 0 ? null : toks[a] };
  readParts(E, h, B, 'amount');
  return finishExpense(E, B, rows);
}

// "Dinner: 120 paid by Ana": the colon (or quotes) ended the name, so the amount comes next.
function readNamed(E, title, rows) {
  const { toks } = E, first = toks.length && toks[0].t === 'num' ? numberFrom(toks, 0, toks.length) : null;
  const B = { title, amount: first && firm(first.tok) };
  readParts(E, first ? first.next : 0, B, first ? 'amount' : 'colon');
  return finishExpense(E, B, rows);
}

/* ---------- "Ana paid ..." lines: payer first, or a payment between two people ---------- */

// Where the verb or arrow is, when only names and plain words stand before it. -1 otherwise.
function verbAt(toks) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'arrow') return i;
    if (t.t === 'word' && VERBS.has(t.low) && !(t.low === 'paid' && isWord(toks[i + 1], 'by'))) return i;
    if (t.t !== 'name' && t.t !== 'word' && !isSep(t)) return -1;
  }
  return -1;
}

function finishPayment(E, P, rows) {
  if (P.from.all || P.from.who.length !== 1) stop('A payment goes from one person to one person. Write one line for each.');
  if (rows.length) stop('A payment cannot have items. Remove the lines under it.');
  const guest = [...E.fresh.values()][0];
  if (guest) stop(guest.name + ' is not in the group yet. Add them first: People: ' + guest.name);
  const cur = currencyOf(E, P.amount) || E.ctx.cur, amount = amountOf(E, P.amount, cur);
  const title = (P.title && P.title.trim() ? P.title : '') || P.note || (nameOf(E, P.from.who[0]) + ' paid ' + nameOf(E, P.to) + ' back').slice(0, MAX_TITLE);
  if (title.length > MAX_TITLE) stop('That note is long. Keep it to ' + MAX_TITLE + ' letters.');
  const bill = { id: uid('e'), kind: 'payment', title, amount: amount.str, currency: cur, from: P.from.who[0], to: P.to };
  fixRate(E, bill, P.rate);
  return approve(E, bill, amount);
}

// "Cy paid Ana 50" (i is at Ana) or "Cy sent 50 to Ana" (the amount is known, i is at "to").
function readPayment(E, P, i) {
  const { toks } = E, n = toks.length;
  E.kind = 'payment';
  E.hint = ' For a bill, write its name first, like: Taxi 50 paid by Ana';
  if (P.amount) i++;
  if (i >= n) stop('Who got the money? Write it like: Cy sent Ana 50');
  const to = personAt(E, i, n, true);
  P.to = to.id;
  i = to.next + (isWord(toks[to.next], 'back') ? 1 : 0);
  if (!P.amount) {
    if (i >= n || toks[i].t !== 'num') stop('How much? Put the amount after the names, like: Cy paid Ana 50');
    const amount = numberFrom(toks, i, n);
    P.amount = firm(amount.tok);
    i = amount.next + (isWord(toks[amount.next], 'back') ? 1 : 0);
  }
  for (const part of splitParts(E, i, 'payment')) {
    const note = part.k === 'for' && P.title === null && P.note === undefined && part.to > part.from && !mentionsPerson(toks, part.from, part.to, true);
    if (part.k === 'rate') P.rate = readRate(E, part, P.rate);
    else if (note) P.note = tidy(E.text.slice(toks[part.from].s, toks[part.to - 1].e));
    else stop('This part is not clear.' + STRAY.payment);
  }
  return finishPayment(E, P, E.rows);
}

/* Reads "Ana paid 120 for dinner" and "Cy paid Ana 50". Returns null when the line is not of this kind,
   so it can be read name first instead. A new name in front only counts when a number or a person
   follows the verb: "Flowers sent to mum 40 paid by Ana" stays a bill called "Flowers sent to mum". */
function readSentence(E, title) {
  const { toks } = E, n = toks.length, v = verbAt(toks);
  if (v < 1) return null;
  const word = toks[v].t === 'arrow' ? '' : toks[v].low, back = k => (isWord(toks[k], 'back') ? k + 1 : k);
  let i = back(v + 1);
  const next = toks[i], person = !!next && (next.t === 'name' || isMe(next)), number = !!next && next.t === 'num';
  if (!isList(toks, 0, v, false) && !((person || number) && isList(toks, 0, v, true))) return null;
  if (word === 'owes' || word === 'owe') stop('"' + toks[v].raw + '" cannot be added as it is. Write who paid, like: Loan 50 paid by Ana for Cy');
  const from = readList(E, 0, v, false), B = { title, amount: null, paid: from, payerFirst: true };
  if (person) return readPayment(E, { title, from, amount: null }, i);
  if (number) {
    const amount = numberFrom(toks, i, n);
    i = back(amount.next);
    B.amount = firm(amount.tok);
    if (isWord(toks[i], 'to')) return readPayment(E, { title, from, amount: B.amount }, i);
    if (word !== 'paid') stop('Who got the money? Write it like: Cy sent Ana 50');
  } else if (word !== 'paid' || !next || (keywordAt(toks, i) || {}).k !== 'for') {
    stop(next ? '"' + rawOf(E, next) + '" is not a person in the group. For a bill, write its name first, like: Taxi 30 paid by Ana' : 'How much, and what for? Write it like: Ana paid 30 for lunch');
  }
  readParts(E, i, B, 'sentence');
  return finishExpense(E, B, E.rows);
}

// True when a name that a colon cut off holds an amount or a keyword, which is worth pointing out.
const busyTitle = title => lex(title, []).some((t, i, all) => t.t === 'num' || t.t === 'arrow' || !!keywordAt(all, i) || (t.t === 'word' && VERBS.has(t.low)));

function readBill(E, line) {
  const quoted = quotedAt(line);
  E.text = quoted ? line.slice(quoted.end) : line;
  E.toks = lex(E.text, lexNames(E.ctx));
  // The first colon ends the name of the bill, whatever stands before it.
  const colon = quoted ? (isP(E.toks[0], ':') ? 0 : -1) : E.toks.findIndex(t => isP(t, ':'));
  const title = quoted ? quoted.value : colon >= 0 ? E.text.slice(0, E.toks[colon].s).trim() : null;
  const onlyPeople = !quoted && colon > 0 && isList(E.toks, 0, colon, false);
  if (colon >= 0) E.toks = E.toks.slice(colon + 1);
  E.named = title !== null;
  try {
    noGluedWords(E.toks);
    if (onlyPeople) stop(peopleAsName(title));
    return readSentence(E, title) || (E.named ? readNamed(E, title, E.rows) : readPlain(E, E.rows));
  } catch (e) {
    if (e instanceof Stop && !quoted && colon >= 0 && busyTitle(title)) e.list.push('The colon makes "' + title + '" the name of the bill.');
    throw e;
  }
}

/* ---------- lines that are not bills ---------- */

// 'Ana, Ben and "Lee, Jr."' -> the three names. Quotes keep a name with a comma or "and" in one piece.
function splitNames(body) {
  const out = [], sep = /[,;&+]|\s+and(?=\s)/gi;
  for (let i = 0; i < body.length;) {
    const lead = /^(?:[\s,;&+]|and(?=\s))+/i.exec(body.slice(i));
    if (lead) { i += lead[0].length; continue; }
    const quoted = quotedAt(body.slice(i));
    sep.lastIndex = i;
    const cut = quoted ? null : sep.exec(body), end = quoted ? i + quoted.end : cut ? cut.index : body.length;
    out.push({ text: quoted ? quoted.value : body.slice(i, end).replace(/\s+/g, ' ').trim(), quoted: !!quoted });
    i = end;
  }
  return out.filter(n => n.text);
}

function readPeopleLine(ctx, body, draft) {
  const names = splitNames(body), seen = new Set(), add = [];
  if (!names.length) stop('Add the names after the colon, like: People: Ana, Ben, Cy');
  names.forEach(({ text, quoted }) => {
    const key = fold(text), known = ctx.byKey.get(key);
    if (!quoted && ['i', 'me', 'myself'].includes(key)) stop('Write your own name in place of "' + text + '". After that you can add a line like: I am Ana');
    if (text.length > MAX_NAME) stop('"' + text.slice(0, 20) + '…" is long for a name. Keep it to ' + MAX_NAME + ' letters.');
    if (!/[\p{L}\p{N}]/u.test(text)) stop('"' + text + '" does not look like a name.');
    if (seen.has(key)) stop(text + ' is in this list twice.');
    seen.add(key);
    if (known) draft.warnings.push(known.name + ' is already in the group.'); else add.push(text);
  });
  if (ctx.people.length + add.length > MAX_PEOPLE) stop(TOO_MANY);
  add.forEach(name => enroll(ctx, 'new:' + name, name, true));
  draft.newPeople = add;
}

function readMeLine(ctx, body, draft) {
  const name = body.replace(/[\s.!]+$/, '').replace(/\s+/g, ' ').trim(), known = ctx.byKey.get(fold(name)), near = known ? null : nearName(ctx, name);
  if (!name) stop('Write your name after it, like: I am Ana');
  if (known && known.twice) stop(TWICE(known.name));
  if (near) stop(name + ' is not in the group. Did you mean ' + near + '? To add a new person, write: People: ' + name);
  if (!known && (name.length > MAX_NAME || !name.split(' ').every(canBeName))) stop('"' + name + '" is not a person in the group. To add a new person, write: People: ' + name);
  if (!known && ctx.people.length >= MAX_PEOPLE) stop(TOO_MANY);
  if (!known) draft.newPeople = [name];
  ctx.me = (known || enroll(ctx, 'new:' + name, name, true)).id;
}

function readCurrencyLine(ctx, body) {
  const text = body.trim().replace(/[\s.]+$/, ''), code = text.toUpperCase();
  const cur = CODES.has(code) ? code : SIGNS.get(text) || MONEY_WORDS.get(text.toLowerCase());
  if (!text) stop('Add a currency code after the colon, like: Currency: EUR');
  if (!cur) stop(unknownCurrency(text));
  ctx.cur = cur === '$' ? (DOLLARS.includes(ctx.base) ? ctx.base : 'USD') : cur === '¥' ? (ctx.base === 'CNY' ? 'CNY' : 'JPY') : cur;
}

// What kind of line this is when it is not a bill: { kind, body } or null.
function directiveOf(line) {
  if (line.startsWith('#') || line.startsWith('//')) return { kind: 'comment', body: '' };
  const m = /^(people|group|currency|me)\s*:(.*)$/i.exec(line);
  if (m) return { kind: m[1].toLowerCase() === 'group' ? 'people' : m[1].toLowerCase(), body: m[2] };
  // "I am Ana". With a number or a colon it is a bill instead, such as "I am legend: 12 paid by Ana".
  const me = /^(?:i\s+am|i['’]m)(?:\s+(.*))?$/i.exec(line);
  return me && !/[\d:]/.test(line) ? { kind: 'me', body: me[1] || '' } : null;
}

/* ---------- parseText ---------- */

function readEntry(ctx, entry) {
  const line = entry.rows[0].raw.trim(), directive = entry.orphan ? null : directiveOf(line);
  const draft = { line: entry.rows[0].n, lines: entry.rows.length, source: entry.rows.map(r => r.raw).join('\n'),
    kind: directive ? directive.kind : 'expense', ok: false, errors: [], warnings: [], newPeople: [] };
  const E = { ctx, fresh: new Map(), rows: entry.rows.slice(1), text: '', toks: [], kind: 'expense', named: false, hint: '', closed: false };
  try {
    if (entry.orphan) stop('This line starts like an item, but no bill is right above it. Remove the dash, or move the line under its bill.');
    else if (!directive) {
      const bill = readBill(E, line);
      if (ctx.people.length + E.fresh.size > MAX_PEOPLE) stop(TOO_MANY);
      draft.bill = bill;
      draft.newPeople = [...E.fresh.values()].map(p => p.name);
      E.fresh.forEach(p => enroll(ctx, p.id, p.name, true));
    } else if (directive.kind === 'people') readPeopleLine(ctx, directive.body, draft);
    else if (directive.kind === 'currency') readCurrencyLine(ctx, directive.body);
    else if (directive.kind === 'me') readMeLine(ctx, directive.body, draft);
  } catch (e) {
    draft.errors = e instanceof Stop ? e.list : [UNREADABLE];
    draft.warnings = [];
  }
  if (!directive) draft.kind = E.kind;
  draft.ok = !draft.errors.length;
  return draft;
}

/* Splits the text into entries: a line, plus the item lines under it (lines that start with a dash,
   a star, a dot, two spaces or a tab). A blank line ends the list of items. */
function entriesOf(text) {
  const entries = [];
  let open = null;   // the bill that item lines below it belong to
  text.split(/\r\n|\n|\r/).forEach((raw, k) => {
    const line = raw.trim(), row = { n: k + 1, raw };
    const note = line.startsWith('#') || line.startsWith('//'), bullet = BULLET.test(raw), item = !note && (bullet || /^(?: {2,}|\s*\t)/.test(raw));
    if (!line) open = null;
    else if (item && open) open.rows.push(row);
    else {
      const entry = { rows: [row], orphan: item && bullet };
      entries.push(entry);
      open = entry.orphan || directiveOf(line) ? null : entry;
    }
  });
  return entries;
}

export function parseText(text, group, opts) {
  const ctx = makeContext(group || {}, opts || {});
  const drafts = entriesOf(String(text == null ? '' : text).normalize('NFC')).map(entry => readEntry(ctx, entry));
  return { drafts, people: ctx.people.map(p => ({ name: p.name, isNew: p.isNew })), defaultCurrency: ctx.cur, me: ctx.me };
}

/* ---------- bills back to text ---------- */

// Drafts point at people who are not in the group yet with ids like "new:Fay". This adds them by name.
function withGuests(group, bill) {
  const people = Array.isArray(group.people) ? group.people : [], have = new Set(people.map(p => p.id)), split = bill.split || {};
  const lists = bill.kind === 'payment' ? [[bill.from, bill.to]] : [(bill.paid || {}).who, split.who, ...(Array.isArray(split.items) ? split.items : []).map(it => it && it.who)];
  const guests = [...new Set(lists.flat().filter(id => typeof id === 'string' && id.startsWith('new:') && !have.has(id)))];
  return guests.length ? { ...group, people: [...people, ...guests.map(id => ({ id, name: id.slice(4) }))] } : group;
}

// A number as plain digits: 0.5, 12, 1.1251. Never 1e-7.
function decimal(v) {
  const n = Math.max(0, num(v)), s = String(n);
  return /e/i.test(s) ? n.toFixed(10).replace(/\.?0+$/, '') : s;
}

const quote = t => '"' + t.replace(/"/g, '""') + '"';

/* A name as it can be typed back. Quotes go around it when a colon, a quote at the start or a space at
   either end would be misread. A bill's name gets them too when it would start an item, a note or a
   "People:" line, or when it is nothing but people of the group ("Ben"), which would be asked about. */
function nameText(name, group) {
  const t = String(name).replace(/[\r\n]+/g, ' '), toks = group ? lex(t, lexNames(makeContext(group, {}))) : [];
  const risky = !!group && (/^(?:[-*•–—·#]|\/\/)/.test(t) || /^(?:people|group|currency|me)$/i.test(t) || isList(toks, 0, toks.length, false));
  return t !== '' && t === t.trim() && !/:|^["“]/.test(t) && !risky ? t : quote(t);
}

export function formatBill(group, bill) {
  const g = withGuests(group, bill), base = g.currency || 'USD', cur = bill.currency || base;
  const ids = new Set((g.people || []).map(p => p.id));
  const name = id => (ids.has(id) ? personName(g, id) : '?');
  const known = who => [...new Set(Array.isArray(who) ? who : [])].filter(id => ids.has(id));
  const money = v => fromMinor(Math.max(0, toMinor(v, cur)), cur);
  // A rate on a bill in the group's own currency does nothing, and typed back it would be refused.
  const fx = bill.fx && num(bill.fx.rate) > 0 && cur !== base ? ', rate ' + decimal(bill.fx.rate) + ' ' + (bill.fx.base || base) : '';
  const title = String(bill.title == null ? '' : bill.title), paid = bill.paid || {}, split = bill.split || {};

  if (bill.kind === 'payment') {
    const line = name(bill.from) + ' paid ' + name(bill.to), usual = !title.trim() || title === line || title === line + ' back';
    return (usual ? '' : nameText(title, g) + ': ') + line + ' ' + money(bill.amount) + ' ' + cur + fx;
  }

  // "?" stands where nobody is left, so a broken bill stays broken when it is typed back.
  const side = (s, isSplit) => {
    const who = known(s.who), values = s.values || {}, pairs = fn => who.map(id => name(id) + ' ' + fn(values[id])).join(', ');
    if (!who.length || (s.mode === 'single' && isSplit)) return '?';
    if (s.mode === 'single') return name(who[0]);
    if (s.mode === 'exact') return pairs(money);
    if (s.mode === 'percent') return pairs(v => decimal(v) + '%');
    if (s.mode === 'shares') return pairs(v => 'x' + decimal(v));
    return s.mode === 'equal' ? (isSplit ? 'between ' : '') + listJoin(who.map(name)) : '?';
  };
  const head = nameText(title, g) + ': ';
  if (split.mode !== 'items') return head + money(bill.amount) + ' ' + cur + ', paid by ' + side(paid, false) + ', split ' + side(split, true) + fx;

  // The total on the first line carries the currency. Without a total, every item carries it.
  const r = computeExpense(g, bill), total = r.errSplit ? '' : plainMoney(r.totalOrig, cur) + ', ';
  const extra = (word, v) => (num(v) > 0 ? ', ' + word + ' ' + decimal(v) + '%' : '');
  const rows = (Array.isArray(split.items) ? split.items : []).map(it => it || {}).filter(it => toMinor(it.amount, cur) > 0 || known(it.who).length);
  return [head + total + 'paid by ' + side(paid, false) + extra('tax', split.tax) + extra('tip', split.tip) + fx,
    ...rows.map(it => '  - ' + (String(it.name == null ? '' : it.name).trim() ? nameText(it.name, null) + ': ' : '') + money(it.amount) + (total ? '' : ' ' + cur)
      + ' for ' + (known(it.who).length ? listJoin(known(it.who).map(name)) : '?'))].join('\n');
}

export function formatGroup(group) {
  const people = (group.people || []).map(p => (/[,;&+]|^["“]|\sand\s|^and\s|^\s|\s$|^(?:i|me|myself)$/i.test(p.name) ? quote(String(p.name)) : p.name));
  return [...(people.length ? ['People: ' + people.join(', ')] : []), ...(group.expenses || []).map(bill => formatBill(group, bill))].join('\n');
}

/* How a bill was understood, in plain words and exact amounts in the bill's own currency:
   "Ana paid 120.00 EUR. Split equally: Ana 40.00, Ben 40.00, Cy 40.00." A bill with a problem is
   described by that problem. */
export function describeBill(group, bill) {
  const g = withGuests(group, bill), r = computeExpense(g, bill);
  if (r.err) return r.err;
  const cur = r.cur, who = id => personName(g, id), total = plainMoney(r.totalOrig, cur);
  const order = new Map(g.people.map((p, k) => [p.id, k]));
  const sorted = map => [...map].sort((a, b) => order.get(a[0]) - order.get(b[0]));
  const each = (map, note) => sorted(map).map(([id, v]) => who(id) + ' ' + fromMinor(v, cur) + (note ? ' (' + note(id) + ')' : '')).join(', ');
  const fixed = r.rateSource === 'fixed' ? ' Rate set for this bill: 1 ' + cur + ' = ' + decimal(bill.fx.rate) + ' ' + (bill.fx.base || g.currency || 'USD') + '.' : '';
  if (bill.kind === 'payment') return who(bill.from) + ' paid ' + who(bill.to) + ' back ' + total + '.' + fixed;

  const payers = sorted(r.paidOrig).map(e => e[0]), split = bill.split, value = id => decimal(split.values[id]);
  const paid = payers.length === 1 ? who(payers[0]) + ' paid ' + total + '.' : listJoin(payers.map(who)) + ' paid ' + total + ': ' + each(r.paidOrig) + '.';
  const extras = [num(split.tax) > 0 ? decimal(split.tax) + '% tax' : '', num(split.tip) > 0 ? decimal(split.tip) + '% tip' : ''].filter(Boolean);
  const how = split.mode === 'equal' ? 'Split equally: ' + each(r.owedOrig)
    : split.mode === 'exact' ? 'Split by amounts: ' + each(r.owedOrig)
    : split.mode === 'percent' ? 'Split by percent: ' + each(r.owedOrig, id => value(id) + '%')
    : split.mode === 'shares' ? 'Split by shares: ' + each(r.owedOrig, id => value(id) + (value(id) === '1' ? ' share' : ' shares'))
    : 'Split by items' + (extras.length ? ' plus ' + extras.join(' and ') : '') + ': ' + each(r.owedOrig);
  return paid + ' ' + how + '.' + fixed;
}
