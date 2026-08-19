/* app.js: boot, routing, the live takeover. */

(function () {
  var QC = window.QC;
  var el = QC.el;

  QC.state = null;
  QC.route = 'home';

  var ROUTES = { '': 'home', 'team': 'team', 'history': 'history', 'build': 'build', 'rules': 'rules' };

  function currentRoute() {
    var h = (location.hash || '#/').replace(/^#\/?/, '').split('/')[0];
    return ROUTES[h] || 'home';
  }

  /* render */

  QC.render = function () {
    var app = document.getElementById('app');
    var nav = document.getElementById('nav');
    var foot = document.querySelector('.foot');
    QC.clear(app);
    // Only the quiz editor docks the assistant; every other screen, a running
    // game included, gets its full width back. The editor re-adds these as it
    // renders, so this has to clear before any of the early returns below.
    document.body.classList.remove('assist-docked', 'assist-open');

    // Not signed in, so show nothing but the sign-in card.
    if (!QC.state || QC.state.anonymous) {
      nav.hidden = true;
      foot.hidden = true;
      document.body.classList.add('bare');
      app.appendChild(QC.screens.auth());
      return;
    }

    nav.hidden = false;
    foot.hidden = false;
    document.body.classList.remove('bare');

    // A running quiz takes over every screen. Nobody has to find a "join" button.
    if (QC.live.isRunning()) {
      document.body.classList.add('playing');
      nav.hidden = true;
      foot.hidden = true;
      try {
        app.appendChild(QC.live.render());
      } catch (err) {
        console.error('Friday Quiz: live view failed', err);
        app.appendChild(errorScreen('the quiz', err));
      }
      return;
    }

    document.body.classList.remove('playing');
    QC.route = currentRoute();

    try {
      app.appendChild(QC.screens[QC.route]());
    } catch (err) {
      console.error('Friday Quiz: could not draw the ' + QC.route + ' screen', err);
      app.appendChild(errorScreen(QC.route, err));
    }

    // The brand shows which team you are looking at, not the app's name.
    var brand = document.querySelector('.brand-name');
    if (brand) brand.textContent = (QC.state.team && QC.state.team.name) || 'Friday Quiz';

    // A guest has no team page to speak of - nothing there applies to them.
    var meNow = QC.user(QC.state.me);
    var amGuest = !!(meNow && meNow.guest);
    document.querySelectorAll('.nav-links a').forEach(function (a) {
      a.classList.toggle('on', a.dataset.route === QC.route);
      if (a.dataset.route === 'team') a.hidden = amGuest;
    });
    renderWhoami();
    window.scrollTo(0, 0);
  };

  function errorScreen(what, err) {
    return el('div.empty', { style: { marginTop: '40px' } }, [
      el('div.big', { text: 'Something went wrong' }),
      el('p', { style: { marginTop: '8px' } }, 'Could not draw ' + what + '. Your data is safe on the server.'),
      el('p.dim.small', { style: { marginTop: '12px', fontFamily: 'monospace' },
        text: String((err && err.message) || err) }),
      el('div.row', { style: { justifyContent: 'center', marginTop: '24px' } }, [
        el('button.btn.ghost', { type: 'button', text: 'Reload', onclick: function () { location.reload(); } }),
        el('a.btn.ghost', { href: '#/', 'data-nav': '', text: 'Home' })
      ])
    ]);
  }

  /* connection indicator */

  QC.setConnection = function (ok) {
    var badge = document.getElementById('conn');
    if (!badge) return;
    badge.hidden = !!ok;
  };

  /* who am I */

  function renderWhoami() {
    var btn = document.getElementById('whoami');
    var me = QC.user(QC.state.me);
    QC.clear(btn);
    if (!me) return;
    // Named so a narrow screen can drop it and keep just the face.
    QC.append(btn, [QC.avatar(me.name), el('span.whoami-name', { text: me.name.split(/\s+/)[0] })]);
    btn.onclick = function () {
      QC.sheet({
        title: me.name,
        content: el('div.stack', { style: { gap: '10px' } }, [
          el('div.field', [
            el('label', { text: 'Appearance' }),
            el('div.seg', [['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(function (o) {
              return el('button', { type: 'button', text: o[1], class: QC.theme.get() === o[0] ? 'on' : '',
                onclick: function (e) {
                  QC.theme.set(o[0]);
                  e.target.parentNode.querySelectorAll('button').forEach(function (b) { b.classList.remove('on'); });
                  e.target.classList.add('on');
                } });
            }))
          ]),
          el('button.btn.ghost.block', { type: 'button', text: 'Change password', style: { marginTop: '10px' },
            onclick: changePassword }),
          el('button.btn.ghost.block', { type: 'button', text: 'Sign out', style: { marginTop: '10px' },
            onclick: function () {
              QC.closeSheet();
              QC.net.logout().then(function () { QC.net.disconnect(); QC.boot(); });
            } })
        ]),
        actions: [el('button.btn.primary', { type: 'button', text: 'Done', onclick: QC.closeSheet })]
      });
    };
  }

  function changePassword() {
    var oldPass = el('input.input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
    var newPass = el('input.input', { type: 'password', placeholder: 'New password', autocomplete: 'new-password' });
    var err = el('p.auth-err', { hidden: true });

    function submit() {
      err.hidden = true;
      QC.net.changePassword(oldPass.value, newPass.value)
        .then(function () { QC.closeSheet(); QC.toast('Password changed'); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; });
    }
    newPass.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

    QC.sheet({
      title: 'Change password',
      content: el('div.stack', { style: { gap: '10px' } }, [oldPass, newPass, err]),
      actions: [
        el('button.btn.ghost', { type: 'button', text: 'Cancel', onclick: QC.closeSheet }),
        el('button.btn.primary', { type: 'button', text: 'Save', onclick: submit })
      ]
    });
  }

  /* boot */

  QC.boot = function () {
    return QC.net.call('api/state')
      .then(function (s) {
        QC.state = s;
        QC.render();
        if (!s.anonymous) QC.net.connect();
      })
      .catch(function (err) {
        QC.state = null;
        document.getElementById('app').appendChild(
          errorScreen('the app', new Error('Cannot reach the server. Is it still running? (' + err.message + ')')));
      });
  };

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-nav]');
    if (a && (a.getAttribute('href') || '')[0] === '#') {
      e.preventDefault();
      location.hash = a.getAttribute('href');
    }
  });

  window.addEventListener('hashchange', function () { QC.render(); });

  /* A file dropped anywhere other than a drop zone would otherwise be opened
     by the browser, throwing away a half-written quiz. Text dragged between
     fields still behaves normally. */
  ['dragover', 'drop'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      if (e.defaultPrevented || !QC.dragHasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    });
  });

  /* The quiz master can drive the slides from the keyboard. */
  document.addEventListener('keydown', function (e) {
    if (!QC.state || !QC.live.isRunning() || !QC.isMaster()) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!document.getElementById('sheetHost').hidden) return;

    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown' || e.key === 'Enter') {
      e.preventDefault(); QC.net.advance().catch(function (err) { QC.toast(err.message); });
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'Backspace') {
      e.preventDefault(); QC.net.back().catch(function (err) { QC.toast(err.message); });
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      else document.documentElement.requestFullscreen().catch(function () {});
    }
  });

  /* A remembered panel width can be too wide for a smaller window, so it is
     re-clamped against the new size rather than written down again. */
  window.addEventListener('resize', function () { QC.assistWidth.apply(); });

  QC.theme.apply();
  QC.assistWidth.apply();
  QC.boot();
})();
