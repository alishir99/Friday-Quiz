/* ui.js: tiny DOM helpers, sheets, toasts. No framework. */

(function () {
  var QC = window.QC;

  /** el('div.card', {onclick:fn}, [children|string]) */
  QC.el = function (spec, attrs, kids) {
    var parts = String(spec).split(/(?=[.#])/);
    var node = document.createElement(parts.shift() || 'div');
    parts.forEach(function (p) {
      if (p[0] === '.') node.classList.add(p.slice(1));
      else if (p[0] === '#') node.id = p.slice(1);
    });
    if (attrs && (Array.isArray(attrs) || typeof attrs === 'string' || attrs instanceof Node)) {
      kids = attrs; attrs = null;
    }
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    });
    if (kids !== null && kids !== undefined) QC.append(node, kids);
    return node;
  };

  QC.append = function (node, kids) {
    (Array.isArray(kids) ? kids : [kids]).forEach(function (k) {
      if (k === null || k === undefined || k === false) return;
      node.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    });
    return node;
  };

  QC.clear = function (node) { while (node.firstChild) node.removeChild(node.firstChild); return node; };

  QC.avatar = function (name, cls) {
    return QC.el('span.av' + (cls ? '.' + cls : ''), { text: QC.initials(name), title: name || '' });
  };

  var MEDALS = ['🥇', '🥈', '🥉'];

  /* Where someone finished, in the circle their initials would otherwise be.
     The name is written right beside it, so initials would only be saying the
     same thing twice - the placing is the useful thing to put there.

     ranked = false for someone with no result to their name. They still get
     their row number rather than a dash: the row itself already says they have
     not played, and one plain sentence beats two cryptic marks. */
  QC.placeFace = function (name, place, cls, ranked) {
    var medal = (ranked === false) ? '' : (MEDALS[place] || '');
    // .m1/.m2/.m3 carry the metal, so the ring matches the medal it holds.
    var mark = medal ? '.medal.m' + (place + 1) : '.place';
    return QC.el('span.av' + (cls ? '.' + cls : '') + mark, {
      text: medal || String(place + 1),
      title: name || ''
    });
  };

  /* Lucide-style sparkles: the conventional "assistant" mark. An SVG rather
     than an emoji, so it inherits currentColor and renders the same on every
     machine instead of turning into whatever glyph the OS happens to ship. */
  QC.sparkle = '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M11.43 2.9a.6.6 0 0 1 1.14 0l1.26 3.88a3 3 0 0 0 1.92 1.92l3.88 1.26a.6.6 0 0 1 0 1.14l-3.88 1.26a3 3 0 0 0-1.92 1.92l-1.26 3.88a.6.6 0 0 1-1.14 0l-1.26-3.88a3 3 0 0 0-1.92-1.92L4.37 11.1a.6.6 0 0 1 0-1.14l3.88-1.26a3 3 0 0 0 1.92-1.92z"/>' +
    '<path d="M18.66 16.5a.34.34 0 0 1 .64 0l.44 1.36a1.5 1.5 0 0 0 .96.96l1.36.44a.34.34 0 0 1 0 .64l-1.36.44a1.5 1.5 0 0 0-.96.96l-.44 1.36a.34.34 0 0 1-.64 0l-.44-1.36a1.5 1.5 0 0 0-.96-.96l-1.36-.44a.34.34 0 0 1 0-.64l1.36-.44a1.5 1.5 0 0 0 .96-.96z"/></svg>';

  QC.arrowUp = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
               '<path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" stroke="currentColor" stroke-width="1.8" ' +
               'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  QC.chev = '<svg width="9" height="14" viewBox="0 0 9 14" fill="none" aria-hidden="true">' +
            '<path d="M1.5 1L7.5 7L1.5 13" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* toasts */

  QC.toast = function (msg, ms) {
    var host = document.getElementById('toasts');
    var t = QC.el('div.toast', { text: msg });
    host.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .3s, transform .3s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(10px)';
      setTimeout(function () { t.remove(); }, 320);
    }, ms || 2400);
  };

  /* sheets (modal dialogs) */

  var sheetHost = null;
  var lastFocus = null;

  QC.sheet = function (opts) {
    QC.closeSheet();
    sheetHost = document.getElementById('sheetHost');
    lastFocus = document.activeElement;

    var body = QC.el('div.sheet', { role: 'dialog', 'aria-modal': 'true', tabindex: '-1' }, [
      opts.title ? QC.el('h3', { text: opts.title }) : null,
      opts.sub ? QC.el('p.sub', { text: opts.sub }) : null,
      opts.content || null,
      opts.actions ? QC.el('div.row', { style: { marginTop: '26px', justifyContent: 'flex-end' } }, opts.actions) : null
    ]);

    QC.clear(sheetHost).appendChild(body);
    sheetHost.hidden = false;
    sheetHost.onclick = function (e) { if (e.target === sheetHost && opts.dismissible !== false) QC.closeSheet(); };
    document.addEventListener('keydown', escClose, true);

    var firstInput = body.querySelector('input, textarea, select, button');
    (firstInput || body).focus();
    return body;
  };

  function escClose(e) { if (e.key === 'Escape') { e.stopPropagation(); QC.closeSheet(); } }

  QC.closeSheet = function () {
    var host = document.getElementById('sheetHost');
    if (!host || host.hidden) return;
    host.hidden = true;
    QC.clear(host);
    document.removeEventListener('keydown', escClose, true);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  };

  /** Promise<boolean> confirm dialog. */
  QC.confirm = function (opts) {
    return new Promise(function (resolve) {
      var done = function (v) { QC.closeSheet(); resolve(v); };
      QC.sheet({
        title: opts.title,
        sub: opts.sub,
        actions: [
          QC.el('button.btn.ghost', { type: 'button', text: opts.cancel || 'Cancel', onclick: function () { done(false); } }),
          QC.el('button.btn' + (opts.danger ? '.danger' : '.primary'),
            { type: 'button', text: opts.ok || 'Continue', onclick: function () { done(true); } })
        ]
      });
    });
  };

  /** Promise<string|null> single-line prompt. */
  QC.ask = function (opts) {
    return new Promise(function (resolve) {
      var input = QC.el('input.input', {
        type: opts.type || 'text',
        value: opts.value || '',
        placeholder: opts.placeholder || '',
        maxlength: opts.maxlength || 80
      });
      var submit = function () {
        var v = input.value.trim();
        if (!v) { input.focus(); return; }
        QC.closeSheet(); resolve(v);
      };
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      QC.sheet({
        title: opts.title,
        sub: opts.sub,
        content: QC.el('div.field', [input]),
        actions: [
          QC.el('button.btn.ghost', { type: 'button', text: 'Cancel',
            onclick: function () { QC.closeSheet(); resolve(null); } }),
          QC.el('button.btn.primary', { type: 'button', text: opts.ok || 'Save', onclick: submit })
        ]
      });
      setTimeout(function () { input.focus(); input.select(); }, 40);
    });
  };

  /** Person picker sheet. onPick(memberId). */
  QC.pickPerson = function (opts) {
    var people = opts.people || (QC.state && QC.state.users) || [];
    var rows = people.map(function (m) {
      return QC.el('button.list-row', {
        type: 'button',
        style: { width: '100%', background: 'transparent', border: 0, borderBottom: '1px solid var(--line-soft)',
                 cursor: 'pointer', textAlign: 'left' },
        onclick: function () { QC.closeSheet(); opts.onPick(m.id); }
      }, [
        QC.avatar(m.name),
        QC.el('div', [
          QC.el('div.nm', { text: m.name }),
          opts.subFor ? QC.el('div.rl', { text: opts.subFor(m) }) : null
        ]),
        QC.el('div.spacer'),
        QC.el('span.dim', { html: QC.chev })
      ]);
    });

    QC.sheet({
      title: opts.title,
      sub: opts.sub,
      content: rows.length ? QC.el('div.list', rows) : QC.el('p.muted', { text: 'Nobody on the team yet.' })
    });
  };
})();
