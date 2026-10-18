/* =========================================================================
 * DUST STRIKE — procedural WebAudio sound engine (CS.audio)
 *
 * Public API (CONTRACT.md §7):
 *   CS.audio.init()                 create AudioContext (first user gesture)
 *   CS.audio.play(name, opts)       opts: {pos:[x,y,z], volume:1, rate:1}
 *   CS.audio.onEvent(event)         consume game events (CONTRACT §15)
 *   CS.audio.setListener(pos, yaw)  update listener for spatialisation
 *   CS.audio.setVolume(0..1)
 *   CS.audio.suspend(); CS.audio.resume();
 *
 * Every sound is synthesized with oscillators + a reuseable white-noise buffer,
 * biquad filters and gain envelopes. No external audio files are used.
 * If WebAudio is unavailable / blocked by autoplay policy everything silently
 * degrades to no-ops (never throws).
 * ========================================================================= */
(function () {
  'use strict';

  var CS = window.CS = window.CS || {};
  var A = CS.audio = CS.audio || {};

  /* ------------------------------------------------------------------ */
  /* state                                                              */
  /* ------------------------------------------------------------------ */
  var ctx = null;              // AudioContext
  var master = null;           // master gain (volume slider)
  var comp = null;             // dynamics compressor, tames overlapping shots
  var noiseBuf = null;         // 2s mono white noise, reused by every voice
  var ready = false;           // context usable
  var dead = false;            // AudioContext unavailable -> stay silent
  var volume = 0.8;
  var listenerPos = [0, 0, 0];
  var listenerYaw = 0;
  var voiceCount = 0;
  var VOICE_LIMIT = 40;        // drop new voices beyond this to avoid crackle
  var lastPlayAt = Object.create(null);

  var SHOT_SOUND = {
    ak47: 'ak47', m4a1: 'm4a1', awp: 'awp', glock: 'glock', usp: 'usp',
    knife: 'knife_swing'
  };

  var BASE_VOLUME = {
    ak47: 0.85, m4a1: 0.8, awp: 1.0, glock: 0.55, usp: 0.5,
    knife_swing: 0.45, knife_hit: 0.6,
    reload_start: 0.45, reload_end: 0.5, switch: 0.4, empty: 0.5,
    step: 0.35, hit: 0.55, headshot: 0.65, hurt: 0.85,
    kill_confirm: 0.5, round_start: 0.6, win: 0.7, lose: 0.7,
    buy: 0.55, beep: 0.5, tick: 0.3
  };

  /* same-name sounds closer than this are dropped (bot footsteps etc.) */
  var THROTTLE = {
    step: 0.05, hit: 0.02, headshot: 0.02, knife_hit: 0.02,
    reload_start: 0.04, reload_end: 0.04, switch: 0.04, empty: 0.07,
    beep: 0.05, tick: 0.07, buy: 0.06, round_start: 0.12, hurt: 0.06,
    knife_swing: 0.03
  };

  /* ------------------------------------------------------------------ */
  /* small helpers                                                      */
  /* ------------------------------------------------------------------ */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function now() { return ctx ? ctx.currentTime : 0; }

  function makeNoiseBuffer() {
    var seconds = 2;
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    var lp = 0;
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1;
      lp = lp * 0.72 + w * 0.28;              // one-pole low-passed layer
      var v = w * 0.7 + lp * 0.5;             // a touch of "pink" body
      data[i] = v > 1 ? 1 : (v < -1 ? -1 : v);
    }
    return buf;
  }

  function ensureContext() {
    if (ready) return true;
    if (dead) return false;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { dead = true; return false; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 22;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      master.connect(comp);
      comp.connect(ctx.destination);
      noiseBuf = makeNoiseBuffer();
      ready = true;
      return true;
    } catch (err) {
      dead = true;
      ctx = null;
      ready = false;
      return false;
    }
  }

  /* Free the gain/pan nodes of one voice after it has finished. */
  function trackVoice(gainNode, panNode, duration) {
    voiceCount++;
    var ms = Math.max(140, (duration || 0.4) * 1000) + 220;
    setTimeout(function () {
      try { gainNode.disconnect(); } catch (e) {}
      if (panNode) { try { panNode.disconnect(); } catch (e) {} }
      voiceCount = Math.max(0, voiceCount - 1);
    }, ms);
  }

  /*
   * Build the output chain for one voice: positional volume attenuation +
   * StereoPanner for left/right, then into the master gain. Returns the node
   * the voice generators should connect into.
   */
  function voiceOut(pos, vol, duration) {
    var g = ctx.createGain();
    var finalVol = (vol == null ? 1 : vol);
    var pan = 0;
    if (pos && pos.length >= 3) {
      var dx = pos[0] - listenerPos[0];
      var dy = pos[1] - listenerPos[1];
      var dz = pos[2] - listenerPos[2];
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      /* clear within 8 m, very small beyond 40 m */
      var att = d <= 8 ? 1 : Math.max(0.03, 1 - (d - 8) / 32);
      att = att * att * 0.85 + att * 0.15;
      finalVol *= att;
      var hd = Math.sqrt(dx * dx + dz * dz);
      if (hd > 0.0001) {
        /* listener right vector for yaw convention: [cos(yaw),0,sin(yaw)] */
        var rx = Math.cos(listenerYaw), rz = Math.sin(listenerYaw);
        pan = clamp(((dx * rx + dz * rz) / hd), -1, 1) * 0.85;
      }
    }
    g.gain.value = Math.max(0.0001, finalVol);
    if (ctx.createStereoPanner) {
      var p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(master);
      trackVoice(g, p, duration);
    } else {
      g.connect(master);
      trackVoice(g, null, duration);
    }
    return g;
  }

  /* Short filtered noise burst. */
  function noiseBurst(out, t0, dur, gain, type, freq, freqEnd, q, rate) {
    if (!noiseBuf) return;
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    src.playbackRate.value = rate || 1;
    var f = ctx.createBiquadFilter();
    f.type = type || 'highpass';
    f.frequency.setValueAtTime(freq, t0);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), t0 + dur);
    f.Q.value = q || 0.9;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + Math.min(0.004, dur * 0.4));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t0, Math.random() * 1.6);
    src.stop(t0 + dur + 0.03);
  }

  /* Simple enveloped oscillator. */
  function tone(out, t0, type, freq, freqEnd, dur, gain, attack) {
    var osc = ctx.createOscillator();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(Math.max(20, freq), t0);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + (attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /* ------------------------------------------------------------------ */
  /* synthesisers                                                       */
  /* ------------------------------------------------------------------ */

  /*
   * Gunshot = low frequency "boom" (pitch-swept sine) + filtered noise blast
   * + short high transient (crack). Each weapon gets a different recipe.
   */
  function gunShot(t0, o, c) {
    var rate = clamp(o.rate || 1, 0.6, 1.6);
    var out = voiceOut(o.pos, o.volume, (c.noiseDur + (c.echoTail || 0) + 0.1));

    /* low thump */
    var osc = ctx.createOscillator();
    osc.type = c.wave || 'sine';
    var f0 = c.thump[0] * rate;
    var f1 = Math.max(20, c.thump[1] * rate);
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f1, t0 + c.thumpDur);
    var og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.exponentialRampToValueAtTime(Math.max(0.0002, c.thumpGain), t0 + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + c.thumpDur);
    osc.connect(og); og.connect(out);
    osc.start(t0); osc.stop(t0 + c.thumpDur + 0.03);

    /* noise blast */
    noiseBurst(out, t0, c.noiseDur, c.noiseGain, c.filter || 'lowpass',
      c.freq * rate, c.freqEnd * rate, c.q || 0.9, rate);

    /* high crack */
    if (c.crack) {
      noiseBurst(out, t0, 0.028, c.crack, 'highpass', 3200 * rate, 0, 0.7, rate);
    }
    /* desert echo tail (AWP) */
    if (c.echo) {
      var et = t0 + 0.09;
      noiseBurst(out, et, c.echoDur || 0.3, c.echo, 'lowpass', 900 * rate, 240 * rate, 0.6, rate);
      tone(out, et, 'sine', 60 * rate, 34 * rate, c.echoDur || 0.3, 0.1);
    }
  }

  function sfx(name, t0, o) {
    var rate = clamp(o.rate || 1, 0.5, 2);
    var out;
    switch (name) {
      /* ---- weapons -------------------------------------------------- */
      case 'ak47': /* heavy, low */
        gunShot(t0, o, {
          thump: [108, 36], thumpDur: 0.24, thumpGain: 0.95, wave: 'triangle',
          noiseDur: 0.28, noiseGain: 0.72, filter: 'lowpass', freq: 2100, freqEnd: 420,
          q: 0.8, crack: 0.34
        });
        break;
      case 'm4a1': /* crisp, brighter, less body */
        gunShot(t0, o, {
          thump: [155, 52], thumpDur: 0.14, thumpGain: 0.6, wave: 'triangle',
          noiseDur: 0.19, noiseGain: 0.58, filter: 'lowpass', freq: 3400, freqEnd: 760,
          q: 0.9, crack: 0.42
        });
        break;
      case 'awp': /* huge boom with echo */
        gunShot(t0, o, {
          thump: [72, 26], thumpDur: 0.5, thumpGain: 1.1, wave: 'sine',
          noiseDur: 0.55, noiseGain: 0.9, filter: 'lowpass', freq: 1200, freqEnd: 150,
          q: 0.7, crack: 0.5, echo: 0.22, echoDur: 0.34, echoTail: 0.34
        });
        break;
      case 'glock': /* snappy pistol */
        gunShot(t0, o, {
          thump: [190, 66], thumpDur: 0.11, thumpGain: 0.5, wave: 'triangle',
          noiseDur: 0.13, noiseGain: 0.42, filter: 'lowpass', freq: 3000, freqEnd: 800,
          q: 1.0, crack: 0.3
        });
        break;
      case 'usp': /* suppressed pistol */
        gunShot(t0, o, {
          thump: [215, 82], thumpDur: 0.09, thumpGain: 0.38, wave: 'sine',
          noiseDur: 0.12, noiseGain: 0.28, filter: 'lowpass', freq: 2400, freqEnd: 620,
          q: 1.2, crack: 0.18
        });
        break;

      /* ---- melee ---------------------------------------------------- */
      case 'knife_swing':
        out = voiceOut(o.pos, o.volume, 0.2);
        noiseBurst(out, t0, 0.16, 0.22, 'bandpass', 700 * rate, 2600 * rate, 1.6, rate);
        break;
      case 'knife_hit':
        out = voiceOut(o.pos, o.volume, 0.2);
        tone(out, t0, 'sine', 240, 70, 0.12, 0.4);
        noiseBurst(out, t0, 0.07, 0.3, 'bandpass', 1400, 500, 1.2, rate);
        noiseBurst(out, t0, 0.02, 0.2, 'highpass', 5200, 0, 0.8, rate);
        break;

      /* ---- handling ------------------------------------------------ */
      case 'reload_start':
        out = voiceOut(o.pos, o.volume, 0.3);
        noiseBurst(out, t0, 0.03, 0.24, 'highpass', 2600, 0, 1.4, rate);
        noiseBurst(out, t0 + 0.10, 0.05, 0.2, 'bandpass', 900, 500, 1.2, rate);
        tone(out, t0 + 0.10, 'square', 130, 90, 0.05, 0.06);
        break;
      case 'reload_end':
        out = voiceOut(o.pos, o.volume, 0.3);
        noiseBurst(out, t0, 0.025, 0.28, 'highpass', 3400, 0, 1.4, rate);
        noiseBurst(out, t0 + 0.06, 0.03, 0.22, 'highpass', 2400, 0, 1.2, rate);
        tone(out, t0 + 0.06, 'square', 180, 120, 0.04, 0.07);
        break;
      case 'switch':
        out = voiceOut(o.pos, o.volume, 0.25);
        noiseBurst(out, t0, 0.08, 0.16, 'bandpass', 1200, 2800, 1.2, rate);
        noiseBurst(out, t0 + 0.07, 0.02, 0.24, 'highpass', 3600, 0, 1.2, rate);
        break;
      case 'empty':
        out = voiceOut(o.pos, o.volume, 0.2);
        noiseBurst(out, t0, 0.02, 0.34, 'highpass', 4200, 0, 1.5, rate);
        tone(out, t0, 'square', 92, 60, 0.04, 0.12);
        break;

      /* ---- movement / combat feedback ------------------------------ */
      case 'step':
        out = voiceOut(o.pos, o.volume, 0.18);
        noiseBurst(out, t0, 0.075, 0.14, 'lowpass', 430 * rate, 160 * rate, 0.9, rate);
        tone(out, t0, 'sine', 95 * rate, 55 * rate, 0.07, 0.06);
        break;
      case 'hit': /* bullet hitting a body */
        out = voiceOut(o.pos, o.volume, 0.2);
        tone(out, t0, 'sine', 190, 62, 0.1, 0.38);
        noiseBurst(out, t0, 0.08, 0.22, 'lowpass', 700, 260, 0.9, rate);
        break;
      case 'headshot':
        out = voiceOut(o.pos, o.volume, 0.35);
        tone(out, t0, 'sine', 1520, 1790, 0.07, 0.2);
        tone(out, t0 + 0.035, 'triangle', 2380, 2520, 0.1, 0.15);
        noiseBurst(out, t0, 0.025, 0.16, 'highpass', 5000, 0, 0.8, rate);
        tone(out, t0, 'sine', 170, 60, 0.1, 0.3);
        break;
      case 'hurt': /* player hurt grunt */
        out = voiceOut(o.pos, o.volume, 0.5);
        tone(out, t0, 'sawtooth', 170 * rate, 82 * rate, 0.3, 0.16);
        tone(out, t0 + 0.1, 'sawtooth', 130 * rate, 70 * rate, 0.22, 0.1);
        noiseBurst(out, t0, 0.2, 0.14, 'lowpass', 520, 220, 0.8, rate);
        break;
      case 'kill_confirm':
        out = voiceOut(null, o.volume, 0.3);
        tone(out, t0, 'triangle', 880, 0, 0.06, 0.16);
        tone(out, t0 + 0.075, 'triangle', 1320, 0, 0.09, 0.14);
        break;

      /* ---- match flow ---------------------------------------------- */
      case 'round_start': /* two beeps */
        out = voiceOut(null, o.volume, 0.4);
        tone(out, t0, 'triangle', 660, 0, 0.09, 0.18);
        tone(out, t0 + 0.15, 'triangle', 990, 0, 0.12, 0.18);
        break;
      case 'win':
        out = voiceOut(null, o.volume, 1.0);
        (function () {
          var notes = [523.25, 659.25, 783.99, 1046.5];
          for (var i = 0; i < notes.length; i++) {
            tone(out, t0 + i * 0.11, 'triangle', notes[i], 0, 0.18, 0.18);
            tone(out, t0 + i * 0.11, 'sine', notes[i] * 2, 0, 0.12, 0.06);
          }
        })();
        break;
      case 'lose':
        out = voiceOut(null, o.volume, 1.1);
        (function () {
          var notes = [392, 329.63, 261.63, 196];
          for (var i = 0; i < notes.length; i++) {
            tone(out, t0 + i * 0.14, 'sawtooth', notes[i], 0, 0.22, 0.1);
          }
          tone(out, t0 + 0.56, 'sine', 98, 0, 0.45, 0.12);
        })();
        break;
      case 'buy':
        out = voiceOut(null, o.volume, 0.4);
        noiseBurst(out, t0, 0.02, 0.24, 'highpass', 3200, 0, 1.2, rate);
        tone(out, t0 + 0.02, 'triangle', 1180, 0, 0.06, 0.16);
        tone(out, t0 + 0.08, 'triangle', 1560, 0, 0.09, 0.14);
        break;
      case 'beep':
        out = voiceOut(null, o.volume, 0.2);
        tone(out, t0, 'square', 880, 0, 0.09, 0.14);
        break;
      case 'tick':
        out = voiceOut(null, o.volume, 0.1);
        noiseBurst(out, t0, 0.02, 0.18, 'highpass', 2600, 0, 1.2, rate);
        tone(out, t0, 'square', 1500, 0, 0.025, 0.06);
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* public API                                                         */
  /* ------------------------------------------------------------------ */

  A.init = function () {
    if (dead) return ctx;
    if (!ensureContext()) return null;
    try {
      if (ctx.state === 'suspended') {
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {}
    return ctx;
  };

  A.play = function (name, opts) {
    opts = opts || {};
    if (!name || dead) return;
    if (!ready) { if (!A.init()) return; }
    if (!ready) return;
    /* Only schedule voices while the context is actually running: queueing
       dozens of sources on a suspended context would make them all fire in a
       burst the moment the user gesture unlocks audio. */
    if (ctx.state !== 'running') {
      if (ctx.state === 'suspended') {
        try {
          var pr0 = ctx.resume();
          if (pr0 && pr0.catch) pr0.catch(function () {});
        } catch (e0) {}
      }
      return;
    }
    if (voiceCount > VOICE_LIMIT) return;
    var t = A._testNow ? A._testNow() : now();
    var gap = THROTTLE[name];
    if (gap) {
      var last = lastPlayAt[name] || 0;
      if (t - last < gap) return;
      lastPlayAt[name] = t;
    }
    var base = BASE_VOLUME.hasOwnProperty(name) ? BASE_VOLUME[name] : 0.5;
    var vol = base * (opts.volume == null ? 1 : clamp(opts.volume, 0, 2));
    var rate = opts.rate == null ? 1 : opts.rate;
    try {
      /* resume lazily if a user gesture gave permission earlier */
      if (ctx.state === 'suspended') {
        var pr = ctx.resume();
        if (pr && pr.catch) pr.catch(function () {});
      }
      sfx(name, now() + 0.005, { pos: opts.pos, volume: vol, rate: rate });
    } catch (err) {
      /* never let audio break the game */
    }
  };

  A.onEvent = function (ev) {
    if (!ev || dead) return;
    var g = CS.game || null;
    var player = g && g.player ? g.player : null;
    try {
      switch (ev.type) {
        case 'shot': {
          var snd = SHOT_SOUND[ev.weapon] || 'ak47';
          A.play(snd, {
            pos: ev.pos,
            volume: ev.byPlayer ? 1 : 0.8,
            rate: 0.94 + Math.random() * 0.12
          });
          break;
        }
        case 'step':
          A.play('step', {
            pos: ev.pos,
            volume: ev.byPlayer ? 0.4 : 0.7,
            rate: 0.85 + Math.random() * 0.3
          });
          break;
        case 'damage': {
          if (!player || !ev.target) break;
          if (ev.target === player) {
            A.play('hurt', { volume: 0.9, rate: 0.92 + Math.random() * 0.12 });
          } else if (ev.attacker === player) {
            A.play(ev.zone === 'head' ? 'headshot' : 'hit', { volume: 0.9 });
          }
          break;
        }
        case 'kill': {
          if (!player) break;
          if (ev.killer === player) {
            A.play('kill_confirm', { volume: 0.9 });
          } else if (ev.victim === player) {
            A.play('hurt', { volume: 0.8, rate: 0.72 });
          }
          break;
        }
        case 'roundStart':
          A.play('round_start', { volume: 0.7 });
          break;
        case 'roundEnd': {
          var winner = ev.winner;
          if (winner && typeof winner === 'object') winner = winner.team || winner.id;
          var myTeam = player ? player.team : 'ct';
          A.play(winner === myTeam ? 'win' : 'lose', { volume: 0.7 });
          break;
        }
        case 'buy':
          A.play(ev.ok === false ? 'tick' : 'buy', { volume: 0.6 });
          break;
        case 'empty':
          A.play('empty', { volume: 0.6 });
          break;
        default:
          break;
      }
    } catch (err) { /* keep silent on any audio error */ }
  };

  A.setListener = function (pos, yaw) {
    if (pos && pos.length >= 3) {
      listenerPos[0] = pos[0];
      listenerPos[1] = pos[1];
      listenerPos[2] = pos[2];
    }
    if (typeof yaw === 'number' && isFinite(yaw)) listenerYaw = yaw;
  };

  A.setVolume = function (v) {
    volume = clamp(typeof v === 'number' ? v : 0.8, 0, 1);
    if (master && ctx) {
      try {
        var t = now();
        master.gain.cancelScheduledValues(t);
        master.gain.setTargetAtTime(volume, t, 0.03);
      } catch (e) {
        try { master.gain.value = volume; } catch (e2) {}
      }
    }
    return volume;
  };

  A.suspend = function () {
    if (!ctx || !ready) return;
    try {
      if (ctx.state === 'running') {
        var p = ctx.suspend();
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {}
  };

  A.resume = function () {
    if (!ctx || !ready) return;
    try {
      if (ctx.state === 'suspended') {
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {}
  };

  A.isReady = function () { return ready; };
  A.isAvailable = function () { return !dead; };
  A.getVolume = function () { return volume; };

})();
