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

  /* Marks the footnote under a revealed answer. Drawn rather than typed: a
     letter "i" in a CSS circle sits at whatever height the font feels like,
     and this has to line up with one line of small text every time. */
  QC.infoIcon = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<circle cx="10" cy="10" r="8.6" stroke="currentColor" stroke-width="1.5"/>' +
    '<circle cx="10" cy="6.15" r="1.15" fill="currentColor"/>' +
    '<path d="M10 9.1v5.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  QC.tick = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
            '<path d="M3 8.4l3.2 3.2L13 4.8" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* The paperclip on a drop zone. An emoji 📎 renders as a fat colour glyph
     that ignores currentColor, sits at its own baseline, and is a different
     picture on every OS. Drawn the same way as the rest of this set - one
     weight, round caps, inherits the colour of whatever it sits in. */
  QC.paperclip = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19' +
    'a2 2 0 0 1-2.83-2.83l8.49-8.48" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  QC.chev = '<svg width="9" height="14" viewBox="0 0 9 14" fill="none" aria-hidden="true">' +
            '<path d="M1.5 1L7.5 7L1.5 13" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* The two list buttons on the Rules toolbar. Drawn rather than typed: the
     bullet and number glyphs a font ships with sit at their own heights and
     will not line up beside a B and an I. */
  QC.bulletIcon = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '<circle cx="4.5" cy="6" r="1.6" fill="currentColor"/><circle cx="4.5" cy="12" r="1.6" fill="currentColor"/>' +
    '<circle cx="4.5" cy="18" r="1.6" fill="currentColor"/></svg>';

  QC.numberIcon = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '<text x="1" y="8.6" font-size="8" font-weight="700" fill="currentColor">1</text>' +
    '<text x="1" y="14.6" font-size="8" font-weight="700" fill="currentColor">2</text>' +
    '<text x="1" y="20.6" font-size="8" font-weight="700" fill="currentColor">3</text></svg>';

  /* written text, drawn

     The rules are stored the way they always were - plain text - so nothing
     written before this needs converting, and nothing coming back from the
     server can smuggle markup in: every node below is built, never handed to
     innerHTML. The subset is exactly what the Rules toolbar can write and no
     more: **bold**, *italic*, # headings, - bullets, 1. numbers. */

  var INLINE = /\*\*([\s\S]+?)\*\*|\*([^*\n]+)\*/g;
  QC.md = { bullet: /^\s*[-*]\s+/, number: /^\s*\d+[.)]\s+/, heading: /^\s*#{1,3}\s+/ };

  function inlineInto(node, str) {
    var last = 0, m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(str))) {
      if (m.index > last) node.appendChild(document.createTextNode(str.slice(last, m.index)));
      var mark = document.createElement(m[1] ? 'strong' : 'em');
      mark.textContent = m[1] || m[2];
      node.appendChild(mark);
      last = m.index + m[0].length;
    }
    if (last < str.length) node.appendChild(document.createTextNode(str.slice(last)));
  }

  function isBlock(line) {
    return QC.md.bullet.test(line) || QC.md.number.test(line) || QC.md.heading.test(line);
  }

  QC.richText = function (text) {
    var doc = document.createElement('div');
    doc.className = 'doc';
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }

      var h = /^\s*(#{1,3})\s+(.*)$/.exec(line);
      if (h) {
        var head = document.createElement('h' + (h[1].length + 1));
        inlineInto(head, h[2]);
        doc.appendChild(head);
        i++; continue;
      }

      var ordered = !QC.md.bullet.test(line) && QC.md.number.test(line);
      if (ordered || QC.md.bullet.test(line)) {
        var re = ordered ? QC.md.number : QC.md.bullet;
        var list = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length && re.test(lines[i])) {
          var item = document.createElement('li');
          inlineInto(item, lines[i].replace(re, ''));
          list.appendChild(item);
          i++;
        }
        doc.appendChild(list); continue;
      }

      /* A run of ordinary lines is one paragraph with the breaks kept. People
         press Enter where they want a new line, not where a Markdown parser
         would like a blank one. */
      var p = document.createElement('p');
      var first = true;
      while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) {
        if (!first) p.appendChild(document.createElement('br'));
        inlineInto(p, lines[i]);
        first = false; i++;
      }
      doc.appendChild(p);
    }
    return doc;
  };

  /* What a toolbar button does to the text, with no textarea in sight: value
     and selection in, value and selection out. Pure, so the fiddly part -
     where the cursor ends up - can be checked without a browser. */
  QC.mdApply = function (kind, value, start, end) {
    var cut = function (from, to, text, s, e) {
      return { value: value.slice(0, from) + text + value.slice(to), start: s, end: e };
    };

    var mark = { bold: '**', italic: '*' }[kind];
    if (mark) {
      var sel = value.slice(start, end), n = mark.length;
      // The same button takes it off again, whether the marks are inside the
      // selection or just outside it.
      if (sel.length >= 2 * n && sel.slice(0, n) === mark && sel.slice(-n) === mark)
        return cut(start, end, sel.slice(n, -n), start, end - 2 * n);
      if (value.slice(start - n, start) === mark && value.slice(end, end + n) === mark)
        return cut(start - n, end + n, sel, start - n, end - n);
      return cut(start, end, mark + sel + mark, start + n, end + n);
    }

    // Line prefixes work on whole lines, however little of them was selected.
    var from = value.lastIndexOf('\n', start - 1) + 1;
    var to = value.indexOf('\n', end);
    if (to < 0) to = value.length;
    var lines = value.slice(from, to).split('\n');
    var re = QC.md[kind];
    var on = lines.every(function (l) { return re.test(l); });
    var out = lines.map(function (l, k) {
      var bare = l.replace(QC.md.bullet, '').replace(QC.md.number, '').replace(QC.md.heading, '');
      if (on) return bare;
      return (kind === 'number' ? (k + 1) + '. ' : kind === 'heading' ? '## ' : '- ') + bare;
    }).join('\n');
    return cut(from, to, out, from, from + out.length);
  };

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
    /* Enter does what the dialog is for. Handled here rather than on each
       input so that confirmations get it too - they have no field to hang it
       off, and pressing Enter at "Remove team?" doing nothing feels broken.
       A button keeps its own Enter (the browser clicks the focused one), and
       a textarea keeps Enter for newlines. */
    body.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON')) return;
      var buttons = body.querySelectorAll('.row button');
      var primary = buttons[buttons.length - 1];       // the affirmative one
      if (primary) { e.preventDefault(); primary.click(); }
    });

    /* Where the cursor lands decides what Enter does, so it is chosen rather
       than left to document order. A field first, if there is one. Otherwise
       the affirmative button - except on a destructive dialog, where Cancel
       is the safe place to be leaning. */
    var field = body.querySelector('input, textarea, select');
    var actions = body.querySelectorAll('.row button');
    var primary = actions[actions.length - 1];
    var target = field
      || ((primary && !primary.classList.contains('danger')) ? primary : actions[0])
      || body;
    target.focus();
    if (field && field.select) field.select();
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
