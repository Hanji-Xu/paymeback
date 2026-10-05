import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_RATES, CURRENCIES, EXAMPLE_GROUP, computeExpense } from '../docs/js/core.js';
import { finalPayments } from '../docs/js/simplify.js';
import { sameContent } from '../docs/js/share.js';
import { createStore } from '../docs/js/store.js';

/* ---------- stand-ins for the browser ---------- */

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); }
  };
}

const brokenStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); }
};

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 10, 12);          // 10 Oct 2026, noon
const UNIX_OCT_10 = Date.UTC(2026, 9, 10) / 1000;

// A clock the test moves by hand.
function clock(start = T0) {
  const c = { t: start, now: () => c.t };
  return c;
}

// Rates as the provider would send them: every built-in rate times `factor`.
function ratesReply(factor = 2, unix = UNIX_OCT_10) {
  const rates = { XXX: 5 };
  for (const code of CURRENCIES) rates[code] = code === 'USD' ? 1 : BUILTIN_RATES.usd[code] * factor;
  return { result: 'success', time_last_update_unix: unix, rates };
}

function fakeFetch(reply) {
  const fn = async url => {
    fn.calls.push(url);
    if (fn.fail) throw new Error('offline');
    return { ok: true, json: async () => (typeof reply === 'function' ? reply() : reply) };
  };
  fn.calls = [];
  fn.fail = false;
  return fn;
}

function make(opts = {}) {
  const storage = 'storage' in opts ? opts.storage : memoryStorage(opts.initial);
  const c = opts.clock || clock();
  const fetch = 'fetch' in opts ? opts.fetch : fakeFetch(ratesReply());
  const store = createStore({ storage, fetch, now: c.now });
  const events = [], uiEvents = [];
  store.subscribe(e => events.push(e));
  store.subscribeUI(keys => uiEvents.push(keys));
  return { store, storage, clock: c, fetch, events, uiEvents };
}

const saved = storage => JSON.parse(storage.getItem('settle.v1'));
const person = (id, name) => ({ id, name });
const expense = (id, title, amount, currency, payer, who) => ({ id, kind: 'expense', title, amount, currency,
  paid: { mode: 'single', who: [payer], values: {} },
  split: { mode: 'equal', who, values: {}, items: [], tax: '', tip: '' } });
const plainGroup = (id = 'g-flat', name = 'Flat') => ({ id, name, currency: 'USD', rev: 5,
  people: [person('p-a', 'Ana'), person('p-b', 'Ben')],
  expenses: [expense('e-a', 'Rent', '100', 'USD', 'p-a', ['p-a', 'p-b'])], rates: {} });
const totals = store => store.group.expenses.map(e => computeExpense(store.group, e).total);
const settle = () => new Promise(r => setTimeout(r, 0));

/* ---------- loading ---------- */

test('a first visit opens the example and saves it', () => {
  const { store, storage } = make();
  assert.equal(store.group.id, 'g-lisbon');
  assert.equal(store.group.example, true);
  assert.equal(store.group.expenses.length, 6);
  assert.equal(store.saved, true);
  assert.equal(saved(storage).current, 'g-lisbon');
  assert.deepEqual(saved(storage).ui, { mode: 'fewest', speed: 1 });
  assert.equal(store.canUndo, false);
  assert.equal(store.readOnly, false);
});

test('the example is a copy: changing it leaves EXAMPLE_GROUP alone', () => {
  const { store } = make();
  store.change('', g => { g.name = 'Mine'; });
  assert.equal(EXAMPLE_GROUP.name, 'Lisbon trip (example)');
  assert.equal(store.group.name, 'Mine');
});

test('the example gives the plan of SPEC section 5, with its rates pinned at the built-in numbers', () => {
  const { store } = make();
  assert.deepEqual(store.group.fx, { date: BUILTIN_RATES.date, usd: { EUR: BUILTIN_RATES.usd.EUR } });
  assert.deepEqual(finalPayments(store.steps), [['p-ben', 'p-eli', 10410], ['p-cy', 'p-eli', 6909], ['p-dee', 'p-ana', 12300], ['p-dee', 'p-eli', 11273]]);
  assert.equal(store.steps.length, 23);
  store.setUI({ mode: 'keep' });
  assert.equal(store.steps.length, 22);
  // Pinning what was in use changes no bill.
  const fresh = structuredClone(EXAMPLE_GROUP);
  assert.deepEqual(totals(store), fresh.expenses.map(e => computeExpense(fresh, e).total));
});

test('unreadable saved data falls back to the example', () => {
  for (const text of ['{not json', '42', 'null', '{"groups":"x"}', '{"groups":[]}', '{"groups":[{"id":"g-x"}]}', '{"groups":[null,7,"x"]}']) {
    const { store } = make({ initial: { 'settle.v1': text } });
    assert.equal(store.group.id, 'g-lisbon', text);
  }
});

test('saved groups go through the gate: bad ones are left out, good ones are cleaned', () => {
  const good = plainGroup();
  good.name = '  <b>Flat</b>\n';
  good.people.push({ id: 'p-c', name: 'x'.repeat(100) });
  good.__proto__ = { hacked: true };
  const initial = { 'settle.v1': JSON.stringify({ groups: [{ id: 'g-bad', currency: 'ZZZ', people: [] }, good, plainGroup('g-flat', 'Same id again')],
    current: 'g-nowhere', me: { 'g-flat': 'p-zz', 'g-gone': 'p-a' }, ui: { mode: 'sideways', speed: 'fast' } }) };
  const { store } = make({ initial });
  assert.deepEqual(store.groups.map(g => g.id), ['g-flat']);
  assert.equal(store.group.name, '<b>Flat</b>');
  assert.equal(store.group.people[2].name.length, 40);
  assert.equal(store.me, '');
  assert.deepEqual(store.ui, { mode: 'fewest', speed: 1, focus: '' });
});

test('saved choices come back: current group, me, mode and speed', () => {
  const a = plainGroup('g-one', 'One'), b = plainGroup('g-two', 'Two');
  const initial = { 'settle.v1': JSON.stringify({ groups: [a, b], current: 'g-two', me: { 'g-two': 'p-b' }, ui: { mode: 'keep', speed: 1.8 } }) };
  const { store } = make({ initial });
  assert.equal(store.group.id, 'g-two');
  assert.equal(store.me, 'p-b');
  assert.deepEqual(store.ui, { mode: 'keep', speed: 1.8, focus: '' });
  assert.deepEqual(store.groups.map(g => [g.id, g.name, g.people, g.bills]), [['g-one', 'One', 2, 1], ['g-two', 'Two', 2, 1]]);
});

test('a browser that refuses storage still works, and says so', () => {
  const { store } = make({ storage: brokenStorage });
  assert.equal(store.group.id, 'g-lisbon');
  assert.equal(store.saved, false);
  assert.equal(store.addPerson('Fay') !== '', true);
  assert.equal(store.group.people.length, 6);
  assert.equal(store.saved, false);
  const none = make({ storage: null });
  assert.equal(none.store.group.id, 'g-lisbon');
  assert.equal(none.store.saved, false);
});

/* ---------- change and undo ---------- */

test('change stamps, drops the example mark, saves and tells once', () => {
  const { store, storage, clock: c, events } = make();
  c.t = T0 + 1234;
  const done = store.change('Renamed.', g => { g.name = 'Lisbon'; });
  assert.equal(done, true);
  assert.equal(store.group.rev, T0 + 1234);
  assert.equal('example' in store.group, false);
  assert.deepEqual(events, [{ type: 'change', label: 'Renamed.' }]);
  assert.equal(saved(storage).groups[0].name, 'Lisbon');
  assert.equal(saved(storage).groups[0].rev, T0 + 1234);
  assert.equal(store.canUndo, true);
});

test('listeners are told after the save, and can stop listening', () => {
  const { store, storage } = make();
  let seen = null;
  const stop = store.subscribe(() => { seen = saved(storage).groups[0].name; });
  store.change('', g => { g.name = 'First'; });
  assert.equal(seen, 'First');
  stop();
  store.change('', g => { g.name = 'Second'; });
  assert.equal(seen, 'First');
});

test('a change that calls itself off does nothing', () => {
  const { store, storage, events } = make();
  const before = storage.getItem('settle.v1');
  assert.equal(store.change('Nope.', () => false), false);
  assert.deepEqual(events, []);
  assert.equal(storage.getItem('settle.v1'), before);
  assert.equal(store.group.example, true);
  assert.equal(store.canUndo, false);
});

test('undo puts back the group as it was, once', () => {
  const { store, storage, events } = make();
  store.deleteBill('e-1');
  assert.equal(store.group.expenses.length, 5);
  assert.deepEqual(events.at(-1), { type: 'change', label: 'Bill deleted.' });
  assert.equal(store.undo(), true);
  assert.equal(store.group.expenses.length, 6);
  assert.equal(store.group.expenses[0].id, 'e-1');
  assert.equal(store.group.example, true);
  assert.equal(store.group.rev, 0);
  assert.deepEqual(events.at(-1), { type: 'undo', label: 'Bill deleted.' });
  assert.equal(saved(storage).groups[0].expenses.length, 6);
  assert.equal(store.undo(), false);
  assert.equal(events.length, 2);
});

test('undo is one level: only the last change comes back', () => {
  const { store } = make();
  store.deleteBill('e-1');
  store.deleteBill('e-2');
  store.undo();
  assert.deepEqual(store.group.expenses.map(e => e.id), ['e-2', 'e-3', 'e-4', 'e-5', 'e-6']);
  assert.equal(store.undo(), false);
});

test('undo works across groups: a deleted group comes back and is shown again', () => {
  const { store } = make();
  store.setMe('p-ana');
  const second = store.addGroup('Flat');
  store.switchGroup('g-lisbon');
  assert.equal(store.deleteGroup(), true);
  assert.deepEqual(store.groups.map(g => g.id), [second]);
  assert.equal(store.group.id, second);
  store.undo();
  assert.deepEqual(store.groups.map(g => g.id), ['g-lisbon', second]);
  assert.equal(store.group.id, 'g-lisbon');
  assert.equal(store.me, 'p-ana');
});

test('a change past the limits is rolled back with a reason', () => {
  const { store, events } = make();
  const done = store.change('Too many.', g => { for (let i = 0; i < 200; i++) g.people.push({ id: 'p-n' + i, name: 'N' + i }); });
  assert.equal(done, false);
  assert.match(store.lastError, /too many people/);
  assert.equal(store.group.people.length, 5);
  assert.equal(store.group.example, true);
  assert.deepEqual(events, []);
  store.addPerson('Fay');
  assert.equal(store.lastError, '');
});

test('a group with more debts than the page can draw is refused', () => {
  const { store } = make();
  const people = Array.from({ length: 40 }, (_, i) => person('p-n' + i, 'N' + i));
  const bills = people.map((p, i) => expense('e-n' + i, 'B' + i, '400', 'USD', p.id, people.map(x => x.id)));
  assert.equal(store.change('', g => { g.people = people; g.expenses = bills; }), false);
  assert.match(store.lastError, /more debts/);
  assert.equal(store.group.people.length, 5);
  assert.throws(() => store.importGroup({ id: 'g-big', name: 'Big', currency: 'USD', rev: 1, people, expenses: bills, rates: {} }), /more debts/);
  assert.deepEqual(store.groups.map(g => g.id), ['g-lisbon']);
});

test('a mistake inside a change leaves the data as it was', () => {
  const { store, events } = make();
  assert.throws(() => store.change('', g => { g.people.pop(); throw new TypeError('oops'); }), TypeError);
  assert.equal(store.group.people.length, 5);
  assert.deepEqual(events, []);
});

/* ---------- people and bills ---------- */

test('people: add, rename, remove', () => {
  const { store } = make();
  const id = store.addPerson('  Fay   Wray ');
  assert.match(id, /^p-[a-z0-9]{7}$/);
  assert.equal(store.name(id), 'Fay Wray');
  assert.deepEqual(store.person(id), { id, name: 'Fay Wray' });
  assert.equal(store.addPerson('fay wray'), '', 'the same name twice is refused');
  assert.equal(store.addPerson('   '), '');
  assert.equal(store.renamePerson(id, 'ANA'), false, 'a name someone else has');
  assert.equal(store.renamePerson(id, 'Faye'), true);
  assert.equal(store.renamePerson('p-ana', 'ana'), true, 'changing only the case of your own name is fine');
  assert.equal(store.name('p-nobody'), '?');
  assert.equal(store.usedPeople().has('p-ana'), true);
  assert.equal(store.usedPeople().has(id), false);
  assert.equal(store.removePerson('p-ana'), false, 'someone on a bill stays');
  assert.equal(store.removePerson(id), true);
  assert.equal(store.person(id), undefined);
});

test('removing the person who is "me" forgets that, and undo remembers it again', () => {
  const { store, events, uiEvents } = make();
  const id = store.addPerson('Fay');
  assert.equal(store.setMe(id), true);
  assert.deepEqual(uiEvents, [['me']]);
  assert.equal(store.setMe(id), false);
  assert.equal(store.setMe('p-nobody'), true, 'an unknown person means nobody');
  assert.equal(store.me, '');
  store.setMe(id);
  store.removePerson(id);
  assert.equal(events.at(-1).label, 'Fay removed.');
  assert.equal(store.me, '');
  store.undo();
  assert.equal(store.me, id);
});

test('usedPeople sees payers, sharers, people on items and both ends of a payment', () => {
  const { store } = make();
  assert.deepEqual([...store.usedPeople()].sort(), ['p-ana', 'p-ben', 'p-cy', 'p-dee', 'p-eli']);
  store.change('', g => { g.expenses = g.expenses.filter(e => e.id === 'e-3'); });
  assert.deepEqual([...store.usedPeople()].sort(), ['p-ana', 'p-ben', 'p-cy', 'p-dee', 'p-eli']);
  store.change('', g => { g.expenses = [{ id: 'e-9', kind: 'payment', title: 'x', amount: '5', currency: 'USD', from: 'p-cy', to: 'p-ana' }]; });
  assert.deepEqual([...store.usedPeople()].sort(), ['p-ana', 'p-cy']);
});

test('bills: save adds or replaces a copy, delete and clear say what they did', () => {
  const { store, events } = make();
  const bill = expense('', 'Taxi', '30', 'USD', 'p-ana', ['p-ana', 'p-ben']);
  assert.equal(store.saveBill(bill), true);
  assert.equal(bill.id, '', 'the caller’s object is not touched');
  const stored = store.group.expenses.at(-1);
  assert.match(stored.id, /^e-[a-z0-9]{7}$/);
  assert.equal(events.at(-1).label, 'Bill added.');
  store.saveBill({ ...stored, amount: '45' });
  assert.equal(store.group.expenses.length, 7);
  assert.equal(store.group.expenses.at(-1).amount, '45');
  assert.equal(events.at(-1).label, 'Bill saved.');
  store.saveBill({ id: 'e-pay', kind: 'payment', title: 'Back', amount: '5', currency: 'USD', from: 'p-ben', to: 'p-ana' });
  assert.equal(events.at(-1).label, 'Payment added.');
  store.deleteBill('e-pay');
  assert.equal(events.at(-1).label, 'Payment deleted.');
  assert.equal(store.deleteBill('e-nowhere'), false);
  assert.equal(store.clearBills(), true);
  assert.equal(events.at(-1).label, '7 bills cleared.');
  assert.equal(store.clearBills(), false);
  store.undo();
  assert.equal(store.group.expenses.length, 7);
});

test('newId never repeats an id of the group', () => {
  const { store } = make();
  const taken = new Set(['g-lisbon', ...store.group.people.map(p => p.id), ...store.group.expenses.map(e => e.id)]);
  for (let i = 0; i < 50; i++) {
    const id = store.newId('e');
    assert.match(id, /^e-[a-z0-9]{7}$/);
    assert.equal(taken.has(id), false);
  }
});

/* ---------- groups ---------- */

test('groups: add, switch, rename, delete', () => {
  const { store, storage, events } = make();
  const id = store.addGroup('  Flat  ');
  assert.equal(store.group.id, id);
  assert.deepEqual({ ...store.group, id: 0, rev: 0 }, { id: 0, name: 'Flat', currency: 'USD', rev: 0, people: [], expenses: [], rates: {} });
  assert.equal(saved(storage).current, id);
  assert.equal(store.groups[0].example, true, 'adding a group does not touch the example');
  assert.equal(store.addGroup(''), store.group.id);
  assert.equal(store.group.name, 'Group 3');
  assert.equal(store.switchGroup('g-nowhere'), false);
  assert.equal(store.switchGroup(id), true);
  assert.deepEqual(events.at(-1), { type: 'show', label: '' });
  assert.equal(store.switchGroup(id), false);
  assert.equal(store.renameGroup('  '), false);
  assert.equal(store.renameGroup('Flat'), false);
  assert.equal(store.renameGroup('x'.repeat(100)), true);
  assert.equal(store.group.name.length, 60);
  assert.equal(store.deleteGroup(id), true);
  assert.equal(events.at(-1).label, 'x'.repeat(60) + ' deleted.');
  assert.equal(store.group.id, 'g-lisbon');
  assert.equal(store.deleteGroup('g-nowhere'), false);
});

test('deleting the last group leaves an empty one', () => {
  const { store } = make({ initial: { 'settle.v1': JSON.stringify({ groups: [{ ...plainGroup(), currency: 'EUR' }], current: 'g-flat' }) } });
  assert.equal(store.deleteGroup(), true);
  assert.equal(store.groups.length, 1);
  assert.equal(store.group.name, 'My group');
  assert.equal(store.group.currency, 'EUR');
  assert.equal(store.group.people.length, 0);
});

/* ---------- this device ---------- */

test('ui: mode and speed are saved, focus is not, and each change is told with its keys', () => {
  const { store, storage, uiEvents, events } = make();
  assert.equal(store.setUI({ mode: 'keep', speed: 1.8, focus: 'p-ben' }), true);
  assert.deepEqual(uiEvents, [['mode', 'speed', 'focus']]);
  assert.deepEqual(store.ui, { mode: 'keep', speed: 1.8, focus: 'p-ben' });
  assert.deepEqual(saved(storage).ui, { mode: 'keep', speed: 1.8 });
  assert.equal(store.setUI({ mode: 'keep', speed: 1.8, focus: 'p-ben' }), false);
  assert.equal(store.setUI({ mode: 'bogus', speed: -3 }), false);
  assert.equal(store.setUI({ focus: 'p-nobody' }), true);
  assert.equal(store.ui.focus, '');
  assert.deepEqual(events, [], 'ui changes are not data changes');
  store.setUI({ focus: 'p-ben' });
  store.addGroup('Other');
  assert.equal(store.ui.focus, '', 'another group, nobody followed');
});

test('steps are worked out once per change and again when the mode changes', () => {
  const { store } = make();
  const first = store.steps;
  assert.equal(store.steps, first);
  store.setUI({ speed: 0.6 });
  assert.equal(store.steps, first);
  store.setUI({ mode: 'keep' });
  assert.notEqual(store.steps, first);
  const keep = store.steps;
  store.deleteBill('e-6');
  assert.notEqual(store.steps, keep);
  assert.equal(store.steps.bills.has('e-6'), false);
});

/* ---------- links ---------- */

test('a link to a group this browser does not have adds it and shows it', () => {
  const { store, storage, events } = make();
  const incoming = plainGroup();
  assert.equal(store.importGroup(incoming), 'added');
  assert.equal(store.group.id, 'g-flat');
  assert.equal(store.group.rev, 5, 'the link’s own time of last change is kept');
  assert.notEqual(store.group, incoming);
  assert.deepEqual(saved(storage).groups.map(g => g.id), ['g-lisbon', 'g-flat']);
  assert.deepEqual(events, [{ type: 'change', label: 'Flat was added from the link.' }]);
  store.undo();
  assert.deepEqual(store.groups.map(g => g.id), ['g-lisbon']);
});

test('a link with the same content just shows the group', () => {
  const { store, storage, events } = make();
  store.addGroup('Other');
  const before = storage.getItem('settle.v1');
  assert.equal(store.importGroup({ ...structuredClone(EXAMPLE_GROUP), rev: 99 }), 'same');
  assert.equal(store.group.id, 'g-lisbon');
  assert.equal(store.group.rev, 0);
  assert.equal(store.readOnly, false);
  assert.deepEqual(events.at(-1), { type: 'show', label: '' });
  assert.deepEqual(saved(storage).groups, JSON.parse(before).groups);
});

test('a link with another version of the untouched example takes its place without asking', () => {
  const { store, events } = make();
  const theirs = structuredClone(EXAMPLE_GROUP);
  delete theirs.example;
  theirs.name = 'Lisbon 2026';
  theirs.rev = 77;
  assert.equal(store.importGroup(theirs), 'added');
  assert.equal(store.readOnly, false);
  assert.equal(store.group.name, 'Lisbon 2026');
  assert.deepEqual(store.groups.map(g => g.id), ['g-lisbon']);
  assert.equal(events.at(-1).label, 'Lisbon 2026 was added from the link.');
  store.undo();
  assert.equal(store.group.example, true);
});

// The example once it has been worked on: it is the reader's own group from then on.
function makeMine() {
  const made = make();
  made.store.renamePerson('p-eli', 'Elias');
  made.events.length = 0;
  return made;
}

test('a link with a different version is shown read-only until a choice is made', () => {
  const { store, storage, events } = makeMine();
  store.setMe('p-ana');
  const theirs = structuredClone(EXAMPLE_GROUP);
  theirs.expenses.pop();
  theirs.rev = 77;
  const before = storage.getItem('settle.v1');
  assert.equal(store.importGroup(theirs), 'differs');
  assert.equal(store.readOnly, true);
  assert.equal(store.group.expenses.length, 5);
  assert.equal(store.steps.bills.size, 5);
  assert.equal(store.me, 'p-ana');
  assert.equal(storage.getItem('settle.v1'), before, 'nothing is saved while looking');
  assert.equal(store.groups[0].bills, 6);
  // Nothing can be changed while looking.
  assert.equal(store.change('', g => { g.name = 'x'; }), false);
  assert.equal(store.addPerson('Fay'), '');
  assert.equal(store.deleteBill('e-1'), false);
  assert.equal(store.addGroup('x'), '');
  assert.equal(store.deleteGroup(), false);
  assert.equal(store.undo(), false);
  assert.equal(store.canUndo, false);
  assert.equal(store.setMe('p-ben'), false);
  assert.equal(storage.getItem('settle.v1'), before);

  assert.equal(store.importGroup(null, 'keep'), 'kept');
  assert.equal(store.readOnly, false);
  assert.equal(store.group.expenses.length, 6);
  assert.deepEqual(events.at(-1), { type: 'show', label: '' });

  assert.equal(store.importGroup(theirs), 'differs');
  assert.equal(store.importGroup(null, 'replace'), 'replaced');
  assert.equal(store.readOnly, false);
  assert.equal(store.group.expenses.length, 5);
  assert.equal(store.group.rev, 77);
  assert.equal(saved(storage).groups[0].expenses.length, 5);
  assert.equal(events.at(-1).label, 'Now using the link’s version of Lisbon trip (example).');
  assert.equal(store.name('p-eli'), 'Eli');
  store.undo();
  assert.equal(store.group.expenses.length, 6, 'replacing can be undone');
  assert.equal(store.name('p-eli'), 'Elias');
});

test('keeping mine shows my version of that group, and switching groups also ends the look', () => {
  const { store } = makeMine();
  store.addGroup('Other');
  const theirs = structuredClone(EXAMPLE_GROUP);
  theirs.name = 'Theirs';
  assert.equal(store.importGroup(theirs), 'differs');
  assert.equal(store.group.name, 'Theirs');
  store.importGroup(null, 'keep');
  assert.equal(store.group.name, 'Lisbon trip (example)');
  assert.equal(store.name('p-eli'), 'Elias');
  store.importGroup(theirs);
  assert.equal(store.switchGroup('g-lisbon'), true);
  assert.equal(store.readOnly, false);
  assert.equal(store.name('p-eli'), 'Elias');
});

test('what comes in from a link is checked again', () => {
  const { store } = make();
  assert.throws(() => store.importGroup({ nope: true }), /does not look like a group/);
  assert.throws(() => store.importGroup(null), /does not hold a group/);
  const odd = plainGroup();
  odd.people[0].name = '<img src=x onerror=alert(1)>';
  odd.extra = 'dropped';
  store.importGroup(odd);
  assert.equal(store.group.people[0].name, '<img src=x onerror=alert(1)>');
  assert.equal('extra' in store.group, false);
});

test('reload reads what another tab saved', () => {
  const storage = memoryStorage();
  const a = make({ storage }), b = make({ storage });
  a.store.addPerson('Fay');
  assert.equal(b.store.group.people.length, 5);
  b.store.reload();
  assert.equal(b.store.group.people.length, 6);
  assert.deepEqual(b.events, [{ type: 'show', label: '' }]);
  assert.equal(b.store.canUndo, false);
});

/* ---------- rates: fetching ---------- */

test('fetchRates asks once a day at most and keeps the answer on this device', async () => {
  const { store, storage, fetch, clock: c } = make();
  const first = await store.fetchRates();
  assert.equal(first.source, 'fetched');
  assert.equal(first.failed, false);
  assert.equal(first.date, '2026-10-10');
  assert.equal(first.usd.EUR, BUILTIN_RATES.usd.EUR * 2);
  assert.equal(first.usd.USD, 1);
  assert.equal('XXX' in first.usd, false, 'only currencies the page knows are kept');
  assert.deepEqual(fetch.calls, ['https://open.er-api.com/v6/latest/USD']);
  const kept = JSON.parse(storage.getItem('settle.rates'));
  assert.equal(kept.fetchedAt, T0);
  assert.equal(kept.date, '2026-10-10');
  assert.equal(Object.keys(kept.usd).length, CURRENCIES.length);

  c.t = T0 + DAY - 1;
  const second = await store.fetchRates();
  assert.equal(second.source, 'cached');
  assert.equal(fetch.calls.length, 1);

  c.t = T0 + DAY;
  assert.equal((await store.fetchRates()).source, 'fetched');
  assert.equal(fetch.calls.length, 2);
});

test('rates kept by an earlier visit are used without asking again', async () => {
  const one = make();
  await one.store.fetchRates();
  const two = make({ storage: one.storage, clock: clock(T0 + 1000) });
  assert.equal((await two.store.fetchRates()).source, 'cached');
  assert.equal(two.fetch.calls.length, 0);
});

test('two calls at once share one request', async () => {
  const { store, fetch } = make();
  const [a, b] = await Promise.all([store.fetchRates(), store.fetchRates()]);
  assert.equal(fetch.calls.length, 1);
  assert.equal(a.source, 'fetched');
  assert.equal(b.source, 'fetched');
});

test('fetchRates never throws: offline, a bad answer or no fetch at all give the built-in rates', async () => {
  const offline = fakeFetch(ratesReply());
  offline.fail = true;
  const replies = [offline, fakeFetch({ result: 'error' }), fakeFetch('nonsense'), fakeFetch({ result: 'success', rates: { EUR: 'x' } }),
    fakeFetch(() => { throw new SyntaxError('bad json'); }), async () => ({ ok: false, json: async () => ratesReply() }), null];
  for (const fetch of replies) {
    const { store, storage } = make({ fetch });
    const got = await store.fetchRates();
    assert.deepEqual({ source: got.source, failed: got.failed, date: got.date }, { source: 'builtin', failed: true, date: BUILTIN_RATES.date });
    assert.equal(got.usd.EUR, BUILTIN_RATES.usd.EUR);
    assert.equal(storage.getItem('settle.rates'), null);
  }
});

test('when a new request fails, rates kept from before are used if they are newer than the built-in ones', async () => {
  const { store, fetch, clock: c } = make();
  await store.fetchRates();
  c.t = T0 + 3 * DAY;
  fetch.fail = true;
  const got = await store.fetchRates();
  assert.deepEqual({ source: got.source, failed: got.failed, date: got.date }, { source: 'cached', failed: true, date: '2026-10-10' });
});

test('a failed request is not repeated for a minute, unless UPDATE RATES is pressed', async () => {
  const { store, fetch, clock: c } = make();
  fetch.fail = true;
  assert.equal((await store.fetchRates()).failed, true);
  assert.equal((await store.fetchRates()).failed, true);
  assert.equal(fetch.calls.length, 1);
  store.saveBill(expense('e-yen', 'Ramen', '3000', 'JPY', 'p-ana', ['p-ana', 'p-ben']));
  await settle();
  assert.equal(fetch.calls.length, 1);
  assert.equal(store.group.fx.usd.JPY, BUILTIN_RATES.usd.JPY, 'the new currency is still pinned, at the built-in rate');
  assert.equal((await store.updateRates()).failed, true);
  assert.equal(fetch.calls.length, 2, 'pressing UPDATE RATES asks again at once');
  c.t = T0 + 60000;
  fetch.fail = false;
  assert.equal((await store.fetchRates()).source, 'fetched');
  assert.equal(fetch.calls.length, 3);
});

test('kept rates that cannot be read are ignored', async () => {
  for (const text of ['{bad', '{"fetchedAt":"now","date":"2026-10-10","usd":{"EUR":1}}', '{"fetchedAt":1,"date":"soon","usd":{"EUR":1}}', '{"fetchedAt":1,"date":"2026-10-10","usd":{"EUR":"1"}}']) {
    const { store, fetch } = make({ initial: { 'settle.rates': text } });
    assert.equal((await store.fetchRates()).source, 'fetched', text);
    assert.equal(fetch.calls.length, 1);
  }
});

/* ---------- rates: pinning ---------- */

const yenBill = (id = 'e-yen') => expense(id, 'Ramen', '3000', 'JPY', 'p-a', ['p-a', 'p-b']);
const FRESH = 2;   // the made-up provider's rates are the built-in ones times this

// A group of the reader's own: one USD bill and one EUR bill. `fx` is its pinned table, if it has one.
function ownGroup(fx) {
  const g = plainGroup();
  g.expenses.push(expense('e-eur', 'Hotel', '100', 'EUR', 'p-a', ['p-a', 'p-b']));
  if (fx) g.fx = fx;
  return { initial: { 'settle.v1': JSON.stringify({ groups: [g], current: 'g-flat' }) } };
}

test('a currency used for the first time is pinned in the same change when today’s rates are at hand', async () => {
  const { store, events } = make(ownGroup({ date: '2026-10-10', usd: { EUR: 0.9 } }));
  await store.fetchRates();
  const before = totals(store);
  store.saveBill(yenBill());
  assert.deepEqual(events.map(e => e.type), ['change']);
  assert.deepEqual(store.group.fx, { date: '2026-10-10', usd: { EUR: 0.9, JPY: BUILTIN_RATES.usd.JPY * FRESH } });
  assert.deepEqual(totals(store).slice(0, 2), before, 'bills that were there keep their numbers');
  const r = computeExpense(store.group, store.group.expenses.at(-1));
  assert.equal(r.rateSource, 'pinned');
  assert.equal(r.rateDate, '2026-10-10');
  assert.equal(r.total, Math.round(3000 / (BUILTIN_RATES.usd.JPY * FRESH) * 100));
  store.undo();
  assert.deepEqual(store.group.fx, { date: '2026-10-10', usd: { EUR: 0.9 } }, 'undo takes the pin back too');
});

test('without today’s rates the pin follows as soon as they arrive, and joins the same undo step', async () => {
  const { store, storage, fetch, events } = make(ownGroup({ date: '2026-10-10', usd: { EUR: 0.9 } }));
  store.saveBill(yenBill());
  assert.equal('JPY' in store.group.fx.usd, false);
  await settle();
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(store.group.fx, { date: '2026-10-10', usd: { EUR: 0.9, JPY: BUILTIN_RATES.usd.JPY * FRESH } });
  assert.deepEqual(events.map(e => e.type), ['change', 'rates']);
  assert.equal(saved(storage).groups[0].fx.usd.JPY, BUILTIN_RATES.usd.JPY * FRESH);
  assert.equal(store.canUndo, true);
  store.undo();
  assert.equal(store.group.expenses.length, 2);
  assert.equal('JPY' in store.group.fx.usd, false);
});

test('one date stands for the whole table: a currency that joins takes that day’s rate where the device has it', async () => {
  // The example runs on the built-in table. A new currency joins from that table, not from today's.
  const example = make();
  await example.store.fetchRates();
  example.store.saveBill(expense('e-yen', 'Ramen', '3000', 'JPY', 'p-ana', ['p-ana', 'p-ben']));
  assert.deepEqual(example.store.group.fx, { date: BUILTIN_RATES.date, usd: { EUR: BUILTIN_RATES.usd.EUR, JPY: BUILTIN_RATES.usd.JPY } });
  // A table from a day this device has no rates for: the freshest rate joins, and the date stays.
  const older = make(ownGroup({ date: '2026-09-01', usd: { EUR: 0.9 } }));
  await older.store.fetchRates();
  older.store.saveBill(yenBill());
  assert.deepEqual(older.store.group.fx, { date: '2026-09-01', usd: { EUR: 0.9, JPY: BUILTIN_RATES.usd.JPY * FRESH } });
});

test('a pinned rate stays when its bills are gone, so the same currency comes back at the same rate', async () => {
  const { store } = make(ownGroup({ date: '2026-09-01', usd: { EUR: 0.9 } }));
  await store.fetchRates();
  const before = totals(store);
  store.deleteBill('e-eur');
  assert.deepEqual(store.group.fx, { date: '2026-09-01', usd: { EUR: 0.9 } });
  store.saveBill(expense('e-eur', 'Hotel', '100', 'EUR', 'p-a', ['p-a', 'p-b']));
  assert.deepEqual(totals(store), before);
});

test('offline, a new currency is pinned at the built-in rate', async () => {
  const fetch = fakeFetch(ratesReply());
  fetch.fail = true;
  const { store } = make({ fetch, ...ownGroup() });
  store.saveBill(yenBill());
  await settle();
  assert.equal(store.group.fx.usd.JPY, BUILTIN_RATES.usd.JPY);
  assert.equal(store.group.fx.date, BUILTIN_RATES.date);
  assert.equal(await store.ensurePinned(), false, 'nothing left to pin');
});

test('a group with no foreign bills has no pinned table, and its first one gets today’s date', async () => {
  const { store } = make({ initial: { 'settle.v1': JSON.stringify({ groups: [plainGroup()], current: 'g-flat' }) } });
  assert.equal('fx' in store.group, false);
  await store.fetchRates();
  store.saveBill(yenBill());
  assert.deepEqual(store.group.fx, { date: '2026-10-10', usd: { JPY: BUILTIN_RATES.usd.JPY * FRESH } });
});

test('changing the settle-up currency pins it, and USD is never stored', async () => {
  const { store } = make(ownGroup({ date: '2026-10-10', usd: { EUR: 0.9 } }));
  await store.fetchRates();
  assert.equal(store.setCurrency('GBP'), true);
  assert.deepEqual(store.group.fx, { date: '2026-10-10', usd: { EUR: 0.9, GBP: BUILTIN_RATES.usd.GBP * FRESH } });
  assert.equal(store.setCurrency('GBP'), false);
  assert.equal(store.setCurrency('ZZZ'), false);
  const r = computeExpense(store.group, store.group.expenses[0]);   // the USD bill
  assert.equal(r.rateSource, 'pinned');
  assert.equal(r.rate, BUILTIN_RATES.usd.GBP * FRESH);
});

test('ensurePinned can be called at any time and only acts when something is missing', async () => {
  const { store, fetch, events } = make();
  assert.equal(await store.ensurePinned(), false);
  assert.equal(fetch.calls.length, 0, 'no request when nothing is missing');
  assert.deepEqual(events, []);
});

test('a saved group with an unpinned currency is pinned at the built-in rate it was running on', () => {
  const g = plainGroup();
  g.expenses.push(expense('e-eur', 'Hotel', '100', 'EUR', 'p-a', ['p-a', 'p-b']));
  const bare = structuredClone(g);
  const { store } = make({ initial: { 'settle.v1': JSON.stringify({ groups: [g], current: 'g-flat' }) } });
  assert.deepEqual(store.group.fx, { date: BUILTIN_RATES.date, usd: { EUR: BUILTIN_RATES.usd.EUR } });
  assert.deepEqual(totals(store), bare.expenses.map(e => computeExpense(bare, e).total));
});

test('updateRates pins every used currency again, and can be undone', async () => {
  const { store, events } = make();
  const before = totals(store);
  const res = await store.updateRates();
  assert.deepEqual(res, { changed: true, date: '2026-10-10', failed: false });
  assert.deepEqual(store.group.fx, { date: '2026-10-10', usd: { EUR: BUILTIN_RATES.usd.EUR * 2 } });
  assert.equal(events.at(-1).label, 'Rates updated.');
  assert.notDeepEqual(totals(store), before);
  assert.deepEqual(await store.updateRates(), { changed: false, date: '2026-10-10', failed: false }, 'a second press changes nothing');
  assert.equal(events.length, 1);
  store.undo();
  assert.deepEqual(totals(store), before);
});

test('updateRates offline keeps what the group has and says the request failed', async () => {
  const { store, fetch, clock: c, events } = make();
  await store.updateRates();
  c.t = T0 + 2 * DAY;
  fetch.fail = true;
  const n = events.length;
  assert.deepEqual(await store.updateRates(), { changed: false, date: '2026-10-10', failed: true });
  assert.equal(events.length, n);
  // And never back to older rates: here the only table at hand is the built-in one, which is older.
  const cold = make({ fetch, storage: memoryStorage({ 'settle.v1': JSON.stringify({ groups: [store.group], current: 'g-lisbon' }) }) });
  assert.deepEqual(await cold.store.updateRates(), { changed: false, date: '2026-10-10', failed: true });
  assert.equal(cold.store.group.fx.usd.EUR, BUILTIN_RATES.usd.EUR * 2);
});

test('updateRates does nothing for a group with no foreign bills', async () => {
  const { store } = make({ initial: { 'settle.v1': JSON.stringify({ groups: [plainGroup()], current: 'g-flat' }) } });
  assert.equal((await store.updateRates()).changed, false);
  assert.equal('fx' in store.group, false);
});

test('typed rates: set, change, clear, and only plain numbers', () => {
  const { store } = make();
  assert.equal(store.setTypedRate('EUR', '1.25'), true);
  assert.deepEqual(store.group.rates, { EUR: { rate: '1.25', base: 'USD' } });
  assert.equal(computeExpense(store.group, store.group.expenses[0]).rateSource, 'manual');
  assert.equal(store.setTypedRate('EUR', '1.25'), false);
  for (const bad of ['1,25', 'abc', '-2', '0', '1e5', '1.2.3', '12345678901']) assert.equal(store.setTypedRate('EUR', bad), false, bad);
  assert.equal(store.setTypedRate('USD', '2'), false, 'not for the settle-up currency itself');
  assert.equal(store.setTypedRate('ZZZ', '2'), false);
  assert.equal(store.setTypedRate('EUR', ''), true);
  assert.deepEqual(store.group.rates, {});
  assert.equal(store.setTypedRate('EUR', ''), false);
});

test('what the store saves opens again as the same groups', async () => {
  const one = make();
  one.store.saveBill(yenBill());
  await settle();
  one.store.addGroup('Flat');
  one.store.addPerson('Ana');
  const two = make({ storage: one.storage });
  assert.equal(two.store.group.name, 'Flat');
  two.store.switchGroup('g-lisbon');
  one.store.switchGroup('g-lisbon');
  assert.equal(sameContent(one.store.group, two.store.group), true);
});
