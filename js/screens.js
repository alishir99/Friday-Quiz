/* screens.js: sign in, home, team, quiz editor, history. */

(function () {
  var QC = window.QC;
  var el = QC.el, av = QC.avatar;

  QC.screens = {};

  /* SIGN IN */

  QC.screens.auth = function () {
    var name = el('input.input', {
      placeholder: 'Your name', autocomplete: 'username', maxlength: 40
    });
    var pass = el('input.input', {
      placeholder: 'Password', type: 'password', autocomplete: 'current-password', maxlength: 80
    });
    var err = el('p.auth-err', { hidden: true });
    var btn = el('button.btn.primary.lg.block', { type: 'button', text: 'Continue' });

    function go() {
      var v = name.value.trim();
      var p = pass.value;
      if (!v) { name.focus(); return; }
      if (!p) { pass.focus(); return; }
      btn.disabled = true;
      err.hidden = true;
      QC.net.login(v, p)
        .then(function () { QC.boot(); })
        .catch(function (e) {
          err.textContent = e.message;
          err.hidden = false;
          btn.disabled = false;
          pass.focus();
        });
    }
    btn.onclick = go;
    name.addEventListener('keydown', function (e) { if (e.key === 'Enter') pass.focus(); });
    pass.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });

    return el('div.auth', [
      el('div.auth-card', [
        el('div.auth-mark', { text: '🏆' }),
        el('h1', { text: 'Friday Quiz' }),
        el('p.muted', { style: { marginTop: '8px', marginBottom: '26px' },
          text: 'Sign in with your name and password to join this week’s quiz.' }),

        el('div.stack', { style: { gap: '12px' } }, [name, pass]),
        err,
        el('div', { style: { marginTop: '20px' } }, [btn]),
        el('p.dim.small', { style: { marginTop: '18px', textAlign: 'center' },
          text: 'First time in, this creates your account with that password. Forgot it? Ask the admin to reset it from the Team page.' })
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
      note = 'Everyone else will be pulled in automatically. Plug this screen into the projector.';
    } else if (status === 'ready') {
      note = 'All set. ' + QC.name(u.quizMasterId) + ' starts it, and your phone will follow along on its own.';
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

    var heading = topicText || (hasTopic ? 'Topic under wraps' : 'Topic to be confirmed');

    return el('div.stack', { style: { gap: '22px' } }, [
      el('div.hero', [
        el('div.row', [
          el('span.pill.' + pills[0], [el('span.dot'), pills[1]]),
          el('div.spacer'),
          el('span.dim.small', { text: 'Round ' + (s.history.length + 1) })
        ]),
        el('h2', { style: { marginTop: '20px' }, text: heading }),
        el('p.when', { text: QC.fmtDate(u.date) }),
        el('div.grid-2', { style: { marginTop: '32px' } }, [
          roleCard('Quiz master', u.quizMasterId, u.reason && u.reason.master, master),
          roleCard('Topic picker', u.topicPickerId, u.reason && u.reason.picker, picker)
        ]),
        action ? el('div.row', { style: { marginTop: '32px' } }, [action]) : null,
        note ? el('p.muted', { style: { marginTop: action ? '14px' : '28px', fontSize: '16px' }, text: note }) : null
      ]),

      el('div.grid-2', [
        el('div.card', [
          el('div.kicker', { text: 'Where we are' }),
          el('div.steps', { style: { marginTop: '8px' } }, [
            phase(hasTopic, status === 'topic', 'Topic chosen',
              !hasTopic ? QC.name(u.topicPickerId) + ' picks it'
                : topicText ? '“' + topicText + '”'
                : 'Kept quiet until Friday'),
            phase(ready, status === 'writing', 'Questions written',
              ready ? 'All 11 ready' : QC.name(u.quizMasterId) + ' is on it'),
            phase(false, status === 'ready', 'Play on Friday', 'Everyone answers on their phone')
          ]),
          (master || picker) ? el('div.row', { style: { marginTop: '18px' } }, [
            hasTopic ? el('button.btn.quiet.sm', { type: 'button', text: 'Change topic', onclick: chooseTopic }) : null,
            master && hasTopic ? el('button.btn.quiet.sm', { type: 'button', text: 'Edit questions',
              onclick: function () { location.hash = '#/build'; } }) : null
          ]) : null
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
      ]),

      QC.isAdmin() ? el('div.row', [
        el('button.btn.quiet.sm', { type: 'button', text: 'Change who does what', onclick: overrideRoles })
      ]) : null
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

    function chooseTopic() {
      QC.ask({
        title: 'What is the quiz about?',
        sub: 'Anything goes: films, geography, the 1980s, the office.',
        value: u.topic || '', placeholder: 'e.g. British seaside towns', ok: 'Set topic'
      }).then(function (v) {
        if (v) QC.net.setTopic(v).catch(function (e) { QC.toast(e.message); });
      });
    }

    function overrideRoles() {
      QC.pickPerson({
        title: 'Who writes the quiz?',
        onPick: function (m) {
          QC.pickPerson({
            title: 'Who chooses the topic?',
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
        el('div.pos', { style: { fontSize: '16px' }, text: String(i + 1) }),
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

    var onlineCount = s.users.filter(function (u) { return u.online; }).length;

    return el('div.stack', [
      el('div.page-head', [
        el('h1', { text: 'The team' }),
        el('p.sub', { text: s.users.length + ' account' + (s.users.length === 1 ? '' : 's')
          + (onlineCount ? ' · ' + onlineCount + ' online now' : '') })
      ]),
      el('div.list', s.users.map(function (u) {
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
          s.adminId === u.id ? el('span.pill', { text: 'Admin' }) : null,
          s.upcoming && s.upcoming.quizMasterId === u.id ? el('span.pill', { text: 'Quiz master' }) : null,
          s.upcoming && s.upcoming.topicPickerId === u.id ? el('span.pill', { text: 'Topic picker' }) : null,
          QC.isAdmin() && u.id !== s.me ? el('button.btn.quiet.sm', { type: 'button', text: 'Reset password',
            onclick: function () { resetPassword(u); } }) : null
        ]);
      })),

      adminCard(),

      el('div.card.flat', { style: { marginTop: '10px' } }, [
        el('div.kicker', { text: 'Adding someone' }),
        el('p.muted', { style: { marginTop: '8px' } },
          'Send them this link, or have them scan the code, and they make their own account.'),
        el('p', { style: { marginTop: '10px', fontFamily: 'monospace', fontSize: '15px' }, text: location.origin }),
        el('div', { style: { marginTop: '14px' } }, [QC.qrSvg(location.origin, 4)])
      ])
    ]);

    function adminCard() {
      if (s.adminId) {
        return el('div.card.flat', { style: { marginTop: '10px' } }, [
          el('div.kicker', { text: 'Admin' }),
          el('div.row', { style: { marginTop: '10px', alignItems: 'center' } }, [
            av(QC.name(s.adminId)),
            el('div', { style: { marginLeft: '12px' } },
              [QC.name(s.adminId) + (s.adminId === s.me ? '  ·  you' : '')]),
            el('div.spacer'),
            QC.isAdmin() ? el('button.btn.quiet.sm', { type: 'button', text: 'Pass to someone else',
              onclick: passAdmin }) : null
          ])
        ]);
      }
      return el('div.card.flat', { style: { marginTop: '10px' } }, [
        el('div.kicker', { text: 'Admin' }),
        el('p.muted', { style: { marginTop: '8px' } },
          'Nobody is admin yet. The admin resets forgotten passwords and edits the Rules page.'),
        el('button.btn.sm', { type: 'button', text: 'Become admin', style: { marginTop: '10px' },
          onclick: function () { QC.net.claimAdmin().catch(function (e) { QC.toast(e.message); }); } })
      ]);
    }

    function passAdmin() {
      QC.pickPerson({
        title: 'Pass admin to who?',
        people: s.users.filter(function (u) { return u.id !== s.me; }),
        onPick: function (id) { QC.net.transferAdmin(id).catch(function (e) { QC.toast(e.message); }); }
      });
    }

    /* Forgot-password recovery: the admin resets it and relays the
       temporary one directly. */
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

    if (!QC.isMaster()) {
      return el('div.empty', { style: { marginTop: '40px' } }, [
        el('div', { style: { fontSize: '46px', marginBottom: '12px' } }, '🔒'),
        el('div.big', { text: 'Only the quiz master can write this quiz' }),
        el('p', { style: { marginTop: '8px' } }, QC.name(u.quizMasterId) + ' is writing it this week.'),
        el('div.row', { style: { justifyContent: 'center', marginTop: '22px' } },
          [el('a.btn.ghost', { href: '#/', 'data-nav': '', text: 'Back' })])
      ]);
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
            el('div.kicker', { text: 'Quiz master · ' + QC.fmtDate(u.date, { day: 'numeric', month: 'short' }) }),
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
          el('button.btn.ghost.sm', { type: 'button', text: '✨ Ask the assistant', onclick: toggleAssist }),
          el('div.spacer'),
          saveState
        ])
      ]);
    }

    function toggleAssist() {
      document.body.classList.toggle('assist-open');
    }

    /* Docked panel, not a modal - stays open alongside the editor like a
       copilot sidebar. Can hand back a whole quiz as JSON, which the quiz
       master inserts with one click rather than copying it in by hand.
       Chat history lives for the session only. */
    function assistDock() {
      var history = QC.screens._assistHistory || (QC.screens._assistHistory = []);
      var body = el('div.assist-dock-body');
      var input = el('textarea.textarea', {
        rows: '2', placeholder: 'Ask for a question, or "write the whole quiz about ___"'
      });
      var sendBtn = el('button.btn.primary.sm', { type: 'button', text: 'Send' });
      var err = el('p.auth-err', { hidden: true });

      function renderBody() {
        QC.clear(body);
        if (!history.length) {
          QC.append(body, el('p.assist-empty', {
            text: 'Ask for one question, a handful of ideas, or the whole thing - e.g. “Write the whole quiz about guessing animal sounds, keep it funny.”'
          }));
        }
        history.forEach(function (m) {
          var msg = el('div.assist-msg.' + m.role, [
            el('div.assist-role', { text: m.role === 'user' ? 'You' : 'Assistant' }),
            el('div.assist-text', { text: m.text })
          ]);
          if (m.quiz) {
            QC.append(msg, el('div.assist-quiz-preview', [
              el('div', { text: m.quiz.questions.length + ' question' + (m.quiz.questions.length === 1 ? '' : 's')
                + ' + tiebreaker, ready to insert' }),
              el('button.btn.primary.sm', { type: 'button', style: { marginTop: '10px' }, text: 'Insert into quiz',
                onclick: function () { insertGenerated(m.quiz); } })
            ]));
          }
          QC.append(body, msg);
        });
        body.scrollTop = body.scrollHeight;
      }

      function send() {
        var text = input.value.trim();
        if (!text) return;
        err.hidden = true;
        history.push({ role: 'user', text: text });
        input.value = '';
        sendBtn.disabled = true;
        renderBody();
        QC.net.assist(history, quiz.topic || u.topic).then(function (r) {
          history.push({ role: 'assistant', text: r.reply, quiz: r.quiz });
          sendBtn.disabled = false;
          renderBody();
        }).catch(function (e) {
          sendBtn.disabled = false;
          err.textContent = e.message;
          err.hidden = false;
        });
      }
      sendBtn.onclick = send;
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      });

      renderBody();

      return el('aside.assist-dock', [
        el('div.assist-dock-head', [
          el('span', { text: '✨', 'aria-hidden': 'true' }),
          el('h3', { text: 'Quiz assistant' }),
          el('button.btn-icon', { type: 'button', 'aria-label': 'Close', text: '✕', onclick: toggleAssist })
        ]),
        body,
        el('div.assist-dock-foot', [
          input, err,
          el('div.row', { style: { marginTop: '10px', justifyContent: 'flex-end' } }, [sendBtn])
        ])
      ]);
    }

    /* Swap in a full quiz the assistant proposed. Replaces everything, so
       anyone with real progress gets a chance to back out first. */
    function insertGenerated(parsed) {
      function apply() {
        quiz.questions = parsed.questions.slice(0, QC.MAX_QUESTIONS).map(function (q) {
          var options = (Array.isArray(q.options) ? q.options : []).slice(0, QC.MAX_OPTIONS)
            .map(function (o) { return String(o == null ? '' : o); });
          while (options.length < QC.MIN_OPTIONS) options.push('');
          var correct = Number.isInteger(q.correct) && q.correct >= 0 && q.correct < options.length ? q.correct : null;
          return { id: QC.uid(), text: String(q.text || ''), options: options, correct: correct,
            note: String(q.note || ''), media: null };
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

      var media = mediaField(q);
      card.appendChild(el('div.q-body', [
        el('div.field', [
          el('label', { text: 'Question ' + (i + 1) }),
          composeBox(bindArea(q, 'text', 'What is the question?', 'Question ' + (i + 1)), media)
        ]),
        el('div.field', [
          el('label', { text: 'Options' }),
          (function () {
            var needsCorrect = q.correct === null && q.options.some(function (o) { return o.trim(); });
            return el('span.hint' + (needsCorrect ? '.warn' : ''), { text: needsCorrect
              ? '⚠  No correct answer picked yet - tap a letter.'
              : 'Tap a letter to mark the correct one.' });
          })(),
          el('div.stack', { style: { gap: '10px', marginTop: '4px' } }, q.options.map(function (opt, oi) {
            var key = QC.OPTION_KEYS[oi];
            return el('div.opt-row', [
              el('button.opt-key' + (q.correct === oi ? '.on' : ''), {
                type: 'button', text: key,
                'aria-label': 'Mark option ' + key + ' as correct',
                onclick: function () { q.correct = oi; renderList(); saveSoon(); refreshHead(); }
              }),
              bindInput(q.options, oi, 'Option ' + key),
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
    function mediaField(target) {
      var wrap = el('div.compose-media');
      var busy = false, busyName = '', progress = 0, fill = null;

      // Called by the question box and the card, so a drop lands here.
      wrap.dropFiles = takeFiles;

      function draw() {
        QC.clear(wrap);
        QC.append(wrap, [(target.media && !busy) ? preview() : dropZone()]);
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
        busy = true; busyName = file.name || 'that file'; progress = 0;
        draw();
        QC.net.uploadMedia(file, function (f) {
          progress = f;
          if (fill) fill.style.width = Math.round(f * 100) + '%';
        }).then(function (media) {
          busy = false; fill = null;
          target.media = media;
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
            el('span.attach-t', { text: 'Uploading ' + busyName + '…' }),
            el('div.media-bar', [fill])
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
        return el('div.attach', {
          role: 'button', tabindex: '0',
          'aria-label': 'Add a picture, sound or video. Drop a file on the question or press to choose one.',
          onclick: pick,
          onkeydown: function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
          }
        }, [
          el('span.attach-icon', { text: '📎', 'aria-hidden': 'true' }),
          el('span.attach-t', { text: 'Drop a picture, sound or video here, or click to choose one' }),
          input
        ]);
      }

      function preview() {
        var m = target.media;
        var url = QC.mediaUrl(m);
        var node;
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
              target.media = null;
              draw(); saveSoon(); refreshHead();
            } })
          ])
        ]);
      }

      draw();
      // A file dropped on this question while it was closed is waiting for us.
      if (pendingDrop) {
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
      return box;
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

      var num = el('input.input', {
        type: 'number', step: 'any', placeholder: 'e.g. 563',
        value: tb.answer === null || tb.answer === undefined ? '' : tb.answer
      });
      num.addEventListener('input', function () {
        tb.answer = num.value === '' ? null : Number(num.value);
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

    function bindInput(obj, key, ph) {
      var input = el('input.input', { value: obj[key] || '', placeholder: ph || '' });
      input.addEventListener('input', function () { obj[key] = input.value; markDirty(); saveSoon(); });
      return input;
    }

    function bindArea(obj, key, ph, fallback) {
      var t = el('textarea.textarea', { placeholder: ph || '', rows: '2' });
      t.value = obj[key] || '';
      t.addEventListener('input', function () {
        obj[key] = t.value; markDirty(); saveSoon();
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

    return el('div.stack', [
      el('a.btn.quiet.sm', { href: '#/', 'data-nav': '', text: '‹  Back', style: { alignSelf: 'flex-start' } }),
      headEl, listEl,
      el('p.dim.small.center', { style: { marginTop: '26px' },
        text: 'Saves as you type. Nobody else can see the answers until you start the quiz.' }),
      assistDock()
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
            el('div.pos', { text: played ? String(i + 1) : '-' }),
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
      var qCount = h.quiz ? h.quiz.questions.length : QC.QUESTION_COUNT;
      return el('div', [
        el('div.board', { style: { marginTop: '20px' } }, rank.map(function (r, i) {
          return el('div.board-row' + (i === 0 ? '.p1' : (i === rank.length - 1 ? '.last' : '')), [
            el('div.pos', { text: String(i + 1) }),
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
        h.quiz ? el('button.btn.ghost.sm', { type: 'button', text: 'Show the questions and answers',
          style: { marginTop: '18px' }, onclick: function () { showQuiz(h); } }) : null
      ]);
    }

    function showQuiz(h) {
      var q = h.quiz;
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
