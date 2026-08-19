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

const node = () => ({
  children: [], style: { setProperty(){}, removeProperty(){}, getPropertyValue(){ return ''; } }, classList: { add(){}, remove(){}, toggle(){}, contains(){return false} },
  dataset: {}, hidden: false, textContent: '', value: '',
  appendChild(c){ this.children.push(c); return c; }, append(...c){ this.children.push(...c); },
  addEventListener(){}, removeEventListener(){}, setAttribute(){}, removeAttribute(){},
  querySelector(){ return node(); }, querySelectorAll(){ return []; },
  closest(){ return null; }, focus(){}, select(){}, remove(){}, insertBefore(){}, cloneNode(){ return node(); },
  getBoundingClientRect(){ return { top:0,left:0,width:0,height:0 }; }
});

const documentStub = {
  createElement: node, createElementNS: node, createTextNode: () => node(),
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
  Node: function Node(){}, Element: function Element(){}, Promise, Error, Buffer
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
