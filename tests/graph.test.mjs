import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { EXAMPLE_GROUP, formatMoney } from '../docs/js/core.js';
import { layoutFor, graphSVG, initials } from '../docs/js/graph.js';

/* simplify.js is written by someone else. The cases that walk through real steps are skipped until it is there. */
const simplifyUrl = new URL('../docs/js/simplify.js', import.meta.url);
const simplify = existsSync(simplifyUrl) ? await import(simplifyUrl.href) : null;
const needsSimplify = simplify ? false : 'docs/js/simplify.js does not exist yet';

/* ---------- reading the markup back ---------- */

const ALLOWED_TAGS = new Set(['defs', 'marker', 'path', 'g', 'circle', 'rect', 'text']);
const NUMERIC = ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'stroke-width'];
// No style, no event handlers, no links: only what the picture needs.
const ALLOWED_ATTRS = new Set([...NUMERIC, 'class', 'd', 'text-anchor', 'marker-end', 'data-key', 'data-node',
  'id', 'viewBox', 'refX', 'refY', 'markerWidth', 'markerHeight', 'markerUnits', 'orient']);

const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// A small strict reader: every tag must be well formed, closed in order, and text may hold no raw < or >.
function parse(svg) {
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+="[^"<>]*")*)>/g;
  const stack = [], els = [];
  let last = 0, m;
  while ((m = re.exec(svg))) {
    const between = svg.slice(last, m.index);
    assert.ok(!/[<>]/.test(between), 'raw angle bracket outside a tag: ' + between);
    if (stack.length) stack.at(-1).text += between; else assert.equal(between, '', 'text outside any element');
    last = re.lastIndex;
    if (m[1]) {
      const open = stack.pop();
      assert.equal(open && open.tag, m[2], 'tags closed out of order');
    } else {
      const attrs = Object.fromEntries([...m[3].matchAll(/([\w:-]+)="([^"]*)"/g)].map(a => [a[1], unesc(a[2])]));
      const el = { tag: m[2], attrs, text: '', parent: stack.at(-1) || null, children: [] };
      if (el.parent) el.parent.children.push(el);
      els.push(el);
      stack.push(el);
    }
  }
  assert.equal(svg.slice(last), '', 'unreadable markup at the end');
  assert.equal(stack.length, 0, 'unclosed tags');
  els.forEach(el => { el.text = unesc(el.text); });
  return els;
}

const classes = el => (el.attrs.class || '').split(' ');
const has = (el, c) => classes(el).includes(c);
const byClass = (els, c) => els.filter(el => has(el, c));
const child = (el, c) => el.children.find(k => has(k, c));
const nodeOf = (els, id) => els.find(el => el.attrs['data-node'] === id);
const edgeOf = (els, key) => byClass(els, 'g-edge')[byClass(els, 'g-hit').findIndex(h => h.attrs['data-key'] === key)];
const labelOf = (els, key) => byClass(els, 'g-lbl').find(l => l.attrs['data-key'] === key);

// The same rough widths graph.js uses, so the checks below test where text is put, not the estimate itself.
const em = ch => { const c = ch.codePointAt(0); return c > 0x2e7f ? 1 : c >= 65 && c <= 90 ? 0.72 : /[.,'’\s]/.test(ch) ? 0.3 : 0.58; };
const widthOf = (s, px) => [...s].reduce((w, ch) => w + em(ch), 0) * px;
const textBox = (el, px) => {
  const x = +el.attrs.x, y = +el.attrs.y, w = widthOf(el.text, px), a = el.attrs['text-anchor'];
  const x0 = a === 'start' ? x : a === 'end' ? x - w : x - w / 2;
  return { x0, x1: x0 + w, y0: y - px * 0.8, y1: y + px * 0.25 };
};
const nameBox = node => {
  const n = textBox(child(node, 'g-name'), 12), b = textBox(child(node, 'g-bal'), 11);
  return { x0: Math.min(n.x0, b.x0), x1: Math.max(n.x1, b.x1), y0: n.y0, y1: b.y1 };
};
// True when `shown` is `full`, or the start of it followed by "…".
const isCutOf = (shown, full) => shown === full || (shown.endsWith('…') && shown.length > 3 && full.startsWith(shown.slice(0, -1).trimEnd()));
const inside = (box, L) => box.x0 >= 0 && box.y0 >= 0 && box.x1 <= L.w && box.y1 <= L.h;
const boxesMeet = (p, q) => p.x0 < q.x1 && p.x1 > q.x0 && p.y0 < q.y1 && p.y1 > q.y0;
const boxMeetsDisc = (box, cx, cy, r) => Math.hypot(cx - Math.max(box.x0, Math.min(cx, box.x1)), cy - Math.max(box.y0, Math.min(cy, box.y1))) < r;

/* Checks that hold for every frame, whatever is in it. Returns the parsed elements. */
function checkFrame(svg, layout, group) {
  for (const bad of ['NaN', 'undefined', 'Infinity']) assert.ok(!svg.includes(bad), `"${bad}" in the markup`);
  assert.ok(!/style\s*=/i.test(svg), 'style attribute in the markup');
  const els = parse(svg);
  els.forEach(el => {
    assert.ok(ALLOWED_TAGS.has(el.tag), 'unexpected tag ' + el.tag);
    Object.keys(el.attrs).forEach(a => assert.ok(ALLOWED_ATTRS.has(a), 'unexpected attribute ' + a));
    NUMERIC.filter(a => a in el.attrs).forEach(a => assert.ok(Number.isFinite(+el.attrs[a]) && el.attrs[a] !== '', `${el.tag} ${a}="${el.attrs[a]}"`));
  });

  // one hit target per person
  const nodes = els.filter(el => 'data-node' in el.attrs);
  assert.deepEqual(nodes.map(n => n.attrs['data-node']), group.people.map(p => p.id));
  nodes.forEach(n => {
    assert.ok(has(n, 'g-node'));
    assert.equal(['is-get', 'is-owe', 'is-even'].filter(c => has(n, c)).length, 1, 'a person is exactly one of gets / owes / even');
    const disc = child(n, 'g-disc');
    assert.ok(+disc.attrs.cx - layout.r >= 0 && +disc.attrs.cx + layout.r <= layout.w && +disc.attrs.cy - layout.r >= 0 && +disc.attrs.cy + layout.r <= layout.h, 'circle outside the picture');
  });

  // one hit path per visible arrow; a label repeats its arrow's key
  const edges = byClass(els, 'g-edge'), hits = byClass(els, 'g-hit'), labels = byClass(els, 'g-lbl');
  const hitKeys = hits.map(h => h.attrs['data-key']);
  assert.equal(new Set(hitKeys).size, hitKeys.length, 'two hit paths for one arrow');
  assert.equal(edges.filter(e => !has(e, 'is-gone')).length, hits.length, 'every visible arrow has one hit path');
  assert.deepEqual(edges.filter(e => !has(e, 'is-gone')).map(e => e.attrs.d), hits.map(h => h.attrs.d), 'hit paths follow their arrows');
  const labelKeys = labels.map(l => l.attrs['data-key']);
  assert.equal(new Set(labelKeys).size, labelKeys.length, 'two labels for one arrow');
  labelKeys.forEach(k => assert.ok(hitKeys.includes(k), 'label without an arrow: ' + k));
  assert.deepEqual([...new Set(els.filter(el => 'data-key' in el.attrs).map(el => el.attrs['data-key']))].sort(), [...hitKeys].sort());

  edges.forEach(e => {
    assert.equal(['is-plain', 'is-off', 'is-on', 'is-down'].filter(c => has(e, c)).length, 1, 'an arrow has exactly one state');
    const w = +e.attrs['stroke-width'];
    assert.ok(w >= 1 && w <= 8, 'arrow width ' + w);
    if ('marker-end' in e.attrs) assert.match(e.attrs['marker-end'], /^url\(#g-ah-(ink|mute)\)$/);
  });

  // every amount label lies inside the picture
  labels.forEach(l => {
    const rect = l.children.find(k => k.tag === 'rect'), x = +rect.attrs.x, y = +rect.attrs.y;
    assert.ok(x >= 0 && y >= 0 && x + +rect.attrs.width <= layout.w && y + +rect.attrs.height <= layout.h,
      `label outside the picture: ${JSON.stringify(rect.attrs)}`);
    const amt = child(l, 'g-amt');
    assert.ok(+amt.attrs.x > x && +amt.attrs.x < x + +rect.attrs.width && +amt.attrs.y > y && +amt.attrs.y < y + +rect.attrs.height, 'amount outside its box');
  });
  return els;
}

/* ---------- fixtures ---------- */

const [ANA, BEN, CY, DEE, ELI] = ['p-ana', 'p-ben', 'p-cy', 'p-dee', 'p-eli'];
const example = () => structuredClone(EXAMPLE_GROUP);
const SIZES = ['wide', 'narrow'];
const layoutOf = (group, size) => layoutFor(group.people.map(p => p.id), size);
const key = (a, b) => a + '>' + b;
const REST = { phase: 6, hl: {}, people: new Set() };

// Draws one graph at rest.
const still = (group, g, extra = {}, size = 'wide') => {
  const layout = layoutOf(group, size);
  const svg = graphSVG({ group, layout, prev: g, next: g, t: 1, step: REST, maxV: Math.max(1, ...g.values()), focus: '', ...extra });
  return { svg, layout, els: checkFrame(svg, layout, group) };
};

const crowd = n => ({
  id: 'g-crowd', name: 'Crowd', currency: 'USD', rev: 0, rates: {}, expenses: [],
  people: Array.from({ length: n }, (_, i) => ({ id: 'p-' + i, name: ['Ana', 'Benedikt', 'Cy', 'Dee Dee', 'Eli'][i % 5] + (i > 4 ? ' ' + i : '') }))
});
// Everyone owes the next person round the ring a different amount, so nobody is even (from three people up).
const ringDebts = n => new Map(Array.from({ length: n > 1 ? n : 0 }, (_, i) => [key('p-' + i, 'p-' + (i + 1) % n), 100000 + i * 12345]).slice(0, n === 2 ? 1 : n));

/* ---------- initials ---------- */

test('initials: two letters, from two words when there are two', () => {
  assert.equal(initials('Ana'), 'AN');
  assert.equal(initials('ana maria'), 'AM');
  assert.equal(initials('Mary Ann Lee'), 'MA');
  assert.equal(initials('  Cy  '), 'CY');
  assert.equal(initials('x'), 'X');
  assert.equal(initials('张伟'), '张伟');
  assert.equal(initials('😀 smile'), '😀S');
  assert.equal(initials(''), '');
  assert.equal(initials('   '), '');
  assert.equal(initials(null), '');
  assert.equal(initials(undefined), '');
  assert.equal(initials(42), '42');
});

/* ---------- layout ---------- */

test('layoutFor: picture sizes', () => {
  const wide = layoutFor(['a', 'b', 'c'], 'wide'), narrow = layoutFor(['a', 'b', 'c'], 'narrow');
  assert.deepEqual([wide.w, wide.h], [720, 480]);
  assert.deepEqual([narrow.w, narrow.h], [400, 440]);
  assert.ok(narrow.r < wide.r && narrow.r >= 18, 'phone circles are smaller but still hold two letters');
  assert.deepEqual(layoutFor(['a', 'b', 'c'], 'anything else'), wide);
  assert.deepEqual(layoutFor(['a', 'b', 'c']), wide);
  assert.equal(layoutFor([], 'wide').pos.size, 0);
});

for (const size of SIZES) {
  for (const n of [1, 2, 3, 5, 9, 12]) {
    test(`layoutFor: ${n} ${n === 1 ? 'person' : 'people'}, ${size}`, () => {
      const group = crowd(n), ids = group.people.map(p => p.id);
      const L = layoutFor(ids, size);
      assert.deepEqual([...L.pos.keys()], ids);
      const spots = [...L.pos.values()];
      spots.forEach(P => {
        ['x', 'y', 'ox', 'oy'].forEach(k => assert.ok(Number.isFinite(P[k]), k + ' is a number'));
        assert.ok(Math.abs(Math.hypot(P.ox, P.oy) - 1) < 1e-9, 'the outward direction has length 1');
        assert.ok(P.x - L.r >= 0 && P.x + L.r <= L.w && P.y - L.r >= 0 && P.y + L.r <= L.h, 'circle inside the picture');
      });
      spots.forEach((P, i) => spots.slice(i + 1).forEach(Q =>
        assert.ok(Math.hypot(P.x - Q.x, P.y - Q.y) >= 2 * L.r + 12, 'circles keep apart')));
      if (n >= 3) {
        assert.ok(Math.abs(spots[0].x - L.w / 2) < 1e-9 && spots.every(P => P.y >= spots[0].y - 1e-9), 'the first person sits at the top');
      }

      // Room for the names: draw it and see where the words land.
      const g = ringDebts(n);
      const svg = graphSVG({ group, layout: L, prev: g, next: g, t: 1, step: REST, maxV: 250000 });
      const nodes = checkFrame(svg, L, group).filter(el => 'data-node' in el.attrs);
      const boxes = nodes.map(nameBox);
      boxes.forEach((box, i) => {
        assert.ok(inside(box, L), `name of person ${i} leaves the picture: ${JSON.stringify(box)}`);
        spots.forEach((P, j) => assert.ok(!boxMeetsDisc(box, P.x, P.y, L.r), `name of person ${i} sits on circle ${j}`));
        boxes.slice(i + 1).forEach((other, k) => assert.ok(!boxesMeet(box, other), `names of person ${i} and ${i + 1 + k} overlap`));
      });
      nodes.forEach((node, i) => assert.equal(child(node, 'g-name').text, group.people[i].name, 'short names are shown in full'));
    });
  }
}

test('long names are cut with "…" and stay inside the picture; long balances are never cut', () => {
  for (const size of SIZES) {
    for (const n of [2, 5, 12]) {
      const group = crowd(n);
      group.currency = 'IDR';
      group.people.forEach((p, i) => { p.name = i % 2 ? 'Bartholomew Fitzgerald-Montgomery the Third' : 'ALEXANDRIA WOLFESCHLEGELSTEIN ' + i; });
      const g = new Map([...ringDebts(n)].map(([k, v]) => [k, v * 1e7 + 1]));
      const { els, layout } = still(group, g, {}, size);
      els.filter(el => 'data-node' in el.attrs).forEach((node, i) => {
        const name = child(node, 'g-name').text, bal = child(node, 'g-bal').text;
        assert.ok(name.endsWith('…') && isCutOf(name, group.people[i].name), 'name is cut: ' + name);
        assert.ok(inside(textBox(child(node, 'g-name'), 12), layout), 'cut name inside the picture');
        assert.match(bal, /^(gets|owes) /);
        assert.ok(!bal.includes('…'));
        assert.ok(inside(textBox(child(node, 'g-bal'), 11), layout), 'balance inside the picture: ' + bal);
      });
    }
  }
});

/* ---------- people ---------- */

test('people: who gets, who owes, who is even', () => {
  const group = example();
  const g = new Map([[key(BEN, ANA), 10000], [key(CY, ANA), 2550], [key(DEE, ELI), 12345]]);
  const { els } = still(group, g);
  const expectLine = { [ANA]: 'gets ' + formatMoney(12550, 'USD'), [BEN]: 'owes ' + formatMoney(10000, 'USD'),
    [CY]: 'owes ' + formatMoney(2550, 'USD'), [DEE]: 'owes ' + formatMoney(12345, 'USD'), [ELI]: 'gets ' + formatMoney(12345, 'USD') };
  for (const p of group.people) {
    const node = nodeOf(els, p.id);
    assert.equal(child(node, 'g-bal').text, expectLine[p.id]);
    assert.equal(child(node, 'g-name').text, p.name);
    assert.equal(child(node, 'g-ini').text, initials(p.name));
    assert.ok(has(node, expectLine[p.id].startsWith('gets') ? 'is-get' : 'is-owe'));
    assert.ok(!child(node, 'g-ring') && !has(node, 'is-hl') && !has(node, 'is-hov') && !has(node, 'is-dim'));
  }
  const settled = still(group, new Map([[key(BEN, ANA), 10000]])).els;
  assert.ok(has(nodeOf(settled, CY), 'is-even'));
  assert.equal(child(nodeOf(settled, CY), 'g-bal').text, 'even');
});

test('people: balances use the group currency, whole units for yen', () => {
  const group = example();
  group.currency = 'JPY';
  const { els } = still(group, new Map([[key(BEN, ANA), 1500]]));
  assert.equal(child(nodeOf(els, ANA), 'g-bal').text, 'gets ' + formatMoney(1500, 'JPY'));
  assert.ok(!/[.,]\d\d$/.test(child(nodeOf(els, ANA), 'g-bal').text));
});

test('people: the ones a step is about get a second ring, but not on the first or last step', () => {
  const group = example(), g = new Map([[key(BEN, ANA), 10000]]);
  const during = still(group, g, { step: { phase: 2, hl: {}, people: new Set([BEN, ANA]) } }).els;
  assert.ok(has(nodeOf(during, BEN), 'is-hl') && child(nodeOf(during, BEN), 'g-ring'));
  assert.ok(has(nodeOf(during, ANA), 'is-hl') && child(nodeOf(during, ANA), 'g-ring'));
  assert.ok(!has(nodeOf(during, CY), 'is-hl') && !child(nodeOf(during, CY), 'g-ring'));
  for (const phase of [0, 6]) {
    const els = still(group, g, { step: { phase, hl: {}, people: new Set([BEN, ANA]) } }).els;
    assert.equal(byClass(els, 'is-hl').length, 0);
    assert.equal(byClass(els, 'g-ring').length, 0);
  }
});

/* ---------- arrows ---------- */

test('arrows: 1 to 6 wide by amount, labels show the amount in full', () => {
  const group = example();
  const g = new Map([[key(BEN, ANA), 10000], [key(CY, ANA), 2550], [key(DEE, ELI), 1]]);
  const { els } = still(group, g);
  assert.equal(byClass(els, 'g-edge').length, 3);
  assert.equal(+edgeOf(els, key(BEN, ANA)).attrs['stroke-width'], 6);
  const mid = +edgeOf(els, key(CY, ANA)).attrs['stroke-width'], thin = +edgeOf(els, key(DEE, ELI)).attrs['stroke-width'];
  assert.ok(thin >= 1 && thin < mid && mid < 6);
  // "$100.00" keeps its cents, like the balances and the settle cards.
  assert.equal(child(labelOf(els, key(BEN, ANA)), 'g-amt').text, formatMoney(10000, 'USD'));
  assert.equal(child(labelOf(els, key(CY, ANA)), 'g-amt').text, formatMoney(2550, 'USD'));
  assert.equal(child(labelOf(els, key(DEE, ELI)), 'g-amt').text, formatMoney(1, 'USD'));
  byClass(els, 'g-edge').forEach(e => assert.equal(e.attrs['marker-end'], 'url(#g-ah-ink)'));
  assert.deepEqual(byClass(els, 'g-mk-ink').length + byClass(els, 'g-mk-mute').length, 2);
});

test('arrows: an amount over maxV, or a missing maxV, still gives a sane width', () => {
  const group = example(), g = new Map([[key(BEN, ANA), 10000]]);
  for (const maxV of [1, 0, undefined, NaN, -5]) {
    const { els } = still(group, g, { maxV });
    assert.equal(+edgeOf(els, key(BEN, ANA)).attrs['stroke-width'], 6);
  }
});

test('arrows: ink when the step points at nothing, grey when it points at others', () => {
  const group = example();
  const g = new Map([[key(BEN, ANA), 10000], [key(CY, ANA), 2550], [key(DEE, ELI), 12345]]);
  const plain = still(group, g, { step: { phase: 3, hl: {}, people: new Set() } }).els;
  byClass(plain, 'g-edge').forEach(e => assert.ok(has(e, 'is-plain')));
  byClass(plain, 'g-lbl').forEach(l => assert.ok(has(l, 'is-plain')));

  const step = { phase: 2, hl: { kind: 'net', edges: [[BEN, ANA], [ANA, BEN]] }, people: new Set([BEN, ANA]) };
  const { els } = still(group, g, { step });
  const on = edgeOf(els, key(BEN, ANA));
  assert.ok(has(on, 'is-on') && has(labelOf(els, key(BEN, ANA)), 'is-on'));
  assert.equal(on.attrs['marker-end'], 'url(#g-ah-ink)');
  assert.equal(+on.attrs['stroke-width'], +edgeOf(plain, key(BEN, ANA)).attrs['stroke-width'] + 1, 'slightly heavier');
  for (const k of [key(CY, ANA), key(DEE, ELI)]) {
    assert.ok(has(edgeOf(els, k), 'is-off') && has(labelOf(els, k), 'is-off'));
    assert.equal(edgeOf(els, k).attrs['marker-end'], 'url(#g-ah-mute)');
    assert.equal(edgeOf(els, k).attrs['stroke-width'], edgeOf(plain, k).attrs['stroke-width']);
  }
  const edges = byClass(els, 'g-edge');
  assert.ok(has(edges.at(-1), 'is-on'), 'the arrow the step is about is painted last, on top');
});

test('focus: everything that does not touch the followed person is dimmed', () => {
  const group = example();
  const g = new Map([[key(BEN, ANA), 10000], [key(CY, ANA), 2550], [key(DEE, ELI), 12345]]);
  const { els } = still(group, g, { focus: ELI });
  assert.deepEqual(group.people.map(p => has(nodeOf(els, p.id), 'is-dim')), [true, true, true, false, false]);
  assert.ok(!has(edgeOf(els, key(DEE, ELI)), 'is-dim') && !has(labelOf(els, key(DEE, ELI)), 'is-dim'));
  for (const k of [key(BEN, ANA), key(CY, ANA)]) assert.ok(has(edgeOf(els, k), 'is-dim') && has(labelOf(els, k), 'is-dim'));
  assert.equal(byClass(els, 'g-hit').length, 3, 'dimmed arrows can still be pointed at');
  for (const focus of ['', null, undefined, 'p-nobody']) assert.equal(byClass(still(group, g, { focus }).els, 'is-dim').length, 0);
});

test('hover: the arrow or person pointed at is marked', () => {
  const group = example();
  const g = new Map([[key(BEN, ANA), 10000], [key(CY, ANA), 2550]]);
  const step = { phase: 2, hl: { kind: 'net', edges: [[BEN, ANA]] }, people: new Set() };
  const calm = still(group, g, { step }).els;
  const { els } = still(group, g, { step, hoverKey: key(CY, ANA), hoverNode: DEE });
  const edge = edgeOf(els, key(CY, ANA));
  assert.ok(has(edge, 'is-hov') && has(edge, 'is-off') && has(labelOf(els, key(CY, ANA)), 'is-hov'));
  assert.equal(edge.attrs['marker-end'], 'url(#g-ah-ink)', 'a grey arrow turns ink while pointed at');
  assert.equal(+edge.attrs['stroke-width'], +edgeOf(calm, key(CY, ANA)).attrs['stroke-width'] + 2);
  assert.ok(!has(edgeOf(els, key(BEN, ANA)), 'is-hov'));
  assert.ok(has(nodeOf(els, DEE), 'is-hov') && child(nodeOf(els, DEE), 'g-ring'));
  assert.equal(byClass(els, 'is-hov').length, 3);
  assert.equal(byClass(calm, 'is-hov').length, 0);
});

test('arrows between unknown people, or from a person to themselves, are left out', () => {
  const group = example();
  const g = new Map([[key(BEN, ANA), 100], [key('p-ghost', ANA), 100], [key(BEN, BEN), 100], ['nonsense', 5], ['a>b>c', 5]]);
  const { els } = still(group, g);
  assert.deepEqual(byClass(els, 'g-hit').map(h => h.attrs['data-key']), [key(BEN, ANA)]);
});

/* ---------- movement ---------- */

const hop = () => {
  const prev = new Map([[key(BEN, CY), 1001], [key(CY, ANA), 1001], [key(DEE, ELI), 500]]);
  const next = new Map([[key(BEN, ANA), 1001], [key(DEE, ELI), 500]]);
  const step = { phase: 4, hl: { kind: 'hop', path: [BEN, CY, ANA], direct: [BEN, ANA], edges: [[BEN, CY], [CY, ANA], [BEN, ANA]] }, people: new Set([BEN, CY, ANA]) };
  return { prev, next, step, maxV: 1001 };
};
const frame = (group, o, t, size = 'wide', extra = {}) => {
  const layout = layoutOf(group, size);
  return checkFrame(graphSVG({ group, layout, t, focus: '', ...o, ...extra }), layout, group);
};
const keysOf = els => byClass(els, 'g-hit').map(h => h.attrs['data-key']).sort();
const amountOn = (els, k) => labelOf(els, k) && child(labelOf(els, k), 'g-amt').text;

test('a middleman step: the dot travels first, then the amounts move', () => {
  const group = example(), o = hop();
  const start = frame(group, o, 0);
  assert.deepEqual(keysOf(start), [key(BEN, CY), key(CY, ANA), key(DEE, ELI)].sort());
  assert.equal(byClass(start, 'g-token').length, 1);
  assert.ok(has(edgeOf(start, key(BEN, CY)), 'is-down') && has(edgeOf(start, key(CY, ANA)), 'is-down'));
  assert.ok(has(edgeOf(start, key(DEE, ELI)), 'is-off'));

  const early = frame(group, o, 0.25);
  const dot0 = byClass(start, 'g-token')[0], dot1 = byClass(early, 'g-token')[0];
  assert.ok(dot0.attrs.cx !== dot1.attrs.cx || dot0.attrs.cy !== dot1.attrs.cy, 'the dot moves');
  assert.equal(amountOn(early, key(BEN, CY)), formatMoney(1001, 'USD'), 'amounts wait for the dot');
  const tokenAt = byClass(early, 'g-token')[0], firstLabel = byClass(early, 'g-lbl')[0];
  assert.ok(early.indexOf(tokenAt) < early.indexOf(firstLabel), 'the dot is drawn under the amount labels');

  const late = frame(group, o, 0.7);
  assert.equal(byClass(late, 'g-token').length, 0);
  assert.deepEqual(keysOf(late), [key(BEN, ANA), key(BEN, CY), key(CY, ANA), key(DEE, ELI)].sort());
  assert.ok(has(edgeOf(late, key(BEN, ANA)), 'is-on'));
  assert.ok(has(edgeOf(late, key(BEN, CY)), 'is-down'));
  assert.ok(!('marker-end' in edgeOf(late, key(BEN, ANA)).attrs), 'a growing arrow has no head yet');

  const nearlyDone = frame(group, o, 0.9999);
  assert.equal(byClass(nearlyDone, 'is-gone').length, 2, 'arrows that reached zero fade before they go');
  assert.deepEqual(keysOf(nearlyDone), [key(BEN, ANA), key(DEE, ELI)].sort());

  const end = frame(group, o, 1);
  assert.deepEqual(keysOf(end), [key(BEN, ANA), key(DEE, ELI)].sort());
  assert.equal(byClass(end, 'g-token').length + byClass(end, 'is-down').length + byClass(end, 'is-gone').length, 0);
  assert.ok(has(edgeOf(end, key(BEN, ANA)), 'is-on') && has(edgeOf(end, key(DEE, ELI)), 'is-off'));
  assert.equal(edgeOf(end, key(BEN, ANA)).attrs['marker-end'], 'url(#g-ah-ink)');
  assert.equal(amountOn(end, key(BEN, ANA)), formatMoney(1001, 'USD'));
});

test('a step that only reroutes money never changes a balance on screen, at any moment', () => {
  const group = example(), o = hop();
  const expected = { [ANA]: 'gets ' + formatMoney(1001, 'USD'), [BEN]: 'owes ' + formatMoney(1001, 'USD'), [CY]: 'even',
    [DEE]: 'owes ' + formatMoney(500, 'USD'), [ELI]: 'gets ' + formatMoney(500, 'USD') };
  for (let i = 0; i <= 200; i++) {
    const els = frame(group, o, i / 200);
    for (const p of group.people) assert.equal(child(nodeOf(els, p.id), 'g-bal').text, expected[p.id], `t = ${i / 200}`);
    assert.ok(has(nodeOf(els, CY), 'is-even') && has(nodeOf(els, CY), 'is-hl'));
  }
});

test('at rest: t = 1, t past 1, a missing t, and prev === next all give the same picture', () => {
  const group = example(), o = hop(), layout = layoutOf(group, 'wide');
  const draw = extra => graphSVG({ group, layout, ...o, ...extra });
  const rest = draw({ t: 1 });
  assert.equal(draw({ t: 1.7 }), rest);
  assert.equal(draw({ t: undefined }), rest);
  assert.equal(draw({ t: NaN }), rest);
  assert.equal(draw({ prev: o.next, t: 0.3 }), rest);
  assert.equal(draw({ prev: undefined, t: 0.3 }), rest);
  assert.equal(draw({ t: -3 }), draw({ t: 0 }), 'a time before the start is the start');
  assert.equal(draw({ t: 0.4 }), draw({ t: 0.4 }), 'same input, same output');
  assert.notEqual(draw({ t: 0.4 }), rest);
});

test('a bill arriving: arrows grow from the person who owes, and carry the bill name when there are few', () => {
  const group = example();
  const prev = new Map([[key(DEE, ELI), 500]]);
  const next = new Map([[key(DEE, ELI), 500], [key(BEN, ANA), 4000], [key(CY, ANA), 4000]]);
  const step = { phase: 1, hl: { kind: 'add', bill: 'Dinner at the very long-named taberna by the river', edges: [[BEN, ANA], [CY, ANA]] }, people: new Set([BEN, CY, ANA]) };
  const o = { prev, next, step, maxV: 4000 };

  assert.deepEqual(keysOf(frame(group, o, 0)), [key(DEE, ELI)]);
  const growing = frame(group, o, 0.4);
  assert.deepEqual(keysOf(growing), [key(BEN, ANA), key(CY, ANA), key(DEE, ELI)].sort());
  assert.ok(has(edgeOf(growing, key(BEN, ANA)), 'is-on') && !('marker-end' in edgeOf(growing, key(BEN, ANA)).attrs));
  assert.equal(labelOf(growing, key(BEN, ANA)), undefined, 'no label on an arrow that has barely started');
  const full = edgeOf(frame(group, o, 1), key(BEN, ANA)).attrs.d, part = edgeOf(growing, key(BEN, ANA)).attrs.d;
  assert.equal(part.split(' ')[0], full.split(' ')[0], 'it starts where the finished arrow starts');
  assert.notEqual(part, full);

  const end = frame(group, o, 1);
  for (const k of [key(BEN, ANA), key(CY, ANA)]) {
    const cap = child(labelOf(end, k), 'g-cap');
    assert.ok(cap && cap.text.endsWith('…') && isCutOf(cap.text, step.hl.bill), 'bill name, cut to fit');
    assert.equal(+labelOf(end, k).children.find(c => c.tag === 'rect').attrs.height, 30);
  }
  assert.equal(child(labelOf(end, key(DEE, ELI)), 'g-cap'), undefined);
  assert.equal(+labelOf(end, key(DEE, ELI)).children.find(c => c.tag === 'rect').attrs.height, 18);

  // more than three new arrows: no bill names, the picture would be too full
  const many = new Map([[key(BEN, ANA), 100], [key(CY, ANA), 100], [key(DEE, ANA), 100], [key(ELI, ANA), 100]]);
  const busy = frame(group, { prev: new Map(), next: many, maxV: 100, step: { phase: 1, hl: { kind: 'add', bill: 'Taxi', edges: [...many.keys()].map(k => k.split('>')) }, people: new Set() } }, 1);
  assert.equal(byClass(busy, 'g-cap').length, 0);
  assert.equal(byClass(busy, 'is-on').filter(el => has(el, 'g-edge')).length, 4);
});

test('a loop step: the dot goes all the way round', () => {
  const group = example();
  const prev = new Map([[key(ANA, BEN), 300], [key(BEN, CY), 500], [key(CY, ANA), 400]]);
  const next = new Map([[key(BEN, CY), 200], [key(CY, ANA), 100]]);
  const step = { phase: 3, hl: { kind: 'loop', path: [ANA, BEN, CY, ANA], edges: [[ANA, BEN], [BEN, CY], [CY, ANA]] }, people: new Set([ANA, BEN, CY]) };
  const seen = new Set();
  for (const t of [0, 0.1, 0.2, 0.3, 0.4, 0.49]) {
    const dot = byClass(frame(group, { prev, next, step, maxV: 500 }, t), 'g-token');
    assert.equal(dot.length, 1);
    seen.add(dot[0].attrs.cx + ',' + dot[0].attrs.cy);
  }
  assert.equal(seen.size, 6);
  assert.equal(byClass(frame(group, { prev, next, step, maxV: 500 }, 0.5), 'g-token').length, 0);
  // a path through someone who is not in the picture: no dot, no crash
  const broken = { ...step, hl: { ...step.hl, path: [ANA, 'p-ghost', CY] } };
  assert.equal(byClass(frame(group, { prev, next, step: broken, maxV: 500 }, 0.2), 'g-token').length, 0);
});

/* ---------- edges of the input ---------- */

test('no people: one line of help and nothing else', () => {
  const group = { ...example(), people: [] };
  const layout = layoutFor([], 'narrow');
  const els = parse(graphSVG({ group, layout, prev: new Map(), next: new Map(), t: 1, step: REST, maxV: 1 }));
  assert.equal(els.length, 1);
  assert.equal(els[0].text, 'Add people to start.');
  assert.ok(has(els[0], 'g-empty'));
  assert.equal(+els[0].attrs.x, 200);
});

test('missing pieces do not break a frame', () => {
  const group = example(), layout = layoutOf(group, 'wide');
  for (const opts of [{ group, layout }, { group, layout, next: new Map(), step: {} }, { group, layout, prev: new Map(), next: new Map([[key(BEN, ANA), 5]]), t: 0.5, step: { phase: 1 } }]) {
    checkFrame(graphSVG(opts), layout, group);
  }
  // a person the layout does not know yet is left out instead of drawn at "NaN"
  const more = example();
  more.people.push({ id: 'p-new', name: 'Fay' });
  const svg = graphSVG({ group: more, layout, next: new Map([[key('p-new', ANA), 5]]), t: 1, step: REST, maxV: 5 });
  assert.ok(!svg.includes('NaN') && !svg.includes('p-new'));
  assert.equal(parse(svg).filter(el => 'data-node' in el.attrs).length, 5);
});

test('hostile names, titles and ids only ever appear escaped', () => {
  const IMG = '<img src=x onerror=alert(1)>', SCRIPT = '"><script>alert(1)</script>', QUOTE = `p-x" onload="alert(1)`;
  const group = { id: 'g-h', name: 'h', currency: 'USD', rev: 0, rates: {}, expenses: [],
    people: [{ id: 'p-a', name: IMG }, { id: QUOTE, name: SCRIPT }, { id: 'p-c', name: '<b>&amp;</b> O\'Neil' }, { id: 'p-d', name: '</text></g><svg onload=alert(1)>' }] };
  const next = new Map([[key('p-a', QUOTE), 4200], [key('p-c', 'p-a'), 100], [key('p-d', 'p-c'), 7]]);
  const step = { phase: 1, hl: { kind: 'add', bill: SCRIPT, edges: [['p-a', QUOTE]] }, people: new Set(['p-a', QUOTE]) };
  for (const size of SIZES) {
    for (const t of [0, 0.3, 0.7, 1]) {
      const layout = layoutOf(group, size);
      const svg = graphSVG({ group, layout, prev: new Map(), next, t, step, maxV: 4200, focus: QUOTE, hoverKey: key('p-a', QUOTE), hoverNode: QUOTE });
      for (const raw of ['<img', '<script', '</script', '<svg', '<b>', 'onload="']) assert.ok(!svg.includes(raw), `raw ${raw} at t=${t}`);
      const els = checkFrame(svg, layout, group);   // also proves the only tags are the graph's own
      if (t === 1) {
        assert.ok(svg.includes('&lt;img src=x'), 'the name is there, as text');
        group.people.forEach(p => assert.ok(isCutOf(child(nodeOf(els, p.id), 'g-name').text, p.name), 'name of ' + p.id));
        assert.ok(child(nodeOf(els, 'p-c'), 'g-name').text.startsWith('<b>&amp;</b>'), 'an "&amp;" somebody typed is shown as typed');
        assert.equal(child(nodeOf(els, 'p-a'), 'g-ini').text, '<S');
        assert.equal(child(nodeOf(els, QUOTE), 'g-ini').text, '">');
        assert.ok(isCutOf(child(labelOf(els, key('p-a', QUOTE)), 'g-cap').text, SCRIPT));
        assert.deepEqual(Object.keys(nodeOf(els, QUOTE).attrs).sort(), ['class', 'data-node']);
      }
    }
  }
});

test('very large amounts: labels are wider but still inside the picture', () => {
  const group = example();
  group.currency = 'IDR';
  const g = new Map([[key(BEN, ANA), 1e13], [key(CY, ANA), 9.9e12], [key(DEE, ELI), 1e13 - 1], [key(ANA, ELI), 123456789012]]);
  for (const size of SIZES) {
    const { els } = still(group, g, { step: { phase: 1, hl: { kind: 'add', bill: 'W'.repeat(80), edges: [[BEN, ANA]] }, people: new Set() } }, size);
    assert.equal(byClass(els, 'g-lbl').length, 4);
    assert.equal(child(labelOf(els, key(DEE, ELI)), 'g-amt').text, formatMoney(1e13 - 1, 'IDR'));
  }
});

test('a wide label on an arrow that hugs the border is pushed back inside', () => {
  // Twelve people on a phone: the arrow from person 4 up to person 2 bends towards the right-hand border.
  // A made-up currency code makes formatMoney fall back to "CODE 123.45", which is long in every locale.
  const group = crowd(12);
  group.currency = 'TESTMONEY';
  const k = key('p-4', 'p-2'), amount = 8e15 + 50, g = new Map([[k, amount]]);
  const { els, layout } = still(group, g, {}, 'narrow');   // `still` checks that every label is inside
  const rect = labelOf(els, k).children.find(c => c.tag === 'rect');
  assert.ok(+rect.attrs.width > 180, 'the label is wide');
  assert.ok(+rect.attrs.x + +rect.attrs.width > layout.w - 2, 'it ends at the border, not past it');
  assert.equal(child(labelOf(els, k), 'g-amt').text, 'TESTMONEY 80000000000000.50', 'the amount is never cut');
});

/* ---------- the built-in example, every step ---------- */

for (const mode of ['fewest', 'keep']) {
  test(`example group, "${mode}": every step, at four moments, in both sizes`, { skip: needsSimplify }, () => {
    const group = example();
    const steps = simplify.buildSteps(group, mode);
    assert.ok(steps.length > 10);
    const lineFor = b => (b > 0 ? 'gets ' + formatMoney(b, 'USD') : b < 0 ? 'owes ' + formatMoney(-b, 'USD') : 'even');
    const positive = g => [...g].filter(([, v]) => v > 0).map(([k]) => k).sort();
    let frames = 0;
    for (const size of SIZES) {
      const layout = layoutOf(group, size);
      steps.forEach((step, i) => {
        const prev = steps[Math.max(0, i - 1)].g, next = step.g;
        for (const t of [0, 0.3, 0.7, 1]) {
          const where = `${size}, step ${i} (${step.title}), t=${t}`;
          const svg = graphSVG({ group, layout, prev, next, t, step, maxV: steps.maxV, focus: '', hoverKey: null, hoverNode: null });
          const els = checkFrame(svg, layout, group);
          frames++;

          // one hit path per visible arrow
          const keys = keysOf(els);
          if (t === 1 || i === 0) assert.deepEqual(keys, positive(next), where);
          else if (t === 0) assert.deepEqual(keys, positive(prev), where);
          else {
            const all = new Set([...positive(prev), ...positive(next)]);
            keys.forEach(k => assert.ok(all.has(k), `${where}: arrow from nowhere ${k}`));
            positive(next).filter(k => prev.get(k) > 0).forEach(k => assert.ok(keys.includes(k), `${where}: lost arrow ${k}`));
          }

          // names and balances stay inside the picture
          els.filter(el => 'data-node' in el.attrs).forEach(node => assert.ok(inside(nameBox(node), layout), `${where}: name outside the picture`));

          // at rest the picture says exactly what the step's graph says
          const shown = Object.fromEntries(group.people.map(p => [p.id, child(nodeOf(els, p.id), 'g-bal').text]));
          const bal = simplify.balancesOf(t === 0 && i > 0 ? prev : next);
          if (t === 0 || t === 1) group.people.forEach(p => assert.equal(shown[p.id], lineFor(bal.get(p.id) || 0), where));
          if (t === 1) positive(next).forEach(k => {
            const label = amountOn(els, k), fullText = formatMoney(next.get(k), 'USD');
            const digits = s => s.replace(/\D/g, '');
            assert.ok(label === fullText || (next.get(k) % 100 === 0 && digits(label) + '00' === digits(fullText)), `${where}: label ${label} for ${fullText}`);
          });
          // once all bills are in, no frame of any later step shows a different balance
          if (step.phase >= 2) {
            const settled = simplify.balancesOf(steps.afterBills);
            group.people.forEach(p => assert.equal(shown[p.id], lineFor(settled.get(p.id) || 0), `${where}: balance moved`));
          }
          // the step's own arrows are ink, the rest grey; nothing is grey when the step points at nothing
          if (t === 1) {
            const mine = new Set((step.hl.edges || []).map(e => key(e[0], e[1])));
            positive(next).forEach(k => assert.ok(has(edgeOf(els, k), mine.has(k) ? 'is-on' : mine.size ? 'is-off' : 'is-plain'), `${where}: state of ${k}`));
          }
          assert.equal(byClass(els, 'g-token').length, step.hl.path && i > 0 && t < 0.5 ? 1 : 0, `${where}: dot`);
        }
      });
    }
    assert.equal(frames, steps.length * 8);
  });
}

test('example group: following a person and pointing at things, on every step', { skip: needsSimplify }, () => {
  const group = example();
  const steps = simplify.buildSteps(group, 'fewest');
  for (const size of SIZES) {
    const layout = layoutOf(group, size);
    steps.forEach((step, i) => {
      const prev = steps[Math.max(0, i - 1)].g, hoverKey = [...step.g.keys()][0] || null;
      for (const t of [0.5, 1]) {
        const els = checkFrame(graphSVG({ group, layout, prev, next: step.g, t, step, maxV: steps.maxV, focus: ELI, hoverKey, hoverNode: CY }), layout, group);
        assert.ok(!has(nodeOf(els, ELI), 'is-dim') && has(nodeOf(els, CY), 'is-hov'));
        byClass(els, 'g-hit').forEach(h => {
          const [a, b] = h.attrs['data-key'].split('>');
          assert.equal(has(edgeOf(els, h.attrs['data-key']), 'is-dim'), a !== ELI && b !== ELI);
        });
      }
    });
  }
});
