/* =========================================================================
 * DUST STRIKE — bootstrap, input, pointer lock, main loop, event dispatch
 * Owned by: Lead. Depends on: CONTRACT.md §14.
 * ========================================================================= */
(function () {
  'use strict';
  var CS = window.CS = window.CS || {};
  var M = CS.math;
  var doc = document;

  /* ----------------------------- URL params ---------------------------- */
  var Q = {};
  (function () {
    try {
      var s = location.search.replace(/^\?/, '');
      if (!s) return;
      s.split('&').forEach(function (kv) {
        var p = kv.split('=');
        Q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
    } catch (e) {}
  })();
  var AUTO = Q.auto === '1';
  var HIDEUI = Q.hideui === '1';
  var START_LIVE = Q.live === '1';
  var SELFTEST = Q.selftest === '1';
  var SELFTEST_TIME = parseFloat(Q.selftestTime || '8') || 8;
  var FAST = Math.max(1, parseInt(Q.fast || '1', 10) || 1);
  var NORENDER = Q.norender === '1';
  var MAPVIEW = Q.mapview === '1';
  var selfTestDone = false;
  var AUTO_SETTINGS = {};
  if (Q.difficulty) AUTO_SETTINGS.difficulty = Q.difficulty;

  /* ------------------------------ error log ---------------------------- */
  var errors = window.__ERRORS__ = window.__ERRORS__ || [];
  var errorCount = 0;
  var errorEl = null;
  function reportError(msg) {
    if (errorCount > 20) return;
    errorCount++;
    var text = String(msg);
    if (errors.indexOf(text) < 0) errors.push(text);
    try {
      if (errorEl) {
        errorEl.textContent = errors.slice(-6).join('  ||  ');
        errorEl.style.display = 'block';
      }
      doc.title = 'DUST STRIKE · JS ERROR';
    } catch (e) {}
  }
  window.addEventListener('error', function (ev) {
    reportError((ev && (ev.message || ev.error)) || 'unknown error');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    reportError('promise: ' + (ev && ev.reason));
  });

  /* ------------------------------- game -------------------------------- */
  var game = {
    canvas: null,
    renderer: null,
    world: null,
    player: null,
    bots: [],
    hud: null,
    audio: null,
    rules: null,
    fx: null,
    time: 0,
    dt: 0,
    frame: 0,
    started: false,
    paused: false,
    running: false,
    frozen: true,
    active: false,
    settings: { sensitivity: 1.0, difficulty: 'normal', volume: 0.8, fov: 90 },
    input: {
      keys: {}, mouseDown: false, mouseDX: 0, mouseDY: 0,
      pressed: {}, locked: false, rightDown: false, rightPressed: false
    },
    events: [],
    emit: function (e) { this.events.push(e); },
    callbacks: {}
  };
  CS.game = game;
  window.__DSH_GAME__ = game;

  function loadSettings() {
    try {
      var raw = localStorage.getItem('duststrike.settings');
      if (raw) {
        var s = JSON.parse(raw);
        if (s && typeof s === 'object') {
          if (typeof s.sensitivity === 'number') game.settings.sensitivity = M.clamp(s.sensitivity, 0.2, 4);
          if (s.difficulty === 'easy' || s.difficulty === 'normal' || s.difficulty === 'hard') game.settings.difficulty = s.difficulty;
          if (typeof s.volume === 'number') game.settings.volume = M.clamp(s.volume, 0, 1);
          if (typeof s.fov === 'number') game.settings.fov = M.clamp(s.fov, 60, 110);
        }
      }
    } catch (e) {}
    for (var k in AUTO_SETTINGS) game.settings[k] = AUTO_SETTINGS[k];
  }
  game.saveSettings = function () {
    try { localStorage.setItem('duststrike.settings', JSON.stringify(game.settings)); } catch (e) {}
  };
  game.setDifficulty = function (d) {
    if (d === 'easy' || d === 'normal' || d === 'hard') { game.settings.difficulty = d; game.saveSettings(); }
  };

  /* ------------------------------- boot -------------------------------- */
  function showFatal(err) {
    var boot = doc.getElementById('boot');
    if (!boot) return;
    boot.style.opacity = '1';
    boot.innerHTML = '<div class="title" style="color:#e0604a">DUST STRIKE</div>' +
      '<div class="err">游戏启动失败：' + String(err && (err.message || err)).replace(/</g, '&lt;') +
      '<br><br>请确认使用 Chrome / Edge 打开，且浏览器支持 WebGL。' +
      '<br>如果是直接双击打开，请确认 js 目录下的脚本齐全。</div>';
    reportError(err && (err.stack || err.message || err));
  }

  function init() {
    loadSettings();
    game.canvas = doc.getElementById('game-canvas');
    errorEl = doc.createElement('div');
    errorEl.id = 'dsh-errors';
    errorEl.style.cssText = 'position:fixed;left:0;bottom:0;z-index:99999;max-width:100vw;display:none;' +
      'color:#ff7a5c;background:rgba(10,8,6,.86);font:11px/1.4 Consolas,monospace;padding:3px 8px;' +
      'white-space:pre-wrap;pointer-events:none';
    doc.body.appendChild(errorEl);

    if (SELFTEST) {
      var stEl = doc.createElement('div');
      stEl.id = 'dsh-selftest';
      stEl.style.cssText = 'position:fixed;left:0;top:0;z-index:99998;display:none;color:#9fe8a0;' +
        'background:rgba(0,0,0,.8);font:10px/1.35 Consolas,monospace;padding:4px 8px;white-space:pre;';
      doc.body.appendChild(stEl);
    }

    try {
      if (!game.canvas) throw new Error('找不到 #game-canvas');
      if (!CS.gl || typeof CS.gl.init !== 'function') throw new Error('js/glcore.js 未加载');
      if (!CS.world || typeof CS.world.init !== 'function') throw new Error('js/world.js 未加载');
      if (!CS.player || typeof CS.player.init !== 'function') throw new Error('js/player.js 未加载');
      if (!CS.bots || typeof CS.bots.init !== 'function') throw new Error('js/bots.js 未加载');
      if (!CS.hud || typeof CS.hud.init !== 'function') throw new Error('js/hud.js 未加载');
      if (!CS.rules || typeof CS.rules.init !== 'function') throw new Error('js/rules.js 未加载');

      game.renderer = CS.gl.init(game.canvas);
      if (!game.renderer) throw new Error('WebGL 初始化失败');

      game.fx = CS.fx;
      if (CS.fx && typeof CS.fx.init === 'function') {
        try { CS.fx.init(game.renderer); } catch (e) { reportError('fx.init: ' + e.message); }
      }
      game.audio = CS.audio || null;
      if (CS.audio && typeof CS.audio.init === 'function') {
        /* created lazily on first user gesture; init here only prepares internals */
        try { CS.audio.setVolume && CS.audio.setVolume(game.settings.volume); } catch (e) {}
      }

      game.world = CS.world.init(game);
      game.player = CS.player.init(game);
      if (game.player) game.player.fov = game.settings.fov;
      var botList = CS.bots.init(game);
      if (botList && botList.length) game.bots = botList;
      if (!game.bots.length && game.player && game.player.bots) game.bots = game.player.bots;

      if (typeof CS.hud.init === 'function') CS.hud.init(game);
      game.hud = CS.hud;
      game.rules = CS.rules.init(game);

      setupCallbacks();
      setupInput();
      window.addEventListener('resize', function () { try { game.renderer.resize(); } catch (e) {} });

      var boot = doc.getElementById('boot');
      if (boot) {
        boot.style.opacity = '0';
        setTimeout(function () { if (boot.parentNode) boot.parentNode.removeChild(boot); }, 450);
      }

      if (AUTO) {
        startAuto();
      } else {
        try { CS.hud.showStart && CS.hud.showStart(); } catch (e) { reportError('showStart: ' + e.message); }
      }
      game.running = true;
      requestAnimationFrame(frame);
    } catch (err) {
      showFatal(err);
    }
  }

  /* ---------------------------- callbacks ------------------------------ */
  /* only asks for pointer lock; paused state flips to false in pointerlockchange */
  function lockPointer() {
    if (AUTO) { game.input.locked = true; return; }
    try {
      var p = game.canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {}
  }

  function startGame() {
    if (game.started) return;
    game.started = true;
    game.paused = false;
    try {
      if (CS.audio && CS.audio.init) CS.audio.init();
      if (CS.audio && CS.audio.setVolume) CS.audio.setVolume(game.settings.volume);
      if (CS.audio && CS.audio.resume) CS.audio.resume();
    } catch (e) {}
    try { if (game.hud) { game.hud.hideStart && game.hud.hideStart(); game.hud.showPause && game.hud.showPause(false); } } catch (e) {}
    try { game.rules.startMatch(game); } catch (e) { reportError('startMatch: ' + (e.stack || e.message)); }
    if (!AUTO) lockPointer();
  }

  function startAuto() {
    HIDEUI = HIDEUI || false;
    game.started = true;
    game.paused = false;
    game.input.locked = true;
    try { if (CS.audio && CS.audio.init) CS.audio.init(); } catch (e) {}
    try {
      if (game.hud) {
        game.hud.hideStart && game.hud.hideStart();
        game.hud.showPause && game.hud.showPause(false);
      }
    } catch (e) {}
    if (HIDEUI) {
      var root = doc.getElementById('hud-root');
      if (root) root.style.display = 'none';
    }
    try { game.rules.startMatch(game); } catch (e) { reportError('startMatch: ' + (e.stack || e.message)); }
    if (START_LIVE) {
      try {
        var st = game.rules.state;
        st.phase = 'live';
        st.phaseTime = st.roundTimeLeft = 115;
        st.buyTimeLeft = 20;
        st.canBuy = true;
        game.frozen = false;
      } catch (e) {}
    }
  }

  function setupCallbacks() {
    game.callbacks.start = startGame;
    game.callbacks.resume = function () {
      if (!game.started) return;
      /* stay paused until the browser actually regains pointer lock */
      game.paused = true;
      try { if (CS.audio && CS.audio.resume) CS.audio.resume(); } catch (e) {}
      try { game.hud && game.hud.showPause && game.hud.showPause(false); } catch (e) {}
      lockPointer();
    };
    game.callbacks.restart = function () {
      game.started = true;
      game.paused = false;
      try {
        if (CS.audio && CS.audio.init) CS.audio.init();
        if (CS.audio && CS.audio.resume) CS.audio.resume();
      } catch (e) {}
      try {
        if (game.hud) {
          game.hud.hideStart && game.hud.hideStart();
          game.hud.showPause && game.hud.showPause(false);
        }
      } catch (e) {}
      try { game.rules.startMatch(game); } catch (e) { reportError('restart: ' + (e.stack || e.message)); }
      if (!AUTO) lockPointer();
    };
    game.callbacks.lockPointer = function () {
      game.paused = false;
      try { game.hud && game.hud.showPause && game.hud.showPause(false); } catch (e) {}
      lockPointer();
    };
    game.callbacks.requestPause = function () {
      game.paused = true;
      try { if (CS.audio && CS.audio.suspend) CS.audio.suspend(); } catch (e) {}
      try { if (doc.pointerLockElement) doc.exitPointerLock(); } catch (e) {}
    };
  }

  /* ------------------------------ input -------------------------------- */
  var ACTION_KEYS = {
    KeyR: 'reload', KeyB: 'buy', KeyE: 'interact', KeyQ: 'switchLast',
    Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3'
  };

  function clearHeldInput() {
    game.input.keys = {};
    game.input.mouseDown = false;
    game.input.rightDown = false;
    game.input.pressed = {};
  }

  function setupInput() {
    /* WebAudio needs a real user gesture: hook the first one (matters for ?auto=1) */
    var audioGestureDone = false;
    function firstGesture() {
      if (audioGestureDone) return;
      audioGestureDone = true;
      try {
        if (CS.audio && CS.audio.init) CS.audio.init();
        if (CS.audio && CS.audio.setVolume) CS.audio.setVolume(game.settings.volume);
        if (CS.audio && CS.audio.resume) CS.audio.resume();
      } catch (e) {}
    }
    window.addEventListener('pointerdown', firstGesture, true);
    window.addEventListener('keydown', firstGesture, true);

    window.addEventListener('keydown', function (e) {
      var code = e.code;
      game.input.keys[code] = true;
      if (!e.repeat) {
        var act = ACTION_KEYS[code];
        if (act) game.input.pressed[act] = true;
        if (code === 'Space') game.input.pressed.jump = true;
        if (code === 'Escape') {
          game.input.pressed.pause = true;
          /* fallback: if the pointer wasn't locked, Esc should still pause */
          if (game.started && !AUTO && !doc.pointerLockElement && !game.paused) {
            var blockedNow = false;
            try { blockedNow = !!(game.hud && game.hud.isBlockingInput && game.hud.isBlockingInput()); } catch (err) {}
            if (!blockedNow) {
              game.paused = true;
              try { game.hud && game.hud.showPause && game.hud.showPause(true); } catch (err2) {}
            }
          }
        }
      }
      if (game.started && (code === 'Tab' || code === 'Space' ||
          code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight')) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', function (e) {
      game.input.keys[e.code] = false;
    });
    window.addEventListener('blur', function () {
      clearHeldInput();
    });

    window.addEventListener('mousemove', function (e) {
      if (doc.pointerLockElement === game.canvas) {
        game.input.mouseDX += e.movementX || 0;
        game.input.mouseDY += e.movementY || 0;
      }
    });

    window.addEventListener('mousedown', function (e) {
      if (!game.started) return;
      if (game.hud && game.hud.isBlockingInput && game.hud.isBlockingInput()) return;
      var locked = doc.pointerLockElement === game.canvas;
      if (e.button === 0) {
        if (!locked && !AUTO) {
          /* click on the world = re-acquire pointer lock, never fire */
          if (e.target === game.canvas) { game.paused = false; lockPointer(); }
          return;
        }
        game.input.mouseDown = true;
        game.input.pressed.fire = true;
      } else if (e.button === 2) {
        game.input.rightDown = true;
        game.input.rightPressed = true;
      }
    });
    window.addEventListener('mouseup', function (e) {
      if (e.button === 0) game.input.mouseDown = false;
      else if (e.button === 2) game.input.rightDown = false;
    });
    window.addEventListener('contextmenu', function (e) {
      if (game.started) e.preventDefault();
    });

    game.canvas.addEventListener('click', function () {
      if (!game.started || AUTO) return;
      if (game.hud && game.hud.isBlockingInput && game.hud.isBlockingInput()) return;
      if (!doc.pointerLockElement) { game.paused = false; lockPointer(); }
    });

    doc.addEventListener('pointerlockchange', function () {
      game.input.locked = doc.pointerLockElement === game.canvas;
      if (game.input.locked) {
        game.paused = false;
        try { if (CS.audio && CS.audio.resume) CS.audio.resume(); } catch (e) {}
        try { game.hud && game.hud.showPause && game.hud.showPause(false); } catch (e) {}
        return;
      }
      if (AUTO) { game.input.locked = true; return; }
      if (!game.started) return;
      clearHeldInput();
      var blocked = false;
      try { blocked = !!(game.hud && game.hud.isBlockingInput && game.hud.isBlockingInput()); } catch (e) {}
      if (blocked) return;
      game.paused = true;
      try { game.hud && game.hud.showPause && game.hud.showPause(true); } catch (e) {}
    });
    doc.addEventListener('pointerlockerror', function () {
      console.warn('pointer lock request failed, click the canvas to retry');
      try { game.hud && game.hud.toast && game.hud.toast('鼠标锁定失败，点击画面重试'); } catch (e) {}
    });
    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden && doc.pointerLockElement) {
        try { doc.exitPointerLock(); } catch (e) {}
      }
    });
  }

  /* -------------------------------- loop ------------------------------- */
  var last = 0;

  function frame(now) {
    if (!game.running) return;
    requestAnimationFrame(frame);
    if (!last) last = now;
    var dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.05) dt = 0.05;
    game.dt = dt;
    game.time += dt;
    game.frame++;

    if (FAST > 1) {
      /* headless logic tests: run several fixed update steps per rendered frame */
      for (var fi = 0; fi < FAST; fi++) {
        game.dt = 1 / 60;
        game.time += 1 / 60;
        try { step(1 / 60); } catch (e) { reportError('step: ' + (e.stack || e.message)); }
        try { dispatchEvents(); } catch (e) { reportError('events: ' + (e.stack || e.message)); }
      }
    } else {
      try { step(dt); } catch (e) { reportError('step: ' + (e.stack || e.message)); }
      try { dispatchEvents(); } catch (e) { reportError('events: ' + (e.stack || e.message)); }
    }
    try { draw(dt); } catch (e) { reportError('draw: ' + (e.stack || e.message)); }
    try { if (game.hud && game.hud.update) game.hud.update(game, dt); } catch (e) { reportError('hud: ' + (e.stack || e.message)); }

    if (SELFTEST && !selfTestDone && game.time >= SELFTEST_TIME) {
      selfTestDone = true;
      writeSelfTest();
    }

    game.input.mouseDX = 0;
    game.input.mouseDY = 0;
    game.input.pressed = {};
    game.input.rightPressed = false;
  }

  function step(dt) {
    var blocked = false;
    try { blocked = !!(game.hud && game.hud.isBlockingInput && game.hud.isBlockingInput()); } catch (e) {}
    game.active = !!(game.started && !game.paused && !blocked);
    if (!game.active) return;

    if (game.player && game.player.update) game.player.update(game, dt);
    if (CS.bots && CS.bots.update) CS.bots.update(game, dt);
    if (game.rules && game.rules.update) game.rules.update(game, dt);
    if (game.fx && game.fx.update) game.fx.update(dt);
    if (SELFTEST) selftestInput();

    try {
      if (game.audio && game.audio.setListener && game.player) {
        var eye = game.player.eye ? game.player.eye() : game.player.pos;
        game.audio.setListener(eye, game.player.yaw);
      }
    } catch (e) {}
  }

  function dispatchEvents() {
    var list = game.events;
    if (!list || !list.length) return;
    game.events = [];
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      if (!ev || !ev.type) continue;
      if (game.rules && game.rules.onEvent) {
        try { game.rules.onEvent(ev); } catch (e) { reportError('rules.event ' + e.message); }
      }
      if (game.hud && game.hud.onEvent) {
        try { game.hud.onEvent(ev); } catch (e) { reportError('hud.event ' + e.message); }
      }
      if (game.audio && game.audio.onEvent) {
        try { game.audio.onEvent(ev); } catch (e) { reportError('audio.event ' + e.message); }
      }
      if (ev.type === 'matchEnd') {
        try { game.hud && game.hud.showMatchEnd && game.hud.showMatchEnd(ev.winner); } catch (e) {}
        game.callbacks.requestPause();
      }
    }
  }

  /* ------------------------ headless selftest hooks -------------------- */
  function round3(v) {
    if (!v) return null;
    return [Math.round(v[0] * 100) / 100, Math.round(v[1] * 100) / 100, Math.round(v[2] * 100) / 100];
  }

  function selftestInput() {
    var t = game.time;
    if (t > 0.4 && t < 2.0) game.input.keys['KeyW'] = true;
    else game.input.keys['KeyW'] = false;
    if (t > 2.0 && t < 3.2) {
      game.input.mouseDown = true;
      game.input.pressed.fire = true;
    } else if (t > 3.2) {
      game.input.mouseDown = false;
    }
    if (t > 2.0 && game.player) game.player.yaw += 0.0025;
  }

  function writeSelfTest() {
    var el = doc.getElementById('dsh-selftest');
    if (!el) return;
    var st = (game.rules && game.rules.state) || {};
    var botInfo = [];
    (game.bots || []).forEach(function (b) {
      botInfo.push({
        n: b.name, t: b.team, alive: !!b.alive,
        hp: Math.round(b.health || 0), st: b.state || '',
        pos: round3(b.pos)
      });
    });
    var data = {
      ok: errors.length === 0,
      errors: errors.slice(0, 8),
      time: +game.time.toFixed(2),
      started: game.started,
      frozen: game.frozen,
      phase: st.phase,
      round: st.round,
      score: st.score,
      money: st.money,
      active: game.active,
      player: game.player ? (function () {
        var def = null;
        try { def = game.player.currentDef ? game.player.currentDef() : null; } catch (e) {}
        var wid = def && def.id ? def.id : game.player.current;
        var am = null;
        try { am = game.player.ammo && wid ? game.player.ammo[wid] : null; } catch (e) {}
        return {
          alive: !!game.player.alive,
          hp: Math.round(game.player.health || 0),
          armor: Math.round(game.player.armor || 0),
          pos: round3(game.player.pos),
          weapon: wid || null,
          ammo: am || null,
          spread: +(game.player.crosshairSpread || 0).toFixed(3),
          kills: game.player.kills || 0
        };
      })() : null,
      bots: botInfo,
      renderer: game.renderer && game.renderer.stats ? game.renderer.stats : null,
      worldMeshes: game.world && game.world.meshes ? game.world.meshes.length : null
    };
    try { el.textContent = JSON.stringify(data); } catch (e) {}
  }

  /* ------------------------------- render ------------------------------ */
  var menuAngle = 0;

  function menuCamera(dt) {
    menuAngle += dt * 0.045;
    var eye = [Math.cos(menuAngle) * 29, 25.5 + Math.sin(game.time * 0.25) * 0.8, Math.sin(menuAngle) * 29];
    var target = [0, 0.5, 0];
    var f = M.V3.norm(M.V3.sub(target, eye));
    return {
      eye: eye,
      yaw: Math.atan2(f[0], -f[2]),
      pitch: Math.asin(M.clamp(f[1], -1, 1)),
      fov: 62
    };
  }

  function draw(dt) {
    var r = game.renderer;
    if (!r || NORENDER) return;
    r.resize();

    var cam;
    if (MAPVIEW) {
      cam = { eye: [0, 42, 42], yaw: 0, pitch: -0.75, fov: 62 };
    } else if (!game.started || !game.player) {
      cam = menuCamera(dt);
    } else {
      var p = game.player;
      var eye = (p.eye ? p.eye() : p.pos).slice(0, 3);
      var yaw = p.yaw || 0;
      var pitch = p.pitch || 0;
      var fov = p.fov || game.settings.fov || 90;
      if (!p.alive) { eye[1] -= 0.75; pitch = Math.min(pitch, -0.15); }
      cam = { eye: eye, yaw: yaw, pitch: pitch, fov: fov };
    }

    r.setCamera(cam.eye, cam.yaw, cam.pitch, cam.fov);
    r.beginFrame();
    try { game.world.render(r); } catch (e) { reportError('world.render: ' + e.message); }
    if (game.started) {
      try { if (CS.bots && CS.bots.render) CS.bots.render(game); } catch (e) { reportError('bots.render: ' + e.message); }
      if (game.player && game.player.alive && game.player.renderViewmodel) {
        try { game.player.renderViewmodel(r); } catch (e) { reportError('viewmodel: ' + e.message); }
      }
    }
    try { if (game.fx && game.fx.render) game.fx.render(r); } catch (e) { reportError('fx.render: ' + e.message); }
    r.endFrame();
  }

  /* ------------------------------- start ------------------------------- */
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
