/* net.js: talking to the server. Accounts, actions, and the live feed. */

(function () {
  var QC = window.QC;

  var Net = QC.net = {
    connected: false,
    source: null,
    pollTimer: null
  };

  /** JSON request. Resolves with the body; rejects with an Error carrying the
      server's message so callers can show it verbatim. */
  Net.call = function (path, method, body) {
    return fetch(path, {
      method: method || 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var err = new Error(j.error || ('Request failed (' + r.status + ')'));
          // Callers sometimes need more than the message - the sign-in screen
          // reveals its invite field off the flag the server sends back.
          err.body = j;
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  };

  Net.login = function (name, password, invite) {
    return Net.call('api/login', 'POST', { name: name, password: password, invite: invite });
  };
  // Nickname only - no password, no invite code. Always a new account.
  Net.join = function (name, invite) { return Net.call('api/join', 'POST', { name: name, invite: invite }); };
  Net.logout = function () { return Net.call('api/logout', 'POST', {}); };
  Net.changePassword = function (oldPassword, newPassword) {
    return Net.call('api/change-password', 'POST', { oldPassword: oldPassword, newPassword: newPassword });
  };
  Net.resetPassword = function (userId) { return Net.call('api/reset-password', 'POST', { userId: userId }); };

  Net.claimAdmin = function () { return Net.call('api/admin/claim', 'POST', {}); };
  Net.transferAdmin = function (userId) { return Net.call('api/admin/transfer', 'POST', { userId: userId }); };
  // Hands over the server, not a team - a separate job and a separate call.
  Net.transferSite = function (userId) { return Net.call('api/site-admin/transfer', 'POST', { userId: userId }); };
  // Removing is a flag, not a delete - the same call puts someone back.
  Net.setActive = function (userId, active) {
    return Net.call('api/admin/set-active', 'POST', { userId: userId, active: active });
  };
  Net.setRules = function (text) { return Net.call('api/rules', 'POST', { text: text }); };
  // Site admin only: the other teams on this install.
  Net.teams = function () { return Net.call('api/teams'); };
  Net.addTeam = function (name, code) { return Net.call('api/teams', 'POST', { name: name, code: code }); };
  Net.renameTeam = function (name, teamId) { return Net.call('api/teams/name', 'POST', { name: name, teamId: teamId }); };
  Net.removeTeam = function (teamId) { return Net.call('api/teams/remove', 'POST', { teamId: teamId }); };
  // Signed out: turns a code into the team's name, so you can see where you are going.
  Net.teamForCode = function (code) { return Net.call('api/team-for-code', 'POST', { code: code }); };
  // Pass a code to choose one, or nothing at all to have one generated.
  Net.setInvite = function (code) { return Net.call('api/invite', 'POST', code === undefined ? {} : { code: code }); };

  /** Upload a picture, sound or video. The file goes up as the raw body with
      its type in the header, so there is no multipart parsing anywhere.
      XHR rather than fetch, because a dropped video can be tens of megabytes
      and onProgress(0..1) is the only honest thing to show while it goes. */
  Net.uploadMedia = function (file, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', 'api/media', true);
      xhr.setRequestHeader('content-type', file.type);
      xhr.setRequestHeader('x-file-name', encodeName(file.name));
      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = function () {
        var j = {};
        try { j = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && j.media) resolve(j.media);
        else reject(new Error(j.error || 'Upload failed (' + xhr.status + ')'));
      };
      xhr.onerror = function () { reject(new Error('Upload failed. Is the server still there?')); };
      xhr.onabort = function () { reject(new Error('Upload stopped')); };
      xhr.send(file);
    });
  };

  // Header values must be latin-1, and file names often are not.
  function encodeName(n) {
    return String(n || '').replace(/[^\x20-\x7E]/g, '');
  }

  Net.pastQuiz = function (id) { return Net.call('api/history/' + id + '/quiz'); };

  Net.assist = function (messages, topic) { return Net.call('api/assist', 'POST', { messages: messages, topic: topic }); };

  Net.setTopic   = function (topic) { return Net.call('api/topic', 'POST', { topic: topic }); };
  Net.saveQuiz   = function (quiz)  { return Net.call('api/quiz', 'PUT', { quiz: quiz }); };
  Net.setRoles   = function (m, p)  { return Net.call('api/roles', 'POST', { quizMasterId: m, topicPickerId: p }); };

  Net.start   = function () { return Net.call('api/live/start', 'POST', {}); };
  Net.advance = function () { return Net.call('api/live/advance', 'POST', {}); };
  Net.back    = function () { return Net.call('api/live/back', 'POST', {}); };
  Net.answer  = function (option) { return Net.call('api/live/answer', 'POST', { option: option }); };
  Net.tiebreak = function (value) { return Net.call('api/live/tiebreak', 'POST', { value: value }); };
  Net.liveRoles = function (m, p) { return Net.call('api/live/roles', 'POST', { quizMasterId: m, topicPickerId: p }); };
  // 'end' = all the answers after the last question, 'each' = straight away.
  Net.reveal  = function (mode) { return Net.call('api/live/reveal', 'POST', { mode: mode }); };
  Net.finish  = function () { return Net.call('api/live/finish', 'POST', {}); };
  Net.stop    = function () { return Net.call('api/live/stop', 'POST', {}); };

  /** Apply a state pushed by the server. */
  function receive(state) {
    var was = QC.state;
    QC.state = state;
    // Redrawing under an open dialog would tear it out from under the user.
    var sheetOpen = !document.getElementById('sheetHost').hidden;
    var editing = QC.route === 'build' && was && state && was.me === state.me;
    if (sheetOpen) return;
    if (editing && !bigChange(was, state)) return;

    /* A push for somebody else's answer changes a counter and nothing else.
       Rebuilding the whole view for that is what made the big screen flicker,
       so nudge the number instead and leave the slide alone. */
    if (onlyCountsMoved(was, state)) {
      if (QC.isMaster() && QC.live.patchCounts()) return;
      if (!QC.isMaster()) return;      // players show no counter at all
    }
    QC.render();
  }

  /* True when the game is on the same slide, showing the same thing, and the
     only difference is how many people have answered so far. */
  function onlyCountsMoved(a, b) {
    if (!a || !b || !a.live || !b.live) return false;
    var x = a.live, y = b.live;
    if (x.phase !== y.phase || x.index !== y.index) return false;
    if (x.reveal !== y.reveal || x.committed !== y.committed) return false;
    // Anything about me changing has to redraw: my answer, my score, my guess.
    if (JSON.stringify(x.myAnswers) !== JSON.stringify(y.myAnswers)) return false;
    if (x.myTieGuess !== y.myTieGuess) return false;
    if (JSON.stringify(x.myScore) !== JSON.stringify(y.myScore)) return false;
    // A roster change shows up as faces in the lobby, so that redraws too.
    if ((x.players || []).length !== (y.players || []).length) return false;
    if (!!x.ranking !== !!y.ranking) return false;
    if (x.ranking && JSON.stringify(x.ranking) !== JSON.stringify(y.ranking)) return false;
    return true;
  }

  /* While the quiz master is typing questions we only redraw when something
     that actually affects the editor changed, otherwise every keystroke's
     save would wipe the field they are in. */
  function bigChange(a, b) {
    if (!a || !b) return true;
    var la = a.live, lb = b.live;
    if (!!la !== !!lb) return true;
    if (la && lb && (la.phase !== lb.phase || la.index !== lb.index)) return true;
    if (!a.upcoming !== !b.upcoming) return true;
    if (a.upcoming && b.upcoming) {
      if (a.upcoming.quizMasterId !== b.upcoming.quizMasterId) return true;
      if (a.upcoming.topic !== b.upcoming.topic) return true;
      if (a.upcoming.topicSet !== b.upcoming.topicSet) return true;
    }
    return false;
  }

  /** Live feed. Server-sent events, falling back to polling if they fail. */
  Net.connect = function () {
    if (Net.source) { Net.source.close(); Net.source = null; }
    if (Net.pollTimer) { clearInterval(Net.pollTimer); Net.pollTimer = null; }

    if (typeof EventSource === 'undefined') return Net.startPolling();

    var es = new EventSource('api/events');
    Net.source = es;

    es.onmessage = function (e) {
      Net.connected = true;
      QC.setConnection(true);
      try { receive(JSON.parse(e.data)); } catch (err) { console.error('bad push', err); }
    };

    es.onerror = function () {
      // EventSource retries on its own; show it and keep a poll going as cover.
      Net.connected = false;
      QC.setConnection(false);
      if (!Net.pollTimer) Net.startPolling();
    };
  };

  Net.startPolling = function () {
    if (Net.pollTimer) return;
    Net.pollTimer = setInterval(function () {
      Net.refresh().then(function () {
        Net.connected = true;
        QC.setConnection(true);
      }).catch(function () {
        Net.connected = false;
        QC.setConnection(false);
      });
    }, 2000);
  };

  Net.refresh = function () {
    return Net.call('api/state').then(function (s) { receive(s); return s; });
  };

  Net.disconnect = function () {
    if (Net.source) { Net.source.close(); Net.source = null; }
    if (Net.pollTimer) { clearInterval(Net.pollTimer); Net.pollTimer = null; }
    Net.connected = false;
  };
})();
