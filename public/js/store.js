/* store.js: shared helpers and the client-side view of the data.
   Ranking, rotation and scoring all live on the server now; this is the
   presentation side of it. Classic script, no modules. */

(function () {
  var QC = window.QC || (window.QC = {});

  QC.QUESTION_COUNT = 10;     // how many a fresh quiz starts with
  QC.MAX_QUESTIONS = 20;      // how many the quiz master can grow it to
  QC.MIN_QUESTIONS = 1;       // can't delete the last one
  QC.OPTION_KEYS = 'ABCDEF';
  QC.DEFAULT_OPTIONS = 3;
  QC.MIN_OPTIONS = 2;
  QC.MAX_OPTIONS = 6;
  var THEME_KEY = 'fridayquiz.theme';
  var ASSIST_W_KEY = 'fridayquiz.assistWidth';

  QC.uid = function () {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  };

  QC.initials = function (name) {
    var parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  /* A number as a phone's keypad actually spells it.

     iOS gives the decimal key whatever mark the handset's own locale uses, and
     on a great many of them that mark is a comma - so a European thumb aiming
     at 70.2 produces "70,2". An <input type="number"> calls that invalid, and
     what it hands back is not the text with a comma in it: it is the empty
     string. Both places that take a number are therefore plain text fields
     with a decimal keypad, and the parsing happens here where both marks are
     accepted.

     null for nothing typed, NaN for something that is not a number, so a
     caller can tell an empty field from a bad one. */
  QC.readNumber = function (raw) {
    var t = String(raw == null ? '' : raw).trim().replace(/\s/g, '');
    if (t === '') return null;
    /* Grouped thousands, unambiguously: 1,000 and 12,345,678. Nobody writes a
       decimal that way, and reading those as 1 and 12.345 would be worse than
       refusing them. Any other comma is a decimal point. */
    t = /^[+-]?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
    var n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };

  /* How tall a picture stands on the big screen, as a percentage of the
     screen's height. It used to be three presets - Fit, Large, Fill - and it
     was never quite the size anybody wanted, so it is a number the quiz maker
     drags now. The three old names still read: a quiz written last month must
     not change shape today. */
  QC.PIC_MIN = 15;
  QC.PIC_MAX = 90;
  var LEGACY_PIC = { fit: 42, large: 62, fill: 86 };

  QC.picSize = function (v) {
    var n = Number(v);
    if (isFinite(n) && n > 0) return Math.min(QC.PIC_MAX, Math.max(QC.PIC_MIN, Math.round(n)));
    return LEGACY_PIC[v] || 42;
  };

  QC.fmtDate = function (iso, opts) {
    if (!iso) return '';
    var d = new Date(iso + (iso.length === 10 ? 'T12:00:00' : ''));
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, opts || { weekday: 'long', day: 'numeric', month: 'long' });
  };

  /* lookups against the state the server sent */

  QC.user = function (id) {
    var s = QC.state;
    if (!s || !s.users || !id) return null;
    for (var i = 0; i < s.users.length; i++) if (s.users[i].id === id) return s.users[i];
    return null;
  };

  QC.name = function (id) {
    var u = QC.user(id);
    return u ? u.name : '?';
  };

  QC.isMaster = function () {
    var s = QC.state;
    if (!s || !s.me) return false;
    // During a game the person running it keeps the presenter view, even after
    // the results are saved and the role has passed to next week's loser.
    if (s.live) return s.live.quizMasterId === s.me;
    return !!(s.upcoming && s.upcoming.quizMasterId === s.me);
  };

  QC.isPicker = function () {
    var s = QC.state;
    return !!(s && s.upcoming && s.me && s.upcoming.topicPickerId === s.me);
  };

  // Fixed person, not part of the weekly rotation. Unset until someone claims it.
  QC.isAdmin = function () {
    var s = QC.state;
    return !!(s && s.me && s.adminId === s.me);
  };

  /* Only the picker and the quiz master are sent the topic itself. Everybody
     else gets topicSet, so the home screen can still show progress without
     giving the surprise away. */
  QC.hasTopic = function () {
    var s = QC.state;
    return !!(s && s.upcoming && s.upcoming.topicSet);
  };

  QC.topicText = function () {
    var s = QC.state;
    return s && s.upcoming ? String(s.upcoming.topic || '').trim() : '';
  };

  /* quiz completeness (mirrors the server's rules) */

  /* An option is real once it has words, a picture, or both - four photos with
     no labels is a perfectly good question. Mirrors optionFilled() on the
     server; the two have to agree or the editor and the Start button disagree. */
  QC.optionFilled = function (q, i) {
    return !!String(q.options[i] || '').trim() || !!(q.optionMedia && q.optionMedia[i]);
  };

  QC.questionReady = function (q) {
    if (!q || !q.text.trim()) return false;
    var filled = q.options.filter(function (o, i) { return QC.optionFilled(q, i); });
    return filled.length >= QC.MIN_OPTIONS
      && typeof q.correct === 'number' && QC.optionFilled(q, q.correct);
  };

  QC.tieBreakerReady = function (tb) {
    return !!(tb && tb.text.trim() && tb.answer !== null && tb.answer !== '' && isFinite(Number(tb.answer)));
  };

  QC.quizProgress = function (quiz) {
    if (!quiz || !quiz.questions) return { done: 0, total: QC.QUESTION_COUNT + 1, ready: false };
    var total = quiz.questions.length + 1;
    var done = quiz.questions.filter(QC.questionReady).length;
    if (QC.tieBreakerReady(quiz.tieBreaker)) done++;
    return { done: done, total: total, ready: done === total };
  };

  QC.blankOptions = function () {
    var o = [];
    for (var i = 0; i < QC.DEFAULT_OPTIONS; i++) o.push('');
    return o;
  };

  QC.blankQuestion = function () {
    return { id: QC.uid(), text: '', options: QC.blankOptions(), correct: null, note: '', media: null };
  };

  QC.blankQuiz = function (topic) {
    var qs = [];
    for (var i = 0; i < QC.QUESTION_COUNT; i++) qs.push(QC.blankQuestion());
    return {
      topic: topic || '', questions: qs,
      tieBreaker: { text: '', answer: null, unit: '', note: '', media: null }
    };
  };

  /* Media on a question */

  /* Same table the server keeps, so a file that is going to be refused can be
     refused here instead of after a long upload. */
  QC.MEDIA_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/webm': 'weba', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
    'video/quicktime': 'mov'
  };
  QC.MAX_MEDIA = 48 * 1024 * 1024;      // matches MAX_MEDIA in server.mjs

  QC.mediaUrl = function (m) {
    if (!m || !m.id) return '';
    var ext = QC.MEDIA_EXT[m.mime];
    return ext ? 'media/' + m.id + '.' + ext : '';
  };

  QC.MEDIA_ACCEPT = 'image/*,audio/*,video/*';

  QC.mediaLabel = function (m) {
    if (!m) return '';
    return { image: 'Picture', audio: 'Sound', video: 'Video' }[m.kind] || 'File';
  };

  /** null if the file can be uploaded, otherwise why it cannot be. */
  QC.mediaProblem = function (file) {
    if (!file) return 'No file there';
    var named = file.name ? '“' + file.name + '”' : 'That file';
    if (!QC.MEDIA_EXT[String(file.type || '').toLowerCase()]) {
      return named + ' is not a picture, sound or video we can use';
    }
    if (!file.size) return named + ' is empty';
    if (file.size > QC.MAX_MEDIA) return named + ' is too big. 48 MB is the limit';
    return null;
  };

  /** Is this drag carrying files, rather than text dragged out of a field? */
  QC.dragHasFiles = function (e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (var i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
    return false;
  };

  /** Drop an option and keep the "correct" pointer aimed at the same answer. */
  QC.removeOption = function (q, index) {
    if (q.options.length <= QC.MIN_OPTIONS) return false;
    q.options.splice(index, 1);
    // Whatever was attached to that option goes with it, or every picture
    // below shifts up onto the wrong answer.
    if (Array.isArray(q.optionMedia)) q.optionMedia.splice(index, 1);
    if (q.correct === index) q.correct = 0;
    else if (q.correct > index) q.correct--;
    return true;
  };

  QC.addOption = function (q) {
    if (q.options.length >= QC.MAX_OPTIONS) return false;
    q.options.push('');
    if (!Array.isArray(q.optionMedia)) q.optionMedia = [];
    while (q.optionMedia.length < q.options.length) q.optionMedia.push(null);
    return true;
  };

  /* all-time table from the stored history */

  QC.leaderboard = function () {
    var s = QC.state;
    if (!s) return [];
    var byId = {};
    s.users.forEach(function (u) {
      // Removed people keep their place in past quizzes but drop off the
      // standings - this table is who is playing now.
      if (u.active === false) return;
      byId[u.id] = { userId: u.id, name: u.name, played: 0, total: 0, wins: 0, spoons: 0, hosted: 0, best: null };
    });
    s.history.forEach(function (h) {
      if (byId[h.quizMasterId]) byId[h.quizMasterId].hosted++;
      (h.ranking || []).forEach(function (r, i) {
        var t = byId[r.memberId];
        if (!t) return;
        t.played++;
        t.total += r.score;
        if (i === 0) t.wins++;
        if (i === h.ranking.length - 1) t.spoons++;
        if (t.best === null || r.score > t.best) t.best = r.score;
      });
    });
    return Object.keys(byId).map(function (k) {
      var t = byId[k];
      t.avg = t.played ? t.total / t.played : null;
      return t;
    }).filter(function (t) { return t.played > 0 || t.hosted > 0; })
      .sort(function (a, b) {
        if ((a.avg === null) !== (b.avg === null)) return a.avg === null ? 1 : -1;
        if (a.avg !== null && b.avg !== a.avg) return b.avg - a.avg;
        if (b.played !== a.played) return b.played - a.played;
        return a.name.localeCompare(b.name);
      });
  };

  /* Scannable link to this app, for the big screen and the team page.
     Always plain black-on-white regardless of theme - that is what a phone
     camera actually needs, not what looks nice in dark mode. */
  QC.qrSvg = function (text, cellSize) {
    var qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return QC.el('div.qr-code', { html: qr.createSvgTag({ cellSize: cellSize || 5, margin: 8 }) });
  };

  /* How wide the assistant panel is, dragged by its edge and remembered per
     browser. Clamped against the window so a narrow laptop can never end up
     with a panel wider than the editor beside it. */
  QC.assistWidth = {
    MIN: 300,
    MAX: 720,
    clamp: function (px) {
      var room = Math.max(QC.assistWidth.MIN, window.innerWidth - 340);
      return Math.max(QC.assistWidth.MIN, Math.min(px, Math.min(QC.assistWidth.MAX, room)));
    },
    read: function () {
      var v;
      try { v = parseInt(localStorage.getItem(ASSIST_W_KEY), 10); } catch (e) {}
      return v > 0 ? v : 400;
    },
    /** Apply a width now; only writes it down when the drag has finished. */
    apply: function (px, remember) {
      var w = QC.assistWidth.clamp(px === undefined ? QC.assistWidth.read() : px);
      document.documentElement.style.setProperty('--assist-w', w + 'px');
      if (remember) { try { localStorage.setItem(ASSIST_W_KEY, String(w)); } catch (e) {} }
      return w;
    }
  };

  /* theme */

  /* Light unless someone asks for otherwise: the projector in a lit meeting
     room is easier to read that way, and it should not depend on whichever
     laptop is plugged in. "Automatic" is still there for anyone who wants it. */
  QC.theme = {
    get: function () { try { return localStorage.getItem(THEME_KEY) || 'light'; } catch (e) { return 'light'; } },
    set: function (v) {
      try { v === 'light' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, v); } catch (e) {}
      QC.theme.apply();
    },
    apply: function () {
      var v = QC.theme.get();
      if (v === 'auto') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', v);
    }
  };
})();
