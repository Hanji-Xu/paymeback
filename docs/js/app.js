/* Pay Me Back page: boot and everything on the page except the graph stage (stage.js) and the bill editor
   (editor.js). Here: the header, opening a link, the text box and its live reading, the bills table, the
   group drawer, the share panel, the status line with UNDO, the notice bar and the marquee.
   All data lives in the store (store.js); this file draws it and passes on what the reader does. */

import { CURRENCIES, esc, fmtDate, fmtRate, formatMoney, listJoin, personName, rateFor, tableRate, usedCurrencies } from './core.js';
import { describeBill, formatGroup, parseText } from './parse.js';
import { decodeGroup, encodeGroup } from './share.js';
import { finalPayments } from './simplify.js';
import { createStore } from './store.js';
import { initStage } from './stage.js';
import { initEditor, openEditor } from './editor.js';

const DRAFT_KEY = 'settle.draft';          // sessionStorage: text typed but not added yet
const EXAMPLE_KEY = 'settle.example';      // sessionStorage: the "this is an example" line was closed
const FALLBACK = 'If A owes B and B owes C, A pays C.';
const CHOOSE_FIRST = 'Choose which version to keep first.';

const $ = id => document.getElementById(id);
const store = createStore();
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

const session = {
  get(key) {
    try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
  },
  set(key, value) {
    try { sessionStorage.setItem(key, value); } catch { /* then it lasts until the page is closed */ }
  }
};

// Where the rate behind a converted amount comes from.
function rateSource(source, date) {
  return source === 'fixed' ? 'Fixed for this bill.' : source === 'manual' ? 'Your rate.'
    : source === 'pinned' ? 'Rate of ' + fmtDate(date) + '.' : 'Built-in rate, ' + fmtDate(date) + '.';
}

const topDialog = () => [...document.querySelectorAll('dialog[open]')].pop() || null;

async function copyText(text, field) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* no clipboard here: select the text and copy that */ }
  const box = field || Object.assign(document.createElement('textarea'), { value: text, className: 'sr', readOnly: true });
  if (!field) (topDialog() || document.body).append(box);
  box.focus();
  box.select();
  let done = false;
  try { done = document.execCommand('copy'); } catch { done = false; }
  if (!field) box.remove();
  return done;
}

// Shows another word on a button for a moment: "Copied".
function flash(button, word) {
  const label = button.dataset.label || (button.dataset.label = button.textContent);
  button.textContent = word;
  setTimeout(() => { button.textContent = label; }, 1600);
}

/* Makes `el` hold `html`, keeping every element that is already right. Unlike innerHTML this does not
   throw away the field being typed in or the button under the pointer. A text field keeps what is being
   typed unless the value it should show has changed. */
function morph(el, html, lock) {
  const next = document.createElement('template');
  next.innerHTML = html;
  if (lock) next.content.querySelectorAll('input, select, button').forEach(c => c.setAttribute('disabled', ''));
  sync(el, next.content);
}

function sync(old, next) {
  const have = [...old.childNodes], want = [...next.childNodes];
  want.forEach((n, i) => {
    const o = have[i];
    if (!o) { old.append(n); return; }
    if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) { o.replaceWith(n); return; }
    if (o.nodeType !== 1) { if (o.data !== n.data) o.data = n.data; return; }
    const shown = o.getAttribute('value');
    [...o.attributes].forEach(a => { if (!n.hasAttribute(a.name)) o.removeAttribute(a.name); });
    [...n.attributes].forEach(a => { if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value); });
    if (o.nodeName === 'INPUT' && shown !== n.getAttribute('value')) o.value = n.getAttribute('value') || '';
    // Read before the options are synced: syncing moves new options out of `n`.
    const chosen = o.nodeName === 'SELECT' ? (n.querySelector('option[selected]') || n.querySelector('option') || { value: '' }).value : null;
    sync(o, n);
    if (chosen !== null) o.value = chosen;
  });
  have.slice(want.length).forEach(o => o.remove());
}

/* ---------- status line: what just happened, with UNDO ---------- */

const statusEl = $('status'), statusText = $('status-text'), statusUndo = $('status-undo');
let statusTimer = 0;

function hideStatus() {
  clearTimeout(statusTimer);
  statusEl.hidden = true;
}

function showStatus(text, undo) {
  clearTimeout(statusTimer);
  statusText.textContent = text;
  statusUndo.hidden = !undo;
  // An open dialog makes the rest of the page unreachable, so the line goes inside it.
  (topDialog() || document.body).append(statusEl);
  statusEl.hidden = false;
  statusTimer = setTimeout(hideStatus, undo ? 10000 : 5000);
}

statusUndo.addEventListener('click', () => store.undo());

/* ---------- notice bar: one line under the header ---------- */

let noticeShown = '', noticeActions = [];
let linkProblem = '', storageClosed = false;

// What to say about a link: it holds another version of a group, or it could not be opened.
function linkNotice() {
  const g = store.group;
  if (store.readOnly) {
    const mine = store.groups.find(x => x.id === g.id) || g;   // (another tab may have deleted mine meanwhile)
    const last = mine.rev && g.rev && mine.rev !== g.rev ? (g.rev > mine.rev ? ' The link’s version was changed last.' : ' Yours was changed last.') : '';
    return { html: `This link has a different version of <b>${esc(mine.name)}</b>. You are looking at the link’s version.${last}`,
      actions: [['Use the link’s version', () => store.importGroup(null, 'replace')],
        ['Keep mine', () => { store.importGroup(null, 'keep'); showStatus('Your version is kept.', false); }]] };
  }
  return linkProblem ? { html: `<b class="tag tag--fix">Link not opened</b>${esc(linkProblem)} Your own groups are untouched.`,
    actions: [['Close', () => { linkProblem = ''; renderNotice(); }]] } : null;
}

/* A bar that needs an answer sticks under the header. A jump to a section must then land below both,
   however tall the bar is, so its height is handed to the stylesheet (scroll-padding-top). */
function measureNotice() {
  const bar = $('notice'), height = getComputedStyle(bar).position === 'sticky' ? bar.offsetHeight : 0;
  document.documentElement.style.setProperty('--notice', height + 'px');
}

// The bar shows one thing at a time: a link first, then a browser that does not save, then the example.
// The line about the example is only a welcome, so it scrolls away with the page (flow).
function renderNotice() {
  const notice = linkNotice() || (store.saved || storageClosed ? null : {
    html: '<b class="tag tag--fix">Not saved</b>This browser does not let the page save. To keep a group, press SHARE and keep the link.',
    actions: [['Close', () => { storageClosed = true; renderNotice(); }]]
  }) || (store.group.example && !session.get(EXAMPLE_KEY) ? {
    flow: true,
    html: 'This is an example trip. Change it, or start your own.',
    actions: [['Start my own', () => { store.addGroup('My group'); $('draft').focus(); }],
      ['Close', () => { session.set(EXAMPLE_KEY, '1'); renderNotice(); }]]
  } : null);
  const html = notice ? `<p class="notice__text">${notice.html}</p><div class="notice__actions">` +
    notice.actions.map((a, i) => `<button type="button" class="link" data-act="${i}">${esc(a[0])}</button>`).join('') + '</div>' : '';
  noticeActions = notice ? notice.actions : [];
  if (html === noticeShown) return;   // the bar is read aloud when it changes, so it is only touched then
  noticeShown = html;
  $('notice').innerHTML = html;
  $('notice').hidden = !notice;
  $('notice').classList.toggle('notice--flow', !!notice && notice.flow === true);
  measureNotice();
}

$('notice').addEventListener('click', e => {
  const button = e.target.closest('[data-act]');
  if (button) noticeActions[+button.dataset.act][1]();
});

new ResizeObserver(measureNotice).observe($('notice'));   // its text wraps differently as the window changes

/* ---------- header ---------- */

function renderHeader() {
  $('people-count').textContent = '(' + store.group.people.length + ')';
}

// Bolds the nav link of the section that crosses a line two fifths down the window.
function watchSections() {
  const links = new Map([...$('nav').querySelectorAll('a')].filter(a => a.hash).map(a => [a.hash.slice(1), a]));
  const on = new Set();
  const watcher = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) on.add(e.target.id); else on.delete(e.target.id); });
    const current = [...links.keys()].find(id => on.has(id));
    links.forEach((a, id) => {
      a.classList.toggle('is-current', id === current);
      if (id === current) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    });
  }, { rootMargin: '-40% 0px -59% 0px' });
  links.forEach((a, id) => watcher.observe($(id)));
}

/* ---------- dialogs ---------- */

// Any [data-open] opens its panel; any [data-close] or a click beside a dialog closes it.
let pressedOn = null;
document.addEventListener('pointerdown', e => { pressedOn = e.target; });
document.addEventListener('click', e => {
  const opener = e.target.closest('[data-open]');
  if (opener) { if (opener.dataset.open === 'share') openShare(); else openDrawer(); return; }
  const closer = e.target.closest('[data-close]');
  const beside = e.target instanceof HTMLDialogElement && pressedOn === e.target ? e.target : null;
  const dialog = closer ? closer.closest('dialog') : beside;
  if (dialog) dialog.close();
});

// An open dialog makes the rest of the page unreachable. So the status line follows: into a dialog
// that opens while the line is showing, and out again the moment that dialog closes.
document.querySelectorAll('dialog').forEach(dialog => {
  new MutationObserver(() => {
    if (dialog.open && !statusEl.hidden) dialog.append(statusEl);
    else if (!dialog.open && dialog.contains(statusEl)) document.body.append(statusEl);
  }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
});

/* ---------- share panel ---------- */

async function openShare() {
  const field = $('share-link'), note = $('share-length'), copy = $('share-copy');
  let url = '';
  try {
    url = location.href.split('#')[0] + '#' + await encodeGroup(store.group);
    note.textContent = url.length.toLocaleString() + ' characters. Anyone who opens it gets their own copy of the group.';
  } catch (e) {
    note.textContent = e.message;
  }
  field.value = url;
  copy.disabled = !url;
  $('share-native').hidden = !url || !navigator.share;
  if (!$('share').open) $('share').showModal();
  field.select();
}

$('share-copy').addEventListener('click', async () => {
  const done = await copyText($('share-link').value, $('share-link'));
  if (done) flash($('share-copy'), 'Copied');
  else $('share-length').textContent = 'The link is selected. Copy it with Ctrl+C, or ⌘C on a Mac.';
});

$('share-native').addEventListener('click', () => {
  navigator.share({ title: store.group.name, url: $('share-link').value }).catch(() => { /* closed without sharing */ });
});

/* ---------- group drawer ---------- */

const drawer = $('drawer'), drawerBody = $('drawer-body');
const drawerSay = { people: '', rates: null, busy: false };

let currencyNames;
function currencyLabel(code) {
  if (currencyNames === undefined) {
    try { currencyNames = new Intl.DisplayNames(undefined, { type: 'currency' }); } catch { currencyNames = null; }
  }
  let name = '';
  try { name = currencyNames ? currencyNames.of(code) : ''; } catch { name = ''; }
  return name && name !== code ? code + ' · ' + name : code;
}

const option = (value, label, on) => `<option value="${esc(value)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
const say = (tag, text, fix) => `<p class="say"><b class="tag${fix ? ' tag--fix' : ''}">${esc(tag)}</b><span>${esc(text)}</span></p>`;
const ATTRIBUTION = '<p class="small mute prose"><a href="https://www.exchangerate-api.com" rel="noopener">Rates by Exchange Rate API</a></p>';

function ratesSection(g) {
  const base = g.currency, codes = usedCurrencies(g);
  // A rate typed earlier stays listed after its bills are gone, so it can still be cleared.
  Object.keys(g.rates).forEach(c => { if (g.rates[c].base === base && c !== base && !codes.includes(c)) codes.push(c); });
  if (!codes.length) return `<p class="mute">All bills are in ${esc(base)}, so nothing is converted.</p>` + ATTRIBUTION;
  const rows = codes.map(code => {
    const used = rateFor(g, code), table = tableRate(g, code), typed = used && used.source === 'manual' ? g.rates[code].rate : '';
    const from = !used ? 'No rate yet' : used.source === 'manual' ? 'Typed by you' : (used.source === 'pinned' ? 'Exchange Rate API, ' : 'Built-in, ') + fmtDate(used.date);
    return `<tr><th scope="row">${esc(code)}</th>` +
      `<td><span class="num">${used ? `1 ${esc(code)} = ${fmtRate(used.rate)} ${esc(base)}` : '—'}</span><span class="rates__src">${esc(from)}</span></td>` +
      `<td><input type="text" inputmode="decimal" data-k="rate" data-id="${esc(code)}" value="${esc(typed)}" placeholder="${table ? fmtRate(table.rate) : ''}" aria-label="Your own rate for ${esc(code)}"></td></tr>`;
  }).join('');
  const note = drawerSay.rates;
  return `<p>Bills in other currencies are turned into ${esc(base)} with these rates. They stay as they are until you press UPDATE RATES, so everyone with the link sees the same numbers.</p>` +
    `<table class="rates"><thead><tr><th scope="col">From</th><th scope="col">Rate in use</th><th scope="col">Your own</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="actions"><button type="button" class="link" data-k="update"${drawerSay.busy ? ' disabled' : ''}>${drawerSay.busy ? 'Getting rates' : 'Update rates'}</button></div>` +
    (note ? say(note.tag, note.text, note.fix) : '') + ATTRIBUTION;
}

function renderDrawer() {
  const g = store.group, used = store.usedPeople(), me = store.me;
  const section = (title, body) => `<section class="drawer__sec"><h3 class="title">${title}</h3>${body}</section>`;
  const people = g.people.map(p => `<li class="people__row"><input type="text" data-k="person" data-id="${esc(p.id)}" value="${esc(p.name)}" aria-label="Name" maxlength="40">` +
    (used.has(p.id) ? '<span class="people__note">On a bill</span>' : `<button type="button" class="link" data-k="remove" data-id="${esc(p.id)}">Remove</button>`) + '</li>').join('');
  morph(drawerBody, [
    store.readOnly ? `<section class="drawer__sec">${say('Read only', 'This is the link’s version. ' + CHOOSE_FIRST, true)}</section>` : '',
    section('This group',
      `<label class="field"><span class="field__label">Name</span><input type="text" data-k="name" value="${esc(g.name)}" maxlength="60"></label>` +
      `<label class="field"><span class="field__label">Settle up in</span><select data-k="currency">${CURRENCIES.map(c => option(c, currencyLabel(c), c === g.currency)).join('')}</select></label>` +
      '<div class="actions"><button type="button" class="link" data-k="delete">Delete this group</button></div>'),
    section('Your groups',
      `<label class="field"><span class="field__label">Switch to</span><select data-k="switch">${store.groups.map(x => option(x.id, x.name, x.id === g.id)).join('')}</select></label>` +
      '<div class="addrow"><input type="text" data-k="new-group" placeholder="Name of a new group" aria-label="Name of a new group" maxlength="60">' +
      '<button type="button" class="btn" data-k="add-group">New group</button></div>'),
    section('People',
      (people ? `<ul class="people">${people}</ul>` : '<p class="mute">Nobody yet. Add everyone who shares costs.</p>') +
      '<div class="addrow"><input type="text" data-k="new-person" placeholder="Add a person" aria-label="Add a person" maxlength="200">' +
      '<button type="button" class="btn" data-k="add-person">Add</button></div>' +
      (drawerSay.people ? say('Fix', drawerSay.people, true) : '') +
      `<label class="field"><span class="field__label">I am</span><select data-k="me">${option('', 'Nobody yet', !me)}${g.people.map(p => option(p.id, p.name, p.id === me)).join('')}</select></label>` +
      '<p class="mute">Lets you write “I paid 20 for coffee” on this device.</p>'),
    section('Exchange rates', ratesSection(g)),
    section('Bills as text',
      '<p>Every bill in this group, written the way you would type it.</p>' +
      `<button type="button" class="btn btn--wide" data-k="copy"${g.expenses.length ? '' : ' disabled'}>Copy all as text</button>`)
  ].join(''), store.readOnly);
}

function openDrawer(focusKey) {
  if (!drawer.open) { drawerSay.people = ''; drawerSay.rates = null; }
  renderDrawer();
  if (!drawer.open) drawer.showModal();
  const field = focusKey && drawerBody.querySelector(`[data-k="${focusKey}"]`);
  if (field) field.focus();
}

function addPeople() {
  const field = drawerBody.querySelector('[data-k="new-person"]');
  const names = field.value.split(',').map(s => s.trim()).filter(Boolean), twice = [];
  let refused = '';
  names.forEach(name => {
    if (store.addPerson(name)) return;
    if (store.lastError) refused = store.lastError; else twice.push(name);
  });
  drawerSay.people = refused || (twice.length ? listJoin(twice) + (twice.length === 1 ? ' is' : ' are') + ' already in the group.' : '');
  field.value = '';
  renderDrawer();
  field.focus();
}

function addGroup() {
  const field = drawerBody.querySelector('[data-k="new-group"]');
  if (!store.addGroup(field.value)) return;
  field.value = '';
  drawerBody.querySelector('[data-k="new-person"]').focus();
}

async function pressUpdateRates() {
  drawerSay.busy = true;
  drawerSay.rates = null;
  renderDrawer();
  const res = await store.updateRates(), date = fmtDate(res.date);
  drawerSay.busy = false;
  drawerSay.rates = res.failed
    ? { tag: 'Offline', fix: true, text: `Rates could not be fetched. The rates of ${date} ${res.changed ? 'are now' : 'stay'} in use.` }
    : { tag: 'OK', fix: false, text: res.changed ? `Rates of ${date} are now in use.` : `Rates of ${date} are in use. They are the latest.` };
  renderDrawer();
}

drawerBody.addEventListener('change', e => {
  const el = e.target, k = el.dataset.k, id = el.dataset.id;
  drawerSay.people = '';
  if (k === 'name') { if (!store.renameGroup(el.value)) el.value = store.group.name; }
  else if (k === 'currency') store.setCurrency(el.value);
  else if (k === 'switch') store.switchGroup(el.value);
  else if (k === 'me') store.setMe(el.value);
  else if (k === 'person') {
    const typed = el.value.trim();
    if (!store.renamePerson(id, typed)) {
      if (typed && typed !== store.name(id)) drawerSay.people = store.lastError || typed + ' is already in the group.';
      el.value = store.name(id);
    }
  } else if (k === 'rate') {
    /* Only a plain number is taken. Anything else leaves the rate as it was. A comma counts as the decimal
       mark, because many phone keypads have no dot. "1,125" could be read two ways, so it is not taken. */
    const raw = el.value.trim(), typed = /^\d*,\d+$/.test(raw) && !/,\d{3}$/.test(raw) ? raw.replace(',', '.') : raw;
    const plain = /^(?:\d{1,9}(?:\.\d{0,12})?|\.\d{1,12})$/.test(typed) && Number(typed) > 0;
    const mine = store.group.rates[id], old = mine && mine.base === store.group.currency ? mine.rate : '';
    drawerSay.rates = typed && !plain ? { tag: 'Fix', fix: true, text: `Type the rate for ${id} as a plain number, like 1.1251.` } : null;
    if (typed && !plain) el.value = old; else store.setTypedRate(id, typed);
  }
  renderDrawer();
});

drawerBody.addEventListener('click', e => {
  const el = e.target.closest('button[data-k]');
  if (!el) return;
  const k = el.dataset.k;
  drawerSay.people = '';
  if (k === 'delete') store.deleteGroup();
  else if (k === 'add-group') addGroup();
  else if (k === 'add-person') addPeople();
  else if (k === 'remove') store.removePerson(el.dataset.id);
  else if (k === 'update') pressUpdateRates();
  else if (k === 'copy') copyAllBills(el);
  renderDrawer();
});

drawerBody.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.nodeName !== 'INPUT') return;
  e.preventDefault();
  const k = e.target.dataset.k;
  if (k === 'new-person') addPeople(); else if (k === 'new-group') addGroup(); else e.target.blur();
});

/* ---------- write it down ---------- */

const draft = $('draft'), addButton = $('draft-add');
const grows = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');
let reading = null;       // what parseText made of the box
let draftTimer = 0, adding = false, askedRates = false;
let lastAdd = null;       // { before, after }: the box around the last ADD, so UNDO can put the lines back

// Where the browser does not size the box to its text, do it by hand: never smaller than the text in it.
function grow() {
  if (grows) return;
  draft.style.minHeight = '';
  if (draft.scrollHeight > draft.clientHeight) draft.style.minHeight = draft.scrollHeight + 'px';
}

function setDraft(text) {
  draft.value = text;
  session.set(DRAFT_KEY, text);
  grow();
}

// The currencies on lines that are ready which this group has no rate for yet.
function newCurrencies() {
  const g = store.group, drafts = reading ? reading.drafts : [];
  return [...new Set(drafts.filter(d => d.ok && d.bill).map(d => d.bill.currency))]
    .filter(c => c !== g.currency && c !== 'USD' && !(g.fx && Object.hasOwn(g.fx.usd, c)));
}

// A "Currency:" or "I am" line read alone tells which currency or person it means.
const alone = d => parseText(d.source, store.group, {});

function sentenceOf(g, d) {
  if (d.kind === 'people') return d.newPeople.length ? `Adds ${esc(listJoin(d.newPeople))} to the group.` : 'Nobody new to add.';
  if (d.kind === 'currency') return `The lines below are in ${esc(alone(d).defaultCurrency)}.`;
  if (d.kind === 'me') {
    const me = alone(d).me || '', name = me.startsWith('new:') ? me.slice(4) : me ? personName(g, me) : 'you';
    return `“I”, “me” and “my” mean ${esc(name)} on the lines below.`;
  }
  // The name the line was given comes first, so a line read too literally is easy to spot.
  const said = describeBill(g, d.bill), title = String(d.bill.title || '');
  return (title && !said.startsWith(title) ? `<b>${esc(title)}:</b> ` : '') + esc(said);
}

function readingRow(g, d) {
  const part = (cls, html) => `<span class="reading__${cls}">${html}</span>`;
  const body = d.ok
    ? [part('say', sentenceOf(g, d)),
      d.newPeople.length && d.kind !== 'people' ? part('new', `<b class="tag">${d.newPeople.length === 1 ? 'New person' : 'New people'}</b>${esc(listJoin(d.newPeople))}`) : '',
      ...d.warnings.map(w => part('warn', `<b class="tag">Check</b>${esc(w)}`))]
    : [part('src', esc(d.source)), ...d.errors.map(m => part('say', esc(m)))];
  return `<li class="reading__row" data-line="${d.line}"><span class="reading__n">${d.line}</span>` +
    `<b class="tag${d.ok ? '' : ' tag--fix'}">${d.ok ? 'OK' : 'Fix'}</b><span class="reading__body">${body.join('')}</span></li>`;
}

function renderReading() {
  const g = store.group, drafts = reading ? reading.drafts.filter(d => d.kind !== 'comment') : [];
  $('reading').innerHTML = drafts.map(d => readingRow(g, d)).join('');
  const bills = drafts.filter(d => d.ok && d.bill).length, fixes = drafts.filter(d => !d.ok).length;
  const people = bills ? 0 : drafts.filter(d => d.ok).reduce((n, d) => n + d.newPeople.length, 0);
  addButton.textContent = bills ? (bills === 1 ? 'Add 1 bill' : `Add ${bills} bills`) : people ? (people === 1 ? 'Add 1 person' : `Add ${people} people`) : 'Add bills';
  addButton.disabled = adding || store.readOnly || !(bills || people);
  const ready = bills ? plural(bills, 'bill is', 'bills are') + ' ready.' : people ? plural(people, 'new person is', 'new people are') + ' ready.' : '';
  const wait = fixes ? plural(fixes, 'line needs', 'lines need') + ' fixing' + (ready ? (fixes === 1 ? ' and stays' : ' and stay') + ' in the box.' : '.') : '';
  $('draft-summary').textContent = store.readOnly && drafts.length ? CHOOSE_FIRST : [ready, wait].filter(Boolean).join(' ');
  // Rates are asked for as soon as a new currency is typed, so they are there when ADD is pressed.
  if (!askedRates && !store.readOnly && newCurrencies().length) { askedRates = true; store.fetchRates(); }
}

function readDraft() {
  clearTimeout(draftTimer);
  reading = draft.value.trim() ? parseText(draft.value, store.group, { me: store.me || undefined }) : null;
  renderReading();
}

// A bill as the parser made it, with real ids in place of the "new:Name" stand-ins.
function realBill(bill, idOf) {
  const id = v => idOf.get(v) || v, ids = list => (list || []).map(id);
  const values = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [id(k), v]));
  if (bill.kind === 'payment') return { ...bill, id: store.newId('e'), from: id(bill.from), to: id(bill.to) };
  return { ...bill, id: store.newId('e'),
    paid: { ...bill.paid, who: ids(bill.paid.who), values: values(bill.paid.values) },
    split: { ...bill.split, who: ids(bill.split.who), values: values(bill.split.values),
      items: (bill.split.items || []).map(it => ({ ...it, who: ids(it.who) })) } };
}

async function addFromBox() {
  if (adding || store.readOnly) return;
  readDraft();
  let offline = null;
  if (newCurrencies().length) {
    adding = true;
    addButton.disabled = true;
    const table = await store.fetchRates();
    if (table.failed) offline = table;
    adding = false;
    readDraft();   // the box may have changed while waiting
  }
  const parsed = reading;
  if (store.readOnly || !parsed) return;
  const ok = parsed.drafts.filter(d => d.ok), bills = ok.filter(d => d.bill), names = ok.flatMap(d => d.newPeople);
  if (!bills.length && !names.length) return;
  const foreign = newCurrencies().length > 0, before = draft.value;
  const idOf = new Map(names.map(name => ['new:' + name, store.newId('p')]));
  const label = (bills.length ? plural(bills.length, 'bill', 'bills') : plural(names.length, 'person', 'people')) + ' added.';
  const done = store.change(label, g => {
    names.forEach(name => g.people.push({ id: idOf.get('new:' + name), name }));
    bills.forEach(d => g.expenses.push(realBill(d.bill, idOf)));
  });
  if (!done) { showStatus(store.lastError || 'Nothing was added.', false); return; }
  if (parsed.me && ok.some(d => d.kind === 'me')) store.setMe(idOf.get(parsed.me) || parsed.me);

  /* What is added leaves the box. Lines that need fixing stay, and with them the notes and "Currency:"
     lines, which the lines below still lean on. People and "I am" lines have done their work. */
  let rest = '';
  if (parsed.drafts.some(d => !d.ok)) {
    const gone = new Set();
    ok.filter(d => d.bill || d.kind === 'people' || d.kind === 'me').forEach(d => { for (let k = 0; k < d.lines; k++) gone.add(d.line + k); });
    rest = before.split(/\r\n|\n|\r/).filter((line, i) => !gone.has(i + 1)).join('\n').replace(/^(?:[ \t]*\n)+/, '');
  }
  setDraft(rest);
  readDraft();
  lastAdd = { before, after: rest };
  if (offline && foreign) showStatus(`${label} Rates could not be fetched, so those of ${fmtDate(offline.date)} are used.`, true);
  store.ensurePinned();
}

draft.addEventListener('input', () => {
  session.set(DRAFT_KEY, draft.value);
  grow();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(readDraft, 150);
});

draft.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addFromBox(); }
});

addButton.addEventListener('click', addFromBox);

$('examples').addEventListener('click', e => {
  const button = e.target.closest('[data-example]');
  if (!button) return;
  const text = draft.value;
  setDraft(text + (text && !text.endsWith('\n') ? '\n' : '') + button.dataset.example + '\n');
  readDraft();
  draft.focus();
  draft.setSelectionRange(draft.value.length, draft.value.length);
});

/* ---------- bills table ---------- */

const HOW = { equal: 'Equally', exact: 'By amounts', percent: 'By percent', shares: 'By shares', items: 'By items' };

function billRow(g, bill, r, focus) {
  const money = (v, cur) => esc(formatMoney(v, cur)), pay = bill.kind === 'payment';
  const title = bill.title || (pay ? 'Payment' : 'Untitled');
  const head = `<th scope="row" class="bill__title"><button type="button" class="bill__open" title="${esc(title)}">${esc(title)}</button></th>`;
  const amount = r.totalOrig > 0 ? money(r.totalOrig, r.cur) : '—';
  if (r.err) {
    return `<tr class="bill is-bad" data-id="${esc(bill.id)}">${head}<td class="bill__amt">${amount}</td>` +
      `<td class="bill__err" colspan="2"><span class="say"><b class="tag tag--fix">Fix</b><span>${esc(r.err)} It is left out until then.</span></span></td></tr>`;
  }
  const part = map => g.people.filter(p => (map.get(p.id) || 0) > 0);
  const payers = part(r.paidOrig), sharers = part(r.owedOrig).map(p => p.name);
  // A converted amount always comes with its rate, and with where and when that rate is from.
  const conv = r.rateSource === 'same' ? '' : `<span class="bill__conv">${money(r.total, g.currency)} at 1 ${esc(r.cur)} = ${fmtRate(r.rate)} ${esc(g.currency)}.</span>` +
    `<span class="bill__conv">${esc(rateSource(r.rateSource, r.rateDate))}</span>`;
  const paid = pay ? esc(personName(g, bill.from))
    : payers.length === 1 ? esc(payers[0].name) : payers.map(p => esc(p.name) + ' ' + money(r.paidOrig.get(p.id), r.cur)).join(', ');
  const split = pay ? 'Payment to ' + esc(personName(g, bill.to))
    : sharers.length === 1 ? 'All for ' + esc(sharers[0])
    : esc(HOW[bill.split.mode] + ' between ' + (sharers.length === g.people.length ? 'everyone' : sharers.length <= 3 ? listJoin(sharers) : sharers.length + ' people'));
  const dim = focus && !((r.paid.get(focus) || 0) > 0 || (r.owed.get(focus) || 0) > 0);
  return `<tr class="bill${dim ? ' is-dim' : ''}" data-id="${esc(bill.id)}">${head}<td class="bill__amt">${amount}${conv}</td>` +
    `<td class="bill__paid">${paid}</td><td class="bill__split">${split}</td></tr>`;
}

function renderBills() {
  const g = store.group, n = g.expenses.length, results = store.steps.bills, focus = store.ui.focus;
  $('group-name').textContent = g.name;
  $('bills-summary').textContent = `${plural(n, 'bill', 'bills')}. ${plural(g.people.length, 'person', 'people')}. Settled in ${g.currency}.`;
  $('bills-body').innerHTML = n ? g.expenses.map(bill => billRow(g, bill, results.get(bill.id).r, focus)).join('')
    : '<tr class="empty"><td colspan="4">No bills yet. Write one in the box above.</td></tr>';
  $('bills-copy').disabled = !n;
  $('bills-clear').disabled = !n || store.readOnly;
}

// Opens the bill editor: for one of the group's bills, or for a new bill of the given kind.
function edit(bill, kind) {
  const need = kind === 'payment' ? 2 : 1;
  if (store.readOnly) { showStatus(CHOOSE_FIRST, false); return; }
  if (!bill && store.group.people.length < need) {
    openDrawer('new-person');
    showStatus(need === 2 ? 'Add at least two people first.' : 'Add the people first.', false);
    return;
  }
  openEditor(bill, kind);
}

async function copyAllBills(button) {
  if (await copyText(formatGroup(store.group))) flash(button, 'Copied');
  else showStatus('This browser did not allow copying.', false);
}

$('bills-body').addEventListener('click', e => {
  const row = e.target.closest('tr.bill');
  const bill = row && store.group.expenses.find(b => b.id === row.dataset.id);
  if (bill) edit(bill, bill.kind);
});
$('bill-new').addEventListener('click', () => edit(null, 'expense'));
$('payment-new').addEventListener('click', () => edit(null, 'payment'));
$('bills-copy').addEventListener('click', e => copyAllBills(e.currentTarget));
$('bills-clear').addEventListener('click', () => store.clearBills());

/* ---------- marquee ---------- */

let marqueeShown = '';

function renderMarquee() {
  const g = store.group, track = $('marquee-track');
  const sentence = finalPayments(store.steps).map(([from, to, v]) => `${personName(g, from)} pays ${personName(g, to)} ${formatMoney(v, g.currency)} —`).join(' ') || FALLBACK;
  if (sentence === marqueeShown) return;
  marqueeShown = sentence;
  // The track moves left by half its width, so it holds the sentence an even number of times.
  const copies = 2 * Math.max(1, Math.ceil(3000 / (sentence.length * 26)));
  track.innerHTML = `<span class="marquee__text">${esc(sentence)}</span>`.repeat(copies);
  track.style.animationDuration = Math.round(track.scrollWidth / 2 / 56) + 's';
}

function watchMarquee() {
  const marquee = $('marquee');
  new IntersectionObserver(entries => {
    marquee.classList.toggle('is-paused', !entries[entries.length - 1].isIntersecting);
  }).observe(marquee);
}

/* ---------- opening a link ---------- */

async function openLink() {
  const hash = location.hash;
  if (!/^#[a-z]\d+\./.test(hash)) return;   // "#bills" and the like are places on the page, not groups
  history.replaceState(null, '', location.pathname + location.search);
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  linkProblem = '';
  try {
    const group = await decodeGroup(hash);
    if (store.importGroup(group) === 'same') showStatus(`This link holds ${group.name} just as you have it.`, false);
  } catch (e) {
    linkProblem = e.message;
  }
  renderNotice();
}

/* ---------- everything together ---------- */

function renderAll() {
  renderHeader();
  renderBills();
  readDraft();
  renderMarquee();
  renderNotice();
  if (drawer.open) renderDrawer();
}

store.subscribe(info => {
  if (info.type !== 'rates') {
    hideStatus();
    // UNDO right after ADD puts the lines back into the box, unless the box was changed since.
    if (info.type === 'undo' && lastAdd && draft.value === lastAdd.after) setDraft(lastAdd.before);
    lastAdd = null;
  }
  if (info.type === 'undo') showStatus('Undone.', false);
  else if (info.label) showStatus(info.label, true);
  renderAll();
});

store.subscribeUI(keys => {
  if (keys.includes('focus')) renderBills();
  if (keys.includes('mode')) renderMarquee();
  if (keys.includes('me')) { readDraft(); if (drawer.open) renderDrawer(); }
});

// Another tab of this page saved something: show that, not what this tab remembers.
window.addEventListener('storage', e => { if (e.key === null || e.key === 'settle.v1') store.reload(); });
window.addEventListener('hashchange', openLink);

setDraft(session.get(DRAFT_KEY));
await openLink();   // a group in the address is opened before the first drawing
initStage(store);
initEditor(store);
renderAll();
watchSections();
watchMarquee();

if (location.protocol === 'https:' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page works without it */ });
}
