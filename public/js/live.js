/* live.js: the running quiz.
   Two views off the same state: the quiz master drives the big screen,
   everyone else answers on their own device - phone, laptop, whatever. */

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
    return q.options.map(function (t, i) {
      return { text: t, i: i, media: (q.optionMedia || [])[i] || null };
    }).filter(function (o) { return o.text.trim() || o.media; });
  }

  /* An option's own picture or clip. Sound on an option is a stage thing -
     six clips on one slide need the quiz master to play them one at a time. */
  function optionMedia(m, onStage) {
    if (!m) return null;
    var url = QC.mediaUrl(m);
    if (!url) return null;
    if (m.kind === 'image') return el('img.opt-pic', { src: url, alt: m.name || '' });
    if (!onStage) return el('span.opt-cue', { text: m.kind === 'audio' ? '🔊' : '📺' });
    return el(m.kind === 'audio' ? 'audio.opt-clip' : 'video.opt-clip', {
      src: url, controls: true, preload: 'metadata', playsinline: true
    });
  }

  /* Media on the big screen. Sound and video wait for the quiz master to press
     play: a clip that starts on its own talks over whoever is still reading the
     question out, and there is no way to un-hear the answer. */
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
    return el('div.s-media.' + m.kind, [node]);
  }

  /* On a player's own device. Pictures are needed to answer, but a roomful of
     them playing the same clip a half-second apart would be chaos, so sound and
     video stay on the big screen. */
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

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Everyone's guess as a bar, with the real answer ruled across it. Who was
     nearest is the whole point of the tiebreaker and a column of numbers makes
     you work it out; the distance to the line is the answer at a glance.

     Drawn as SVG so it scales from a phone to a projector without going soft,
     and coloured by class so it follows the theme. */
  function tieChart(rows, unit, answer) {
    var got = rows.filter(function (r) { return r.guess !== null; });
    if (!got.length) return null;

    var ans = Number(answer);
    var vals = got.map(function (r) { return Number(r.guess); }).concat([ans]);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (lo === hi) { lo -= 1; hi += 1; }             // everyone said the same
    var pad = (hi - lo) * 0.12;
    var d0 = lo - pad, d1 = hi + pad;

    var W = 1000, H = 460, L = 74, R = 26, T = 30, B = 78;
    var plotW = W - L - R, base = H - B, plotH = base - T;
    var y = function (v) { return base - ((v - d0) / (d1 - d0)) * plotH; };

    var slot = plotW / got.length;
    var barW = Math.min(96, slot * 0.6);
    var best = Math.min.apply(null, got.map(function (r) { return r.diff; }));

    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="tie-chart-svg" ' +
            'role="img" aria-label="Everyone\'s tiebreaker guesses against the answer">';

    // Scale down the left, so the bar heights mean something.
    for (var t = 0; t <= 4; t++) {
      var v = d0 + (d1 - d0) * (t / 4), yy = y(v);
      s += '<line class="tc-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '"/>';
      s += '<text class="tc-tick" x="' + (L - 12) + '" y="' + (yy + 6) + '" text-anchor="end">' + esc(num(v)) + '</text>';
    }

    got.forEach(function (r, i) {
      var cx = L + slot * (i + 0.5);
      var gy = y(Number(r.guess));
      var top = Math.min(gy, base), h = Math.max(2, Math.abs(base - gy));
      var cls = 'tc-bar' + (r.diff === best ? ' best' : '');
      s += '<rect class="' + cls + '" x="' + (cx - barW / 2) + '" y="' + top +
           '" width="' + barW + '" height="' + h + '" rx="6"/>';
      s += '<text class="tc-val" x="' + cx + '" y="' + (top - 10) + '" text-anchor="middle">' +
           esc(num(r.guess)) + '</text>';
      // First name only: surnames turn the axis into a wall of text.
      s += '<text class="tc-name" x="' + cx + '" y="' + (base + 30) + '" text-anchor="middle">' +
           esc(String(r.name).split(/\s+/)[0]) + '</text>';
    });

    // The answer itself, ruled across everything.
    var ay = y(ans);
    s += '<line class="tc-line" x1="' + L + '" x2="' + (W - R) + '" y1="' + ay + '" y2="' + ay + '"/>';
    s += '<text class="tc-line-lbl" x="' + (W - R) + '" y="' + (ay - 12) + '" text-anchor="end">' +
         esc(num(ans) + (unit ? ' ' + unit : '')) + '</text>';

    s += '</svg>';
    return el('div.tie-chart', { html: s });
  }

  function placeFace(name, i, big) {
    return QC.placeFace(name, i, big ? 'lg' : '');
  }

  /* Your score as it stands, counted only over the answers already shown, and
     sat up in the header beside the question number in the same small type.
     Nothing to show before the first reveal - a nought then would read as
     "you have got none right" rather than "we have not said yet". */
  function scoreSoFar(L) {
    var sc = L.myScore;
    if (!sc || !sc.of) return null;
    var done = sc.of >= L.questionCount;
    return el('span.play-score' + (done ? '.final' : ''), {
      title: sc.of + ' of ' + L.questionCount + ' marked so far',
      text: (done ? 'Final ' : 'Score ') + sc.right + ' / ' + L.questionCount
    });
  }

  /* PRESENTER: the big screen */

  /* Every answer a player sends pushes new state, which redraws this view. The
     slide itself has not changed - only the tally has - so replaying its
     entrance animation each time reads as flashing. Animate only when the
     slide is genuinely a different one. */
  var lastSlide = null;

  function presenter() {
    var L = live();
    var body;
    tally = null;               // a fresh slide invalidates the old handles
    var key = L.phase + ':' + L.index;
    var same = key === lastSlide;
    lastSlide = key;

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

    if (same) body.classList.add('still');
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
      /* Never the topic, even though the quiz master could see it - they are
         the one with the screen shared, and this is the slide that sits up
         there while everyone files in. It appears on the first question. */
      el('h1.s-title', { text: 'Friday Quiz' }),
      el('p.s-sub', { text: L.questionCount + ' questions and a tiebreaker' }),
      el('div.lobby-grid', [
        el('div.lobby-join', [
          QC.qrSvg(location.origin, 8),
          el('div.lobby-join-label', { text: 'Scan to join from your phone' }),
          // Spelled out for anyone whose camera will not co-operate.
          el('div.lobby-join-or', { text: 'or open this address' }),
          el('div.lobby-join-url', { text: location.host }),
          /* Only first-timers are asked for it, but they are exactly who is
             squinting at this screen. */
          s.inviteCode ? el('div.lobby-code', [
            el('span.lbl', { text: 'Invite code' }),
            el('span.val', { text: s.inviteCode })
          ]) : null
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
      el('p.s-hint', { text: 'Everyone answers on their own screen. Press Start when you are ready.' })
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
      el('div.s-opts' + (opts.length <= 3 ? '.single' : '')
         + (opts.some(function (o) { return o.media; }) ? '.with-media' : ''), opts.map(function (o) {
        var cls = reveal ? (o.i === q.correct ? '.right' : '.wrong') : '';
        return el('div.s-opt' + cls, [
          el('span.k', { text: KEYS[o.i] }),
          optionMedia(o.media, true),
          o.text.trim() ? el('span', { text: o.text }) : null
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

  /* Held on to so the counter can be nudged without rebuilding the slide.
     Cleared whenever a slide is drawn, so a stale one is never written to. */
  var tally = null;

  function answerTally(L) {
    var done = L.answeredCount, total = L.playerCount;
    var allIn = total > 0 && done === total;
    var fill = el('i', { style: { width: (total ? (done / total) * 100 : 0) + '%' } });
    var text = el('div.tally-text', { text: allIn ? 'Everyone has answered' : done + ' of ' + total + ' answered' });
    var box = el('div.tally' + (allIn ? '.all-in' : ''), [el('div.tally-bar', [fill]), text]);
    tally = { box: box, fill: fill, text: text, kind: 'answers' };
    return box;
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
            tieChart(L.tieRows || [], tb.unit, tb.answer) || guesses
          ])
        : el('div', [
            el('p.s-sub', { text: 'Everyone type in a number. It only matters if two people finish level.' }),
            (function () {
              var allIn = L.tieCount === L.playerCount && L.playerCount;
              var fill = el('i', { style: { width: (L.playerCount ? (L.tieCount / L.playerCount) * 100 : 0) + '%' } });
              var text = el('div.tally-text', { text: L.tieCount + ' of ' + L.playerCount + ' guessed' });
              var box = el('div.tally' + (allIn ? '.all-in' : ''), [el('div.tally-bar', [fill]), text]);
              tally = { box: box, fill: fill, text: text, kind: 'tie' };
              return box;
            })()
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
          placeFace(r.name, i, true),
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
        roleCard('Quiz maker', roles.quizMasterId, 'Finished last, so you write next week’s quiz'),
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
    var each = L.reveal === 'each';
    var last = L.index === L.questionCount - 1;
    var label = 'Next';
    if (L.phase === 'lobby') label = 'Start the quiz';
    else if (L.phase === 'topic') label = 'First question';
    else if (L.phase === 'q') label = each ? 'Show the answer' : (last ? 'Tiebreaker' : 'Next');
    else if (L.phase === 'a' && each) label = last ? 'Tiebreaker' : 'Next question';
    else if (L.phase === 'tb') label = each ? 'Show the answer' : 'Show the answers';
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
    var n = 1;

    // Question and answer alternate, so there is no separate gap slide.
    // Question and answer alternate, so there is no separate gap slide.
    if (L.reveal === 'each') {
      var total = 2 * qc + 6;
      if (L.phase === 'topic') n = 2;
      else if (L.phase === 'q') n = 3 + 2 * L.index;
      else if (L.phase === 'a') n = 4 + 2 * L.index;
      else if (L.phase === 'tb') n = 2 * qc + 3;
      else if (L.phase === 'tba') n = 2 * qc + 4;
      else if (L.phase === 'board') n = 2 * qc + 5;
      else if (L.phase === 'roles') n = 2 * qc + 6;
      return { text: n + ' / ' + total, pct: (n / total) * 100 };
    }

    var totalEnd = 2 * qc + 7;
    if (L.phase === 'topic') n = 2;
    else if (L.phase === 'q') n = 3 + L.index;
    else if (L.phase === 'tb') n = qc + 3;
    else if (L.phase === 'gap') n = qc + 4;
    else if (L.phase === 'a') n = qc + 5 + L.index;
    else if (L.phase === 'tba') n = 2 * qc + 5;
    else if (L.phase === 'board') n = 2 * qc + 6;
    else if (L.phase === 'roles') n = 2 * qc + 7;
    return { text: n + ' / ' + totalEnd, pct: (n / totalEnd) * 100 };
  }

  /* PLAYER: whatever they are holding */

  function player() {
    var L = live();
    switch (L.phase) {
      case 'lobby': return waitCard('Waiting to start',
        QC.name(live().quizMasterId) + ' is about to begin. Keep this page open.');
      case 'topic': return plTopic();
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

  function plTopic() {
    var L = live();
    return el('div.play', [
      el('div.play-head', [el('span.play-step', { text: 'Tonight’s topic' })]),
      el('h2.play-q', { text: L.topic || 'Anything goes' }),
      el('p.play-foot', { text: L.questionCount + ' questions and a tiebreaker. Here we go.' })
    ]);
  }

  function plQuestion() {
    var L = live(), q = quiz().questions[L.index];
    var mine = L.myAnswers[L.index];
    var opts = filledOptions(q);

    return el('div.play', [
      el('div.play-head', [
        el('span.play-step', { text: 'Question ' + (L.index + 1) + ' of ' + L.questionCount }),
        scoreSoFar(L),
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
          optionMedia(o.media, false),
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
    // One guess only, so a guess already on record locks the whole form.
    var sent = L.myTieGuess !== null;
    var input = el('input.input.play-number', {
      type: 'number', step: 'any', inputmode: 'decimal',
      placeholder: 'Your number',
      value: sent ? L.myTieGuess : '',
      disabled: sent
    });
    var btn = el('button.btn.primary.lg.block', {
      type: 'button', style: { marginTop: '16px' },
      text: sent ? '✓ Guess sent' : 'Send my guess', disabled: sent
    });

    var send = function () {
      if (btn.disabled) return;
      if (input.value === '') { input.focus(); return; }
      // Down before the request goes out, not after it lands - a double tap is
      // faster than a round trip, and that is exactly what we are stopping.
      btn.disabled = true;
      input.disabled = true;
      QC.net.tiebreak(Number(input.value))
        .then(function () { btn.textContent = '✓ Guess sent'; QC.toast('Guess sent'); })
        .catch(function (e) {
          // It never landed, so let them try again.
          btn.disabled = false;
          input.disabled = false;
          QC.toast(e.message);
        });
    };
    btn.onclick = send;
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

    return el('div.play', [
      el('div.play-head', [
        el('span.play-step', { text: 'Tiebreaker' }),
        scoreSoFar(L),
        sent ? el('span.pill.done', { text: '✓ Guess sent' }) : null
      ]),
      el('h2.play-q', { text: tb.text }),
      phoneMedia(tb.media),
      el('div.field', { style: { marginTop: '20px' } }, [
        input,
        tb.unit ? el('span.hint', { text: 'in ' + tb.unit }) : null
      ]),
      btn,
      el('p.play-foot', { text: sent
        ? 'That one is locked in. Closest number wins if two people finish level.'
        : 'You only get one go, so make it count. Closest number wins if two people finish level.' })
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
        scoreSoFar(L),
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
      el('div.play-head', [el('span.play-step', { text: 'Tiebreaker' }), scoreSoFar(L)]),
      el('h2.play-q', { text: tb.text }),
      el('div.s-answer', { style: { marginTop: '20px' } }, [
        el('div.lbl', { text: 'Answer' }),
        el('div.val', { text: tb.answer + (tb.unit ? ' ' + tb.unit : '') }),
        el('div.note', { text: L.myTieGuess === null
          ? 'You did not guess.'
          : 'You said ' + L.myTieGuess + ', out by ' + num(out) }),
        // The quiz master's own explanation, same as the questions get.
        tb.note ? el('div.note.tb-note', { text: tb.note }) : null
      ]),
      guesses ? el('div', { style: { marginTop: '22px' } }, [
        el('div.kicker', { text: 'Everyone’s guesses' }),
        tieChart(L.tieRows || [], tb.unit, tb.answer),
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
          placeFace(r.name, i, false),
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
          el('div.who', [el('div.lbl', { text: 'Quiz maker' }), el('div.val', { text: QC.name(roles.quizMasterId) })])
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
