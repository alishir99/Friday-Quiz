/* Every screen, drawn in Node behind the thinnest possible DOM.

   `node --check` only proves a file parses. It cannot see a screen calling a
   helper that no longer exists - that is a runtime ReferenceError, and one of
   those shipped: the Team page died with "adminCard is not defined" after a
   refactor moved code around. This catches that class of thing in a second,
   without a browser.

   Deliberately not a full DOM. The stubs only have to be good enough for the
   screens to build their element tree; if a screen ever needs more, add the
   one method rather than reaching for a DOM library - this app has no
   dependencies and that is worth keeping. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Real instances, because QC.append only keeps a child it recognises as a
   Node - anything else it turns into a text node, and the tree a test wants to
   walk would come out flattened. */
function NodeStub(){}
const node = () => Object.assign(new NodeStub(), {
  children: [], style: { setProperty(){}, removeProperty(){}, getPropertyValue(){ return ''; } }, classList: { add(){}, remove(){}, toggle(){}, contains(){return false} },
  dataset: {}, hidden: false, textContent: '', value: '',
  appendChild(c){ this.children.push(c); return c; }, append(...c){ this.children.push(...c); },
  // Handlers are kept so a test can press a button; the tag so a test can ask
  // what a screen actually built.
  addEventListener(t, fn){ (this.on = this.on || {})[t] = fn; }, removeEventListener(){},
  setAttribute(){}, removeAttribute(){},
  querySelector(){ return node(); }, querySelectorAll(){ return []; },
  closest(){ return null; }, focus(){}, select(){}, remove(){}, insertBefore(){}, cloneNode(){ return node(); },
  getBoundingClientRect(){ return { top:0,left:0,width:0,height:0 }; }
});

const documentStub = {
  createElement: (tag) => Object.assign(node(), { tag }),
  createElementNS: node, createTextNode: () => node(),
  getElementById: () => node(), querySelector: () => node(), querySelectorAll: () => [],
  addEventListener(){}, body: node(), documentElement: node()
};

const sandbox = {
  window: {}, document: documentStub, console,
  localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  location: { origin: 'http://x', hash: '#/', host: 'x' },
  navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
  addEventListener(){}, removeEventListener(){}, scrollTo(){}, matchMedia: () => ({ matches:false, addEventListener(){} }),
  XMLHttpRequest: function(){ this.open=()=>{}; this.send=()=>{}; this.setRequestHeader=()=>{}; },
  EventSource: undefined, Math, JSON, Date,
  Node: NodeStub, Element: NodeStub, Promise, Error, Buffer
};
sandbox.window = sandbox;
vm.createContext(sandbox);

for (const f of ['store.js','ui.js','qrcode.js','net.js','screens.js','live.js','app.js']) {
  vm.runInContext(readFileSync('public/js/' + f, 'utf8'), sandbox, { filename: f });
}

const me = 'u1', mate = 'u2';

/* Rebuilt per test: app.js starts a boot when it loads, and that boot fails
   against the stub fetch and nulls QC.state out from under us. */
function freshState(extra) {
  return Object.assign({
    me, team: { id: 't1', name: 'Friday Quiz' }, siteAdmin: true,
    adminId: me, inviteCode: 'ABC123', rules: '', revealMode: 'end',
    users: [
      { id: me, name: 'Ali', active: true, guest: false, online: true },
      { id: mate, name: 'Jahn', active: true, guest: false, online: false },
      { id: 'u3', name: 'Gone', active: false, guest: false, online: false }
    ],
    history: [],
    upcoming: { id: 'w1', date: '2026-08-21', quizMasterId: me, topicPickerId: mate,
                reason: {}, topic: 'Badgers', topicSet: true, quiz: null, quizReady: false },
    live: null
  }, extra || {});
}

for (const name of ['home', 'team', 'rules', 'history']) {
  test('the ' + name + ' screen draws', () => {
    sandbox.QC.state = freshState();
    assert.doesNotThrow(() => sandbox.QC.screens[name]());
  });
}

/* The same screens as somebody with no powers: a guest sees a different Team
   page, and half the buttons are gone. Re-running with a plain member catches
   anything that only exists inside an isAdmin() branch. */
test('the screens draw for an ordinary member too', () => {
  for (const name of ['home', 'team', 'rules', 'history']) {
    sandbox.QC.state = freshState({ siteAdmin: false, adminId: mate });
    assert.doesNotThrow(() => sandbox.QC.screens[name](), name);
  }
});

/* The tiebreaker takes a number, and a phone spells numbers the way its own
   locale does. An iOS decimal key is a comma on a great many handsets, and an
   <input type="number"> reports an empty value for "70,2" rather than the text
   - so the guess vanished and the field looked fine. Both number fields parse
   through QC.readNumber now, which is small enough to check outright. */
test('a number is read however the phone spelled it', () => {
  const r = sandbox.QC.readNumber;
  assert.equal(r('70.2'), 70.2, 'a dot, as a desktop types it');
  assert.equal(r('70,2'), 70.2, 'a comma, as an iOS decimal key gives it');
  assert.equal(r('328,45'), 328.45, 'two decimal places');
  assert.equal(r('  40 '), 40, 'whitespace either side');
  assert.equal(r('-3,5'), -3.5, 'and negatives');

  // Grouped thousands are not decimals, and reading 1,000 as 1 would be worse
  // than refusing it.
  assert.equal(r('1,000'), 1000);
  assert.equal(r('12,345,678'), 12345678);

  // An empty field and a bad one are different things: one is "carry on", the
  // other is "say so".
  assert.equal(r(''), null, 'nothing typed');
  assert.equal(r('   '), null, 'only whitespace');
  assert.ok(Number.isNaN(r('banana')), 'not a number');
  assert.ok(Number.isNaN(r('1,2,3')), 'ambiguous rubbish is refused, not guessed at');
});

/* The Rules page: written in Markdown, read as headings and lists. Both halves
   are worth checking without a browser - the drawing, because a screen that
   only appears after a button press is one the loop above never reaches, and
   the marker-writing, because where the cursor lands afterwards is the part
   that is easy to get quietly wrong. */

function find(node, text) {
  if (!node || typeof node !== 'object') return null;
  if (node.textContent === text) return node;
  for (const kid of node.children || []) {
    const hit = find(kid, text);
    if (hit) return hit;
  }
  return null;
}

test('the rules are drawn as a document, not as markers', () => {
  const doc = sandbox.QC.richText('# Rules\n- one\n- two\n\nPlain **bold** line');
  assert.deepEqual(doc.children.map(c => c.tag), ['h2', 'ul', 'p']);
  assert.equal(doc.children[1].children.length, 2, 'both bullets');
  assert.ok(doc.children[2].children.some(c => c.tag === 'strong'), '**bold** became a strong');

  // Numbers are their own list, and a line with no marker is still a paragraph.
  assert.deepEqual(sandbox.QC.richText('1. one\n2. two').children.map(c => c.tag), ['ol']);
  assert.deepEqual(sandbox.QC.richText('just a line').children.map(c => c.tag), ['p']);
});

test('the rules editor draws once the admin presses Edit', () => {
  sandbox.QC.state = freshState({ rules: '# House rules\n- Be nice' });
  const edit = find(sandbox.QC.screens.rules(), 'Edit');
  assert.ok(edit, 'the read view offers an Edit button');

  const render = sandbox.QC.render;
  sandbox.QC.render = () => {};            // there is no page to redraw in here
  try {
    edit.on.click();
    assert.doesNotThrow(() => sandbox.QC.screens.rules());
  } finally {
    sandbox.QC.render = render;
    sandbox.QC.state = freshState({ siteAdmin: false, adminId: mate });
    sandbox.QC.screens.rules();            // drops the draft, so later tests read
  }
});

test('a toolbar button writes the markers and keeps the words selected', () => {
  const md = sandbox.QC.mdApply;

  const plain = (o) => ({ ...o });
  assert.deepEqual(plain(md('bold', 'hello', 0, 5)), { value: '**hello**', start: 2, end: 7 });
  assert.deepEqual(plain(md('italic', 'hello', 0, 5)), { value: '*hello*', start: 1, end: 6 });

  // The same button takes them off again, from either side of the selection.
  assert.deepEqual(plain(md('bold', '**hello**', 0, 9)), { value: 'hello', start: 0, end: 5 });
  assert.deepEqual(plain(md('bold', '**hello**', 2, 7)), { value: 'hello', start: 0, end: 5 });

  // Nothing selected: the marks go in and the cursor sits between them.
  assert.deepEqual(plain(md('bold', 'ab', 1, 1)), { value: 'a****b', start: 3, end: 3 });

  // Line buttons take the whole line, however little of it was selected.
  assert.equal(md('bullet', 'one\ntwo', 1, 5).value, '- one\n- two');
  assert.equal(md('number', 'one\ntwo', 0, 7).value, '1. one\n2. two');
  assert.equal(md('bullet', '- one\n- two', 0, 11).value, 'one\ntwo', 'and take it off again');
  assert.equal(md('heading', 'Scoring', 0, 0).value, '## Scoring');
  assert.equal(md('number', '- one\n- two', 0, 11).value, '1. one\n2. two', 'one list becomes the other');
});
