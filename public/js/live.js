/* live.js: the running quiz.
   Two views off the same state: the quiz master drives the big screen,
   everyone else taps answers on their phone. */

(function () {
  var QC = window.QC;
  var el = QC.el, av = QC.avatar;

  var Live = QC.live = {};
  var KEYS = QC.OPTION_KEYS;

  Live.isRunning = function () { return !!(QC.state && QC.state.live); };

  Live.render = function () {
    return QC.isMaster() ? presenter() : player();
  };

  function quiz() { return QC.state.upcoming.quiz; }
  function live() { return QC.state.live; }
  function currentQ() { return quiz().questions[live().index]; }
  function filledOptions(q) {
    return q.options.map(function (t, i) { return { text: t, i: i }; })
                    .filter(function (o) { return o.text.trim(); });
  }

  /* Media on the big screen. Sound and video try to play as soon as the slide
     appears; browsers block that until the page has been interacted with, and
     the controls are there for when they do. */
  function stageMedia(m) {
    if (!m) return null;
    var url = QC.mediaUrl(m);
    if (!url) return null;

    if (m.kind === 'image') {
      return el('div.s-media', [el('img', { src: url, alt: m.name || '' })]);
    }

    var node = el(m.kind === 'audio' ? 'audio' : 'video', {
      src: url, controls: true, preload: 'auto', playsinline: true
    });
    setTimeout(function () {
      var p = node.play();
      if (p && p.catch) p.catch(function () { /* blocked until a click, fine */ });
    }, 60);
    return el('div.s-media.' + m.kind, [node]);
  }

  /* On a phone. Pictures are needed to answer, but ten handsets playing the
     same clip out of sync would be chaos, so sound and video stay on the
     big screen. */
  function phoneMedia(m) {
    if (!m) return null;
    var url = QC.mediaUrl(m);
    if (!url) return null;

    if (m.kind === 'image') {
      return el('img.play-media', { src: url, alt: m.name || '' });
    }
    return el('div.play-media-note', [
      el('span.icon', { text: m.kind === 'audio' ? '🔊' : '📺' }),
      el('span', { text: m.kind === 'audio'
        ? 'Listen to the big screen' : 'Watch the big screen' })
    ]);
  }

  /* Everyone's tiebreaker guess, closest first. The server only sends these
     once the answer is up, so this cannot spoil anything. */
  function tieBoard(rows, unit, big) {
    if (!rows || !rows.length) return null;

    var best = null;
    rows.forEach(function (r) {
      if (r.diff !== null && (best === null || r.diff < best)) best = r.diff;
    });
    var me = QC.state.me;

    return el('div.tie-board' + (big ? '.big' : ''), rows.map(function (r) {
      var closest = r.diff !== null && r.diff === best;
      return el('div.tie-row' + (closest ? '.closest' : '') + (r.userId === me ? '.mine' : ''), [
        av(r.name, big ? 'lg' : ''),
        el('div.tie-who', [
          el('div.nm', { text: r.name + (r.userId === me ? '  ·  you' : '') }),
          el('div.tag', { text: r.guess === null ? 'never guessed'
            : r.diff === 0 ? 'spot on' : 'out by ' + num(r.diff) })
        ]),
        el('div.spacer'),
        el('div.tie-guess', { text: r.guess === null ? '-' : num(r.guess) + (unit ? ' ' + unit : '') }),
        closest ? el('span.pill.done.tie-flag', { text: r.diff === 0 ? '🎯 Exact' : 'Closest' }) : null
      ]);
    }));
  }

  // Guesses are numbers people typed, so keep them short on screen.
  function num(n) {
    var v = Math.round(Number(n) * 10) / 10;
    return String(v);
  }

  /* PRESENTER: the big screen */

  function presenter() {
    var L = live();
    var body;

    switch (L.phase) {
      case 'lobby': body = pLobby(); break;
      case 'q':     body = pQuestion(false); break;
      case 'tb':    body = pTie(false); break;
      case 'gap':   body = pGap(); break;
      case 'a':     body = pQuestion(true); break;
      case 'tba':   body = pTie(true); break;
      case 'board': body = pBoard(); break;
      case 'roles': body = pRoles(); break;
      default:      body = el('div.slide');
    }

    var wrap = el('div.stage-live');
    wrap.appendChild(body);
    wrap.appendChild(presenterBar());
    return wrap;
  }

  function pLobby() {
    var L = live(), s = QC.state;
    var others = L.players.filter(function (id) { return id !== L.quizMasterId; });
    return el('div.slide', [
      el('div.s-kicker', { text: QC.fmtDate(s.upcoming.date) }),
      el('h1.s-title', { text: L.topic || 'Friday Quiz' }),
      el('p.s-sub', { text: L.questionCount + ' questions and a tiebreaker' }),
      el('div.lobby-grid', [
        el('div.lobby-join', [
          QC.qrSvg(location.origin, 8),
          el('div.lobby-join-label', { text: 'Scan to join' }),
          el('div.lobby-join-url', { text: location.host })
        ]),
        el('div.lobby-players', [
          el('div.lobby-players-count', {
            text: others.length ? others.length + ' joined so far' : 'Waiting for players…'
          }),
          el('div.lobby-faces', others.map(function (id) {
            return el('div.lobby-face', [av(QC.name(id), 'lg'), el('span', { text: QC.name(id).split(/\s+/)[0] })]);
          }))
        ])
      ]),
      el('p.s-hint', { text: 'Everyone answers on their own phone. Press Start when you are ready.' })
    ]);
  }

  function pQuestion(reveal) {
    var L = live(), q = currentQ();
    var opts = filledOptions(q);

    return el('div.slide' + (q.media ? '.has-media' : ''), [
      el('div.s-kicker', { text: 'Question ' + (L.index + 1) + ' of ' + L.questionCount }),
      el('h2.s-q', { text: q.text }),
      stageMedia(q.media),
      // Few options read better stacked full-width on a projector than
      // squeezed into two columns with a gap at the end.
      el('div.s-opts' + (opts.length <= 3 ? '.single' : ''), opts.map(function (o) {
        var cls = reveal ? (o.i === q.correct ? '.right' : '.wrong') : '';
        return el('div.s-opt' + cls, [
          el('span.k', { text: KEYS[o.i] }),
          el('span', { text: o.text })
        ]);
      })),
      reveal
        ? (q.note ? el('div.s-answer', [
            el('div.lbl', { text: 'Answer' }),
            el('div.val', { text: KEYS[q.correct] + ': ' + q.options[q.correct] }),
            el('div.note', { text: q.note })
          ]) : null)
        : answerTally(L)
    ]);
  }

  function answerTally(L) {
    var done = L.answeredCount, total = L.playerCount;
    var allIn = total > 0 && done === total;
    return el('div.tally' + (allIn ? '.all-in' : ''), [
      el('div.tally-bar', [
        el('i', { style: { width: (total ? (done / total) * 100 : 0) + '%' } })
      ]),
      el('div.tally-text', { text: allIn ? 'Everyone has answered' : done + ' of ' + total + ' answered' })
    ]);
  }

  function pTie(reveal) {
    var tb = quiz().tieBreaker, L = live();
    // With everyone's guesses listed the slide gets tall, so the question and
    // any media shrink out of the way.
    var guesses = reveal ? tieBoard(L.tieRows, tb.unit, true) : null;
    return el('div.slide' + (tb.media ? '.has-media' : '') + (guesses ? '.tight' : ''), [
      el('div.s-kicker', { text: 'Tiebreaker  ·  closest number wins' }),
      el('h2.s-q', { text: tb.text }),
      stageMedia(tb.media),
      reveal
        ? el('div', [
            el('div.s-answer', [
              el('div.lbl', { text: 'Answer' }),
              el('div.val', { text: tb.answer + (tb.unit ? ' ' + tb.unit : '') }),
              tb.note ? el('div.note', { text: tb.note }) : null
            ]),
            guesses
          ])
        : el('div', [
            el('p.s-sub', { text: 'Type a number on your phone. It only matters if two people finish level.' }),
            el('div.tally' + (L.tieCount === L.playerCount && L.playerCount ? '.all-in' : ''), [
              el('div.tally-bar', [el('i', { style: { width: (L.playerCount ? (L.tieCount / L.playerCount) * 100 : 0) + '%' } })]),
              el('div.tally-text', { text: L.tieCount + ' of ' + L.playerCount + ' guessed' })
            ])
          ])
    ]);
  }

  function pGap() {
    return el('div.slide', [
      el('div.s-kicker', { text: 'That is all of them' }),
      el('h1.s-title', { text: 'Now the answers' }),
      el('p.s-sub', { text: 'Same questions, same order, this time with the right one shown.' })
    ]);
  }

  function pBoard() {
    var L = live();
    var rows = L.ranking || [];
    var lastIdx = rows.length - 1;
    return el('div.slide', [
      el('div.s-kicker', { text: L.topic || '' }),
      el('h1.s-title', { style: { fontSize: 'clamp(34px,4.6vw,68px)' }, text: 'The results' }),
      el('div.stage-board', rows.map(function (r, i) {
        var cls = i === 0 ? '.p1' : (i === lastIdx && rows.length > 1 ? '.last' : '');
        var node = el('div.board-row' + cls, [
          el('div.pos', { text: i === 0 ? '🏆' : String(i + 1) }),
          el('div', [
            el('div.nm', { text: r.name }),
            r.tieGuess !== null ? el('div.tag', { text: 'tiebreaker ' + r.tieGuess }) : null
          ]),
          el('div.row', { style: { gap: '14px' } }, [
            i === lastIdx && rows.length > 1 ? el('span.tag', { text: 'WOODEN SPOON' }) : null,
            el('div.sc', { text: r.score + '/' + L.questionCount })
          ])
        ]);
        node.style.animationDelay = (i * 90) + 'ms';
        return node;
      }))
    ]);
  }

  function pRoles() {
    var L = live(), roles = L.nextRoles || {};
    return el('div.slide', [
      el('div.s-kicker', { text: 'Next Friday' }),
      el('h1.s-title', { style: { fontSize: 'clamp(34px,4.6vw,68px)' }, text: 'Over to you two' }),
      el('div.next-grid', [
        roleCard('Quiz master', roles.quizMasterId, 'Finished last, so you write next week’s quiz'),
        roleCard('Topic picker', roles.topicPickerId, 'Second from last, so you choose the subject')
      ]),
      L.committed
        ? el('p.s-hint', { style: { marginTop: '30px' }, text: '✓  Saved. See you next week.' })
        : el('div.row', { style: { marginTop: 'clamp(24px,4vh,48px)' } }, [
            el('button.nav-big.primary', { type: 'button', text: 'Save and finish', onclick: function (e) {
              e.target.disabled = true;
              QC.net.finish().catch(function (err) { QC.toast(err.message); e.target.disabled = false; });
            } }),
            el('button.nav-big', { type: 'button', text: 'Swap these two', onclick: swapRoles })
          ])
    ]);
  }

  function roleCard(label, id, why) {
    return el('div.next-card', [
      el('div.lbl', { text: label }),
      id ? av(QC.name(id), 'xl') : el('span.av.xl', { text: '?' }),
      el('div.val', { text: id ? QC.name(id) : 'Not set' }),
      el('div.why', { text: why })
    ]);
  }

  function swapRoles() {
    var roles = live().nextRoles || {};
    QC.pickPerson({
      title: 'Who writes next week’s quiz?',
      onPick: function (m) {
        QC.pickPerson({
          title: 'Who chooses the topic?',
          onPick: function (p) {
            QC.net.liveRoles(m, p).catch(function (e) { QC.toast(e.message); });
          }
        });
      }
    });
  }

  /* Presenter controls */

  function presenterBar() {
    var L = live();
    var label = 'Next';
    if (L.phase === 'lobby') label = 'Start the quiz';
    else if (L.phase === 'q' && L.index === L.questionCount - 1) label = 'Tiebreaker';
    else if (L.phase === 'tb') label = 'Show the answers';
    else if (L.phase === 'tba') label = 'Show the scores';
    else if (L.phase === 'board') label = 'Next week';

    var step = stepNumber(L);

    return el('div.stage-bar', [
      el('button.btn-icon', { type: 'button', 'aria-label': 'Stop the quiz', text: '✕', onclick: function () {
        QC.confirm({
          title: 'Stop the quiz?',
          sub: L.committed ? 'It is already saved.' : 'Nothing will be saved and everyone drops back to the home screen.',
          ok: 'Stop', danger: true
        }).then(function (yes) { if (yes) QC.net.stop().catch(function (e) { QC.toast(e.message); }); });
      } }),
      el('span.count', { text: step.text }),
      el('div.progress', [el('i', { style: { width: step.pct + '%' } })]),
      el('button.nav-big', { type: 'button', disabled: L.phase === 'lobby', onclick: function () {
        QC.net.back().catch(function (e) { QC.toast(e.message); });
      } }, ['‹  Back']),
      el('button.nav-big.primary', { type: 'button', disabled: L.phase === 'roles', onclick: function () {
        QC.net.advance().catch(function (e) { QC.toast(e.message); });
      } }, [label + '  ›'])
    ]);
  }

  function stepNumber(L) {
    var qc = L.questionCount;
    var total = 2 * qc + 6;                                    // qc=10 -> 26, as before
    var n = 1;
    if (L.phase === 'q') n = 2 + L.index;
    else if (L.phase === 'tb') n = qc + 2;
    else if (L.phase === 'gap') n = qc + 3;
    else if (L.phase === 'a') n = qc + 4 + L.index;
    else if (L.phase === 'tba') n = 2 * qc + 4;
    else if (L.phase === 'board') n = 2 * qc + 5;
    else if (L.phase === 'roles') n = 2 * qc + 6;
    return { text: n + ' / ' + total, pct: (n / total) * 100 };
  }

  /* PLAYER: the phone */

  function player() {
    var L = live();
    switch (L.phase) {
      case 'lobby': return waitCard('Waiting to start',
        QC.name(live().quizMasterId) + ' is about to begin. Keep this page open.');
      case 'q':     return plQuestion();
      case 'tb':    return plTie();
      case 'gap':   return waitCard('Here come the answers', 'Look at the big screen.');
      case 'a':     return plAnswer();
      case 'tba':   return plTieAnswer();
      case 'board': return plBoard();
      case 'roles': return plRoles();
    }
    return el('div');
  }

  function waitCard(title, sub) {
    return el('div.play', [
      el('div.play-wait', [
        el('div.pulse'),
        el('h2', { text: title }),
        el('p.muted', { text: sub })
      ])
    ]);
  }

  function plQuestion() {
    var L = live(), q = quiz().questions[L.index];
    var mine = L.myAnswers[L.index];
    var opts = filledOptions(q);

    return el('div.play', [
      el('div.play-head', [
        el('span.play-step', { text: 'Question ' + (L.index + 1) + ' of ' + L.questionCount }),
        mine !== undefined ? el('span.pill.done', { text: '✓ Answer sent' }) : null
      ]),
      el('h2.play-q', { text: q.text }),
      phoneMedia(q.media),
      el('div.play-opts', opts.map(function (o) {
        return el('button.play-opt' + (mine === o.i ? '.picked' : ''), {
          type: 'button',
          onclick: function () {
            QC.net.answer(o.i).catch(function (e) { QC.toast(e.message); });
          }
        }, [
          el('span.k', { text: KEYS[o.i] }),
          el('span.t', { text: o.text }),
          mine === o.i ? el('span.tick', { text: '✓' }) : null
        ]);
      })),
      el('p.play-foot', { text: mine === undefined
        ? 'Tap your answer.'
        : 'You can change it until the next question comes up.' })
    ]);
  }

  function plTie() {
    var tb = quiz().tieBreaker, L = live();
    var input = el('input.input.play-number', {
      type: 'number', step: 'any', inputmode: 'decimal',
      placeholder: 'Your number',
      value: L.myTieGuess === null ? '' : L.myTieGuess
    });
    var send = function () {
      if (input.value === '') { input.focus(); return; }
      QC.net.tiebreak(Number(input.value))
        .then(function () { QC.toast('Guess sent'); })
        .catch(function (e) { QC.toast(e.message); });
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

    return el('div.play', [
      el('div.play-head', [
        el('span.play-step', { text: 'Tiebreaker' }),
        L.myTieGuess !== null ? el('span.pill.done', { text: '✓ Guess sent' }) : null
      ]),
      el('h2.play-q', { text: tb.text }),
      phoneMedia(tb.media),
      el('div.field', { style: { marginTop: '20px' } }, [
        input,
        tb.unit ? el('span.hint', { text: 'in ' + tb.unit }) : null
      ]),
      el('button.btn.primary.lg.block', { type: 'button', text: 'Send my guess',
        style: { marginTop: '16px' }, onclick: send }),
      el('p.play-foot', { text: 'Closest number wins if two people finish level.' })
    ]);
  }

  function plAnswer() {
    var L = live(), q = quiz().questions[L.index];
    var mine = L.myAnswers[L.index];
    var right = mine === q.correct;
    var opts = filledOptions(q);

    return el('div.play', [
      el('div.play-head', [
        el('span.play-step', { text: 'Question ' + (L.index + 1) + ' of ' + L.questionCount }),
        el('span.pill.' + (right ? 'done' : 'wait'), { text: right ? '✓ You got it' : (mine === undefined ? 'No answer' : '✗ Not this time') })
      ]),
      el('h2.play-q', { text: q.text }),
      phoneMedia(q.media),
      el('div.play-opts', opts.map(function (o) {
        var cls = o.i === q.correct ? '.right' : (o.i === mine ? '.mine-wrong' : '.faded');
        return el('div.play-opt' + cls, [
          el('span.k', { text: KEYS[o.i] }),
          el('span.t', { text: o.text }),
          o.i === q.correct ? el('span.tick', { text: '✓' }) : null
        ]);
      })),
      q.note ? el('p.play-note', { text: q.note }) : null
    ]);
  }

  function plTieAnswer() {
    var tb = quiz().tieBreaker, L = live();
    var out = L.myTieGuess === null ? null : Math.abs(L.myTieGuess - Number(tb.answer));
    var guesses = tieBoard(L.tieRows, tb.unit, false);
    return el('div.play', [
      el('div.play-head', [el('span.play-step', { text: 'Tiebreaker' })]),
      el('h2.play-q', { text: tb.text }),
      el('div.s-answer', { style: { marginTop: '20px' } }, [
        el('div.lbl', { text: 'Answer' }),
        el('div.val', { text: tb.answer + (tb.unit ? ' ' + tb.unit : '') }),
        el('div.note', { text: L.myTieGuess === null
          ? 'You did not guess.'
          : 'You said ' + L.myTieGuess + ', out by ' + num(out) })
      ]),
      guesses ? el('div', { style: { marginTop: '22px' } }, [
        el('div.kicker', { text: 'Everyone’s guesses' }),
        guesses
      ]) : null
    ]);
  }

  function plBoard() {
    var L = live();
    var rows = L.ranking || [];
    var me = QC.state.me;
    var lastIdx = rows.length - 1;
    return el('div.play', [
      el('div.play-head', [el('span.play-step', { text: 'Final scores' })]),
      el('h2.play-q', { style: { marginBottom: '18px' }, text: 'The results' }),
      el('div.board', rows.map(function (r, i) {
        var cls = i === 0 ? '.p1' : (i === lastIdx && rows.length > 1 ? '.last' : '');
        return el('div.board-row' + cls, [
          el('div.pos', { text: i === 0 ? '🏆' : String(i + 1) }),
          el('div.nm', { text: r.name + (r.userId === me ? '  ·  you' : '') }),
          el('div.sc', { text: r.score + '/' + L.questionCount })
        ]);
      }))
    ]);
  }

  function plRoles() {
    var roles = live().nextRoles || {};
    var me = QC.state.me;
    var mine = roles.quizMasterId === me ? 'You are writing next week’s quiz.'
             : roles.topicPickerId === me ? 'You are choosing next week’s topic.'
             : null;
    return el('div.play', [
      el('div.play-head', [el('span.play-step', { text: 'Next Friday' })]),
      el('h2.play-q', { text: 'Over to you two' }),
      el('div.stack', { style: { marginTop: '20px', gap: '12px' } }, [
        el('div.role-card', [
          av(QC.name(roles.quizMasterId), 'lg'),
          el('div.who', [el('div.lbl', { text: 'Quiz master' }), el('div.val', { text: QC.name(roles.quizMasterId) })])
        ]),
        el('div.role-card', [
          av(QC.name(roles.topicPickerId), 'lg'),
          el('div.who', [el('div.lbl', { text: 'Topic picker' }), el('div.val', { text: QC.name(roles.topicPickerId) })])
        ])
      ]),
      mine ? el('p.play-foot', { style: { fontWeight: '600', color: 'var(--accent)' }, text: mine }) : null
    ]);
  }
})();
