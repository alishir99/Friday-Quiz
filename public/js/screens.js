/* screens.js: sign in, home, team, quiz editor, history. */

(function () {
  var QC = window.QC;
  var el = QC.el, av = QC.avatar;

  QC.screens = {};

  /* The quiz master and the topic picker already know the topic - seeing it on
     the dashboard is a reminder, not news. It stays covered by default because
     this is the screen most likely to end up on a shared display, and kept out
     here so it survives the re-render every server push causes. */
  var topicShown = false;

  /* SIGN IN */

  QC.screens.auth = function () {
    var name = el('input.input', {
      placeholder: 'Your name', autocomplete: 'username', maxlength: 40
    });
    var pass = el('input.input', {
      placeholder: 'Password', type: 'password', autocomplete: 'current-password', maxlength: 80
    });
    /* Only new accounts need this, so it stays out of the way until the
       server says one is required - the team never sees it after joining. */
    var invite = el('input.input', {
      placeholder: 'Invite code', autocomplete: 'off', maxlength: 80
    });
    var inviteField = el('div.stack', { hidden: true, style: { gap: '12px' } }, [invite]);
    var err = el('p.auth-err', { hidden: true });
    // Filled in once a code is recognised, so nobody joins the wrong quiz.
    var whose = el('p.auth-team', { hidden: true });
    var btn = el('button.btn.primary.lg.block', { type: 'button', text: 'Continue' });

    /* Someone who is here for one night should not have to invent a password
       or hunt down the invite code. Same screen, two doors. */
    var guest = false;
    var lede = el('p.muted', { style: { marginTop: '8px', marginBottom: '26px' },
      text: 'Sign in with your name and password to join this week’s quiz.' });
    var note = el('p.dim.small', { style: { marginTop: '18px', textAlign: 'center' },
      text: 'First time in, this creates your account with that password. Forgot it? Ask your quiz master to reset it from the Team page.' });
    var swap = el('button.btn.ghost.sm.block', { type: 'button',
      style: { marginTop: '12px' }, text: 'Just visiting? Join as a guest' });
    var memberOnly = el('div.stack', { style: { gap: '12px' } }, [pass]);
    // One input, parked in whichever half of the form is currently showing.
    var codeSlot = el('div.stack', { style: { gap: '12px' } }, [inviteField, whose]);

    /* A code names a team. Look it up as they type so they can see whose quiz
       they are about to join - a wrong code is easier to notice here than
       after signing up somewhere unexpected. */
    var lookingUp = null;
    function showTeamForCode() {
      var code = invite.value.trim();
      clearTimeout(lookingUp);
      if (!code) { whose.hidden = true; return; }
      lookingUp = setTimeout(function () {
        QC.net.teamForCode(code).then(function (r) {
          if (invite.value.trim() !== code) return;      // they typed on
          whose.hidden = !r.name;
          whose.textContent = r.name ? 'Joining ' + r.name : '';
        }).catch(function () { whose.hidden = true; });
      }, 250);
    }
    invite.addEventListener('input', showTeamForCode);

    function setMode(asGuest) {
      guest = asGuest;
      memberOnly.hidden = guest;
      err.hidden = true;
      name.placeholder = guest ? 'Your name for the scoreboard' : 'Your name';
      btn.textContent = guest ? 'Join the quiz' : 'Continue';
      swap.textContent = guest ? 'On the team? Sign in instead' : 'Just visiting? Join as a guest';
      lede.textContent = guest
        ? 'Pick a name and jump straight in. Nothing to set up.'
        : 'Sign in with your name and password to join this week’s quiz.';
      note.textContent = guest
        ? 'Guests play and score like everyone else, but never get handed next week’s quiz.'
        : 'First time in, this creates your account with that password. Forgot it? Ask your quiz master to reset it from the Team page.';
      name.focus();
    }
    swap.onclick = function () { setMode(!guest); };

    function go() {
      var v = name.value.trim();
      if (!v) { name.focus(); return; }
      if (!guest && !pass.value) { pass.focus(); return; }
      btn.disabled = true;
      err.hidden = true;
      var code = invite.value.trim();
      var req = guest ? QC.net.join(v, code) : QC.net.login(v, pass.value, code);
      /* Home, whatever address they arrived at. Someone sent a link to #/build
         lands on "only the quiz maker can write this quiz" the moment they
         sign in, which reads as being turned away at the door rather than as
         having followed a link meant for somebody else. */
      req.then(function () {
        /* replaceState rather than setting location.hash: assigning to it
           fires hashchange, which renders once against the state we have not
           fetched yet, and the sign-in screen flashes back before boot lands.
           This also leaves no trip back to #/build in the history. */
        if (location.hash && location.hash !== '#/') {
          history.replaceState(null, '', location.pathname + location.search + '#/');
        }
        QC.boot();
      })
        .catch(function (e) {
          err.textContent = e.message;
          err.hidden = false;
          btn.disabled = false;
          /* Two reasons the server asks for a code: a brand-new account has
             to quote one, or a name exists on more than one team and it is
             what says which. Same field either way. */
          if (e.body && (e.body.needInvite || e.body.needTeam)) {
            inviteField.hidden = false;
            invite.placeholder = e.body.needTeam ? 'Your team’s code' : 'Invite code';
            invite.focus();
          } else if (guest) { name.focus(); }
          else { pass.focus(); }
        });
    }
    btn.onclick = go;
    name.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (guest) go(); else pass.focus();
    });
    pass.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    invite.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });

    return el('div.auth', [
      el('div.auth-card', [
        el('div.auth-mark', { text: '🏆' }),
        el('h1', { text: 'Friday Quiz' }),
        lede,

        el('div.stack', { style: { gap: '12px' } }, [name, memberOnly, codeSlot]),
        err,
        el('div', { style: { marginTop: '20px' } }, [btn, swap]),
        note
      ])
    ]);
  };

  /* HOME */

  QC.screens.home = function () {
    var s = QC.state;
    if (!s.upcoming) return waitingForTeam();

    var u = s.upcoming;
    var master = QC.isMaster(), picker = QC.isPicker();
    var hasTopic = QC.hasTopic();
    // Empty while hasTopic is true means the topic is set but not ours to see.
    var topicText = QC.topicText();
    var ready = u.quizReady;
    var status = !hasTopic ? 'topic' : (!ready ? 'writing' : 'ready');

    var action = null, note = null;

    if (status === 'ready' && master) {
      action = el('button.btn.primary.lg', { type: 'button', text: '▶  Start the quiz', onclick: function (e) {
        e.target.disabled = true;
        QC.net.start().catch(function (err) { QC.toast(err.message); e.target.disabled = false; });
      } });
      //note = 'Everyone else will be pulled in automatically. Plug this screen into the projector.';
    } else if (status === 'ready') {
      note = 'All set. ' + QC.name(u.quizMasterId) + ' starts it, and this page will follow along on its own.';
    } else if (status === 'topic' && picker) {
      action = el('button.btn.primary.lg', { type: 'button', text: 'Choose the topic', onclick: chooseTopic });
    } else if (status === 'topic' && master) {
      // The topic usually arrives by Teams message, so the quiz master can
      // type it in themselves rather than waiting for the picker to log in.
      action = el('button.btn.primary.lg', { type: 'button', text: 'Set the topic', onclick: chooseTopic });
      note = QC.name(u.topicPickerId) + ' picks the topic. If they have already told you, put it in here.';
    } else if (status !== 'ready' && master && hasTopic) {
      action = el('button.btn.primary.lg', { type: 'button', text: 'Write the quiz',
        onclick: function () { location.hash = '#/build'; } });
    } else if (status === 'topic') {
      note = 'Waiting for ' + QC.name(u.topicPickerId) + ' to choose the topic.';
    } else {
      note = QC.name(u.quizMasterId) + ' is writing the questions.'
           + (topicText ? '' : ' The topic stays with them and ' + QC.name(u.topicPickerId) + ' until Friday.');
    }

    var pills = {
      topic: ['wait', 'Waiting for a topic'],
      writing: ['wait', 'Quiz being written'],
      ready: ['done', 'Ready to play']
    }[status];

    // topicText is only ever non-empty for the two people allowed to see it.
    var heading = !hasTopic ? 'Topic to be confirmed'
      : !topicText ? 'Topic under wraps'
      : topicShown ? topicText : 'Topic chosen';

    return el('div.stack', { style: { gap: '22px' } }, [
      el('div.hero', [
        el('div.row', [
          el('span.pill.' + pills[0], [el('span.dot'), pills[1]]),
          el('div.spacer'),
          el('span.dim.small', { text: 'Round ' + (s.history.length + 1) })
        ]),
        el('h2', { style: { marginTop: '20px' }, text: heading }),
        topicText ? el('button.btn.chip', {
          type: 'button', style: { marginTop: '12px' },
          text: topicShown ? 'Hide it' : 'Show me the topic',
          onclick: function () { topicShown = !topicShown; QC.render(); }
        }) : null,
        el('p.when', { text: QC.fmtDate(u.date) }),
        el('div.grid-2', { style: { marginTop: '32px' } }, [
          roleCard('Quiz maker', u.quizMasterId, u.reason && u.reason.master, master),
          roleCard('Topic picker', u.topicPickerId, u.reason && u.reason.picker, picker)
        ]),
        /* The action for whoever is looking, and off to the right the admin's
           override. Same line because they are the two things you might do to
           this week, not a footnote at the bottom of the page. */
        (action || QC.isAdmin()) ? el('div.row', { style: { marginTop: '32px' } }, [
          action,
          (status === 'ready' && master) ? revealSwitch() : null,
          el('div.spacer'),
          QC.isAdmin() ? el('button.btn.chip', { type: 'button',
            text: 'Change who does what', onclick: overrideRoles }) : null
        ]) : null,
        note ? el('p.muted', { style: { marginTop: action ? '14px' : '28px', fontSize: '16px' }, text: note }) : null
      ]),

      el('div.grid-2', [
        el('div.card', [
          el('div.row', [
            el('div.kicker', { text: 'Where we are' }),
            el('div.spacer'),
            hasTopic ? el('button.btn.chip', { type: 'button', text: 'Change topic',
              onclick: chooseTopic, hidden: !(master || picker) }) : null,
            (master && hasTopic) ? el('button.btn.chip', { type: 'button', text: 'Edit questions',
              onclick: function () { location.hash = '#/build'; } }) : null
          ]),
          el('div.steps', { style: { marginTop: '8px' } }, [
            phase(hasTopic, status === 'topic', 'Topic chosen',
              !hasTopic ? QC.name(u.topicPickerId) + ' picks it'
                : !topicText ? 'Kept quiet until Friday'
                : topicShown ? '“' + topicText + '”'
                : 'Yours to see, covered for now'),
            phase(ready, status === 'writing', 'Questions written',
              ready ? 'All 11 ready' : QC.name(u.quizMasterId) + ' is on it'),
            phase(false, status === 'ready', 'Play on Friday', 'Everyone answers on their own screen')
          ]),
        ]),
        el('div.card', [
          el('div.row', [
            el('div.kicker', { text: 'Standings' }),
            el('div.spacer'),
            s.history.length ? el('a.btn.quiet.sm', { href: '#/history', 'data-nav': '', text: 'All history' }) : null
          ]),
          s.history.length ? miniBoard() : el('p.muted', { style: { marginTop: '14px' },
            text: 'Nothing played yet. The table fills in after your first Friday.' })
        ])
      ])
    ]);

    function roleCard(label, id, why, isMe) {
      return el('div.role-card', [
        id ? av(QC.name(id), 'lg') : el('span.av.lg', { text: '?' }),
        el('div.who', [
          el('div.lbl', { text: label + (isMe ? ' (that’s you)' : '') }),
          el('div.val', { text: QC.name(id) }),
          why ? el('div.rl.small', { text: why }) : null
        ])
      ]);
    }

    function phase(done, now, t, d) {
      return el('div.step' + (done ? '.done' : (now ? '.now' : '')), [
        el('div.bullet', { text: done ? '✓' : (now ? '•' : '') }),
        el('div', [el('div.t', { text: t }), el('div.d', { text: d })])
      ]);
    }

    /* On: the pub way, nobody finds out anything until the end. Off: the answer
       lands straight after each question. Sits by the Start button because
       that is the moment you decide, and it is remembered for next time. */
    function revealSwitch() {
      var on = s.revealMode !== 'each';
      var box = el('input', { type: 'checkbox', checked: on, role: 'switch' });
      box.addEventListener('change', function () {
        QC.net.reveal(box.checked ? 'end' : 'each')
          .catch(function (e) { box.checked = on; QC.toast(e.message); });
      });
      return el('label.switch', { title: on
        ? 'Every answer comes after the last question'
        : 'Each answer comes straight after its question' }, [
        box,
        el('span.track', [el('span.knob')]),
        el('span.switch-t', { text: 'Answers at the end' })
      ]);
    }

    function chooseTopic() {
      QC.ask({
        title: 'What is the quiz about?',
        sub: 'Anything goes: films, geography, the 1980s, the office.',
        value: u.topic || '', placeholder: 'e.g. Who wants some Fika?', ok: 'Set topic'
      }).then(function (v) {
        if (v) QC.net.setTopic(v).catch(function (e) { QC.toast(e.message); });
      });
    }

    function overrideRoles() {
      // Neither job can go to a guest, so do not offer them.
      var members = QC.state.users.filter(function (u) { return !u.guest && u.active !== false; });
      QC.pickPerson({
        title: 'Who writes the quiz?',
        people: members,
        onPick: function (m) {
          QC.pickPerson({
            title: 'Who chooses the topic?',
            people: members,
            onPick: function (p) {
              QC.net.setRoles(m, p).catch(function (e) { QC.toast(e.message); });
            }
          });
        }
      });
    }
  };

  function waitingForTeam() {
    return el('div.empty', { style: { marginTop: '60px' } }, [
      el('div', { style: { fontSize: '48px', marginBottom: '14px' } }, '👋'),
      el('div.big', { text: 'Waiting for one more person' }),
      el('p', { style: { marginTop: '8px' } },
        'A quiz needs at least two accounts. Send your teammates this link and get them to sign up.'),
      el('p.dim.small', { style: { marginTop: '14px', fontFamily: 'monospace' }, text: location.origin })
    ]);
  }

  function miniBoard() {
    var rows = QC.leaderboard().filter(function (r) { return r.avg !== null; }).slice(0, 5);
    return el('div.board', { style: { marginTop: '14px' } }, rows.map(function (r, i) {
      return el('div.board-row' + (i === 0 ? '.p1' : ''), { style: { padding: '11px 16px' } }, [
        QC.placeFace(r.name, i),
        el('div.nm', { style: { fontSize: '16px' }, text: r.name }),
        el('div.sc', { style: { fontSize: '18px' }, text: r.avg.toFixed(1) })
      ]);
    }));
  }

  /* TEAM */

  QC.screens.team = function () {
    var s = QC.state;
    var board = QC.leaderboard();
    var statsFor = function (id) {
      for (var i = 0; i < board.length; i++) if (board[i].userId === id) return board[i];
      return null;
    };

    // This page is about the team, so one-night guests stay off it.
    var everyone = s.users.filter(function (u) { return !u.guest; });
    var members = everyone.filter(function (u) { return u.active !== false; });
    var removed = everyone.filter(function (u) { return u.active === false; });
    var onlineCount = members.filter(function (u) { return u.online; }).length;

    return el('div.stack', [
      /* Who runs this place comes first - it is the thing you check, and the
         thing you hand over. */
      adminCard(),

      /* One block per team, folded shut. Everything a team has - its people,
         its code, the QR to join it - lives inside its own fold rather than
         spread down the page, so two teams can never be read as one.
         <details> because the browser already does this properly: keyboard,
         screen readers and all. */
      yourTeamBlock(),
      s.siteAdmin ? otherTeams() : null
    ]);

    /* Your own team, open by default: it is the one you actually run. */
    function yourTeamBlock() {
      return el('details.team-fold', { open: true }, [
        el('summary.team-sum', [
          el('span.team-nm', { text: (s.team && s.team.name) || 'The team' }),
          el('span.pill.done', { text: 'Yours' }),
          el('div.spacer'),
          el('span.dim.small', { text: members.length + ' member' + (members.length === 1 ? '' : 's')
            + (onlineCount ? ' · ' + onlineCount + ' online' : '') })
        ]),
        el('div.team-body', [
          QC.isAdmin() ? el('div.row', { style: { marginBottom: '14px' } }, [
            el('button.btn.quiet.sm', { type: 'button', text: 'Rename team', onclick: renameTeam })
          ]) : null,
          el('div.list', members.map(memberRow)),
          removedBlock(),
          joinBlock()
        ])
      ]);
    }

    function memberRow(u) {
      var st = statsFor(u.id);
      return el('div.list-row', [
        el('span.av-wrap', [av(u.name), el('span.presence' + (u.online ? '.on' : ''),
          { title: u.online ? 'Online now' : 'Offline' })]),
        el('div', [
          el('div.person', [el('span.nm', { text: u.name + (u.id === s.me ? '  ·  you' : '') })]),
          el('div.rl', { text: st && st.played
            ? st.played + ' played · ' + st.avg.toFixed(1) + ' avg · ' + st.hosted + ' hosted'
            : 'Not played yet' })
        ]),
        el('div.spacer'),
        s.adminId === u.id ? el('span.pill', { text: 'Quiz master' }) : null,
        s.upcoming && s.upcoming.quizMasterId === u.id ? el('span.pill', { text: 'Quiz maker' }) : null,
        s.upcoming && s.upcoming.topicPickerId === u.id ? el('span.pill', { text: 'Topic picker' }) : null,
        QC.isAdmin() && u.id !== s.me ? el('button.btn.quiet.sm', { type: 'button', text: 'Reset password',
          onclick: function () { resetPassword(u); } }) : null,
        QC.isAdmin() && u.id !== s.me ? (function () {
          /* Removing whoever is down to write or pick next week would leave
             that job with nobody holding it. Saying so on the button beats
             letting them click and reading it in a toast. */
          var why = blockedFrom(u);
          return el('button.btn.quiet.sm' + (why ? '.is-off' : ''), {
            type: 'button', text: 'Remove', disabled: !!why,
            title: why || ('Remove ' + u.name + ' from the team'),
            onclick: function () { removeMember(u); }
          });
        })() : null
      ]);
    }

    /* Removed people are kept, not deleted, so every quiz they played still
       reads properly. Only the quiz master needs to see the list. */
    function removedBlock() {
      if (!QC.isAdmin() || !removed.length) return null;
      return el('div.card.flat', { style: { marginTop: '14px' } }, [
        el('div.kicker', { text: 'Removed  ·  ' + removed.length }),
        el('p.muted', { style: { marginTop: '8px', marginBottom: '14px' } },
          'They cannot sign in and are out of the rota. Past quizzes still show their name.'),
        el('div.list', removed.map(function (u) {
          var st = statsFor(u.id);
          return el('div.list-row.is-removed', [
            av(u.name),
            el('div', [
              el('div.person', [el('span.nm', { text: u.name })]),
              el('div.rl', { text: st && st.played ? st.played + ' played · ' + st.hosted + ' hosted' : 'Never played' })
            ]),
            el('div.spacer'),
            el('button.btn.quiet.sm', { type: 'button', text: 'Put back',
              onclick: function () {
                QC.net.setActive(u.id, true)
                  .then(function () { QC.toast(u.name + ' is back on the team'); })
                  .catch(function (e) { QC.toast(e.message); });
              } })
          ]);
        }))
      ]);
    }

    /* The link, the code and the QR - everything someone needs to get in. */
    function joinBlock() {
      return el('div.card.flat', { style: { marginTop: '14px' } }, [
        el('div.kicker', { text: 'Adding someone' }),
        el('p.muted', { style: { marginTop: '8px' } }, s.inviteCode
          ? 'Send them this link, or have them scan the code. They will need the code the first time.'
          : 'Send them this link, or have them scan the code, and they make their own account.'),
        el('p', { style: { marginTop: '10px', fontFamily: 'monospace', fontSize: '15px' }, text: location.origin }),
        inviteBlock(),
        el('div', { style: { marginTop: '14px' } }, [QC.qrSvg(location.origin, 4)])
      ]);
    }

    /* The other teams on this install, one fold each, for whoever owns the
       place. Loaded on demand - most people never open this page as site
       admin, and it is a second request. */
    function otherTeams() {
      var body = el('div', { style: { marginTop: '10px' } }, [el('p.muted', { text: 'Loading…' })]);

      QC.net.teams().then(function (r) {
        var others = r.teams.filter(function (t) { return !t.mine; });
        QC.clear(body);
        QC.append(body, [
          others.length
            ? el('div.stack', { style: { gap: '10px' } }, others.map(teamFold))
            : el('p.muted', { text: 'No other teams yet.' }),
          el('button.btn.quiet.sm', { type: 'button', text: '+  New team',
            style: { marginTop: '12px' }, onclick: addTeam })
        ]);
      }).catch(function (e) {
        QC.clear(body);
        QC.append(body, [el('p.auth-err', { text: e.message })]);
      });

      return el('div', { style: { marginTop: '20px' } }, [
        el('div.row', [
          el('div.kicker', { text: 'Other teams on this server' }),
          el('div.spacer'),
          el('button.btn.quiet.sm', { type: 'button', text: 'Hand on site admin',
            title: 'The whole server, not just a team', onclick: passSite })
        ]),
        body
      ]);
    }

    /* One other team, shut. Everything it has is inside: who is on it, its
       code, and the QR to join it. Nothing here acts on your own team. */
    function teamFold(t) {
      var live = t.users.filter(function (u) { return !u.guest && u.active; });
      return el('details.team-fold', [
        el('summary.team-sum', [
          el('span.team-nm', { text: t.name }),
          el('div.spacer'),
          el('span.dim.small', { text: live.length + ' member' + (live.length === 1 ? '' : 's')
            + ' · ' + t.played + ' played' })
        ]),
        el('div.team-body', [
          el('div.row', { style: { marginBottom: '14px' } }, [
            el('button.btn.quiet.sm', { type: 'button', text: 'Rename',
              onclick: function () { renameOther(t); } }),
            el('button.btn.quiet.sm.danger', { type: 'button', text: 'Remove team',
              onclick: function () { removeTeam(t); } })
          ]),
          el('div.list', live.length ? live.map(function (u) {
            return el('div.list-row', [
              av(u.name),
              el('div', [
                el('div.person', [el('span.nm', { text: u.name })]),
                el('div.rl', { text: t.masterId === u.id ? 'Quiz master' : 'Member' })
              ])
            ]);
          }) : [el('p.muted', { style: { padding: '10px 2px' }, text: 'Nobody has joined yet.' })]),

          el('div.card.flat', { style: { marginTop: '14px' } }, [
            el('div.kicker', { text: 'How they join' }),
            el('p', { style: { marginTop: '10px', fontFamily: 'monospace', fontSize: '15px' }, text: location.origin }),
            el('div.invite-box', { style: { marginTop: '12px' } }, [
              el('div.kicker', { text: 'Their code' }),
              el('div.invite-code', { text: t.code || 'open', title: 'Tap to copy',
                onclick: function () { copy(t.code); } })
            ]),
            el('div', { style: { marginTop: '14px' } }, [QC.qrSvg(location.origin, 4)])
          ])
        ])
      ]);
    }

    /* Handing over the server is not the same as handing over a team, and it
       is the one thing that cannot be undone by anyone but the new owner. */
    function passSite() {
      QC.net.teams().then(function (r) {
        var everyone = [];
        r.teams.forEach(function (t) {
          (t.users || []).forEach(function (u) {
            if (!u.guest && u.active && u.id !== s.me) {
              everyone.push({ id: u.id, name: u.name + '  ·  ' + t.name, active: true });
            }
          });
        });
        if (!everyone.length) return QC.toast('There is nobody else to hand it to');
        QC.pickPerson({
          title: 'Hand on site admin',
          sub: 'They take the whole server - creating teams and seeing every one of them. '
             + 'You keep any team you run. You will not be able to take this back yourself.',
          people: everyone,
          onPick: function (id) {
            QC.net.transferSite(id)
              .then(function () { QC.toast('Handed on'); QC.render(); })
              .catch(function (e) { QC.toast(e.message); });
          }
        });
      }).catch(function (e) { QC.toast(e.message); });
    }

    function renameOther(t) {
      QC.ask({
        title: 'Rename ' + t.name, value: t.name, placeholder: 'Team name', ok: 'Save'
      }).then(function (v) {
        if (!v) return;
        QC.net.renameTeam(v, t.id).then(function () { QC.render(); })
          .catch(function (e) { QC.toast(e.message); });
      });
    }

    function removeTeam(t) {
      QC.confirm({
        title: 'Remove ' + t.name + '?',
        sub: 'Their members, history and rota go with it, and everyone on it is signed out. '
           + 'A copy of the whole team is written to the server first, so it is recoverable by hand.',
        ok: 'Remove team', danger: true
      }).then(function (yes) {
        if (!yes) return;
        QC.net.removeTeam(t.id)
          .then(function (r) { QC.toast(r.name + ' removed'); QC.render(); })
          .catch(function (e) { QC.toast(e.message); });
      });
    }

    function addTeam() {
      QC.ask({
        title: 'New team',
        sub: 'They get their own members, rota and history. A code is made up unless you set one.',
        placeholder: 'e.g. The Badgers', ok: 'Create'
      }).then(function (name) {
        if (!name) return;
        QC.net.addTeam(name).then(function (r) {
          QC.toast(r.team.name + ' created · code ' + r.team.code);
          QC.render();
        }).catch(function (e) { QC.toast(e.message); });
      });
    }

    /* Why this person cannot be removed yet, or '' if they can. Mirrors the
       server's guards - it refuses either way, this just says so sooner. */
    /* The invite code, readable by any member so anyone can invite someone,
       changeable by the admin without going anywhere near the server. */
    function inviteBlock() {
      if (s.inviteCode === null || s.inviteCode === undefined) return null;   // a guest
      var admin = QC.isAdmin();
      if (!s.inviteCode) {
        return el('div', { style: { marginTop: '14px' } }, [
          el('p.muted', { text: 'Anyone with the link can sign up - no code is set.' }),
          admin ? el('button.btn.quiet.sm', { type: 'button', text: 'Set an invite code',
            style: { marginTop: '8px' }, onclick: newCode }) : null
        ]);
      }
      return el('div.invite-box', { style: { marginTop: '14px' } }, [
        el('div.kicker', { text: 'Invite code' }),
        el('div.invite-code', { text: s.inviteCode, title: 'Tap to copy',
          onclick: function () { copy(s.inviteCode); } }),
        admin ? el('div.row', { style: { marginTop: '10px' } }, [
          el('button.btn.quiet.sm', { type: 'button', text: 'New code', onclick: newCode }),
          el('button.btn.quiet.sm', { type: 'button', text: 'Type my own', onclick: pickCode })
        ]) : null
      ]);
    }

    function copy(text) {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text)
          .then(function () { QC.toast('Copied'); })
          .catch(function () { /* a tap that does nothing is better than a scary error */ });
      }
    }

    function newCode() {
      QC.confirm({
        title: 'Make a new invite code?',
        sub: 'The old one stops working straight away. Anyone who already has an account is unaffected.',
        ok: 'New code'
      }).then(function (yes) {
        if (!yes) return;
        QC.net.setInvite().then(function (r) { QC.toast('New code: ' + r.inviteCode); })
          .catch(function (e) { QC.toast(e.message); });
      });
    }

    function pickCode() {
      QC.ask({
        title: 'Invite code',
        sub: 'Anything your team will remember. Capitals do not matter.',
        value: s.inviteCode || '', placeholder: 'e.g. pickled-onion', ok: 'Save'
      }).then(function (v) {
        if (!v) return;                      // cancelled; it never returns empty
        QC.net.setInvite(v).catch(function (e) { QC.toast(e.message); });
      });
    }

    /* Who runs THIS team. It used to say "Admin", which read as running the
       whole server - and on a new team, "Become admin" looked like an open
       door to it. The server never allowed that; the words did. */
    function adminCard() {
      if (s.adminId) {
        return el('div.card.flat', { style: { marginTop: '10px' } }, [
          el('div.kicker', { text: 'Quiz master' }),
          el('div.row', { style: { marginTop: '10px', alignItems: 'center' } }, [
            av(QC.name(s.adminId)),
            el('div', { style: { marginLeft: '12px' } }, [
              el('div', { text: QC.name(s.adminId) + (s.adminId === s.me ? '  ·  you' : '') }),
              el('div.rl.small', { text: 'Runs ' + ((s.team && s.team.name) || 'this team') })
            ]),
            el('div.spacer'),
            s.siteAdmin ? el('span.pill', { title: 'You run this server', text: 'Site admin' }) : null,
            QC.isAdmin() ? el('button.btn.quiet.sm', { type: 'button',
              text: 'Hand on quiz master', title: 'Only this team. You keep everything else.',
              onclick: passAdmin }) : null
          ])
        ]);
      }
      return el('div.card.flat', { style: { marginTop: '10px' } }, [
        el('div.kicker', { text: 'Quiz master' }),
        el('p.muted', { style: { marginTop: '8px' } },
          'Nobody runs ' + ((s.team && s.team.name) || 'this team') + ' yet. The quiz master resets '
          + 'forgotten passwords, changes the code and edits the Rules page - for this team only.'),
        el('button.btn.sm', { type: 'button', text: 'Run this team', style: { marginTop: '10px' },
          onclick: function () { QC.net.claimAdmin().catch(function (e) { QC.toast(e.message); }); } })
      ]);
    }

    function passAdmin() {
      QC.pickPerson({
        title: 'Hand on quiz master',
        sub: 'They take over ' + ((s.team && s.team.name) || 'this team') + ' - passwords, the code, '
           + 'the rules and the rota. Nothing outside it.'
           + (s.siteAdmin ? ' You stay site admin of the whole server.' : ''),
        people: s.users.filter(function (u) { return u.id !== s.me && !u.guest && u.active !== false; }),
        onPick: function (id) { QC.net.transferAdmin(id).catch(function (e) { QC.toast(e.message); }); }
      });
    }

    function renameTeam() {
      QC.ask({
        title: 'Rename the team',
        sub: 'Shown at the top of the page and beside the code when someone joins.',
        value: (s.team && s.team.name) || '', placeholder: 'e.g. The Badgers', ok: 'Save'
      }).then(function (v) {
        if (!v) return;
        QC.net.renameTeam(v).catch(function (e) { QC.toast(e.message); });
      });
    }

    function blockedFrom(u) {
      // Only the person running the team is off limits. Anyone else can go,
      // and next week's duty is handed on for them.
      if (s.adminId === u.id) return 'Pass the quiz master role on first';
      return '';
    }

    function removeMember(u) {
      QC.confirm({
        title: 'Remove ' + u.name + '?',
        sub: 'They will be signed out and cannot sign back in. If they were down to write or '
           + 'pick next week, that gets handed on. Nothing is deleted - every quiz they played '
           + 'still shows their name, and you can put them back.',
        ok: 'Remove', danger: true
      }).then(function (yes) {
        if (!yes) return;
        QC.net.setActive(u.id, false)
          .then(function () { QC.toast(u.name + ' removed'); })
          .catch(function (e) { QC.toast(e.message); });
      });
    }

    function resetPassword(u) {
      QC.confirm({
        title: 'Reset ' + u.name + '’s password?',
        sub: 'They will get a new, temporary password. Give it to them yourself - in person, on Slack, however.',
        ok: 'Reset', danger: true
      }).then(function (yes) {
        if (!yes) return;
        QC.net.resetPassword(u.id).then(function (r) {
          var out = el('input.input', { readonly: true, value: r.tempPassword });
          out.addEventListener('click', function () { out.select(); });
          QC.sheet({
            title: 'Temporary password for ' + u.name,
            sub: 'They can sign in with this right away, then change it from their own account menu.',
            content: el('div.field', [out]),
            actions: [el('button.btn.primary', { type: 'button', text: 'Done', onclick: QC.closeSheet })]
          });
          setTimeout(function () { out.select(); }, 40);
        }).catch(function (e) { QC.toast(e.message); });
      });
    }
  };

  /* RULES */

  QC.screens.rules = function () {
    var s = QC.state;
    var text = s.rules || '';

    if (!QC.isAdmin()) {
      return el('div.stack', [
        el('div.page-head', [el('h1', { text: 'Rules' })]),
        text.trim()
          ? el('div.card', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.6', fontSize: '16px' } }, text)
          : el('div.empty', { style: { marginTop: '20px' } }, [
              el('div.big', { text: 'No rules yet' }),
              el('p', { style: { marginTop: '8px' } },
                (s.adminId ? QC.name(s.adminId) : 'The admin') + ' hasn’t written any.')
            ])
      ]);
    }

    var saveState = el('span.save-state.dim.small', { text: '' });
    var area = el('textarea.textarea', {
      rows: '16', placeholder: 'House rules, scoring notes, whatever the team should know…'
    });
    area.value = text;
    var saveSoon = debounce(function () {
      saveState.textContent = 'Saving…';
      QC.net.setRules(area.value)
        .then(function () { saveState.textContent = 'Saved'; })
        .catch(function (e) { saveState.textContent = 'Not saved: ' + e.message; });
    }, 600);
    area.addEventListener('input', saveSoon);

    return el('div.stack', [
      el('div.page-head', [
        el('h1', { text: 'Rules' }),
        el('p.sub', { text: 'Only you, as admin, can edit this. Everyone can read it.' })
      ]),
      area,
      el('div.row', { style: { marginTop: '10px' } }, [saveState])
    ]);
  };

  /* QUIZ EDITOR */

  QC.screens.build = function () {
    var s = QC.state, u = s.upcoming;
    if (!u) { location.hash = '#/'; return el('div'); }

    /* Home, rather than a locked door. Nothing in the app links here unless
       you are the quiz maker, so the only ways to arrive are an address bar
       left over from the account you just switched away from, or somebody
       else's link - and neither deserves a padlock and a dead end. The toast
       says why, so it is not a silent bounce. */
    if (!QC.isMaster()) {
      QC.toast(QC.name(u.quizMasterId) + ' is writing this week’s quiz');
      location.hash = '#/';
      return el('div');
    }

    if (!(u.topic || '').trim()) {
      return el('div.empty', { style: { marginTop: '40px' } }, [
        el('div.big', { text: 'No topic yet' }),
        el('p', { style: { marginTop: '8px' } },
          QC.name(u.topicPickerId) + ' picks the topic. If they have already sent it to you, put it in here.'),
        el('div.row', { style: { justifyContent: 'center', marginTop: '22px' } }, [
          el('button.btn.primary', { type: 'button', text: 'Set the topic', onclick: function () {
            QC.ask({
              title: 'What is the quiz about?',
              sub: 'Whatever ' + QC.name(u.topicPickerId) + ' chose.',
              placeholder: 'e.g. British seaside towns', ok: 'Set topic'
            }).then(function (v) {
              if (v) QC.net.setTopic(v).catch(function (e) { QC.toast(e.message); });
            });
          } }),
          el('a.btn.ghost', { href: '#/', 'data-nav': '', text: 'Back' })
        ])
      ]);
    }

    // Work on a local copy so a push from the server cannot yank the field
    // out from under whoever is typing.
    var quiz = QC.screens._draft;
    if (!quiz || QC.screens._draftFor !== u.id) {
      quiz = QC.screens._draft = u.quiz
        ? JSON.parse(JSON.stringify(u.quiz))
        : QC.blankQuiz(u.topic);
      QC.screens._draftFor = u.id;
    }

    var open = QC.screens._openQ === undefined ? 0 : QC.screens._openQ;
    // Files dropped on a closed question, waiting for it to be opened.
    var pendingDrop = null;
    var headEl = el('div.page-head'), listEl = el('div.q-editor');
    var saveState = el('span.save-state.dim.small', { text: '' });

    var saveSoon = debounce(function () {
      saveState.textContent = 'Saving…';
      QC.net.saveQuiz(quiz)
        .then(function () { saveState.textContent = 'Saved'; })
        .catch(function (e) { saveState.textContent = 'Not saved: ' + e.message; });
    }, 600);

    function refreshHead() {
      var p = QC.quizProgress(quiz);
      QC.clear(headEl);
      QC.append(headEl, [
        el('div.row', [
          el('div', [
            el('div.kicker', { text: 'Quiz maker · ' + QC.fmtDate(u.date, { day: 'numeric', month: 'short' }) }),
            el('h1', { style: { fontSize: '38px', marginTop: '6px' }, text: quiz.topic || u.topic })
          ]),
          el('div.spacer'),
          el('span.pill' + (p.ready ? '.done' : '.wait'), { text: p.done + ' of ' + p.total + ' ready' })
        ]),
        el('p.sub', { style: { fontSize: '17px' },
          text: quiz.questions.length + ' question' + (quiz.questions.length === 1 ? '' : 's')
            + ', each with two to six options, plus a tiebreaker whose answer is a number.' }),
        el('div.row', { style: { marginTop: '14px' } }, [
          !p.ready ? el('button.btn.sm', { type: 'button', text: 'Jump to the next gap', onclick: function () {
            for (var i = 0; i < quiz.questions.length; i++) {
              if (!QC.questionReady(quiz.questions[i])) return setOpen(i);
            }
            setOpen(quiz.questions.length);
          } }) : el('span.pill.done', { text: '✓ Ready to play. Start it from the home screen' }),
          el('div.spacer'),
          saveState
        ])
      ]);
    }

    // Only used on a phone, where there is no room to keep the panel open.
    function toggleAssist() {
      document.body.classList.toggle('assist-open');
    }

    /* Always-there panel down the right-hand side, not something you open:
       writing the quiz is a sit-at-a-monitor job and Quizzy is part of that
       screen. Drag its left edge to resize. It can hand back a whole quiz as
       JSON, which the quiz master inserts with one click rather than copying
       it in by hand. Chat history lives for the session only. */
    function assistDock() {
      var history = QC.screens._assistHistory || (QC.screens._assistHistory = []);
      var body = el('div.assist-body');
      var input = el('textarea.assist-input', {
        rows: '1', placeholder: 'Ask Quizzy to write a question, or the whole quiz'
      });
      var sendBtn = el('button.assist-send', {
        type: 'submit', 'aria-label': 'Send', disabled: true, html: QC.arrowUp
      });
      var err = el('p.assist-err', { hidden: true });

      // Worth a click rather than a wall of instructions: the first one is
      // the whole point of the panel.
      var EXAMPLES = [
        'Write the whole quiz about guessing animal sounds, keep it funny',
        'Give me one hard question about the 1980s',
        'Ten questions on world capitals, mixed difficulty'
      ];

      function welcome() {
        return el('div.assist-welcome', [
          el('p', { text: 'Get help from Quizzy, your humble servant. Ask for a single question, a few ideas, or the whole quiz in one go.' }),
          el('div.assist-try', { text: 'Try' }),
          el('div.assist-examples', EXAMPLES.map(function (ex) {
            return el('button.assist-example', { type: 'button', text: ex,
              onclick: function () { send(ex); } });
          }))
        ]);
      }

      /* No rule under the title. The page header already draws a line right
         above this panel, and a second one a little lower down never lines up
         with it - which reads as a mistake rather than as structure. */

      /* Whether a request is in flight. Drives the waiting indicator, which
         matters more here than in most places: writing ten questions takes the
         model the better part of a minute, and with nothing on screen a quiet
         panel is indistinguishable from a broken one. */
      var pending = false;

      function thinking() {
        return el('div.assist-msg.assistant.assist-pending', { role: 'status', 'aria-label': 'Quizzy is writing' }, [
          el('div.assist-role', { text: 'Quizzy' }),
          el('div.assist-dots', [el('i'), el('i'), el('i')])
        ]);
      }

      function renderBody() {
        QC.clear(body);
        if (!history.length && !pending) QC.append(body, welcome());
        history.forEach(function (m) {
          var msg = el('div.assist-msg.' + m.role, [
            el('div.assist-role', { text: m.role === 'user' ? 'You' : 'Quizzy' }),
            el('div.assist-text', { text: m.text })
          ]);
          if (m.quiz) {
            QC.append(msg, el('div.assist-card', [
              el('div.assist-card-title', { text: m.quiz.questions.length + ' question'
                + (m.quiz.questions.length === 1 ? '' : 's') + ' and a tiebreaker' }),
              el('div.assist-card-sub', { text: m.inserted
                ? 'These are the questions in the editor now.'
                : 'Drops straight into the editor beside you.' }),
              /* Ticked once it has actually gone in - and only then, since the
                 replace warning gives you a chance to back out. Inserting
                 replaces the whole quiz, so at most one of these can be true
                 at a time and the others give their ticks up. */
              el('button.btn.sm' + (m.inserted ? '.ghost.is-done' : '.primary'), {
                type: 'button', style: { marginTop: '12px' },
                disabled: m.inserted || null,
                html: m.inserted ? QC.tick + ' <span>Inserted</span>' : null,
                text: m.inserted ? null : 'Insert into quiz',
                onclick: function () {
                  insertGenerated(m.quiz, function () {
                    history.forEach(function (o) { o.inserted = false; });
                    m.inserted = true;
                    renderBody();
                  });
                }
              })
            ]));
          }
          QC.append(body, msg);
        });
        if (pending) QC.append(body, thinking());
        body.scrollTop = body.scrollHeight;
      }

      function send(preset) {
        var text = (preset || input.value).trim();
        if (!text || sendBtn.disabled && !preset) return;
        err.hidden = true;
        history.push({ role: 'user', text: text });
        input.value = '';
        resize();
        sendBtn.disabled = true;
        pending = true;
        renderBody();
        QC.net.assist(history, quiz.topic || u.topic).then(function (r) {
          history.push({ role: 'assistant', text: r.reply, quiz: r.quiz });
        }).catch(function (e) {
          err.textContent = e.message;
          err.hidden = false;
        }).then(function () {
          pending = false;
          renderBody();
          sendBtn.disabled = !input.value.trim();
        });
      }

      // Grows with what is typed, up to the cap the stylesheet sets.
      function resize() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 140) + 'px';
      }
      input.addEventListener('input', function () {
        resize();
        sendBtn.disabled = !input.value.trim();
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      });

      var form = el('form.assist-field');
      form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
      QC.append(form, [input, sendBtn]);

      renderBody();

      return el('aside.assist-dock', [
        resizeGrip(),
        el('div.assist-head', [
          el('span.assist-mark', { html: QC.sparkle }),
          el('h3', { text: 'Quizzy' }),
          el('div.spacer'),
          el('button.btn-icon.assist-close', { type: 'button', 'aria-label': 'Hide Quizzy', text: '✕',
            onclick: toggleAssist })
        ]),
        body,
        el('div.assist-foot', [form, err])
      ]);
    }

    /* THE PREVIEW: the open question, drawn as the room will see it.

       The same function the projector calls, not a lookalike - a lookalike
       drifts from the real thing the first time either is touched. It is drawn
       at the size of this very screen and then scaled down to fit the panel,
       which is what makes it honest: everything on a slide is sized in vh and
       vw, so a miniature built any other way would put the picture and the
       text in proportions nobody will ever see.

       The two settings that only make sense against a picture of the result -
       how big the picture is, how the answers are arranged - live here beside
       it rather than buried down the card, and move it as they are dragged. */
    var previewBody = null, previewSettings = null;

    function drawPreview() {
      if (!previewBody) return;
      var q = quiz.questions[open];
      QC.clear(previewBody);
      QC.clear(previewSettings);

      if (!q) {
        QC.append(previewBody, el('p.dim.small.center', { style: { padding: '30px 16px' },
          text: open === quiz.questions.length ? 'The tiebreaker has no slide to preview.'
                                               : 'Open a question to see it here.' }));
        return;
      }

      /* Both slides, one above the other. Every question makes two - the one
         with the answers hidden and the one with the right one lit - and a
         tab between them meant only ever seeing half of what was being
         changed. Stacked, one glance covers both. */
      /* The picture's size sits between the two previews rather than down with
         the rest: below the question it belongs to, above the answer slide it
         is not about. A slider in a block at the bottom of the panel could
         have meant either of them. */
      QC.append(previewBody, [
        shotOf(q, false, 'Question'),
        q.media ? sizeControl(q) : null,
        shotOf(q, true, 'Answer')
      ]);
      /* Sized now rather than next frame. They are in the panel at this point,
         so the width is known - and waiting left a window where the CSS
         fallback scale showed instead, which is a slide drawn far too big. */
      [].forEach.call(previewBody.querySelectorAll('.preview-shot'), scalePreview);
      fitPreview();

      var hasOptionPics = (q.optionMedia || []).some(function (m) { return m && m.kind === 'image'; });
      QC.append(previewSettings, [
        hasOptionPics ? optPicControl(q) : null,
        arrangeControl(q)
      ]);
    }

    /* One slide, captioned, scaled into the panel. */
    function shotOf(q, reveal, caption) {
      var slide = QC.live.previewSlide(q, open, quiz.questions.length, reveal);
      /* Frame inside a stage, the same nesting the projector uses. The frame
         sits inset from the screen edge by a margin of its own, so scaling the
         frame alone put that margin outside the miniature - the slide started
         24px in and hung the same off the other side. The stage is exactly one
         screen wide, margins included, so nothing can escape it. */
      var shot = el('div.preview-shot', [
        el('div.preview-stage', [el('div.slide-frame', slide)])
      ]);
      var wrap = el('div.pv-one', [el('div.pv-cap', { text: caption }), shot]);
      /* A picture arriving late makes the slide taller after it was measured,
         and the first fit runs before it has loaded - so measure again when it
         does. The projector has the same listener; this one is the preview's,
         because that one only fires while presenting. */
      [].forEach.call(slide.querySelectorAll('img, video'), function (m) {
        /* A cached picture is already complete and will never fire `load`, so
           asking for the event alone leaves the commonest case unmeasured. */
        if (m.complete || m.readyState >= 1) { fitPreview(); return; }
        m.addEventListener('load', fitPreview);
        m.addEventListener('loadedmetadata', fitPreview);
      });
      return wrap;
    }

    /* Shrink the slide until all of it is inside its frame - the same sum the
       projector does, run on the miniature. Next frame, so it measures a slide
       that has actually been laid out. */
    function fitPreview() {
      requestAnimationFrame(function () {
        if (!previewBody) return;
        [].forEach.call(previewBody.querySelectorAll('.preview-shot .slide'), QC.live.fitInto);
      });
    }

    /* The slide is laid out at the full size of this window and then shrunk.
       transform, not a smaller layout: scaling is the only way the proportions
       survive, and it costs nothing because nothing reflows. */
    function scalePreview(shot) {
      /* The shot's own width, not its parent's. clientWidth includes padding,
         so measuring the panel handed back its 16px either side as if they
         were room to draw in - the slide came out a shade too big and hung off
         the right-hand edge, which is what the clipping was. */
      var w = shot.clientWidth;
      /* On the very first draw the panel is not laid out yet and this is 0.
         Guessing a width leaves the miniature the wrong size until something
         else happens to redraw it, so wait a frame and measure properly. */
      if (!w) { requestAnimationFrame(function () { scalePreview(shot); }); return; }
      var k = w / Math.max(320, window.innerWidth);
      shot.style.setProperty('--shot-scale', k.toFixed(4));
      shot.style.height = Math.round(window.innerHeight * k) + 'px';
    }

    function sizeControl(q) {
      var read = el('span.size-read', { text: QC.picSize(q.mediaSize) + '%' });
      var slider = el('input.size-range', {
        type: 'range', min: String(QC.PIC_MIN), max: String(QC.PIC_MAX), step: '1',
        value: String(QC.picSize(q.mediaSize)), 'aria-label': 'Picture size on the big screen'
      });
      slider.addEventListener('input', function () {
        q.mediaSize = Number(slider.value);
        read.textContent = slider.value + '%';
        // Move the picture in the preview without rebuilding the whole slide -
        // dragging a slider that redraws on every pixel is a slideshow.
        [].forEach.call(previewBody.querySelectorAll('.s-media'), function (box) {
          box.style.setProperty('--pic', q.mediaSize + 'vh');
        });
        fitPreview();          // a taller picture may push the answers out
        saveSoon();
        drawPreviewSoon();     // and settle it properly once the drag pauses
      });
      return el('div.pv-field', [
        el('label', { text: 'Picture size' }),
        el('div.size-row', [slider, read])
      ]);
    }

    /* Pictures inside the options are their own decision: six of them on one
       slide want to be small enough that the answers still read as answers,
       and a single one wants to be seen. Only offered when there is one. */
    function optPicControl(q) {
      var read = el('span.size-read', { text: QC.optPicSize(q.optionPicSize) + '%' });
      var slider = el('input.size-range', {
        type: 'range', min: String(QC.OPTPIC_MIN), max: String(QC.OPTPIC_MAX), step: '1',
        value: String(QC.optPicSize(q.optionPicSize)), 'aria-label': 'Size of the pictures in the options'
      });
      slider.addEventListener('input', function () {
        q.optionPicSize = Number(slider.value);
        read.textContent = slider.value + '%';
        [].forEach.call(previewBody.querySelectorAll('.s-opts'), function (row) {
          row.style.setProperty('--opt-pic', q.optionPicSize + 'vh');
        });
        fitPreview();
        saveSoon();
        drawPreviewSoon();
      });
      return el('div.pv-field', [
        el('label', { text: 'Pictures in the options' }),
        el('div.size-row', [slider, read])
      ]);
    }

    function arrangeControl(q) {
      var seg = choice(q, 'optionLayout', 'auto', [
        ['auto', 'Auto', 'Chosen from how long the answers are'],
        ['row', 'In a row', 'Side by side, for short answers'],
        ['stacked', 'Stacked', 'One per line, for long answers']
      ], drawPreview);
      return el('div.pv-field', [el('label', { text: 'Answers' }), seg]);
    }

    /* Redrawn once the drag stops, so the fit is measured against a slide that
       has finished moving rather than one mid-gesture. */
    var drawPreviewSoon = debounce(function () { drawPreview(); }, 250);

    function previewDock() {
      previewBody = el('div.pv-body');
      previewSettings = el('div.pv-settings');

      var dock = el('aside.preview-dock', [
        el('div.pv-head', [el('h3', { text: 'Slide settings' })]),
        previewBody,
        previewSettings
      ]);

      drawPreview();
      // The miniature is a fraction of the window, so it has to be remeasured.
      window.addEventListener('resize', function () {
        if (!previewBody) return;
        [].forEach.call(previewBody.querySelectorAll('.preview-shot'), scalePreview);
        fitPreview();
      });
      return dock;
    }

    /* Drag the left edge to set how much of the screen Quizzy gets. Pointer
       events rather than mouse ones, so a pen or a touchscreen works too. */
    function resizeGrip() {
      var grip = el('div.assist-grip', {
        role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the assistant panel', tabindex: '0'
      });

      grip.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        document.body.classList.add('assist-resizing');

        function move(ev) { QC.assistWidth.apply(window.innerWidth - ev.clientX); }
        function stop(ev) {
          // Written down only once the drag ends, not on every mouse move.
          QC.assistWidth.apply(window.innerWidth - ev.clientX, true);
          document.body.classList.remove('assist-resizing');
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', stop);
          grip.removeEventListener('pointercancel', stop);
        }
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', stop);
        grip.addEventListener('pointercancel', stop);
      });

      // Same thing from the keyboard, for anyone not using a mouse.
      grip.addEventListener('keydown', function (e) {
        var step = e.key === 'ArrowLeft' ? 24 : (e.key === 'ArrowRight' ? -24 : 0);
        if (!step) return;
        e.preventDefault();
        QC.assistWidth.apply(QC.assistWidth.read() + step, true);
      });

      return grip;
    }

    /* Swap in a full quiz the assistant proposed. Replaces everything, so
       anyone with real progress gets a chance to back out first. */
    function insertGenerated(parsed, onDone) {
      function apply() {
        quiz.questions = parsed.questions.slice(0, QC.MAX_QUESTIONS).map(function (q) {
          var options = (Array.isArray(q.options) ? q.options : []).slice(0, QC.MAX_OPTIONS)
            .map(function (o) { return String(o == null ? '' : o); });
          while (options.length < QC.MIN_OPTIONS) options.push('');
          var correct = Number.isInteger(q.correct) && q.correct >= 0 && q.correct < options.length ? q.correct : null;
          /* Quizzy cannot attach a file, only describe the one it wants. The
             hints ride along on the empty slots so the quiz master knows what
             to go and find; uploading is still theirs to do. */
          var hints = Array.isArray(q.optionHints) ? q.optionHints : [];
          return { id: QC.uid(), text: String(q.text || ''), options: options, correct: correct,
            optionMedia: options.map(function () { return null; }),
            optionHints: options.map(function (o, i) { return String(hints[i] || ''); }),
            note: String(q.note || ''), media: null, mediaHint: String(q.mediaHint || '') };
        });
        if (parsed.tieBreaker) {
          quiz.tieBreaker = {
            text: String(parsed.tieBreaker.text || ''),
            answer: (parsed.tieBreaker.answer === null || parsed.tieBreaker.answer === undefined || parsed.tieBreaker.answer === '')
              ? null : Number(parsed.tieBreaker.answer),
            unit: String(parsed.tieBreaker.unit || ''),
            note: String(parsed.tieBreaker.note || ''),
            media: (quiz.tieBreaker && quiz.tieBreaker.media) || null
          };
        }
        QC.screens._openQ = -1;
        renderList(); refreshHead(); saveSoon();
        QC.toast('Quiz filled in - read it over before you start');
        if (onDone) onDone();
      }
      if (QC.quizProgress(quiz).done > 0) {
        QC.confirm({
          title: 'Replace the current quiz?',
          sub: 'This overwrites every question and the tiebreaker with the assistant’s version. Anything already written is gone.',
          ok: 'Replace', danger: true
        }).then(function (yes) { if (yes) apply(); });
      } else {
        apply();
      }
    }

    function setOpen(i) {
      QC.screens._openQ = (open === i ? -1 : i);
      open = QC.screens._openQ;
      renderList();
      drawPreview();
      var card = listEl.children[open];
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Opening a question means you're about to type it, so put the
        // cursor straight in the question box instead of making them click again.
        var ta = card.querySelector('textarea');
        if (ta) ta.focus();
      }
    }

    function renderList() {
      QC.clear(listEl);
      // The tiebreaker always has to stay at index quiz.questions.length
      // (setOpen/markDirty index into listEl.children by position), so the
      // add-question button goes after it instead of before.
      quiz.questions.forEach(function (q, i) { listEl.appendChild(qCard(q, i)); });
      listEl.appendChild(tbCard());
      listEl.appendChild(addQuestionButton());
    }

    function addQuestionButton() {
      if (quiz.questions.length >= QC.MAX_QUESTIONS) {
        return el('p.hint', { style: { margin: '2px 0 16px' },
          text: 'That is the most questions you can have (' + QC.MAX_QUESTIONS + ').' });
      }
      return el('button.btn.ghost.block', {
        type: 'button', text: '+  Add another question', style: { margin: '2px 0 16px' },
        onclick: function () {
          quiz.questions.push(QC.blankQuestion());
          setOpen(quiz.questions.length - 1);
          saveSoon(); refreshHead();
        }
      });
    }

    function qCard(q, i) {
      var isOpen = open === i, ready = QC.questionReady(q);
      var card = el('div.q-card' + (ready ? '.filled' : '') + (isOpen ? '.open' : ''));

      card.appendChild(el('button.q-head', {
        type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', onclick: function () { setOpen(i); }
      }, [
        el('span.q-num', { text: ready ? '✓' : String(i + 1) }),
        el('span.q-title' + (q.text.trim() ? '' : '.ph'), { text: q.text.trim() || 'Question ' + (i + 1) }),
        el('span.q-chev', { html: QC.chev })
      ]));

      if (!isOpen) {
        dropOpensCard(card, i);
        return card;
      }

      /* Overrides for the two things the automatic layout sometimes gets
         wrong. Proportions, not positions - whatever is picked still has to
         work on a projector and on somebody's phone. */
      var media = mediaField(q, 'media', false, q.mediaHint);
      card.appendChild(el('div.q-body', [
        el('div.field', [
          el('label', { text: 'Question ' + (i + 1) }),
          el('p.paste-tip', [
            el('b', { text: 'Pictures:' }),
            ' right-click any picture on the web, choose ',
            el('b', { text: 'Copy image' }),
            ', then paste it in here. Pasting a link works on most sites - though '
            + 'a search results page is not a picture, so that one will not.'
          ]),
          composeBox(bindArea(q, 'text', 'What is the question?', 'Question ' + (i + 1)), media)
        ]),
        el('div.field', [
          el('label', { text: 'Options' }),
          /* Said here rather than left to be discovered. Copying the image
             itself is the reliable half and the one nobody thinks of, so it
             goes first; a link is the obvious half and works on most sites. */
          el('p.paste-tip', [
            el('b', { text: 'Pictures:' }),
            ' right-click any picture on the web, choose ',
            el('b', { text: 'Copy image' }),
            ', then paste into an option below. Pasting a link works too.'
          ]),
          (function () {
            var needsCorrect = q.correct === null && q.options.some(function (o) { return o.trim(); });
            return el('span.hint' + (needsCorrect ? '.warn' : ''), { text: needsCorrect
              ? '⚠  No correct answer picked yet - tap a letter.'
              : 'Tap a letter to mark the correct one.' });
          })(),
          el('div.stack', { style: { gap: '10px', marginTop: '4px' } }, q.options.map(function (opt, oi) {
            var key = QC.OPTION_KEYS[oi];
            if (!Array.isArray(q.optionMedia)) q.optionMedia = [];
            while (q.optionMedia.length < q.options.length) q.optionMedia.push(null);
            var optField = bindInput(q.options, oi, 'Option ' + key);
            var optMedia = mediaField(q.optionMedia, oi, true, (q.optionHints || [])[oi]);
            // Same as the question box: a picture or a bare link pasted into
            // an option becomes that option's picture.
            optField.addEventListener('paste', function (e) { optMedia.takePaste(e); });
            return el('div.opt-row', [
              el('button.opt-key' + (q.correct === oi ? '.on' : ''), {
                type: 'button', text: key,
                'aria-label': 'Mark option ' + key + ' as correct',
                onclick: function () { q.correct = oi; renderList(); saveSoon(); refreshHead(); }
              }),
              optField,
              optMedia,
              q.options.length > QC.MIN_OPTIONS ? el('button.opt-drop', {
                type: 'button', text: '×', 'aria-label': 'Remove option ' + key,
                onclick: function () {
                  QC.removeOption(q, oi);
                  renderList(); saveSoon(); refreshHead();
                }
              }) : null
            ]);
          })),
          q.options.length < QC.MAX_OPTIONS ? el('button.btn.ghost.sm', {
            type: 'button', text: '+  Add another option',
            style: { marginTop: '12px', alignSelf: 'flex-start' },
            onclick: function () {
              QC.addOption(q);
              renderList(); saveSoon();
              // Put the cursor straight in the box that just appeared.
              var boxes = listEl.children[open].querySelectorAll('.opt-row .input');
              if (boxes.length) boxes[boxes.length - 1].focus();
            }
          }) : el('span.hint', { style: { marginTop: '10px' },
            text: 'Six is the most you can have.' })
        ]),
        /* Only worth showing once there is a picture to size. */
        el('div.field', [
          el('label', { text: 'Extra note  (optional)' }),
          el('span.hint', { text: 'Shown with the answer: a bit of trivia or an explanation.' }),
          bindInput(q, 'note', '')
        ]),
        quiz.questions.length > QC.MIN_QUESTIONS ? el('div.row', { style: { justifyContent: 'flex-end' } }, [
          el('button.btn.danger.sm', {
            type: 'button', text: 'Delete this question', onclick: function () { deleteQuestion(i); }
          })
        ]) : null
      ]));
      dropOnCard(card, media);
      return card;
    }

    /* Removing a question shifts everything after it up one slot, including
       the tiebreaker's card position (it always sits at quiz.questions.length),
       so "open" has to move with whatever it was pointing at. */
    function deleteQuestion(i) {
      QC.confirm({
        title: 'Delete question ' + (i + 1) + '?',
        sub: 'Its text, options and any attached media are gone for good.',
        ok: 'Delete', danger: true
      }).then(function (yes) {
        if (!yes) return;
        quiz.questions.splice(i, 1);
        if (open === i) open = QC.screens._openQ = -1;
        else if (open > i) open = QC.screens._openQ = open - 1;
        renderList(); saveSoon(); refreshHead();
      });
    }

    /* Picture, sound or video, part of the question's own box. Files are
       dropped straight onto the question; the strip is there to click. */
    function mediaField(target, key, compact, hint) {
      key = key == null ? 'media' : key;
      hint = String(hint || '').trim();
      var wrap = el('div.compose-media');
      var busy = false, busyName = '', progress = 0, fill = null, fromWeb = false;

      // Called by the question box and the card, so a drop lands here.
      wrap.dropFiles = takeFiles;
      wrap.takePaste = takePaste;

      /* A paste on the question or an option comes here first.

         Two things arrive on a clipboard and both are worth having. Copying an
         image in a browser puts the picture itself there - that is what
         "Copy image" does, and it is the answer for anything sat behind a
         search page, because the file travels rather than the address. Copying
         a link puts text there, and if that text is nothing but a web address
         it is almost certainly meant as the picture.

         Anything else - a word, a sentence, an address in the middle of a
         sentence - is left alone and pastes as text. Returns true only when it
         has taken over. */
      function takePaste(e) {
        if (busy || target[key]) return false;
        var dt = e.clipboardData;
        if (!dt) return false;

        var files = Array.prototype.slice.call(dt.files || []);
        if (files.length) { e.preventDefault(); takeFiles(files); return true; }

        var text = String(dt.getData('text/plain') || '').trim();
        if (!/^https?:\/\/\S+$/i.test(text)) return false;
        e.preventDefault();
        fromUrl(text);
        return true;
      }

      /* Fetched by the server, not the browser: the picture has to end up in
         this team's media store either way, and going via the browser would
         mean asking every site on the internet to allow us by CORS. */
      function fromUrl(url) {
        busy = true; fromWeb = true; busyName = shortUrl(url); progress = 0;
        draw();
        QC.net.mediaFromUrl(url).then(function (media) {
          busy = false;
          target[key] = media;
          draw(); saveSoon(); refreshHead();
          QC.toast(QC.mediaLabel(media) + ' added');
        }).catch(function (err) {
          busy = false;
          draw();
          QC.toast(err.message);
        });
      }

      function draw() {
        QC.clear(wrap);
        QC.append(wrap, [(target[key] && !busy) ? preview() : dropZone()]);
      }

      /** Take the first usable file of a drop or a file-picker selection. */
      function takeFiles(files) {
        if (busy) return;
        var list = files ? Array.prototype.slice.call(files) : [];
        if (!list.length) return;

        var file = null, why = null;
        for (var i = 0; i < list.length && !file; i++) {
          var problem = QC.mediaProblem(list[i]);
          if (problem) { if (!why) why = problem; }
          else file = list[i];
        }
        if (!file) { QC.toast(why); return; }
        if (list.length > 1) QC.toast('One file per question, so I kept ' + (file.name || 'the first'));
        upload(file);
      }

      function upload(file) {
        busy = true; fromWeb = false; busyName = file.name || 'that file'; progress = 0;
        draw();
        QC.net.uploadMedia(file, function (f) {
          progress = f;
          if (fill) fill.style.width = Math.round(f * 100) + '%';
        }).then(function (media) {
          busy = false; fill = null;
          target[key] = media;
          draw(); saveSoon(); refreshHead();
          QC.toast(QC.mediaLabel(media) + ' added');
        }).catch(function (e) {
          busy = false; fill = null;
          draw();
          QC.toast(e.message);
        });
      }

      function dropZone() {
        if (busy) {
          fill = el('i', { style: { width: Math.round(progress * 100) + '%' } });
          return el('div.attach.busy', [
            // No progress to report on a fetch - the server is doing it.
            el('span.attach-t', { text: (fromWeb ? 'Fetching ' : 'Uploading ') + busyName + '…' }),
            el('div.media-bar' + (fromWeb ? '.waiting' : ''), [fill])
          ]);
        }

        var input = el('input', {
          type: 'file', accept: QC.MEDIA_ACCEPT, style: { display: 'none' }
        });
        input.addEventListener('change', function () {
          takeFiles(input.files);
          input.value = '';                 // so the same file can be picked twice
        });
        // The input sits inside the strip, so the click we fire on it must not
        // bubble back to the strip and open the picker all over again.
        input.addEventListener('click', function (e) { e.stopPropagation(); });

        var pick = function () { input.click(); };
        // Six full drop strips would bury the option they belong to, so on an
        // option it is just the paperclip.
        if (compact) {
          return el('button.opt-clip', {
            type: 'button',
            'aria-label': hint ? 'Add media to this option: ' + hint : 'Add a picture or sound to this option',
            title: hint ? 'Quizzy suggests: ' + hint : 'Add a picture or sound', onclick: pick
          }, [el('span', { text: '📎', 'aria-hidden': 'true' }), input]);
        }
        return el('div.attach', {
          role: 'button', tabindex: '0',
          'aria-label': 'Add a picture, sound or video. Drop a file on the question or press to choose one.',
          onclick: pick,
          onkeydown: function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
          }
        }, [
          el('span.attach-icon', { text: '📎', 'aria-hidden': 'true' }),
          el('span.attach-t', { text: hint
            ? 'Quizzy suggests: ' + hint + ' - drop it here or click to choose'
            : 'Drop a picture, sound or video here, click to choose one, or paste a link' }),
          input
        ]);
      }

      function preview() {
        var m = target[key];
        var url = QC.mediaUrl(m);
        var node;
        if (compact) {
          return el('div.opt-media', [
            m.kind === 'image'
              ? el('img', { src: url, alt: m.name || 'Picture' })
              : el('span.opt-media-kind', { text: m.kind === 'audio' ? '🔊' : '📺' }),
            el('button.opt-media-x', {
              type: 'button', text: '×', 'aria-label': 'Remove this option’s media',
              onclick: function () { target[key] = null; draw(); saveSoon(); refreshHead(); }
            })
          ]);
        }
        if (m.kind === 'image') node = el('img.media-thumb', { src: url, alt: m.name || 'Picture' });
        else if (m.kind === 'audio') node = el('audio.media-player', { src: url, controls: true, preload: 'metadata' });
        else node = el('video.media-player', { src: url, controls: true, preload: 'metadata' });

        return el('div.media-box', [
          node,
          el('div.media-meta', [
            el('span.pill', { text: QC.mediaLabel(m) }),
            m.name ? el('span.dim.small', { text: m.name }) : null,
            el('div.spacer'),
            el('button.btn.quiet.sm', { type: 'button', text: 'Remove', onclick: function () {
              target[key] = null;
              draw(); saveSoon(); refreshHead();
            } })
          ])
        ]);
      }

      draw();
      // A file dropped on this question while it was closed is waiting for us.
      // It was aimed at the question, so an option must not intercept it.
      if (pendingDrop && !compact) {
        var waiting = pendingDrop;
        pendingDrop = null;
        takeFiles(waiting);
      }
      return wrap;
    }

    /* The question box: the words and whatever is attached to them, in one
       frame, so a file can be dropped straight onto what you are typing. */
    function composeBox(textarea, mediaEl) {
      var box = el('div.q-compose', [textarea, mediaEl]);
      dragTarget(box, function (files) { mediaEl.dropFiles(files); });
      // A picture or a bare link pasted into the question becomes the media.
      textarea.addEventListener('paste', function (e) { mediaEl.takePaste(e); });
      return box;
    }

    /* Enough of an address to recognise while it is being fetched. */
    function shortUrl(url) {
      try {
        var u = new URL(url);
        var last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
        return last && last.length < 40 ? last : u.hostname.replace(/^www\./, '');
      } catch (e) { return 'that link'; }
    }

    /* Dropping a file anywhere else on an open question works too, so nobody
       has to aim. Text dragged between fields is left alone. */
    function dropOnCard(card, mediaEl) {
      dragTarget(card, function (files) { mediaEl.dropFiles(files); });
    }

    /* On a closed question, a drop opens it first and the media field picks the
       file up as it is built. */
    function dropOpensCard(card, i) {
      dragTarget(card, function (files) {
        pendingDrop = files;
        setOpen(i);
      });
    }

    function dragTarget(node, onFiles) {
      var depth = 0, cool = null;

      /* Crossing between children can briefly look like leaving, so switching
         the highlight off waits a moment in case it comes straight back. */
      function lit(on) {
        clearTimeout(cool); cool = null;
        if (on) node.classList.add('dropping');
        else cool = setTimeout(function () { node.classList.remove('dropping'); }, 90);
      }

      node.addEventListener('dragenter', function (e) {
        if (!QC.dragHasFiles(e)) return;
        e.preventDefault(); depth++; lit(true);
      });
      node.addEventListener('dragover', function (e) {
        if (!QC.dragHasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      // Fires for every child the pointer crosses, hence the counter.
      node.addEventListener('dragleave', function () {
        if (--depth <= 0) { depth = 0; lit(false); }
      });
      node.addEventListener('drop', function (e) {
        if (!QC.dragHasFiles(e)) return;
        e.preventDefault(); depth = 0; lit(false);
        // The question box sits inside the card, and both are listening. Each
        // clears its own highlight, but only the innermost one takes the file.
        if (e.fqDropTaken) return;
        e.fqDropTaken = true;
        var files = (e.dataTransfer && e.dataTransfer.files) || [];
        if (files.length) onFiles(files);
      });
    }

    function tbCard() {
      var i = quiz.questions.length, isOpen = open === i, tb = quiz.tieBreaker;
      var ready = QC.tieBreakerReady(tb);
      var card = el('div.q-card.tb' + (ready ? '.filled' : '') + (isOpen ? '.open' : ''));

      card.appendChild(el('button.q-head', {
        type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', onclick: function () { setOpen(i); }
      }, [
        el('span.q-num', { text: ready ? '✓' : '☆' }),
        el('span.q-title' + (tb.text.trim() ? '' : '.ph'), { text: tb.text.trim() || 'Tiebreaker: the answer is a number' }),
        el('span.q-chev', { html: QC.chev })
      ]));

      if (!isOpen) {
        dropOpensCard(card, i);
        return card;
      }

      /* Text, not number: on a phone whose decimal key is a comma, a
         type="number" field reports an empty value for "328,1" - so the answer
         silently went null on every keystroke and the quiz would not go ready,
         with nothing on screen to say why. See QC.readNumber. */
      var num = el('input.input', {
        type: 'text', inputmode: 'decimal', autocomplete: 'off',
        placeholder: 'e.g. 563',
        value: tb.answer === null || tb.answer === undefined ? '' : tb.answer
      });
      num.addEventListener('input', function () {
        var n = QC.readNumber(num.value);
        // Mid-typing rubbish ("-", "3.") is left alone rather than wiping the
        // answer; the readiness check already refuses to start without one.
        if (n === null) tb.answer = null;
        else if (!Number.isNaN(n)) tb.answer = n;
        markDirty(); saveSoon();
      });

      var media = mediaField(tb);
      card.appendChild(el('div.q-body', [
        el('div.field', [
          el('label', { text: 'Tiebreaker question' }),
          el('span.hint', { text: 'Everyone types a number. Closest wins if two people finish level.' }),
          composeBox(
            bindArea(tb, 'text', 'e.g. How many steps to the top of Blackpool Tower?',
              'Tiebreaker: the answer is a number'),
            media)
        ]),
        el('div.grid-2', [
          el('div.field', [el('label', { text: 'The number' }), num]),
          el('div.field', [el('label', { text: 'Unit  (optional)' }), bindInput(tb, 'unit', 'e.g. steps, metres')])
        ]),
        el('div.field', [el('label', { text: 'Extra note  (optional)' }), bindInput(tb, 'note', '')])
      ]));
      dropOnCard(card, media);
      return card;
    }

    /* A little segmented control bound to one field. Lives out here rather
       than inside the question card because the preview panel uses it too. */
    function choice(obj, key, fallback, choices, after) {
      return el('div.seg', choices.map(function (c) {
        var on = (obj[key] || fallback) === c[0];
        return el('button', { type: 'button', text: c[1], class: on ? 'on' : '',
          title: c[2] || '',
          onclick: function (e) {
            obj[key] = c[0];
            e.target.parentNode.querySelectorAll('button').forEach(function (b) { b.classList.remove('on'); });
            e.target.classList.add('on');
            saveSoon();
            if (after) after();
          } });
      }));
    }

    /* Typing moves the preview too, but a beat behind: rebuilding a slide on
       every keystroke is a slideshow, not a preview. */
    var previewSoon = debounce(function () { drawPreview(); }, 350);

    function bindInput(obj, key, ph) {
      var input = el('input.input', { value: obj[key] || '', placeholder: ph || '' });
      input.addEventListener('input', function () {
        obj[key] = input.value; markDirty(); saveSoon(); previewSoon();
      });
      return input;
    }

    function bindArea(obj, key, ph, fallback) {
      var t = el('textarea.textarea', { placeholder: ph || '', rows: '2' });
      t.value = obj[key] || '';
      t.addEventListener('input', function () {
        obj[key] = t.value; markDirty(); saveSoon(); previewSoon();
        if (key !== 'text') return;
        var head = t.closest('.q-card').querySelector('.q-title');
        if (!head) return;
        head.textContent = t.value.trim() || fallback;
        head.classList.toggle('ph', !t.value.trim());
      });
      return t;
    }

    var dirtyTimer = null;
    function markDirty() {
      clearTimeout(dirtyTimer);
      dirtyTimer = setTimeout(function () {
        var card = listEl.children[open];
        if (!card) return;
        var isTb = open === quiz.questions.length;
        var ready = isTb ? QC.tieBreakerReady(quiz.tieBreaker) : QC.questionReady(quiz.questions[open]);
        card.classList.toggle('filled', ready);
        var num = card.querySelector('.q-num');
        if (num) num.textContent = ready ? '✓' : (isTb ? '☆' : String(open + 1));
        refreshHead();
      }, 200);
    }

    refreshHead();
    renderList();

    // Only this screen reserves room down the right-hand side for Quizzy.
    QC.assistWidth.apply();
    document.body.classList.add('assist-docked');

    return el('div.stack', [
      el('a.btn.quiet.sm', { href: '#/', 'data-nav': '', text: '‹  Back', style: { alignSelf: 'flex-start' } }),
      headEl, listEl,
      previewDock(),
      el('p.dim.small.center', { style: { marginTop: '26px' },
        text: 'Saves as you type. Nobody else can see the answers until you start the quiz.' }),
      assistDock(),
      // Phone-sized screens have no room to keep the panel open, so there it
      // slides over the editor from this button instead.
      el('button.assist-fab', { type: 'button', 'aria-label': 'Ask Quizzy', html: QC.sparkle,
        onclick: toggleAssist })
    ]);
  };

  function debounce(fn, ms) {
    var t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  /* HISTORY */

  QC.screens.history = function () {
    var s = QC.state;
    if (!s.history.length) {
      return el('div', [
        el('div.page-head', [el('h1', { text: 'History' })]),
        el('div.empty', [
          el('div.big', { text: 'No quizzes played yet' }),
          el('div', { text: 'Results appear here after your first Friday.' })
        ])
      ]);
    }

    var board = QC.leaderboard();

    return el('div.stack', { style: { gap: '38px' } }, [
      el('div.page-head', { style: { marginBottom: 0 } }, [
        el('h1', { text: 'History' }),
        el('p.sub', { text: s.history.length + ' quiz' + (s.history.length === 1 ? '' : 'zes') + ' played' })
      ]),
      el('div', [
        el('div.kicker', { style: { marginBottom: '14px' }, text: 'All time · by average score' }),
        el('div.board', board.map(function (r, i) {
          var played = r.avg !== null;
          return el('div.board-row' + (i === 0 && played ? '.p1' : ''), [
            QC.placeFace(r.name, i, '', played),
            el('div', [
              el('div.nm', { text: r.name }),
              el('div.rl.dim.small', { text: played
                ? r.played + ' played · best ' + r.best + ' · ' + r.wins + ' win' + (r.wins === 1 ? '' : 's') + ' · ' + r.hosted + ' hosted'
                : 'Has only set quizzes so far · ' + r.hosted + ' hosted' })
            ]),
            el('div.sc', { text: played ? r.avg.toFixed(1) : '-' })
          ]);
        }))
      ]),
      el('div', [
        el('div.kicker', { style: { marginBottom: '14px' }, text: 'Every quiz' }),
        el('div.stack', { style: { gap: '14px' } }, s.history.slice().reverse().map(sessionCard))
      ])
    ]);

    function sessionCard(h) {
      var rank = h.ranking || [];
      var winner = rank[0];
      var open = false;
      var card = el('div.card', { style: { padding: '22px 24px' } });

      function draw() {
        QC.clear(card);
        QC.append(card, [
          el('button', {
            type: 'button',
            style: { width: '100%', background: 'transparent', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' },
            onclick: function () { open = !open; draw(); }
          }, [
            el('div.row', [
              el('div', [
                el('div.kicker', { text: QC.fmtDate(h.date, { day: 'numeric', month: 'long', year: 'numeric' }) }),
                el('h3', { style: { fontSize: '23px', marginTop: '5px' }, text: h.topic || 'Untitled quiz' }),
                el('div.rl.dim.small', { style: { marginTop: '5px' },
                  text: 'Set by ' + QC.name(h.quizMasterId) +
                        (winner ? ' · won by ' + winner.name + ' with ' + winner.score : '') })
              ]),
              el('div.spacer'),
              el('span.q-chev', { html: QC.chev, style: { transform: open ? 'rotate(90deg)' : '' } })
            ])
          ]),
          open ? detail(h, rank) : null
        ]);
      }
      draw();
      return card;
    }

    function detail(h, rank) {
      var qCount = h.questionCount || QC.QUESTION_COUNT;
      return el('div', [
        el('div.board', { style: { marginTop: '20px' } }, rank.map(function (r, i) {
          return el('div.board-row' + (i === 0 ? '.p1' : (i === rank.length - 1 ? '.last' : '')), [
            QC.placeFace(r.name, i),
            el('div', [
              el('div.nm', { text: r.name }),
              r.tieGuess !== null && r.tieGuess !== undefined
                ? el('div.rl.dim.small', { text: 'Tiebreaker guess: ' + r.tieGuess }) : null
            ]),
            el('div.row', { style: { gap: '12px' } }, [
              i === rank.length - 1 && rank.length > 1 ? el('span.tag', { text: 'WOODEN SPOON' }) : null,
              el('div.sc', { text: r.score + '/' + qCount })
            ])
          ]);
        })),
        el('button.btn.ghost.sm', { type: 'button', text: 'Show the questions and answers',
          style: { marginTop: '18px' }, onclick: function (e) {
            // Fetched on demand rather than shipped with every push.
            e.target.disabled = true;
            QC.net.pastQuiz(h.id)
              .then(function (r) { e.target.disabled = false; showQuiz(h, r.quiz); })
              .catch(function (err) { e.target.disabled = false; QC.toast(err.message); });
          } })
      ]);
    }

    function showQuiz(h, q) {
      QC.sheet({
        title: h.topic,
        sub: QC.fmtDate(h.date, { day: 'numeric', month: 'long', year: 'numeric' }),
        content: el('div.stack', { style: { gap: '18px' } },
          q.questions.map(function (qq, i) {
            return el('div', [
              el('div.small.dim', { text: 'Question ' + (i + 1) }),
              el('div', { style: { fontWeight: '550', marginTop: '3px' }, text: qq.text }),
              el('div', { style: { color: 'var(--good)', fontWeight: '550', marginTop: '4px' },
                text: qq.options[qq.correct] })
            ]);
          }).concat([
            el('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '16px' } }, [
              el('div.small.dim', { text: 'Tiebreaker' }),
              el('div', { style: { fontWeight: '550', marginTop: '3px' }, text: q.tieBreaker.text }),
              el('div', { style: { color: 'var(--good)', fontWeight: '550', marginTop: '4px' },
                text: q.tieBreaker.answer + (q.tieBreaker.unit ? ' ' + q.tieBreaker.unit : '') })
            ])
          ])),
        actions: [el('button.btn.primary', { type: 'button', text: 'Close', onclick: QC.closeSheet })]
      });
    }
  };
})();
