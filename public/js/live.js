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
    var view = QC.isMaster() ? presenter() : player();
    /* A clip whose slide has gone stops. Detaching an <audio> from the page
       does not pause it in Chrome, and this one is cached on purpose so that a
       redraw does not restart it - which means it outlives its own slide
       unless somebody says otherwise. Next frame, once the swap has happened,
       anything no longer on the page is hushed. */
    requestAnimationFrame(hushDetachedAudio);
    return view;
  };

  function hushDetachedAudio() {
    Object.keys(audioCache).forEach(function (url) {
      var a = audioCache[url];
      if (!a.isConnected && !a.paused) a.pause();
    });
  }

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
  function stageMedia(m, size) {
    if (!m) return null;
    var url = QC.mediaUrl(m);
    if (!url) return null;

    var box;
    if (m.kind === 'image') box = el('div.s-media', [el('img', { src: url, alt: m.name || '' })]);
    else if (m.kind === 'audio') box = el('div.s-media.audio', [nowPlaying(url)]);
    else box = el('div.s-media.video', [
      el('video', { src: url, controls: true, preload: 'auto', playsinline: true })
    ]);

    /* How tall the quiz maker dragged it, in vh. setProperty rather than the
       style object el() takes: custom properties are invisible to a plain
       assignment, which fails silently and leaves everything default-sized. */
    box.style.setProperty('--pic', QC.picSize(size) + 'vh');
    return box;
  }

  /* A playing clip, on the big screen.

     The browser's own audio bar is a grey pill built for a webpage, and this
     is a stage. So: the trace, a play button, and how far through it is - the
     shape every music player has settled on, because at ten paces it is the
     only part anybody reads.

     Deliberately no title anywhere. The file is called whatever the quiz maker
     saved it as, and that is very often the answer. */
  var audioCache = {};

  function nowPlaying(url) {
    /* The same element every time this slide is drawn. A fresh <audio> would
       start the clip again from nought the moment anybody's phone reconnected,
       which on a slide the room is listening to is the whole ballgame. */
    var audio = audioCache[url];
    if (!audio) {
      audio = el('audio', { src: url, preload: 'auto' });
      audioCache[url] = audio;
    }

    var card = el('div.np');
    var icon = el('button.np-play', {
      type: 'button', 'aria-label': 'Play the clip',
      onclick: function () {
        if (audio.paused) audio.play().catch(function () {}); else audio.pause();
      }
    }, [el('span.np-glyph', { html: PLAY_ICON })]);

    var seek = el('input.np-seek', {
      type: 'range', min: '0', max: '1000', value: '0',
      'aria-label': 'Position in the clip'
    });
    var elapsed = el('span.np-t', { text: '0:00' });
    var total = el('span.np-t', { text: '0:00' });

    var paint = function () {
      var d = audio.duration;
      var frac = d ? audio.currentTime / d : 0;
      seek.value = String(Math.round(frac * 1000));
      // The filled part of the track is drawn from this, so it has to be set
      // rather than left to the browser's own progress styling.
      seek.style.setProperty('--played', (frac * 100).toFixed(2) + '%');
      elapsed.textContent = clock(audio.currentTime);
      if (d) total.textContent = clock(d);
    };
    var mark = function () {
      var on = !audio.paused && !audio.ended;
      card.classList.toggle('playing', on);
      icon.setAttribute('aria-label', on ? 'Pause the clip' : 'Play the clip');
      icon.firstChild.innerHTML = on ? PAUSE_ICON : PLAY_ICON;
    };

    audio.ontimeupdate = paint;
    audio.onloadedmetadata = paint;
    audio.onplay = mark;
    audio.onpause = mark;
    audio.onended = mark;
    seek.oninput = function () {
      if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration;
    };

    QC.append(card, [
      ribbon('lg'),
      el('div.np-bar', [
        icon,
        el('div.np-track', [elapsed, seek, total])
      ]),
      audio
    ]);
    paint(); mark();
    return card;
  }

  // m:ss, and h:mm:ss only if a quiz maker really has dropped in an hour of it.
  function clock(secs) {
    if (!isFinite(secs) || secs < 0) secs = 0;
    var s = Math.floor(secs % 60), m = Math.floor(secs / 60) % 60, h = Math.floor(secs / 3600);
    var mm = h ? (m < 10 ? '0' + m : m) : m;
    return (h ? h + ':' : '') + mm + ':' + (s < 10 ? '0' + s : s);
  }

  var PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.1-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z"/></svg>';
  var PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<rect x="6" y="4.5" width="4.2" height="15" rx="1.4"/>'
    + '<rect x="13.8" y="4.5" width="4.2" height="15" rx="1.4"/></svg>';

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
    /* A clip is running on the projector and not on this phone, so all this
       screen can do is point at it. A row of bars rising and falling says
       "something is playing over there" the moment you glance down, where a
       loudspeaker glyph just sits there - and it is drawn rather than typed,
       so it looks the same on every handset instead of whatever that phone
       happens to ship for an emoji. */
    return el('div.play-media-note', [
      ribbon('sm'),
      el('span', { text: m.kind === 'audio'
        ? 'Listen to the big screen' : 'Watch the big screen' })
    ]);
  }

  /* THE RIBBON: a glowing oscilloscope trace, for wherever a clip is playing.

     Built the way the real thing looks: not one line but a stack of them, the
     same trace at different amplitudes, sliding over each other at slightly
     different speeds. They fan apart and close up again as they drift, which
     is what gives the contoured, layered look - a single line just slides past
     and reads as wallpaper.

     One path, drawn once, used nine times. `<use>` costs a reference where
     nine separate paths would cost nine sets of point data, and the player
     view is rebuilt on every push - so this markup is generated once when the
     file loads and stamped in from a string after that.

     The shape is a sum of three harmonics of one fundamental, which is what
     makes it look like a signal rather than a sine, and what makes it repeat
     exactly: every component completes a whole number of cycles per period, so
     sliding by a whole period is seamless. */

  var RIB_W = 1200;          // the viewBox, one screen wide
  var RIB_MID = 100;         // the centre line
  var RIB_PERIOD = 300;      // 4 of them across the viewBox
  var RIB_LANES = 9;

  function ribbonTrace() {
    var pts = [];
    // Twice the viewBox wide, so a slide of one whole viewBox still covers it.
    for (var x = 0; x <= RIB_W * 2; x += 8) {
      var t = (x / RIB_PERIOD) * Math.PI * 2;
      var y = Math.sin(t) * 40
            + Math.sin(t * 2 + 1.1) * 17
            + Math.sin(t * 3 + 2.4) * 9
            + Math.sin(t * 5 + 0.6) * 4;
      pts.push(x + ',' + (RIB_MID + y).toFixed(1));
    }
    return 'M' + pts.join('L');
  }

  /* Ids have to be unique per document or the second ribbon on a page would
     borrow the first one's gradient. Only one is ever on screen at a time, but
     that is a fact about today's slides, not a property of the markup. */
  var ribCount = 0;

  function buildRibbon() {
    var n = ++ribCount;
    var ink = 'ribInk' + n, path = 'ribPath' + n;
    var out = '<svg class="rib-svg" viewBox="0 0 ' + RIB_W + ' ' + (RIB_MID * 2) + '" '
            + 'preserveAspectRatio="none" aria-hidden="true" focusable="false">'
            + '<defs>'
            /* Two colour cycles across the path. The path is twice the
               viewBox wide, so one cycle would only ever show half its range
               through the window - blue to violet, and never the pink. */
            + '<linearGradient id="' + ink + '" x1="0" y1="0" x2="1" y2="0">'
            /* Classes, not stop-color="var(--rib-a)". The colours have to
               follow the theme - neon on a dark page washes out to nothing on
               a white one - but var() inside a presentation attribute has a
               patchy history in Safari, and Safari is what the room is
               holding. A class and a stylesheet rule work everywhere. */
            + '<stop class="rs-a" offset="0"/>'
            + '<stop class="rs-b" offset="0.15"/>'
            + '<stop class="rs-c" offset="0.28"/>'
            + '<stop class="rs-d" offset="0.4"/>'
            + '<stop class="rs-a" offset="0.5"/>'
            + '<stop class="rs-b" offset="0.65"/>'
            + '<stop class="rs-c" offset="0.78"/>'
            + '<stop class="rs-d" offset="0.9"/>'
            + '<stop class="rs-a" offset="1"/>'
            + '</linearGradient>'
            + '<path id="' + path + '" d="' + ribbonTrace() + '"/>'
            + '</defs>'
            + '<g class="rib-lanes" stroke="url(#' + ink + ')" fill="none">';

    for (var i = 0; i < RIB_LANES; i++) {
      /* Amplitude fans out from a hairline in the middle of the stack to the
         full trace at the edges, so the bundle has a body rather than being
         nine copies of the same line. */
      var k = 0.16 + (i / (RIB_LANES - 1)) * 0.84;
      // Each lane takes its own time to cross, which is what makes them fan.
      var secs = (7.5 + i * 0.9).toFixed(1);
      out += '<g transform="translate(0 ' + RIB_MID + ') scale(1 ' + k.toFixed(3)
           + ') translate(0 -' + RIB_MID + ')">'
           + '<use class="rib-lane" href="#' + path + '" '
           + 'style="animation-duration:' + secs + 's;opacity:' + (0.28 + k * 0.5).toFixed(2) + '"/>'
           + '</g>';
    }
    return out + '</g></svg>';
  }

  /* Stamped from a string rather than rebuilt: the trace is 300 points and the
     player view is redrawn every time somebody answers. */
  var RIBBON_HTML = null;

  function ribbon(cls) {
    if (RIBBON_HTML === null) RIBBON_HTML = buildRibbon();
    return el('div.ribbon' + (cls ? '.' + cls : ''), { html: RIBBON_HTML });
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

  /* THE TOSS: who writes next week's quiz.

     The wooden spoon writes it and whoever finished just above them picks the
     topic. When those two finish dead level there is nothing left to say which
     of them takes which job, so they call it and the quiz maker flips a coin
     in front of the room.

     Nothing here decides anything - the server holds the calls and the result.
     This is the object on the table: it shows what has been called, it takes
     the quiz maker's press, and it lands the way it was already told to. */

  var SIDES = [
    { key: 'heads', mark: 'H', word: 'Heads' },
    { key: 'tails', mark: 'T', word: 'Tails' }
  ];

  function sideWord(key) {
    var s = SIDES.filter(function (x) { return x.key === key; })[0];
    return s ? s.word : '';
  }

  function callerOn(c, side) {
    return c.players.filter(function (p) { return p.call === side; })[0] || null;
  }

  /* Remembered so the coin spins on the push that lands it and not on every
     push after it. A phone reconnecting must not send it round again. */
  var lastResult = null;

  /* The coin itself. Both faces carry their side's letter and, once it has been
     called, the name of whoever called it - so a coin sitting on the table is
     already showing the room what is riding on each face.

     Which way up it lands is a class rather than a computed angle: heads is
     five turns, tails five and a half, and the motion stays in the CSS where
     prefers-reduced-motion can take it away. */
  function coinPiece(c, big, live_) {
    var landed = c.result;
    var spin = landed && landed !== lastResult;
    if (landed) lastResult = landed;

    var stage = el('div.coin-stage'
      + (big ? '.big' : '')
      + (landed === 'tails' ? '.tails' : '')
      + (spin ? '.flipping' : ''), [
      el('div.coin', SIDES.map(function (side) {
        var who = callerOn(c, side.key);
        return el('div.coin-face.' + side.key, [
          el('span.coin-mark', { text: side.mark }),
          who ? el('span.coin-legend', { text: who.name.split(/\s+/)[0] }) : null
        ]);
      }))
    ]);

    if (!live_) {
      stage.setAttribute('role', 'img');
      stage.setAttribute('aria-label', landed
        ? sideWord(landed) + '. ' + (c.winnerId ? QC.name(c.winnerId) + ' called it.' : '')
        : 'A coin, waiting to be flipped');
      return stage;
    }

    /* The quiz maker picks it up and flips it. A real button, so it is
       reachable from a keyboard and announces itself - this is the only control
       on the slide and the whole room is waiting on it. */
    var btn = el('button.coin-flip', {
      type: 'button', 'aria-label': 'Flip the coin',
      onclick: function () {
        btn.disabled = true;
        QC.net.flip().catch(function (e) { QC.toast(e.message); btn.disabled = false; });
      }
    }, [stage]);
    return btn;
  }

  /* One side of the coin on the big screen: the letter, the word, and whoever
     has called it. The two sides are the structure of the slide - they sit
     either side of the coin from the moment it goes up, and the two players
     attach themselves to whichever one they take. Empty until they do, so the
     room can see at a glance what is still to be called. */
  function coinSide(side, c) {
    var who = callerOn(c, side.key);
    var landed = c.result;
    var state = !landed ? (who ? '.claimed' : '')
              : (landed === side.key ? '.won' : '.lost');
    return el('div.coin-side' + state, [
      el('div.coin-side-mark', { text: side.mark }),
      el('div.coin-side-word', { text: side.word }),
      who
        ? el('div.coin-side-who', [av(who.name, 'lg'), el('span.nm', { text: who.name })])
        : el('div.coin-side-who.unclaimed', { text: 'Nobody yet' }),
      landed && who
        ? el('div.job', { text: landed === side.key ? 'Picks the topic' : 'Writes the quiz' })
        : null
    ]);
  }

  function pCoin() {
    var L = live(), c = L.coin;
    // Only ever reached with a toss to run, but a stale push must not throw.
    if (!c) return el('div.slide');
    var uncalled = c.players.filter(function (p) { return !p.call; }).length;
    var foot;

    if (c.result) {
      foot = el('div.coin-out', [
        el('div.coin-called', { text: sideWord(c.result) }),
        el('div.coin-verdict', { text: QC.name(c.winnerId) + ' called it, so '
          + QC.name(c.loserId) + ' writes next Friday\u2019s quiz' })
      ]);
    } else {
      foot = el('div.coin-out.coin-cue', {
        text: uncalled === 2 ? 'Both of them are calling it on their phones'
            : uncalled === 1 ? 'One of them still has to call it'
            : 'Tap the coin'
      });
    }

    return el('div.slide.coin-slide', [
      el('div.s-kicker', { text: 'Level at the bottom' }),
      el('h1.s-title', { text: c.result ? 'That settles it' : 'Call it' }),
      el('p.s-sub', { text: c.players.map(function (p) { return p.name; }).join(' and ')
        + ' finished dead level. The coin decides which of them writes next Friday\u2019s quiz.' }),
      el('div.coin-row', [
        coinSide(SIDES[0], c),
        // Pressable only while it is still in play; afterwards it is a picture.
        coinPiece(c, true, !c.result),
        coinSide(SIDES[1], c)
      ]),
      foot
    ]);
  }

  function plCoin() {
    var L = live(), c = L.coin, me = QC.state.me;
    if (!c) return waitCard('Level at the bottom', 'Look at the big screen.');
    var mine = c.players.filter(function (p) { return p.userId === me; })[0];
    var them = c.players.filter(function (p) { return p.userId !== me; })[0];
    var head = function (t) {
      return el('div.play-head', [el('span.play-step', { text: 'Level at the bottom' })]);
    };

    // Everyone else is watching, so they get the big screen's story, quietly.
    if (!mine) {
      return el('div.play.play-coin', [
        head(),
        el('h2.play-q', { text: c.result ? 'That settles it' : 'They are calling it' }),
        el('p.muted', { style: { marginTop: '10px' }, text: c.result
          ? QC.name(c.winnerId) + ' called ' + sideWord(c.result).toLowerCase()
            + ', so ' + QC.name(c.loserId) + ' writes next Friday\u2019s quiz.'
          : c.players.map(function (p) { return p.name; }).join(' and ')
            + ' finished level, so a coin decides who writes next Friday\u2019s quiz.' }),
        coinPiece(c, false, false)
      ]);
    }

    if (c.result) {
      var won = c.winnerId === me;
      return el('div.play.play-coin', [
        head(),
        el('h2.play-q', { text: won ? 'You called it' : 'Not your day' }),
        coinPiece(c, false, false),
        el('div.coin-out', [
          el('div.coin-called', { text: sideWord(c.result) }),
          el('div.coin-verdict', { text: won
            ? 'You pick next Friday\u2019s topic'
            : 'You are writing next Friday\u2019s quiz' })
        ])
      ]);
    }

    // Still to be called, or called and waiting on the flip.
    var taken = them && them.call;
    return el('div.play.play-coin', [
      head(),
      el('h2.play-q', { text: mine.call
        ? 'You called ' + sideWord(mine.call).toLowerCase()
        : 'Call it' }),
      el('p.muted', { style: { marginTop: '10px' }, text: mine.call
        ? 'Now ' + QC.name(L.quizMasterId) + ' flips it. Watch the big screen.'
        : 'You and ' + (them ? them.name : 'someone else') + ' finished dead level. '
          + 'Call it right and you pick next Friday\u2019s topic; the other one writes '
          + 'the quiz.' }),
      el('div.call-row', SIDES.map(function (side) {
        var isMine = mine.call === side.key;
        var gone = !isMine && taken === side.key;
        var btn = el('button.call-opt' + (isMine ? '.picked' : '') + (gone ? '.gone' : ''), {
          type: 'button',
          disabled: !!mine.call || gone,
          onclick: function () {
            btn.disabled = true;
            QC.net.callIt(side.key).catch(function (e) { QC.toast(e.message); btn.disabled = false; });
          }
        }, [
          el('span.mark', { text: side.mark }),
          el('span.t', { text: side.word }),
          el('span.by', { text: gone ? them.name.split(/\s+/)[0] + ' has it' : (isMine ? 'Yours' : '') })
        ]);
        return btn;
      }))
    ]);
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
      case 'topic': body = pTopic(); break;
      case 'q':     body = pQuestion(false); break;
      case 'tb':    body = pTie(false); break;
      case 'gap':   body = pGap(); break;
      case 'a':     body = pQuestion(true); break;
      case 'tba':   body = pTie(true); break;
      case 'coin':  body = pCoin(); break;
      case 'board': body = pBoard(); break;
      case 'roles': body = pRoles(); break;
      default:      body = el('div.slide');
    }

    if (same) body.classList.add('still');
    var wrap = el('div.stage-live');
    /* The slide sits on a canvas of its own rather than bleeding into the
       window. It gives the content an edge to sit inside, which is what makes
       the scaling read as deliberate instead of as things drifting about. */
    wrap.appendChild(el('div.slide-frame', body));
    wrap.appendChild(presenterBar());
    /* Laid out first, measured second. The slide has to be in the document and
       have its fonts before anything can know whether it fits. */
    requestAnimationFrame(fitSlide);
    return wrap;
  }

  /* Shrink a slide that would otherwise be cut off by the stage bar.
     Everything on a slide matters - a clipped tally or a half-eaten invite
     code is information silently withheld - and the layout cannot always win
     on its own: a four-line question with four long answers is simply taller
     than some screens.
     This runs after the natural layout, so at normal sizes it measures, finds
     nothing wrong and does nothing at all. It only ever scales down. */
  function fitSlide() {
    var slide = document.querySelector('.slide-frame > .slide');
    // Phones scroll the slide instead; scaling text down there helps nobody.
    if (!slide || !document.body.classList.contains('presenting')) return;
    Live.fitInto(slide);
  }

  /* Shrink one slide until all of it is inside its frame.

     Exported because the editor's preview needs the same sum: without it the
     preview shows a picture and clips the answers, while the projector shows
     everything a size smaller - and a preview that disagrees with the room is
     worse than none. */
  Live.fitInto = function (slide) {
    if (!slide) return;
    var had = slide.style.transform;
    slide.style.transform = '';                       // measure unscaled
    var room = slide.clientHeight, need = slide.scrollHeight;
    /* Nothing to measure against - the slide is not laid out yet. Put back
       whatever was there rather than leaving it cleared, or a fit that ran
       correctly a moment ago gets undone by one that ran too early. */
    if (!room) { slide.style.transform = had; return; }
    if (need <= room + 1) return;

    /* No floor. Small and readable beats large and cut in half, and a floor is
       exactly how the tally ended up behind the stage bar. If a slide is so
       overloaded that this makes it tiny, that is worth seeing. */
    slide.style.transformOrigin = 'top center';
    slide.style.transform = 'scale(' + (room / need).toFixed(4) + ')';
  };

  /* A picture arriving late makes the slide taller after it was measured. */
  document.addEventListener('load', function (e) {
    if (e.target && /^(IMG|VIDEO)$/.test(e.target.tagName)) fitSlide();
  }, true);
  window.addEventListener('resize', fitSlide);

  function pLobby() {
    var L = live(), s = QC.state;
    var others = L.players.filter(function (id) { return id !== L.quizMasterId; });
    return el('div.slide.lobby-slide', [
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

  /* The subject on its own, before anything is asked. Kept quiet all week, so
     it gets a slide rather than appearing in the corner of question one. The
     quiz master sees it too - they are the one reading it out. */
  function pTopic() {
    var L = live(), s = QC.state;
    var topic = L.topic || (s.upcoming && s.upcoming.topic) || '';
    return el('div.slide.topic-slide', [
      el('div.s-kicker', { text: 'Today’s topic' }),
      el('h1.s-title', { text: topic || 'Anything goes' }),
      el('p.s-sub', { text: L.questionCount + ' questions and a tiebreaker' })
    ]);
  }

  /* How wide the answers want to be. Four dates should sit in a row rather
     than as four full-width bars with an ocean of space in each; a sentence
     needs the whole width. Measured from the longest one, since they have to
     share a layout. */
  function optionShape(opts, override) {
    // The quiz master gets the last word when the guess reads badly.
    if (override === 'row') return 'tight';
    if (override === 'stacked') return 'wide';
    var longest = 0, pics = false;
    opts.forEach(function (o) {
      longest = Math.max(longest, String(o.text || '').trim().length);
      if (o.media) pics = true;
    });
    if (pics) return 'pics';                    // pictures set their own grid
    if (longest <= 12) return 'tight';          // 1994, Blue, Owl
    if (longest <= 28) return 'mid';            // a few words
    return 'wide';                              // a phrase or a sentence
  }

  /* The longest answer, in characters. What decides how they are laid out. */
  function longestOption(opts) {
    return opts.reduce(function (n, o) {
      return Math.max(n, String(o.text || '').trim().length);
    }, 0);
  }

  /* The same answers, judged against a phone's width instead of a projector's.
     Two columns on a 390px screen leaves about eight characters once the
     letter circle and the padding have taken their share - so the twelve that
     sit happily side by side on the big screen ("Christchurch") run straight
     off the edge here. The quiz maker's explicit "side by side" still wins;
     the grid can no longer be forced wider than the screen either way. */
  function phoneShape(q, opts) {
    var shape = optionShape(opts, q.optionLayout);
    if (shape === 'tight' && q.optionLayout !== 'row' && longestOption(opts) > 8) return 'wide';
    return shape;
  }

  /* How many across. Chosen so the rows come out even - three answers go three
     across rather than two and a stranded one, which is what looked broken. */
  function optionColumns(shape, count) {
    if (shape === 'wide') return 1;
    if (shape === 'pics') return count <= 2 ? count : (count === 3 ? 3 : 2);
    if (shape === 'tight') {
      if (count <= 3) return count;             // 2 or 3 across, evenly
      return count === 4 ? 4 : (count % 3 === 0 ? 3 : 2);
    }
    // 'mid': wordier, so fewer across.
    if (count <= 3) return count === 3 ? 3 : count;
    return count % 2 === 0 ? 2 : 3;
  }

  /* A long question has to give way; a short one can be large. */
  function questionShape(text) {
    var n = String(text || '').trim().length;
    if (n > 150) return 'q-xlong';
    if (n > 80) return 'q-long';
    return '';
  }

  function pQuestion(reveal) {
    var L = live();
    return questionSlide(currentQ(), L.index, L.questionCount, reveal,
      reveal ? null : tallyBox('answers'));
  }

  /* One question, drawn as the slide the room will see.

     Taken out of pQuestion so the quiz editor's preview can call it too. A
     preview that is a lookalike drifts from the real thing the first time
     either is touched; this one cannot, because it is the same function. The
     live game passes its tally along as `foot`, the editor passes nothing. */
  function questionSlide(q, index, count, reveal, foot) {
    var opts = filledOptions(q);
    var shape = optionShape(opts, q.optionLayout);
    var qShape = questionShape(q.text);

    return el('div.slide' + (q.media ? '.has-media' : ''), [
      el('div.s-kicker', { text: 'Question ' + (index + 1) + ' of ' + count }),
      el('h2.s-q' + (qShape ? '.' + qShape : ''), { text: q.text }),
      stageMedia(q.media, q.mediaSize),
      el('div.s-opts.opts-' + shape + '.cols-' + optionColumns(shape, opts.length)
         + (shape === 'pics' ? '.with-media' : ''), opts.map(function (o) {
        var cls = reveal ? (o.i === q.correct ? '.right' : '.wrong') : '';
        return el('div.s-opt' + cls, [
          el('span.k', { text: KEYS[o.i] }),
          optionMedia(o.media, true),
          o.text.trim() ? el('span', { text: o.text }) : null
        ]);
      })),
      /* No "Answer: A" line. The right option is already lit up green and
         scaled forward - saying it again in words is the slide repeating
         itself. All that is left to add is why, so that is all this is: a
         footnote along the bottom, out of the way of the answers. */
      reveal
        ? (q.note ? el('div.s-note', [
            el('span.i', { html: QC.infoIcon, 'aria-hidden': 'true' }),
            el('span.t', { text: q.note })
          ]) : null)
        : foot
    ]);
  }

  /* What the editor's preview asks for. `reveal` shows it as the answer slide,
     which is the other half of what the quiz maker is deciding. */
  Live.previewSlide = function (q, index, count, reveal) {
    return questionSlide(q, index, count, !!reveal, null);
  };

  /* Held on to so the counter can be nudged without rebuilding the slide.
     Cleared whenever a slide is drawn, so a stale one is never written to. */
  var tally = null;

  /* "7 of 9 answered", with a bar. Built once per slide and then written to in
     place by patchCounts - the numbers are the only thing that moves while a
     question is up, and rebuilding the slide for them restarts whatever clip
     the quiz master has playing on it. */
  function tallyBox(kind) {
    var fill = el('i');
    var text = el('div.tally-text');
    var box = el('div.tally', [el('div.tally-bar', [fill]), text]);
    tally = { box: box, fill: fill, text: text, kind: kind };
    writeCounts();
    return box;
  }

  function writeCounts() {
    var L = live(), tie = tally.kind === 'tie';
    var done = tie ? L.tieCount : L.answeredCount, total = L.playerCount;
    var allIn = total > 0 && done === total;
    var verb = tie ? 'guessed' : 'answered';
    tally.fill.style.width = (total ? (done / total) * 100 : 0) + '%';
    tally.text.textContent = allIn ? 'Everyone has ' + verb : done + ' of ' + total + ' ' + verb;
    tally.box.classList.toggle('all-in', allIn);
  }

  /* net.js calls this instead of redrawing when somebody else's answer lands.
     False means there is no counter on screen after all, so a redraw it is. */
  Live.patchCounts = function () {
    if (!tally || !tally.box.isConnected) return false;
    writeCounts();
    return true;
  };

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
            tallyBox('tie')
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
    else if (L.phase === 'tba') label = L.coin ? 'Settle the tie' : 'Show the scores';
    else if (L.phase === 'coin') label = 'Show the scores';
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
    // The coin slide only exists when two people finish level, and we only
    // learn that at the tiebreaker answer - so the total grows late. It is the
    // last slide but two, where a step's worth of bar is not worth chasing.
    var c = L.coin ? 1 : 0;

    // Question and answer alternate, so there is no separate gap slide.
    // Question and answer alternate, so there is no separate gap slide.
    if (L.reveal === 'each') {
      var total = 2 * qc + 6;
      if (L.phase === 'topic') n = 2;
      else if (L.phase === 'q') n = 3 + 2 * L.index;
      else if (L.phase === 'a') n = 4 + 2 * L.index;
      else if (L.phase === 'tb') n = 2 * qc + 3;
      else if (L.phase === 'tba') n = 2 * qc + 4;
      else if (L.phase === 'coin') n = 2 * qc + 5;
      else if (L.phase === 'board') n = 2 * qc + 5 + c;
      else if (L.phase === 'roles') n = 2 * qc + 6 + c;
      return { text: n + ' / ' + (total + c), pct: (n / (total + c)) * 100 };
    }

    var totalEnd = 2 * qc + 7;
    if (L.phase === 'topic') n = 2;
    else if (L.phase === 'q') n = 3 + L.index;
    else if (L.phase === 'tb') n = qc + 3;
    else if (L.phase === 'gap') n = qc + 4;
    else if (L.phase === 'a') n = qc + 5 + L.index;
    else if (L.phase === 'tba') n = 2 * qc + 5;
    else if (L.phase === 'coin') n = 2 * qc + 6;
    else if (L.phase === 'board') n = 2 * qc + 6 + c;
    else if (L.phase === 'roles') n = 2 * qc + 7 + c;
    return { text: n + ' / ' + (totalEnd + c), pct: (n / (totalEnd + c)) * 100 };
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
      case 'coin':  return plCoin();
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
    // Nothing to do on this screen, so it sits in the middle rather than
    // starting at the top like a question does.
    return el('div.play.play-topic', [
      el('div.play-step', { text: 'Today’s topic' }),
      el('h2.play-topic-t', { text: L.topic || 'Anything goes' }),
      el('p.muted', { text: L.questionCount + ' questions and a tiebreaker' })
    ]);
  }

  function plQuestion() {
    var L = live(), q = quiz().questions[L.index];
    var mine = L.myAnswers[L.index];
    var opts = filledOptions(q);
    var shape = phoneShape(q, opts);
    /* The quiz maker has stepped back. The question stays on screen so it can
       be talked through, but it is not open again: marked already means nobody
       may touch it, and merely moved on means whoever answered is locked to
       what they said. Someone who never answered can still catch up. */
    var marked = L.index <= (L.shown === undefined ? -1 : L.shown);
    var movedOn = L.index < (L.asked === undefined ? -1 : L.asked);
    var closed = marked || (movedOn && mine !== undefined);

    return el('div.play', [
      el('div.play-head', [
        el('span.play-step', { text: 'Question ' + (L.index + 1) + ' of ' + L.questionCount }),
        scoreSoFar(L),
        mine !== undefined ? el('span.pill.done', { text: '✓ Answer sent' }) : null
      ]),
      el('h2.play-q' + (questionShape(q.text) ? '.' + questionShape(q.text) : ''), { text: q.text }),
      phoneMedia(q.media),
      el('div.play-opts.opts-' + shape, opts.map(function (o) {
        return el('button.play-opt' + (mine === o.i ? '.picked' : '')
                  + (closed && mine !== o.i ? '.faded' : ''), {
          type: 'button',
          disabled: closed,
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
      el('p.play-foot', { text: marked
        ? 'This one has already been marked, so it is closed.'
        : closed
          ? 'The quiz has moved on from this one - your answer is the one that stands.'
          : movedOn
            ? 'You never answered this one. You can still put something down.'
            : mine === undefined
              ? 'Tap your answer.'
              : 'You can change it until the next question comes up.' })
    ]);
  }

  function plTie() {
    var tb = quiz().tieBreaker, L = live();
    // One guess only, so a guess already on record locks the whole form.
    var sent = L.myTieGuess !== null;
    var input = el('input.input.play-number', {
      // Text, not number: see QC.readNumber for why that loses the guess.
      type: 'text', inputmode: 'decimal', autocomplete: 'off',
      enterkeyhint: 'send', placeholder: 'Your number',
      value: sent ? L.myTieGuess : '',
      disabled: sent
    });
    var btn = el('button.btn.primary.lg.block', {
      type: 'button', style: { marginTop: '16px' },
      text: sent ? '✓ Guess sent' : 'Send my guess', disabled: sent
    });

    var send = function () {
      if (btn.disabled) return;
      var guess = QC.readNumber(input.value);
      if (guess === null) { input.focus(); return; }
      if (Number.isNaN(guess)) {
        QC.toast('That is not a number');
        input.focus();
        return;
      }
      // Down before the request goes out, not after it lands - a double tap is
      // faster than a round trip, and that is exactly what we are stopping.
      btn.disabled = true;
      input.disabled = true;
      QC.net.tiebreak(guess)
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
      /* Same mark as the projector footnote, so the two screens are plainly
         showing the same thing. It keeps its card here: a phone has no slide
         floor for a footnote to sit on. */
      q.note ? el('div.play-note', [
        el('span.i', { html: QC.infoIcon, 'aria-hidden': 'true' }),
        el('span.t', { text: q.note })
      ]) : null
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
