/* Pay Me Back store: the one place the page's data lives. No DOM. The only outside things it touches are
   localStorage (every access in try/catch) and one exchange-rate request a day at most.

   const store = createStore()        // createStore({ storage, fetch, now }) in tests

   READING
     store.group        the group on screen (a live object: read it, change it only inside change())
     store.groups       [{ id, name, rev, example, people, bills }] for every saved group, in the order added
     store.readOnly     true while a link's version of a group is being looked at (see importGroup)
     store.steps        buildSteps(store.group, store.ui.mode), worked out once per change. Do not change it
     store.ui           { mode: 'fewest'|'keep', speed: number, focus: personId|'' }   (a copy)
     store.me           the person "I" stands for in this group on this device, or ''
     store.person(id)   { id, name } or undefined          store.name(id)   the name, or '?'
     store.usedPeople() Set of the ids of people who are on a bill
     store.newId('e')   an id nothing in the group has yet ('e' bill, 'p' person)
     store.canUndo, store.saved (false if the browser refused to save), store.lastError (why the last change was refused)

   LISTENING
     store.subscribe(fn)    fn({ type, label }) after the data changed and was saved; returns a function that stops it.
                            type 'change'  an edit. label is a sentence for the status line ('Bill deleted.') or ''
                                 'undo'    the last edit was taken back; label is that edit's label
                                 'show'    another group is on screen (switched, a link's version, reloaded)
                                 'rates'   rates for a newly used currency arrived a moment after the edit
     store.subscribeUI(fn)  fn(keys) after ui or me changed; keys is a list out of 'mode', 'speed', 'focus', 'me'

   CHANGING (each returns true when done; all are refused while readOnly)
     store.change(label, fn)   the one way to edit the group: fn(group) changes it in place. The store keeps a copy
                               for undo first and afterwards sets group.rev, removes group.example, pins rates for
                               a currency used for the first time, saves and tells the listeners once. fn may
                               return false, before changing anything, to call it off. A change that would pass the
                               limits (200 people, 2000 bills, 100 items, or too many debts to draw) is rolled back.
     store.undo()              puts back what was there before the last change. One level, across groups
     store.addPerson(name) -> id or ''      store.renamePerson(id, name)      store.removePerson(id)
     store.saveBill(bill)      adds the bill, or replaces the one with the same id (a copy is stored)
     store.deleteBill(id)      store.clearBills()
     store.renameGroup(name)   store.setCurrency(code)   store.setTypedRate(code, '1.25' or '')
     store.addGroup(name) -> id   store.switchGroup(id)   store.deleteGroup(id)
     store.setUI({ mode, speed, focus })   store.setMe(personId or '')

   LINKS
     store.importGroup(group, how) -> 'added' | 'same' | 'differs' | 'replaced' | 'kept'
       how 'ask' (default): a group this browser does not have is added and shown; one it has with the same
       content is shown; one that differs is shown read-only and nothing is saved ('differs'). The untouched
       example counts as not having it: the link's version takes its place.
       how 'replace': the link's version takes the place of the local one. how 'keep': it is dropped.
       For 'replace' and 'keep' the group may be left out: the one being looked at is meant.
       Throws an Error with a message for the reader if the group cannot be used.
     store.reload()   reads the saved data again (another tab changed it)

   RATES (SPEC section 8: a group's numbers change only when UPDATE RATES is pressed)
     await store.fetchRates()   -> { date, usd, source: 'fetched'|'cached'|'builtin', failed }. Never throws. One
                                request a day at most; in between, and when the request fails, the freshest table
                                this device has (a failed request is not repeated for a minute). Call it, with no
                                need to wait, when a new currency shows up in a form.
     await store.ensurePinned() pins every currency the group uses that has no pinned rate yet. change() does
                                this by itself; calling it again is harmless.
     await store.updateRates()  -> { changed, date, failed }. Pins every used currency again from the freshest table. */

import { BUILTIN_RATES, CURRENCIES, EXAMPLE_GROUP, computeExpense, personName, uid, usedCurrencies } from './core.js';
import { sameContent, sanitizeGroup } from './share.js';
import { buildSteps } from './simplify.js';

const KEY = 'settle.v1';
const RATES_KEY = 'settle.rates';
const RATES_URL = 'https://open.er-api.com/v6/latest/USD';
const DAY = 24 * 60 * 60 * 1000;
const FETCH_WAIT = 4000;   // ms before a rates request is given up
const RETRY_WAIT = 60000;  // ms before a failed request is tried again without being asked
const MODES = ['fewest', 'keep'];
const MAX_GROUP_NAME = 60;
const MAX_PERSON_NAME = 40;
const MAX_COST = 1e6;
const TOO_LARGE = 'This group has more debts between people than this page can draw. Split it into smaller groups.';

// A change that was refused, with a message for the reader.
class Refusal extends Error {}

const tidy = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max).trim();
const sameName = (a, b) => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));

/* Building the steps takes time and memory in step with the number of debts between pairs of people times
   the number of steps. Up to the limit that is well under a second; far past it a phone would freeze, and
   again on every visit once the group is saved. So such a group is refused before it gets in. */
function costOf(group) {
  const arrows = new Set();
  for (const bill of group.expenses) computeExpense(group, bill).edges.forEach(([a, b]) => arrows.add(a + '>' + b));
  return arrows.size * (arrows.size + group.expenses.length);
}

function check(group) {
  try { sanitizeGroup(group); } catch (e) { throw new Refusal(e.message); }
  if (costOf(group) > MAX_COST) throw new Refusal(TOO_LARGE);
}

function usedPeopleOf(group) {
  const ids = new Set();
  for (const bill of group.expenses) {
    if (bill.kind === 'payment') { ids.add(bill.from); ids.add(bill.to); continue; }
    const split = bill.split || {};
    const lists = [(bill.paid || {}).who, split.mode === 'items' ? (split.items || []).flatMap(it => it.who || []) : split.who];
    lists.forEach(list => (list || []).forEach(id => ids.add(id)));
  }
  return ids;
}

/* ---------- rates ---------- */

// A rates table as kept on this device: { fetchedAt, date, usd }, only currencies this page knows. Else null.
function readTable(raw) {
  if (!raw || typeof raw !== 'object' || !isDate(raw.date) || typeof raw.fetchedAt !== 'number' || !(raw.fetchedAt >= 0) || !raw.usd || typeof raw.usd !== 'object') return null;
  const usd = {};
  for (const code of CURRENCIES) {
    const n = code === 'USD' ? 1 : Object.hasOwn(raw.usd, code) ? raw.usd[code] : null;
    if (typeof n === 'number' && n > 0 && Number.isFinite(n)) usd[code] = n;
  }
  return Object.keys(usd).length > 1 ? { fetchedAt: raw.fetchedAt, date: raw.date, usd } : null;
}

// The currencies a group needs a pinned rate for: those on its bills and, with them, its own.
// USD is the unit every table is written in, so it is never stored.
function needed(group) {
  const used = usedCurrencies(group);
  return used.length ? [...new Set([...used, group.currency])].filter(c => c !== 'USD') : [];
}

const isPinned = (group, code) => !!group.fx && Object.hasOwn(group.fx.usd, code);
const missing = group => needed(group).filter(c => !isPinned(group, c));

/* Pins the needed currencies that have no pinned rate yet. Rates that are already pinned keep their
   numbers, and the table keeps its date: one date stands for the whole table. So a currency that joins
   later takes the rate of that same day where this device has it (`table` when its date matches, or the
   built-in table) and only otherwise the freshest rate there is. */
function pinMissing(group, table) {
  const add = missing(group), old = group.fx;
  if (!add.length) return false;
  const from = old && old.date !== table.date && old.date === BUILTIN_RATES.date ? BUILTIN_RATES : table;
  const usd = old ? { ...old.usd } : {};
  add.forEach(c => { usd[c] = from.usd[c] > 0 ? from.usd[c] : BUILTIN_RATES.usd[c]; });
  group.fx = { date: old ? old.date : table.date, usd };
  return true;
}

// Until a currency is pinned it runs on the built-in rates, so pinning those changes no number.
const adopt = group => { pinMissing(group, BUILTIN_RATES); return group; };

const sameTable = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

function browserStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/* ---------- the store ---------- */

export function createStore(env = {}) {
  const storage = 'storage' in env ? env.storage : browserStorage();
  const fetchFn = 'fetch' in env ? env.fetch : typeof fetch === 'function' ? (...args) => fetch(...args) : null;
  const now = env.now || Date.now;

  const subs = new Set(), uiSubs = new Set();
  let state = null;        // { groups, current, me, ui: { mode, speed } }: what is saved
  let preview = null;      // a link's version of a group being looked at, never saved
  let undoState = null;    // { groups, current, me, label } from before the last change
  let steps = null, focus = '', saved = true, lastError = '';
  let rates = null, pending = null, failedAt = -Infinity;

  const read = key => {
    try { return JSON.parse(storage.getItem(key)); } catch { return null; }
  };
  const write = (key, value) => {
    try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  };

  const current = () => state.groups.find(g => g.id === state.current);
  const shown = () => preview || current();
  const save = () => { saved = write(KEY, state); };
  const emit = info => { steps = null; [...subs].forEach(fn => fn(info)); };
  const emitUI = keys => [...uiSubs].forEach(fn => fn(keys));

  function load() {
    const raw = read(KEY), stored = raw && typeof raw === 'object' ? raw : {};
    const groups = [];
    for (const item of Array.isArray(stored.groups) ? stored.groups : []) {
      try {
        const g = sanitizeGroup(item);
        if (!groups.some(x => x.id === g.id) && costOf(g) <= MAX_COST) groups.push(adopt(g));
      } catch { /* a group that cannot be read is left out */ }
    }
    if (!groups.length) groups.push(adopt(structuredClone(EXAMPLE_GROUP)));
    const me = {}, storedMe = stored.me && typeof stored.me === 'object' ? stored.me : {};
    groups.forEach(g => {
      const id = Object.hasOwn(storedMe, g.id) ? storedMe[g.id] : '';
      if (g.people.some(p => p.id === id)) me[g.id] = id;
    });
    const ui = stored.ui && typeof stored.ui === 'object' ? stored.ui : {};
    state = { groups, me, current: groups.some(g => g.id === stored.current) ? stored.current : groups[0].id,
      ui: { mode: MODES.includes(ui.mode) ? ui.mode : 'fewest', speed: typeof ui.speed === 'number' && ui.speed >= 0.1 && ui.speed <= 10 ? ui.speed : 1 } };
    steps = null;
    if (!raw) save();   // a first visit: this also finds out whether the browser lets the page save
  }

  /* ---------- changes and undo ---------- */

  const snapshot = () => ({ groups: structuredClone(state.groups), current: state.current, me: { ...state.me } });
  const restore = snap => { state.groups = snap.groups; state.current = snap.current; state.me = snap.me; steps = null; };

  // Every change to saved data goes through here: copy for undo, change, save, tell.
  function commit(label, work) {
    lastError = '';
    if (preview) return false;
    const before = snapshot();
    try {
      if (work() === false) { restore(before); return false; }
    } catch (e) {
      restore(before);
      if (!(e instanceof Refusal)) throw e;
      lastError = e.message;
      return false;
    }
    undoState = { ...before, label: label || '' };
    save();
    emit({ type: 'change', label: label || '' });
    return true;
  }

  function change(label, fn) {
    let waiting = false;
    const done = commit(label, () => {
      const g = current();
      if (fn(g) === false) return false;
      g.rev = now();
      delete g.example;
      check(g);
      // A currency used for the first time is pinned right here when today's rates are at hand.
      const table = rates && now() - rates.fetchedAt < DAY ? rates : null;
      if (table) pinMissing(g, table); else waiting = missing(g).length > 0;
      return true;
    });
    if (done && waiting) ensurePinned();
    return done;
  }

  function undo() {
    if (!undoState || preview) return false;
    const { label } = undoState;
    restore(undoState);
    undoState = null;
    save();
    emit({ type: 'undo', label });
    return true;
  }

  /* ---------- people, bills, group settings ---------- */

  const person = id => shown().people.find(p => p.id === id);

  function newId(prefix) {
    const g = shown(), taken = new Set([...state.groups.map(x => x.id), g.id, ...g.people.map(p => p.id), ...g.expenses.map(e => e.id)]);
    let id;
    do id = uid(prefix); while (taken.has(id));
    return id;
  }

  function addPerson(name) {
    const clean = tidy(name, MAX_PERSON_NAME), id = newId('p');
    const done = clean !== '' && change('', g => {
      if (g.people.some(p => sameName(p.name, clean))) return false;
      g.people.push({ id, name: clean });
      return true;
    });
    return done ? id : '';
  }

  function renamePerson(id, name) {
    const clean = tidy(name, MAX_PERSON_NAME);
    return clean !== '' && change('', g => {
      const p = g.people.find(x => x.id === id);
      if (!p || p.name === clean || g.people.some(x => x !== p && sameName(x.name, clean))) return false;
      p.name = clean;
      return true;
    });
  }

  function removePerson(id) {
    const p = current().people.find(x => x.id === id);
    if (!p || usedPeopleOf(current()).has(id)) return false;
    return change(p.name + ' removed.', g => {
      g.people = g.people.filter(x => x.id !== id);
      if (state.me[g.id] === id) delete state.me[g.id];
    });
  }

  function saveBill(bill) {
    const copy = structuredClone(bill);
    if (!copy.id) copy.id = newId('e');
    const isNew = !current().expenses.some(e => e.id === copy.id);
    return change((copy.kind === 'payment' ? 'Payment' : 'Bill') + (isNew ? ' added.' : ' saved.'), g => {
      const at = g.expenses.findIndex(e => e.id === copy.id);
      if (at < 0) g.expenses.push(copy); else g.expenses[at] = copy;
    });
  }

  function deleteBill(id) {
    const bill = current().expenses.find(e => e.id === id);
    return !!bill && change((bill.kind === 'payment' ? 'Payment' : 'Bill') + ' deleted.', g => {
      g.expenses = g.expenses.filter(e => e.id !== id);
    });
  }

  function clearBills() {
    const n = current().expenses.length;
    return n > 0 && change(n === 1 ? '1 bill cleared.' : n + ' bills cleared.', g => { g.expenses = []; });
  }

  function renameGroup(name) {
    const clean = tidy(name, MAX_GROUP_NAME);
    return clean !== '' && change('', g => {
      if (g.name === clean) return false;
      g.name = clean;
      return true;
    });
  }

  function setCurrency(code) {
    return CURRENCIES.includes(code) && change('Settling up in ' + code + '.', g => {
      if (g.currency === code) return false;
      g.currency = code;
      return true;
    });
  }

  // A rate typed for the group: 1 code = rate x the group's currency. '' takes it away again.
  function setTypedRate(code, rate) {
    const value = String(rate == null ? '' : rate).trim();
    if (!CURRENCIES.includes(code)) return false;
    if (value && !(/^(?:\d{1,9}(?:\.\d{0,12})?|\.\d{1,12})$/.test(value) && Number(value) > 0)) return false;
    return change('', g => {
      const old = g.rates[code], mine = !!old && old.base === g.currency;
      if (code === g.currency || (value ? mine && old.rate === value : !mine)) return false;
      if (value) g.rates[code] = { rate: value, base: g.currency }; else delete g.rates[code];
      return true;
    });
  }

  /* ---------- groups ---------- */

  const emptyGroup = (name, currency) => ({ id: newId('g'), name, currency, rev: now(), people: [], expenses: [], rates: {} });

  function addGroup(name) {
    const g = emptyGroup(tidy(name, MAX_GROUP_NAME) || 'Group ' + (state.groups.length + 1), current().currency);
    const done = commit('', () => { state.groups.push(g); state.current = g.id; focus = ''; });
    return done ? g.id : '';
  }

  function switchGroup(id) {
    if (!state.groups.some(g => g.id === id) || (id === state.current && !preview)) return false;
    preview = null;
    state.current = id;
    focus = '';
    save();
    emit({ type: 'show', label: '' });
    return true;
  }

  function deleteGroup(id = state.current) {
    const g = state.groups.find(x => x.id === id);
    if (!g) return false;
    // There is always a group to show: deleting the last one leaves an empty one.
    const spare = state.groups.length === 1 ? emptyGroup('My group', g.currency) : null;
    return commit(g.name + ' deleted.', () => {
      state.groups = state.groups.filter(x => x !== g);
      delete state.me[g.id];
      if (spare) state.groups.push(spare);
      if (state.current === g.id) { state.current = state.groups[0].id; focus = ''; }
    });
  }

  /* ---------- this device: how the graph plays, and who "I" is ---------- */

  const validFocus = () => (focus && person(focus) ? focus : '');

  function setUI(patch) {
    const keys = [], ui = state.ui, p = patch || {};
    if (MODES.includes(p.mode) && p.mode !== ui.mode) { ui.mode = p.mode; steps = null; keys.push('mode'); }
    if (typeof p.speed === 'number' && p.speed >= 0.1 && p.speed <= 10 && p.speed !== ui.speed) { ui.speed = p.speed; keys.push('speed'); }
    if ('focus' in p) {
      const next = p.focus && person(p.focus) ? p.focus : '';
      if (next !== validFocus()) keys.push('focus');
      focus = next;
    }
    if (!keys.length) return false;
    if (keys.some(k => k !== 'focus')) save();
    emitUI(keys);
    return true;
  }

  const meOf = g => (g.people.some(p => p.id === state.me[g.id]) ? state.me[g.id] : '');

  function setMe(id) {
    const g = current(), next = id && g.people.some(p => p.id === id) ? id : '';
    if (preview || next === meOf(g)) return false;
    if (next) state.me[g.id] = next; else delete state.me[g.id];
    save();
    emitUI(['me']);
    return true;
  }

  /* ---------- links ---------- */

  function importGroup(raw, how = 'ask') {
    if (how === 'keep') {
      if (!preview) return 'kept';
      if (state.groups.some(g => g.id === preview.id)) state.current = preview.id;
      preview = null;
      focus = '';
      save();
      emit({ type: 'show', label: '' });
      return 'kept';
    }
    const group = raw ? adopt(sanitizeGroup(raw)) : preview;
    if (!group) throw new Error('This link does not hold a group.');
    if (costOf(group) > MAX_COST) throw new Error(TOO_LARGE);
    const local = state.groups.find(g => g.id === group.id);
    const same = !!local && sameContent(local, group);
    // The untouched example is nobody's work, so a link's version of it takes its place without asking.
    const mine = !!local && !local.example;
    if (how !== 'replace' && mine && !same) {
      preview = group;
      focus = '';
      emit({ type: 'show', label: '' });
      return 'differs';
    }
    preview = null;
    focus = '';
    if (how !== 'replace' && same) {
      state.current = local.id;
      save();
      emit({ type: 'show', label: '' });
      return 'same';
    }
    commit(mine ? 'Now using the link’s version of ' + group.name + '.' : group.name + ' was added from the link.', () => {
      if (local) state.groups[state.groups.indexOf(local)] = group; else state.groups.push(group);
      state.current = group.id;
    });
    return mine ? 'replaced' : 'added';
  }

  function reload() {
    undoState = null;
    focus = '';
    load();
    emit({ type: 'show', label: '' });
  }

  /* ---------- exchange rates ---------- */

  async function download() {
    if (typeof fetchFn !== 'function') return null;
    const stop = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = stop ? setTimeout(() => stop.abort(), FETCH_WAIT) : 0;
    try {
      const res = await fetchFn(RATES_URL, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: stop ? stop.signal : undefined });
      const data = res && res.ok ? await res.json() : null;
      if (!data || data.result !== 'success') return null;
      const at = data.time_last_update_unix > 0 ? data.time_last_update_unix * 1000 : now();
      const table = readTable({ fetchedAt: now(), date: new Date(at).toISOString().slice(0, 10), usd: data.rates });
      if (table) { rates = table; write(RATES_KEY, table); }
      return table;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // retry: ask again even if a request has just failed (someone pressed UPDATE RATES).
  async function getRates(retry) {
    const age = rates ? now() - rates.fetchedAt : Infinity;
    if (age >= 0 && age < DAY) return { date: rates.date, usd: rates.usd, source: 'cached', failed: false };
    const sinceFail = now() - failedAt;
    if (retry || !(sinceFail >= 0 && sinceFail < RETRY_WAIT)) {
      if (!pending) pending = download().finally(() => { pending = null; });
      const table = await pending;
      if (table) return { date: table.date, usd: table.usd, source: 'fetched', failed: false };
      failedAt = now();
    }
    // No luck: older saved rates if they are newer than the ones built into the page, else the built-in ones.
    return rates && rates.date > BUILTIN_RATES.date
      ? { date: rates.date, usd: rates.usd, source: 'cached', failed: true }
      : { date: BUILTIN_RATES.date, usd: BUILTIN_RATES.usd, source: 'builtin', failed: true };
  }

  const fetchRates = () => getRates(false);

  async function ensurePinned() {
    const id = state.current;
    if (preview || !missing(current()).length) return false;
    const table = await fetchRates();
    const g = state.groups.find(x => x.id === id);
    if (preview || !g || !pinMissing(g, table)) return false;
    g.rev = now();
    save();
    emit({ type: 'rates', label: '' });
    return true;
  }

  async function updateRates() {
    const id = state.current, table = await getRates(true);
    const g = state.groups.find(x => x.id === id), old = g && g.fx;
    const still = { changed: false, date: old ? old.date : table.date, failed: table.failed };
    // Never back to older rates than the group already has.
    if (preview || !g || !needed(g).length || (old && table.date < old.date)) return still;
    const usd = {};
    needed(g).forEach(c => { usd[c] = table.usd[c] > 0 ? table.usd[c] : isPinned(g, c) ? old.usd[c] : BUILTIN_RATES.usd[c]; });
    const next = { date: table.date, usd };
    if (sameTable(next, old) || state.current !== id) return still;
    const changed = change('Rates updated.', grp => { grp.fx = next; });
    return { changed, date: changed ? next.date : still.date, failed: table.failed };
  }

  rates = readTable(read(RATES_KEY));
  load();

  return {
    get group() { return shown(); },
    get groups() {
      return state.groups.map(g => ({ id: g.id, name: g.name, rev: g.rev, example: g.example === true, people: g.people.length, bills: g.expenses.length }));
    },
    get readOnly() { return preview !== null; },
    get steps() { return steps || (steps = buildSteps(shown(), state.ui.mode)); },
    get ui() { return { mode: state.ui.mode, speed: state.ui.speed, focus: validFocus() }; },
    get me() { return meOf(shown()); },
    get canUndo() { return undoState !== null && !preview; },
    get saved() { return saved; },
    get lastError() { return lastError; },
    person,
    name: id => personName(shown(), id),
    usedPeople: () => usedPeopleOf(shown()),
    newId,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    subscribeUI(fn) { uiSubs.add(fn); return () => uiSubs.delete(fn); },
    change, undo,
    addPerson, renamePerson, removePerson,
    saveBill, deleteBill, clearBills,
    renameGroup, setCurrency, setTypedRate,
    addGroup, switchGroup, deleteGroup,
    setUI, setMe,
    importGroup, reload,
    fetchRates, ensurePinned, updateRates
  };
}
