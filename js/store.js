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

  QC.uid = function () {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  };

  QC.initials = function (name) {
    var parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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

  QC.questionReady = function (q) {
    if (!q || !q.text.trim()) return false;
    var filled = q.options.filter(function (o) { return o.trim(); });
    return filled.length >= QC.MIN_OPTIONS
      && typeof q.correct === 'number' && !!(q.options[q.correct] || '').trim();
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
    if (q.correct === index) q.correct = 0;
    else if (q.correct > index) q.correct--;
    return true;
  };

  QC.addOption = function (q) {
    if (q.options.length >= QC.MAX_OPTIONS) return false;
    q.options.push('');
    return true;
  };

  /* all-time table from the stored history */

  QC.leaderboard = function () {
    var s = QC.state;
    if (!s) return [];
    var byId = {};
    s.users.forEach(function (u) {
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
