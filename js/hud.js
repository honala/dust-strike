/* =========================================================================
 * DUST STRIKE — DOM HUD / menus / crosshair (CS.hud)
 *
 * Public API (CONTRACT.md §13):
 *   CS.hud.init(game)  CS.hud.update(game, dt)  CS.hud.onEvent(event)
 *   CS.hud.showStart() CS.hud.hideStart()       CS.hud.reset()
 *   CS.hud.showPause(bool)                      CS.hud.isBuyMenuOpen()
 *   CS.hud.isBlockingInput()                    CS.hud.banner(title, sub, seconds)
 *   CS.hud.toast(msg)                           CS.hud.showMatchEnd(winner)
 *
 * Everything is programmatic: one injected <style> + DOM under #hud-root.
 * No external images / fonts / network requests.
 *
 * Input integration (agreed with Lead):
 *   - HUD reads game.input.pressed.buy / pressed.pause in update() (main fills
 *     them and clears pressed after hud.update()).
 *   - HUD reads game.input.keys['Tab'] (plus its own keydown/keyup fallback)
 *     for the hold-Tab scoreboard. Tab is preventDefault'ed.
 *   - While the buy menu is open HUD listens for Digit1..Digit4 itself; the
 *     game is paused at that moment so player weapon switching cannot fire.
 *   - Esc handling for the pause menu is main's job (pointerlockchange); HUD
 *     displays the pause menu from showPause(true) or from game.paused.
 *
 * CONTRACT-GAP: §13 does not name the buy item ids; using 'ak47'|'m4a1'|'awp'
 *   |'armor' per §12 rules.buy(). CONTRACT-GAP: callback signatures are not
 *   specified; the HUD only calls them with no arguments and tolerates missing
 *   callbacks. CONTRACT-GAP: player.currentDef() is optional in §10 so HUD
 *   falls back to player.def / CS.weapons.defs[player.current].
 * ========================================================================= */
(function () {
  'use strict';

  var CS = window.CS = window.CS || {};
  var H = CS.hud = CS.hud || {};

  /* ------------------------------------------------------------------ */
  /* constants                                                          */
  /* ------------------------------------------------------------------ */
  var BUY_ORDER = ['ak47', 'm4a1', 'awp', 'armor'];
  var BUY_META = {
    ak47: { name: 'AK-47', cat: '步枪 · 高伤害' },
    m4a1: { name: 'M4A1-S', cat: '步枪 · 消音精准' },
    awp: { name: 'AWP', cat: '狙击步枪 · 一击致命' },
    armor: { name: '护甲 + 头盔', cat: '装备 · 护甲 100' }
  };
  var FALLBACK_PRICE = { ak47: 2700, m4a1: 2900, awp: 4750, armor: 650 };
  var MAX_KILL_FEED = 5;
  var KILL_FEED_LIFE = 5.0;
  var TARGET_SCORE = 8;

  /* ------------------------------------------------------------------ */
  /* module state                                                       */
  /* ------------------------------------------------------------------ */
  var game = null;
  var root = null;
  var inited = false;
  var refs = Object.create(null);
  var buyCardEls = [];
  var feed = [];                       // [{el, until, fading}]
  var timer = { bannerUntil: 0, toastUntil: 0 };
  var deathInfo = { killer: '', weapon: '', headshot: false };
  var ownTabHeld = false;
  var scoreboardDirty = true;
  var lastSbBuild = -1;
  var suppressBuyToastUntil = 0;
  var pauseSuppressUntil = 0;   // grace period after re-locking the pointer
  var lastGap = -1;
  var lastMoney = null;
  var deadShown = false;
  var autoMode = false;
  var hideuiMode = false;

  var flags = {
    startOpen: true,
    pauseOpen: false,
    buyOpen: false,
    matchEndOpen: false,
    scoreboardHeld: false,
    started: false
  };

  /* ------------------------------------------------------------------ */
  /* tiny helpers                                                       */
  /* ------------------------------------------------------------------ */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function nowSec() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }
  function $(id) { return refs[id] || (refs[id] = document.getElementById(id)); }
  function setText(node, value) {
    if (!node) return;
    var s = value == null ? '' : String(value);
    if (node.textContent !== s) node.textContent = s;
  }
  function setShown(node, on) {
    if (!node) return;
    var v = !!on;
    if (node.__shown === v) return;
    node.__shown = v;
    node.style.display = v ? '' : 'none';
  }
  function toggleClass(node, cls, on) {
    if (!node) return;
    var has = node.classList.contains(cls);
    if (on && !has) node.classList.add(cls);
    else if (!on && has) node.classList.remove(cls);
  }
  function setBar(fill, pct) {
    if (!fill) return;
    var w = clamp(pct, 0, 100).toFixed(1) + '%';
    if (fill.__w !== w) { fill.__w = w; fill.style.width = w; }
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtTime(sec) {
    if (typeof sec !== 'number' || !isFinite(sec)) return '0:00';
    sec = Math.max(0, Math.ceil(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function callCallback(name) {
    if (!game || !game.callbacks) return false;
    var fn = game.callbacks[name];
    if (typeof fn !== 'function') return false;
    try { fn(); return true; } catch (err) {
      if (window.console) console.error('[hud] callback "' + name + '" threw:', err);
      return false;
    }
  }
  function input() { return (game && game.input) || {}; }
  function rulesState() {
    if (!game) return null;
    var rules = game.rules || CS.rules;
    return (rules && rules.state) || null;
  }
  function playerTeam() {
    return (game && game.player && game.player.team) || 'ct';
  }
  function displayName(obj) {
    if (!obj) return '世界';
    return obj.name || obj.id || '士兵';
  }
  function weaponName(id) {
    if (!id) return '—';
    var defs = CS.weapons && CS.weapons.defs;
    if (defs && defs[id] && defs[id].name) return defs[id].name;
    var fallback = {
      ak47: 'AK-47', m4a1: 'M4A1-S', awp: 'AWP', glock: 'Glock-18', usp: 'USP-S',
      knife: '匕首', armor: '护甲'
    };
    return fallback[id] || String(id).toUpperCase();
  }
  function buyPrice(id) {
    if (id === 'armor') return 650;
    var defs = CS.weapons && CS.weapons.defs;
    if (defs && defs[id] && typeof defs[id].price === 'number') return defs[id].price;
    return FALLBACK_PRICE[id] || 0;
  }
  function itemName(id) {
    var defs = CS.weapons && CS.weapons.defs;
    if (defs && defs[id] && defs[id].name) return defs[id].name;
    return (BUY_META[id] && BUY_META[id].name) || id;
  }
  function playerDef(player) {
    if (!player) return null;
    if (typeof player.currentDef === 'function') {
      try { var d = player.currentDef(); if (d) return d; } catch (e) {}
    }
    if (player.def && typeof player.def === 'object') return player.def;
    var defs = CS.weapons && CS.weapons.defs;
    var id = player.current;
    if (defs && id && defs[id]) return defs[id];
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* style injection                                                    */
  /* ------------------------------------------------------------------ */
  var CSS = `
  .ds-hud, .ds-hud * { box-sizing: border-box; }
  .ds-hud {
    position: absolute; inset: 0; overflow: hidden; pointer-events: none;
    font-family: "Microsoft YaHei", "Segoe UI", system-ui, -apple-system, sans-serif;
    color: #e8e2d4; user-select: none; -webkit-user-select: none;
    --sand: #d8bd86; --sand-bright: #f0d593; --orange: #e8873a; --orange-hot: #ff9b3d;
    --panel: rgba(13,14,15,.94); --line: rgba(216,189,134,.3);
    --ct: #cfe0f2; --t: #e8a35c; --red: #d94a35; --green: #9ad06a;
    --mono: Consolas, "Courier New", monospace;
    z-index: 10;
  }
  .ds-hud button { font-family: inherit; }
  .ds-hud button:focus { outline: none; }
  .ds-hud button:focus-visible { outline: 1px solid var(--orange-hot); outline-offset: 2px; }

  /* ---------------- gameplay layer ---------------- */
  .ds-game { position: absolute; inset: 0; }

  /* top score / timer */
  .ds-top {
    position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 1px;
    text-shadow: 0 1px 3px rgba(0,0,0,.9); z-index: 5;
  }
  .ds-score-row {
    display: flex; align-items: center; gap: 18px;
    padding: 5px 34px 6px;
    background: linear-gradient(90deg, rgba(8,9,10,0), rgba(8,9,10,.72) 16%, rgba(8,9,10,.72) 84%, rgba(8,9,10,0));
    border-top: 1px solid rgba(216,189,134,.32);
    border-bottom: 1px solid rgba(216,189,134,.2);
    min-width: 330px; justify-content: center;
  }
  .ds-team { display: flex; align-items: baseline; gap: 8px; min-width: 68px; }
  .ds-team.ds-ct { justify-content: flex-end; color: var(--ct); }
  .ds-team.ds-t { justify-content: flex-start; color: var(--t); }
  .ds-team-tag {
    font: 700 11px/1 var(--mono); letter-spacing: 2px; opacity: .85;
    padding: 2px 4px; border: 1px solid currentColor; border-radius: 2px;
  }
  .ds-score { font: 800 30px/1 var(--mono); letter-spacing: 1px; color: #f3ede0; }
  .ds-timer-wrap { display: flex; flex-direction: column; align-items: center; min-width: 112px; }
  .ds-timer {
    font: 700 29px/1.05 var(--mono); letter-spacing: 2px; color: #f3ede0;
    font-variant-numeric: tabular-nums;
  }
  .ds-timer.warn { color: var(--orange-hot); text-shadow: 0 0 14px rgba(232,135,58,.75); }
  .ds-timer.buy { color: var(--sand-bright); }
  .ds-round { font-size: 11px; letter-spacing: 2px; color: #b7a888; margin-top: 3px; white-space: nowrap; }
  .ds-phase { font-size: 11px; letter-spacing: 2px; color: #a99d84; margin-top: 2px; text-shadow: 0 1px 3px rgba(0,0,0,.9); }

  /* kill feed */
  .ds-killfeed {
    position: absolute; top: 96px; right: 22px;
    display: flex; flex-direction: column; gap: 5px; align-items: flex-end;
    width: 320px; z-index: 5;
  }
  .ds-kf {
    display: flex; align-items: center; gap: 8px; justify-content: flex-end;
    padding: 4px 10px; min-width: 186px;
    background: rgba(8,9,10,.66); border-left: 3px solid rgba(216,189,134,.5);
    font-size: 13px; letter-spacing: .5px; white-space: nowrap;
    transition: opacity .45s ease, transform .45s ease;
    text-shadow: 0 1px 2px rgba(0,0,0,.9);
  }
  .ds-kf.ct { border-left-color: #7fa7d8; }
  .ds-kf.t { border-left-color: #d9a05b; }
  .ds-kf.fade { opacity: 0; transform: translateX(16px); }
  .ds-kf-k { color: #dfe7f2; font-weight: 700; }
  .ds-kf.t .ds-kf-k { color: #f0c08a; }
  .ds-kf-w { color: var(--sand); font: 600 11px/1 var(--mono); letter-spacing: .5px; }
  .ds-kf-hs {
    font: 700 9px/1 var(--mono); color: #ffd9a0; background: #b33a22;
    padding: 2px 3px; border-radius: 2px; letter-spacing: 0;
  }
  .ds-kf-v { color: #b9b09d; }
  .ds-kf.you-victim .ds-kf-v { color: #ff7c62; font-weight: 700; }
  .ds-kf.you-killer { border-left-color: var(--orange); }

  /* bottom left vitals */
  .ds-vitals {
    position: absolute; left: 24px; bottom: 20px; width: 272px;
    display: flex; flex-direction: column; gap: 3px; z-index: 5;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,.95)) drop-shadow(0 0 6px rgba(0,0,0,.55));
  }
  .ds-money {
    font: 700 22px/1.1 var(--mono); color: var(--sand-bright);
    letter-spacing: 1px; margin-bottom: 5px;
    text-shadow: 0 0 3px #000, 0 2px 5px rgba(0,0,0,.95);
    transition: color .2s;
  }
  .ds-money.up { color: #c6ef94; }
  .ds-money.down { color: #ff9a7c; }
  .ds-vrow { display: flex; align-items: baseline; justify-content: space-between; }
  .ds-vlabel {
    font-size: 10px; letter-spacing: 3px; color: #d2c6aa;
    text-shadow: 0 0 2px #000, 0 1px 3px rgba(0,0,0,.95);
  }
  .ds-vnum {
    font: 800 28px/1 var(--mono); color: #fbf8f0; letter-spacing: .5px;
    text-shadow: 0 0 3px #000, 0 1px 4px rgba(0,0,0,.95);
  }
  .ds-vnum.low { color: #ff6a4d; text-shadow: 0 0 12px rgba(217,74,53,.85), 0 0 3px #000; }
  .ds-vnum.ds-armor-num { font-size: 17px; color: #9fc0e0; margin-top: 1px; }
  .ds-bar {
    height: 6px; width: 100%; margin: 2px 0 4px;
    background: rgba(0,0,0,.62); border: 1px solid rgba(216,189,134,.3);
    box-shadow: 0 1px 3px rgba(0,0,0,.6);
  }
  .ds-bar i { display: block; height: 100%; width: 0; transition: width .12s linear; }
  .ds-hpbar i { background: linear-gradient(90deg, #85b95d, #cfe6a4); }
  .ds-hpbar.low i { background: linear-gradient(90deg, #a3301f, #ff6a4d); }
  .ds-armorbar i { background: linear-gradient(90deg, #587ea8, #a8c8e8); }

  /* bottom right ammo */
  .ds-ammo {
    position: absolute; right: 26px; bottom: 20px; text-align: right;
    min-width: 200px; z-index: 5;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,.95)) drop-shadow(0 0 6px rgba(0,0,0,.5));
  }
  .ds-weapon {
    font-size: 13px; letter-spacing: 3px; color: var(--sand); font-weight: 700;
    text-transform: uppercase; margin-bottom: 2px;
    text-shadow: 0 0 3px #000, 0 1px 3px rgba(0,0,0,.95);
  }
  .ds-ammo-row { display: flex; align-items: baseline; justify-content: flex-end; gap: 4px; }
  .ds-mag {
    font: 800 44px/1 var(--mono); color: #fbf8f0; letter-spacing: 1px;
    text-shadow: 0 0 3px #000, 0 2px 5px rgba(0,0,0,.95);
  }
  .ds-ammo.low .ds-mag { color: #ff9a7c; }
  .ds-slash { font: 400 22px/1 var(--mono); color: #cfc3a6; text-shadow: 0 0 2px #000, 0 1px 3px rgba(0,0,0,.95); }
  .ds-reserve { font: 600 21px/1 var(--mono); color: #ded4ba; text-shadow: 0 0 2px #000, 0 1px 3px rgba(0,0,0,.95); }
  .ds-reload {
    font-size: 11px; letter-spacing: 3px; color: var(--orange-hot);
    margin-top: 4px; opacity: 0; transition: opacity .12s;
  }
  .ds-reload.on { opacity: 1; animation: dsBlink .8s ease-in-out infinite; }
  @keyframes dsBlink { 0%,100% { opacity: .35; } 50% { opacity: 1; } }

  /* buy hint */
  .ds-buytip {
    position: absolute; bottom: 15%; left: 50%; transform: translateX(-50%);
    font-size: 13px; letter-spacing: 2px; color: #d6c7a6;
    background: rgba(6,7,8,.55); border-top: 1px solid rgba(216,189,134,.25);
    border-bottom: 1px solid rgba(216,189,134,.12);
    padding: 6px 20px; opacity: 0; visibility: hidden; transition: opacity .2s;
    white-space: nowrap; z-index: 5;
  }
  .ds-buytip.show { opacity: 1; visibility: visible; }
  .ds-buytip b {
    color: var(--sand-bright); border: 1px solid rgba(216,189,134,.5);
    padding: 1px 5px; border-radius: 2px; font-family: var(--mono); font-size: 12px;
  }

  /* crosshair */
  .ds-crosshair {
    position: absolute; left: 50%; top: 50%; width: 0; height: 0;
    --gap: 6px; --len: 8px; z-index: 8;
  }
  .ds-crosshair.off { display: none; }
  .ds-crosshair .ch-line {
    position: absolute; background: #f2ffe8;
    box-shadow: 0 0 0 1px rgba(0,0,0,.72), 0 0 3px rgba(0,0,0,.9);
  }
  .ds-crosshair .ch-t { left: -1px; top: calc(-1 * (var(--gap) + var(--len))); width: 2px; height: var(--len); }
  .ds-crosshair .ch-b { left: -1px; top: var(--gap); width: 2px; height: var(--len); }
  .ds-crosshair .ch-l { top: -1px; left: calc(-1 * (var(--gap) + var(--len))); height: 2px; width: var(--len); }
  .ds-crosshair .ch-r { top: -1px; left: var(--gap); height: 2px; width: var(--len); }
  .ds-crosshair .ch-dot {
    position: absolute; left: -1px; top: -1px; width: 2px; height: 2px;
    background: #f2ffe8; box-shadow: 0 0 0 1px rgba(0,0,0,.7), 0 0 2px rgba(0,0,0,.9);
  }

  /* AWP scope overlay: black mask with a transparent circular lens + reticle.
     z-index 3 keeps it above the 3D canvas but below the HUD readouts (z 5+). */
  .ds-scope {
    position: absolute; inset: 0; z-index: 3; display: none;
    pointer-events: none; overflow: hidden;
    --scope: min(76vh, 76vw);
  }
  .ds-scope.on { display: block; }
  .ds-scope-lens {
    position: absolute; left: 50%; top: 50%; width: var(--scope); height: var(--scope);
    transform: translate(-50%, -50%); border-radius: 50%;
    border: 2px solid rgba(0,0,0,.94);
    box-shadow: 0 0 0 9999px rgba(0,0,0,.968), 0 0 0 4px rgba(0,0,0,.6),
      inset 0 0 110px rgba(0,0,0,.62);
  }
  .ds-scope-lens::after {
    content: ""; position: absolute; inset: 4px; border-radius: 50%;
    box-shadow: inset 0 0 0 1px rgba(0,0,0,.8), inset 0 0 34px rgba(0,0,0,.5);
  }
  .ds-scope-vignette {
    position: absolute; inset: 0; border-radius: 50%;
    background: radial-gradient(circle at 50% 50%,
      rgba(0,0,0,0) 52%, rgba(0,0,0,.16) 74%, rgba(0,0,0,.58) 100%);
  }
  .ds-scope-ret i { position: absolute; background: rgba(8,8,8,.94); }
  .ds-scope-ret .l { left: 13%; width: 33%; top: calc(50% - 1px); height: 2px; }
  .ds-scope-ret .r { left: 54%; width: 33%; top: calc(50% - 1px); height: 2px; }
  .ds-scope-ret .t { top: 13%; height: 33%; left: calc(50% - 1px); width: 2px; }
  .ds-scope-ret .b { top: 54%; height: 33%; left: calc(50% - 1px); width: 2px; }
  .ds-scope-ret .dot {
    left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px;
    border-radius: 50%; background: rgba(8,8,8,.95);
  }

  /* hitmarker */
  .ds-hitmarker { position: absolute; left: 50%; top: 50%; width: 0; height: 0; z-index: 9; opacity: 0; }
  .ds-hitmarker i {
    position: absolute; width: 12px; height: 2px;
    background: #f4faef; box-shadow: 0 0 3px rgba(0,0,0,.9), 0 0 0 1px rgba(0,0,0,.4);
  }
  .ds-hitmarker i:nth-child(1) { left: 6px; top: 6px; transform: rotate(45deg); }
  .ds-hitmarker i:nth-child(2) { right: 6px; top: 6px; transform: rotate(-45deg); }
  .ds-hitmarker i:nth-child(3) { left: 6px; bottom: 6px; transform: rotate(-45deg); }
  .ds-hitmarker i:nth-child(4) { right: 6px; bottom: 6px; transform: rotate(45deg); }
  .ds-hitmarker.hs i { background: var(--orange-hot); }
  .ds-hitmarker.kill i { background: #ff4a35; }
  .ds-hitmarker.show { animation: dsHitPop .38s cubic-bezier(.2,.9,.3,1) both; }
  @keyframes dsHitPop {
    0% { opacity: 1; transform: scale(.55); }
    45% { opacity: 1; transform: scale(1.2); }
    100% { opacity: 0; transform: scale(1.55); }
  }

  /* damage feedback */
  .ds-dmgflash {
    position: absolute; inset: 0; opacity: 0; z-index: 6;
    background: radial-gradient(ellipse at center, rgba(120,0,0,0) 42%, rgba(150,12,6,.6) 100%);
    box-shadow: inset 0 0 150px rgba(160,16,6,.8);
  }
  .ds-dmgflash.flash { animation: dsDmgFlash .6s ease-out; }
  @keyframes dsDmgFlash { 0% { opacity: .95; } 100% { opacity: 0; } }
  .ds-lowhp {
    position: absolute; inset: 0; opacity: 0; z-index: 5;
    background: radial-gradient(ellipse at center, rgba(0,0,0,0) 38%, rgba(130,12,6,.5) 100%);
  }
  .ds-lowhp.active { animation: dsLowHp 1.15s ease-in-out infinite; }
  @keyframes dsLowHp { 0%,100% { opacity: .28; } 50% { opacity: .8; } }
  .ds-hitdir { position: absolute; left: 50%; top: 50%; width: 0; height: 0; z-index: 9; opacity: 0; }
  .ds-hitdir i {
    position: absolute; left: -32px; top: -196px; width: 64px; height: 26px;
    background: linear-gradient(180deg, rgba(255,96,52,.98), rgba(204,32,12,.5));
    clip-path: polygon(50% 0, 100% 100%, 50% 76%, 0 100%);
    filter: drop-shadow(0 0 8px rgba(255,60,20,.85));
  }
  .ds-hitdir.flash { animation: dsHitDir .95s ease-out both; }
  @keyframes dsHitDir { 0% { opacity: 1; } 65% { opacity: .75; } 100% { opacity: 0; } }

  /* death overlay */
  .ds-death {
    position: absolute; inset: 0; z-index: 11;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; opacity: 0; visibility: hidden; transition: opacity .25s;
    background: radial-gradient(ellipse at center, rgba(20,0,0,0) 34%, rgba(18,1,1,.55) 100%);
  }
  .ds-death.show { opacity: 1; visibility: visible; }
  .ds-death-title {
    font-size: 50px; font-weight: 800; letter-spacing: 14px; text-indent: 14px; color: #e0503a;
    text-shadow: 0 0 32px rgba(200,30,10,.55), 0 3px 10px rgba(0,0,0,.9);
  }
  .ds-death-sub { font-size: 16px; letter-spacing: 2px; color: #e6dcc2; text-shadow: 0 2px 6px rgba(0,0,0,.95); }
  .ds-death-sub b { color: var(--orange-hot); }
  .ds-death-hint { font-size: 12px; letter-spacing: 4px; color: #c2b498; margin-top: 8px; text-shadow: 0 2px 6px rgba(0,0,0,.95); }

  /* round banner */
  .ds-banner {
    position: absolute; top: 21%; left: 50%; transform: translateX(-50%);
    z-index: 12; text-align: center; opacity: 0; visibility: hidden;
    transition: opacity .18s; width: 90%;
  }
  .ds-banner.show { opacity: 1; visibility: visible; }
  .ds-banner-title {
    font-size: 46px; font-weight: 800; letter-spacing: 10px; text-indent: 10px; color: var(--sand-bright);
    text-shadow: 0 0 34px rgba(232,135,58,.5), 0 4px 12px rgba(0,0,0,.85);
  }
  .ds-banner-sub {
    font-size: 15px; letter-spacing: 3px; color: #d8c9a6; margin-top: 8px;
    text-shadow: 0 2px 6px rgba(0,0,0,.95);
  }
  .ds-banner.show .ds-banner-title { animation: dsBannerIn .45s cubic-bezier(.2,.8,.3,1) both; }
  .ds-banner.show .ds-banner-sub { animation: dsBannerSub .55s ease-out both; }
  @keyframes dsBannerIn { from { opacity: 0; transform: scale(1.22); letter-spacing: 26px; } to { opacity: 1; transform: scale(1); } }
  @keyframes dsBannerSub { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

  /* toast */
  .ds-toast {
    position: absolute; bottom: 20%; left: 50%; transform: translateX(-50%);
    z-index: 40; padding: 8px 22px; font-size: 14px; letter-spacing: 1.5px;
    color: var(--sand-bright); background: rgba(8,9,10,.86);
    border: 1px solid rgba(232,135,58,.45); border-left-width: 3px;
    box-shadow: 0 6px 24px rgba(0,0,0,.5);
    opacity: 0; visibility: hidden; transition: opacity .18s;
    pointer-events: none; white-space: nowrap; max-width: 90vw;
    overflow: hidden; text-overflow: ellipsis;
  }
  .ds-toast.show { opacity: 1; visibility: visible; }

  /* ---------------- modal overlays ---------------- */
  .ds-start, .ds-pause, .ds-buy, .ds-matchend {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    pointer-events: auto;
  }
  .ds-start { z-index: 30; background: radial-gradient(ellipse at 50% 42%, rgba(12,10,6,.2) 0%, rgba(6,7,8,.72) 62%, rgba(4,5,6,.9) 100%); }
  .ds-pause { z-index: 28; background: rgba(5,6,7,.72); }
  .ds-buy { z-index: 26; background: rgba(5,6,7,.74); }
  .ds-matchend { z-index: 29; background: radial-gradient(ellipse at 50% 40%, rgba(20,16,8,.35), rgba(4,5,6,.9) 75%); }

  /* start screen */
  .ds-start-inner {
    width: 92%; max-width: 1060px; display: flex; flex-direction: column;
    align-items: center; gap: 24px; padding: 20px;
  }
  .ds-logo-line { display: flex; align-items: center; gap: 26px; width: 100%; justify-content: center; }
  .ds-logo-line i { flex: 0 0 90px; height: 2px; }
  .ds-logo-line i:first-child { background: linear-gradient(90deg, transparent, var(--sand)); }
  .ds-logo-line i:last-child { background: linear-gradient(90deg, var(--sand), transparent); }
  .ds-logo {
    font-family: "Arial Black", "Segoe UI Black", Impact, sans-serif;
    font-size: clamp(54px, 6.4vw, 88px); font-weight: 900; line-height: 1;
    letter-spacing: 13px; color: var(--sand-bright); text-indent: 13px;
    text-shadow: 0 0 40px rgba(232,135,58,.4), 0 4px 0 rgba(0,0,0,.6), 0 8px 22px rgba(0,0,0,.7);
    white-space: nowrap;
  }
  .ds-start-head { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .ds-subtitle { font-size: 16px; letter-spacing: 8px; color: #cfb88b; text-indent: 8px; }
  .ds-tagline { font-size: 11px; letter-spacing: 3px; color: #8f8570; text-indent: 3px; }
  .ds-start-cols {
    display: grid; grid-template-columns: 1.16fr .84fr; gap: 22px; width: 100%;
  }
  .ds-panel {
    background: rgba(9,10,11,.62); border: 1px solid rgba(216,189,134,.18);
    border-top: 2px solid rgba(216,189,134,.42);
    padding: 20px 24px; text-align: left; backdrop-filter: blur(3px);
  }
  .ds-panel-title {
    font-size: 12px; letter-spacing: 5px; color: var(--sand); margin-bottom: 14px;
    display: flex; align-items: center; gap: 8px;
  }
  .ds-panel-title::before { content: ""; width: 3px; height: 12px; background: var(--orange); display: block; }
  .ds-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 9px 20px; }
  .ds-ctrl { display: flex; align-items: center; gap: 9px; font-size: 13px; color: #c9c0ad; letter-spacing: 1px; }
  .ds-ctrl kbd {
    min-width: 58px; text-align: center; padding: 3px 7px;
    font: 700 11px/1.2 var(--mono); color: var(--sand-bright);
    background: rgba(216,189,134,.09); border: 1px solid rgba(216,189,134,.32);
    border-bottom-width: 2px; border-radius: 3px; letter-spacing: .5px; white-space: nowrap;
  }
  .ds-field { margin-bottom: 15px; }
  .ds-field > label {
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 12px; letter-spacing: 2px; color: #c0b49b; margin-bottom: 7px;
  }
  .ds-field > label b { font: 700 13px var(--mono); color: var(--sand-bright); }
  .ds-seg { display: flex; gap: 6px; }
  .ds-seg button {
    flex: 1; padding: 8px 0; font-size: 13px; letter-spacing: 2px;
    background: rgba(255,255,255,.03); color: #a99d84;
    border: 1px solid rgba(216,189,134,.22); cursor: pointer; transition: .14s;
  }
  .ds-seg button:hover { border-color: rgba(232,135,58,.6); color: #e6d9bd; }
  .ds-seg button.sel {
    background: rgba(232,135,58,.16); border-color: var(--orange);
    color: var(--sand-bright); font-weight: 700;
  }
  .ds-hud input[type="range"] {
    -webkit-appearance: none; appearance: none; width: 100%; height: 16px;
    background: transparent; cursor: pointer;
  }
  .ds-hud input[type="range"]::-webkit-slider-runnable-track {
    height: 4px; background: rgba(255,255,255,.13); border: 1px solid rgba(216,189,134,.18);
  }
  .ds-hud input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 14px; height: 14px; margin-top: -6px;
    border-radius: 50%; background: var(--orange); border: 2px solid #f7d9a4;
    box-shadow: 0 0 8px rgba(232,135,58,.6);
  }
  .ds-hud input[type="range"]::-moz-range-track { height: 4px; background: rgba(255,255,255,.13); }
  .ds-hud input[type="range"]::-moz-range-thumb {
    width: 12px; height: 12px; border-radius: 50%; background: var(--orange);
    border: 2px solid #f7d9a4;
  }
  .ds-btn {
    display: inline-block; padding: 11px 24px; cursor: pointer;
    font-size: 15px; letter-spacing: 2px; color: #e8e2d4;
    background: rgba(255,255,255,.04); border: 1px solid rgba(216,189,134,.35);
    transition: background .15s, border-color .15s, transform .1s;
    pointer-events: auto;
  }
  .ds-btn:hover { border-color: var(--orange); background: rgba(232,135,58,.12); }
  .ds-btn:active { transform: translateY(1px); }
  .ds-btn-primary {
    background: linear-gradient(180deg, #ea8c3f, #b55a1c);
    border-color: #ffb066; color: #1a1006; font-weight: 800; letter-spacing: 4px;
  }
  .ds-btn-primary:hover { background: linear-gradient(180deg, #ffa356, #cc6722); border-color: #ffc487; }
  .ds-start-btn { width: 100%; padding: 14px 20px; font-size: 17px; margin-top: 4px; }
  .ds-start-hint { font-size: 11px; letter-spacing: 1.5px; color: #7f7663; text-align: center; margin-top: 10px; }
  .ds-foot { font-size: 11px; letter-spacing: 2px; color: #6b6455; }
  .ds-foot b { color: #8d8064; font-weight: 400; }

  /* modal panel (pause / match end) */
  .ds-modal {
    position: relative; background: linear-gradient(180deg, rgba(21,22,23,.97), rgba(11,12,13,.97));
    border: 1px solid rgba(216,189,134,.28); border-top: 2px solid var(--sand);
    padding: 34px 52px; text-align: center; min-width: 440px;
    box-shadow: 0 22px 70px rgba(0,0,0,.65); backdrop-filter: blur(4px);
  }
  .ds-modal::before, .ds-modal::after {
    content: ""; position: absolute; width: 12px; height: 12px;
    border: 1px solid rgba(216,189,134,.5);
  }
  .ds-modal::before { left: -1px; bottom: -1px; border-right: 0; border-top: 0; }
  .ds-modal::after { right: -1px; top: -1px; border-left: 0; border-bottom: 0; }
  .ds-modal-title { font-size: 34px; font-weight: 800; letter-spacing: 14px; color: var(--sand-bright); text-indent: 14px; }
  .ds-modal-sub { font-size: 13px; letter-spacing: 2px; color: #9b9079; margin-top: 10px; }
  .ds-btn-row { display: flex; gap: 14px; justify-content: center; margin-top: 26px; }
  .ds-pause-tip { font-size: 11px; letter-spacing: 1.5px; color: #756d5d; margin-top: 18px; }

  /* buy menu */
  .ds-buy-panel { min-width: 780px; max-width: 92vw; padding: 26px 30px 22px; text-align: left; }
  .ds-buy-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 30px; margin-bottom: 18px; }
  .ds-buy-head .ds-modal-title { font-size: 26px; letter-spacing: 8px; text-indent: 8px; }
  .ds-buy-sub { font-size: 12px; letter-spacing: 1.5px; color: #8f8570; margin-top: 8px; }
  .ds-buy-sub b { color: var(--orange-hot); font-family: var(--mono); }
  .ds-buy-money { text-align: right; white-space: nowrap; }
  .ds-buy-money span { display: block; font-size: 10px; letter-spacing: 3px; color: #8f8570; }
  .ds-buy-money b { font: 800 27px/1.2 var(--mono); color: var(--sand-bright); }
  .ds-buy-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .ds-card {
    position: relative; display: flex; flex-direction: column; align-items: flex-start;
    gap: 4px; padding: 14px 16px 12px; text-align: left; cursor: pointer;
    background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(0,0,0,.22));
    border: 1px solid rgba(216,189,134,.24); color: #e8e2d4;
    transition: border-color .14s, background .14s, transform .1s;
  }
  .ds-card:hover { border-color: var(--orange); background: rgba(232,135,58,.1); }
  .ds-card:active { transform: translateY(1px); }
  .ds-card.disabled { opacity: .36; cursor: not-allowed; }
  .ds-card.disabled:hover { border-color: rgba(216,189,134,.24); background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(0,0,0,.22)); }
  .ds-card.owned { opacity: .68; cursor: default; }
  .ds-card-key {
    position: absolute; top: 10px; right: 12px; width: 20px; height: 20px;
    display: flex; align-items: center; justify-content: center;
    font: 700 11px/1 var(--mono); color: var(--sand-bright);
    border: 1px solid rgba(216,189,134,.4); border-radius: 2px;
  }
  .ds-card-name { font-size: 19px; font-weight: 700; letter-spacing: 1px; color: #f4ead2; }
  .ds-card-cat { font-size: 11px; letter-spacing: 1.5px; color: #8f8570; }
  .ds-card-price { font: 700 15px/1 var(--mono); color: var(--sand-bright); margin-top: 5px; }
  .ds-card-owned {
    display: none; position: absolute; right: 12px; bottom: 11px;
    font-size: 10px; letter-spacing: 1.5px; color: var(--green);
  }
  .ds-card.owned .ds-card-owned { display: block; }
  .ds-buy-foot { font-size: 11px; letter-spacing: 2px; color: #7f7663; margin-top: 16px; text-align: center; }
  .ds-buy-foot b { color: var(--sand); font-family: var(--mono); }

  /* match end */
  .ds-me-panel { min-width: 520px; padding: 40px 60px; }
  .ds-me-rank {
    font-size: 62px; font-weight: 900; letter-spacing: 20px; text-indent: 20px;
    color: var(--sand-bright); text-shadow: 0 0 40px rgba(232,135,58,.5), 0 4px 12px rgba(0,0,0,.8);
  }
  .ds-me-rank.win { color: #f2d791; }
  .ds-me-rank.lose { color: #d94a35; text-shadow: 0 0 34px rgba(217,74,53,.5), 0 4px 12px rgba(0,0,0,.8); }
  .ds-me-sub { font-size: 14px; letter-spacing: 5px; color: #a99d84; margin-top: 6px; }
  .ds-me-score { font: 700 26px/1 var(--mono); color: #e8e2d4; letter-spacing: 3px; margin: 26px 0 4px; }
  .ds-me-panel .ds-btn { margin-top: 26px; padding: 13px 46px; letter-spacing: 6px; }

  /* scoreboard */
  .ds-scoreboard {
    position: absolute; inset: 0; z-index: 24; display: flex;
    align-items: center; justify-content: center; pointer-events: none;
    background: rgba(4,5,6,.5);
  }
  .ds-sb-panel {
    width: min(940px, 94vw); background: linear-gradient(180deg, rgba(18,19,20,.97), rgba(9,10,11,.97));
    border: 1px solid rgba(216,189,134,.28); border-top: 2px solid var(--sand);
    padding: 22px 26px 16px; box-shadow: 0 24px 70px rgba(0,0,0,.6);
  }
  .ds-sb-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
  .ds-sb-head .ds-modal-title { font-size: 22px; letter-spacing: 8px; text-indent: 8px; }
  .ds-sb-score { font: 700 18px/1 var(--mono); color: var(--sand-bright); letter-spacing: 2px; }
  .ds-sb-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .ds-sb-team { border: 1px solid rgba(216,189,134,.12); background: rgba(255,255,255,.015); }
  .ds-sb-teamhead {
    display: flex; justify-content: space-between; align-items: center;
    padding: 7px 10px; font-size: 12px; letter-spacing: 3px; font-weight: 700;
    background: rgba(255,255,255,.04);
  }
  .ds-sb-ct .ds-sb-teamhead { color: var(--ct); border-bottom: 1px solid rgba(127,167,216,.35); }
  .ds-sb-t .ds-sb-teamhead { color: var(--t); border-bottom: 1px solid rgba(217,160,91,.35); }
  .ds-sb-teamcount { font: 700 13px var(--mono); opacity: .7; }
  .ds-sb-hrow, .ds-sb-row {
    display: grid; grid-template-columns: 1fr 40px 40px 52px; align-items: center;
    padding: 5px 10px; font-size: 13px;
  }
  .ds-sb-hrow { font-size: 10px; letter-spacing: 2px; color: #7f7663; padding-top: 7px; padding-bottom: 4px; }
  .ds-sb-row { border-top: 1px solid rgba(255,255,255,.045); }
  .ds-sb-row.you { background: rgba(232,135,58,.14); color: var(--sand-bright); font-weight: 700; }
  .ds-sb-row.dead { opacity: .42; }
  .ds-sb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ds-sb-k, .ds-sb-d { font-family: var(--mono); text-align: center; color: #d8d0bd; }
  .ds-sb-state { text-align: right; font-size: 11px; letter-spacing: 1px; color: #8f9a7d; }
  .ds-sb-row.dead .ds-sb-state { color: #a05a4a; }
  .ds-sb-foot { font-size: 10px; letter-spacing: 2px; color: #6b6455; text-align: center; margin-top: 12px; }

  /* responsive: keep everything inside a 720p frame */
  @media (max-height: 820px) {
    .ds-start-inner { gap: 16px; padding: 10px; }
    .ds-logo { font-size: 60px; }
    .ds-panel { padding: 14px 18px; }
    .ds-controls { gap: 7px 16px; }
    .ds-field { margin-bottom: 10px; }
    .ds-track { font-size: 12px; }
    .ds-banner-title { font-size: 38px; }
    .ds-death-title { font-size: 40px; }
  }
  @media (max-width: 900px) {
    .ds-start-cols { grid-template-columns: 1fr; }
    .ds-buy-panel, .ds-me-panel, .ds-modal { min-width: 0; width: 92vw; }
    .ds-vitals { width: 210px; }
    .ds-ammo { min-width: 150px; }
  }
  `;

  function injectStyle() {
    if (document.getElementById('ds-hud-styles')) return;
    var style = document.createElement('style');
    style.id = 'ds-hud-styles';
    style.type = 'text/css';
    style.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------------ */
  /* DOM construction                                                   */
  /* ------------------------------------------------------------------ */
  var HTML = `
  <div class="ds-hud" id="ds-hud">
    <div class="ds-game" id="ds-game">
      <div class="ds-top" id="ds-top">
        <div class="ds-score-row">
          <div class="ds-team ds-ct"><span class="ds-team-tag">CT</span><span class="ds-score" id="ds-score-ct">0</span></div>
          <div class="ds-timer-wrap">
            <div class="ds-timer" id="ds-timer">2:00</div>
            <div class="ds-round" id="ds-round">第 1 回合 · 先到 8 胜</div>
          </div>
          <div class="ds-team ds-t"><span class="ds-score" id="ds-score-t">0</span><span class="ds-team-tag">T</span></div>
        </div>
        <div class="ds-phase" id="ds-phase">购买阶段</div>
      </div>

      <div class="ds-killfeed" id="ds-killfeed"></div>

      <div class="ds-vitals" id="ds-vitals">
        <div class="ds-money" id="ds-money">$800</div>
        <div class="ds-vrow"><span class="ds-vlabel">生命</span><span class="ds-vnum" id="ds-hp">100</span></div>
        <div class="ds-bar ds-hpbar" id="ds-hpbar"><i id="ds-hpfill"></i></div>
        <div class="ds-vrow"><span class="ds-vlabel">护甲</span><span class="ds-vnum ds-armor-num" id="ds-armor">0</span></div>
        <div class="ds-bar ds-armorbar" id="ds-armorbar"><i id="ds-armorfill"></i></div>
      </div>

      <div class="ds-ammo" id="ds-ammo">
        <div class="ds-weapon" id="ds-weapon">USP-S</div>
        <div class="ds-ammo-row"><span class="ds-mag" id="ds-mag">12</span><span class="ds-slash">/</span><span class="ds-reserve" id="ds-reserve">100</span></div>
        <div class="ds-reload" id="ds-reload">换弹中…</div>
      </div>

      <div class="ds-buytip" id="ds-buytip">按 <b>B</b> 购买 · 剩余 <span id="ds-buytime">8</span> 秒</div>

      <div class="ds-crosshair" id="ds-crosshair">
        <i class="ch-line ch-t"></i><i class="ch-line ch-b"></i>
        <i class="ch-line ch-l"></i><i class="ch-line ch-r"></i><i class="ch-dot"></i>
      </div>
      <div class="ds-hitmarker" id="ds-hitmarker"><i></i><i></i><i></i><i></i></div>

      <div class="ds-scope" id="ds-scope">
        <div class="ds-scope-lens">
          <div class="ds-scope-vignette"></div>
          <div class="ds-scope-ret">
            <i class="l"></i><i class="r"></i><i class="t"></i><i class="b"></i><i class="dot"></i>
          </div>
        </div>
      </div>

      <div class="ds-lowhp" id="ds-lowhp"></div>
      <div class="ds-dmgflash" id="ds-dmgflash"></div>
      <div class="ds-hitdir" id="ds-hitdir"><i></i></div>

      <div class="ds-death" id="ds-death">
        <div class="ds-death-title">你已阵亡</div>
        <div class="ds-death-sub" id="ds-death-sub">被击杀了</div>
        <div class="ds-death-hint" id="ds-death-hint">等待下一回合…</div>
      </div>

      <div class="ds-banner" id="ds-banner">
        <div class="ds-banner-title" id="ds-banner-title"></div>
        <div class="ds-banner-sub" id="ds-banner-sub"></div>
      </div>
    </div>

    <div class="ds-scoreboard" id="ds-scoreboard">
      <div class="ds-sb-panel">
        <div class="ds-sb-head">
          <div class="ds-modal-title">记分板</div>
          <div class="ds-sb-score" id="ds-sb-score">CT 0 : 0 T</div>
        </div>
        <div class="ds-sb-cols" id="ds-sb-cols"></div>
        <div class="ds-sb-foot">按住 TAB 查看 · 先到 ${TARGET_SCORE} 回合获胜</div>
      </div>
    </div>

    <div class="ds-pause" id="ds-pause">
      <div class="ds-modal">
        <div class="ds-modal-title">已暂停</div>
        <div class="ds-modal-sub">游戏已暂停 · 点击继续返回战场</div>
        <div class="ds-btn-row">
          <button type="button" class="ds-btn ds-btn-primary" id="ds-resume-btn" tabindex="-1">继续游戏</button>
          <button type="button" class="ds-btn" id="ds-restart-btn" tabindex="-1">重新开始</button>
        </div>
        <div class="ds-pause-tip">继续后鼠标将被锁定 · 按 ESC 可再次暂停</div>
      </div>
    </div>

    <div class="ds-buy" id="ds-buy">
      <div class="ds-modal ds-buy-panel">
        <div class="ds-buy-head">
          <div>
            <div class="ds-modal-title">购买菜单</div>
            <div class="ds-buy-sub">数字键 <b>1-4</b> 或点击卡片购买 · <b>B</b> / <b>ESC</b> 关闭</div>
          </div>
          <div class="ds-buy-money"><span>余额</span><b id="ds-buy-money">$800</b><div class="ds-buy-sub" id="ds-buy-time"></div></div>
        </div>
        <div class="ds-buy-cards" id="ds-buy-cards"></div>
        <div class="ds-buy-foot">购买成功后自动返回战斗 · 死亡将失去未保留的武器</div>
      </div>
    </div>

    <div class="ds-matchend" id="ds-matchend">
      <div class="ds-modal ds-me-panel">
        <div class="ds-me-rank" id="ds-me-rank">胜利</div>
        <div class="ds-me-sub" id="ds-me-sub">比赛结束</div>
        <div class="ds-me-score" id="ds-me-score">CT 8 : 3 T</div>
        <button type="button" class="ds-btn ds-btn-primary" id="ds-again-btn" tabindex="-1">再来一局</button>
      </div>
    </div>

    <div class="ds-toast" id="ds-toast"></div>

    <div class="ds-start" id="ds-start">
      <div class="ds-start-inner">
        <div class="ds-start-head">
          <div class="ds-logo-line"><i></i><div class="ds-logo">DUST STRIKE</div><i></i></div>
          <div class="ds-subtitle">网页版 CS · 5v5 战术射击</div>
          <div class="ds-tagline">DUST2 沙漠战场 · 回合制经济 · 纯前端 WEBGL · 5v5</div>
        </div>
        <div class="ds-start-cols">
          <div class="ds-panel">
            <div class="ds-panel-title">操作说明</div>
            <div class="ds-controls">
              <div class="ds-ctrl"><kbd>W A S D</kbd><span>移动</span></div>
              <div class="ds-ctrl"><kbd>鼠标</kbd><span>瞄准</span></div>
              <div class="ds-ctrl"><kbd>左键</kbd><span>射击</span></div>
              <div class="ds-ctrl"><kbd>R</kbd><span>换弹</span></div>
              <div class="ds-ctrl"><kbd>1 - 3</kbd><span>切换武器</span></div>
              <div class="ds-ctrl"><kbd>B</kbd><span>购买菜单</span></div>
              <div class="ds-ctrl"><kbd>Tab</kbd><span>记分板</span></div>
              <div class="ds-ctrl"><kbd>Shift</kbd><span>静步</span></div>
              <div class="ds-ctrl"><kbd>Ctrl</kbd><span>蹲下</span></div>
              <div class="ds-ctrl"><kbd>空格</kbd><span>跳跃</span></div>
              <div class="ds-ctrl"><kbd>Esc</kbd><span>暂停</span></div>
            </div>
          </div>
          <div class="ds-panel">
            <div class="ds-panel-title">对局设置</div>
            <div class="ds-field">
              <label><span>难度</span></label>
              <div class="ds-seg" id="ds-diff">
                <button type="button" data-diff="easy" tabindex="-1">简单</button>
                <button type="button" data-diff="normal" class="sel" tabindex="-1">普通</button>
                <button type="button" data-diff="hard" tabindex="-1">困难</button>
              </div>
            </div>
            <div class="ds-field">
              <label><span>灵敏度</span><b id="ds-sens-val">1.0×</b></label>
              <input type="range" id="ds-sens" min="0.5" max="3" step="0.1" value="1" tabindex="-1">
            </div>
            <div class="ds-field">
              <label><span>音量</span><b id="ds-vol-val">80%</b></label>
              <input type="range" id="ds-vol" min="0" max="1" step="0.01" value="0.8" tabindex="-1">
            </div>
            <button type="button" class="ds-btn ds-btn-primary ds-start-btn" id="ds-start-btn" tabindex="-1">进入游戏</button>
            <div class="ds-start-hint">点击进入后鼠标将被锁定 · 按 ESC 释放鼠标并暂停</div>
          </div>
        </div>
        <div class="ds-foot">纯前端 · <b>WebGL</b> 渲染 · <b>WebAudio</b> 程序化音效 · 无外部资源</div>
      </div>
    </div>
  </div>
  `;

  function buildDom() {
    var host = document.getElementById('hud-root');
    if (!host) {
      host = document.createElement('div');
      host.id = 'hud-root';
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10;overflow:hidden;';
      document.body.appendChild(host);
    }
    var wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    root = wrap.firstElementChild;
    host.appendChild(root);

    var nodes = root.querySelectorAll('[id]');
    for (var i = 0; i < nodes.length; i++) refs[nodes[i].id] = nodes[i];

    buildBuyCards();
  }

  function buildBuyCards() {
    var wrap = refs['ds-buy-cards'];
    if (!wrap) return;
    wrap.innerHTML = '';
    buyCardEls = [];
    for (var i = 0; i < BUY_ORDER.length; i++) {
      var id = BUY_ORDER[i];
      var meta = BUY_META[id] || { name: id, cat: '' };
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'ds-card';
      card.setAttribute('data-item', id);
      card.setAttribute('tabindex', '-1');
      card.innerHTML =
        '<span class="ds-card-key">' + (i + 1) + '</span>' +
        '<span class="ds-card-name">' + esc(meta.name) + '</span>' +
        '<span class="ds-card-cat">' + esc(meta.cat) + '</span>' +
        '<span class="ds-card-price">$' + buyPrice(id) + '</span>' +
        '<span class="ds-card-owned">已拥有</span>';
      (function (itemId) {
        card.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          attemptBuy(itemId);
        });
      })(id);
      wrap.appendChild(card);
      buyCardEls.push({ id: id, el: card, priceEl: card.querySelector('.ds-card-price') });
    }
  }

  /* ------------------------------------------------------------------ */
  /* visibility                                                         */
  /* ------------------------------------------------------------------ */
  function pauseVisible() {
    if (flags.startOpen || flags.buyOpen || flags.matchEndOpen) return false;
    if (flags.pauseOpen) return true;
    if (!game || !game.paused) return false;
    /* right after closing the buy menu the pointer lock request is async and
       game.paused may still be true for a frame or two: don't flash the pause
       menu while we wait for pointerlockchange to confirm. */
    if (nowSec() < pauseSuppressUntil) return false;
    return !!(flags.started || game.started);
  }
  function scoreboardVisible() {
    return !!flags.scoreboardHeld && !flags.startOpen && !flags.matchEndOpen &&
      !flags.buyOpen && !pauseVisible();
  }
  function syncOverlays() {
    if (!root) return;
    setShown(refs['ds-game'], !flags.startOpen);
    setShown(refs['ds-start'], flags.startOpen);
    setShown(refs['ds-buy'], flags.buyOpen);
    setShown(refs['ds-matchend'], flags.matchEndOpen);
    setShown(refs['ds-pause'], pauseVisible());
    setShown(refs['ds-scoreboard'], scoreboardVisible());
  }

  /* ------------------------------------------------------------------ */
  /* public visibility API                                              */
  /* ------------------------------------------------------------------ */
  H.showStart = function () {
    flags.startOpen = true;
    flags.pauseOpen = false;
    flags.matchEndOpen = false;
    if (flags.buyOpen) closeBuy(false);
    syncStartSettings();
    syncOverlays();
  };

  H.hideStart = function () {
    if (!flags.startOpen && flags.started) return;
    flags.startOpen = false;
    flags.started = true;
    syncOverlays();
  };

  H.reset = function () {
    if (!inited) return;
    clearFeed();
    hideBanner();
    hideToast();
    flags.pauseOpen = false;
    flags.buyOpen = false;
    flags.matchEndOpen = false;
    flags.scoreboardHeld = false;
    ownTabHeld = false;
    deathInfo = { killer: '', weapon: '', headshot: false };
    toggleClass(refs['ds-death'], 'show', false);
    deadShown = false;
    lastMoney = null;
    lastGap = -1;
    scoreboardDirty = true;
    lastSbBuild = -1;
    suppressBuyToastUntil = 0;
    syncOverlays();
    if (game || CS.game) H.update(game || CS.game, 0);
  };

  H.showPause = function (on) {
    var want = !!on;
    if (want && (flags.startOpen || flags.matchEndOpen || flags.buyOpen)) return;
    if (flags.pauseOpen === want) { syncOverlays(); return; }
    flags.pauseOpen = want;
    syncOverlays();
  };

  H.isBuyMenuOpen = function () { return !!flags.buyOpen; };
  H.isBlockingInput = function () {
    return !!(flags.startOpen || flags.buyOpen || flags.matchEndOpen || pauseVisible());
  };

  /* ------------------------------------------------------------------ */
  /* timers / messages                                                  */
  /* ------------------------------------------------------------------ */
  H.banner = function (title, sub, seconds) {
    if (!inited) return;
    setText(refs['ds-banner-title'], title || '');
    setText(refs['ds-banner-sub'], sub || '');
    var b = refs['ds-banner'];
    if (!b) return;
    b.classList.remove('show');
    void b.offsetWidth;                       // restart the CSS animation
    b.classList.add('show');
    timer.bannerUntil = nowSec() + (typeof seconds === 'number' ? seconds : 2.5);
  };
  function hideBanner() {
    if (refs['ds-banner']) refs['ds-banner'].classList.remove('show');
    timer.bannerUntil = 0;
  }

  H.toast = function (msg, ms) {
    if (!inited || !refs['ds-toast']) return;
    setText(refs['ds-toast'], msg);
    refs['ds-toast'].classList.add('show');
    timer.toastUntil = nowSec() + (typeof ms === 'number' ? ms : 2.6);
  };
  function hideToast() {
    if (refs['ds-toast']) refs['ds-toast'].classList.remove('show');
    timer.toastUntil = 0;
  }

  /* ------------------------------------------------------------------ */
  /* buy menu                                                           */
  /* ------------------------------------------------------------------ */
  function isOwned(id, player) {
    if (!player) return false;
    if (id === 'armor') return (player.armor || 0) >= 100;
    return !!(player.loadout && player.loadout.primary === id);
  }
  function canPurchase(id, st, player) {
    if (!st || st.canBuy === false) return false;
    if (!player || player.alive === false) return false;
    if (isOwned(id, player)) return false;
    var money = typeof st.money === 'number' ? st.money : 0;
    return money >= buyPrice(id);
  }
  function canOpenBuy() {
    if (!game || !game.player) return false;
    if (flags.startOpen || flags.matchEndOpen || pauseVisible()) return false;
    if (game.paused) return false;
    if (game.player.alive === false) return false;
    var st = rulesState();
    if (!st) return false;
    return st.phase === 'buy' || st.phase === 'live';
  }
  function openBuy() {
    if (flags.buyOpen) return true;
    if (!canOpenBuy()) {
      var st0 = rulesState();
      if (game && game.player && game.player.alive === false) H.toast('已阵亡，无法购买');
      else if (st0 && st0.phase !== 'buy' && st0.phase !== 'live') H.toast('当前阶段无法购买');
      return false;
    }
    flags.buyOpen = true;
    flags.pauseOpen = false;
    suppressBuyToastUntil = 0;
    refreshBuyCards(true);
    syncOverlays();
    callCallback('requestPause');
    return true;
  }
  function closeBuy(lockPointerAfter) {
    if (!flags.buyOpen) return;
    flags.buyOpen = false;
    flags.pauseOpen = false;
    if (lockPointerAfter !== false) pauseSuppressUntil = nowSec() + 0.9;
    syncOverlays();
    if (lockPointerAfter !== false) callCallback('lockPointer');
  }
  function attemptBuy(id) {
    if (!flags.buyOpen) return;
    var st = rulesState();
    var player = game && game.player;
    if (!canPurchase(id, st, player)) {
      if (isOwned(id, player)) H.toast('已拥有 ' + itemName(id));
      else if (st && st.canBuy === false) H.toast('当前无法购买');
      else if (st && typeof st.money === 'number' && st.money < buyPrice(id)) H.toast('资金不足：' + itemName(id) + ' $' + buyPrice(id));
      else H.toast('无法购买');
      return;
    }
    var rules = (game && game.rules) || CS.rules;
    if (!rules || typeof rules.buy !== 'function') { H.toast('购买系统未就绪'); return; }
    var res = null;
    try { res = rules.buy(game, id); } catch (err) {
      if (window.console) console.error('[hud] rules.buy threw:', err);
      H.toast('购买失败');
      return;
    }
    if (res && res.ok) {
      suppressBuyToastUntil = nowSec() + 0.6;
      H.toast(res.msg || ('已购买 ' + itemName(id)));
      closeBuy(true);                       // auto close + re-lock pointer
    } else {
      H.toast((res && res.msg) || '购买失败');
      refreshBuyCards(true);
    }
  }
  function refreshBuyCards(force) {
    if (!flags.buyOpen && !force) return;
    var st = rulesState();
    var player = game && game.player;
    var money = st && typeof st.money === 'number' ? st.money : 0;
    setText(refs['ds-buy-money'], '$' + money);
    var left = st && typeof st.buyTimeLeft === 'number' ? Math.max(0, Math.ceil(st.buyTimeLeft)) : null;
    setText(refs['ds-buy-time'], left == null ? '' : ('剩余 ' + left + ' 秒'));
    for (var i = 0; i < buyCardEls.length; i++) {
      var card = buyCardEls[i];
      var price = buyPrice(card.id);
      if (card.priceEl) setText(card.priceEl, '$' + price);
      var owned = isOwned(card.id, player);
      var can = canPurchase(card.id, st, player);
      toggleClass(card.el, 'owned', owned);
      toggleClass(card.el, 'disabled', !owned && !can);
    }
  }

  /* ------------------------------------------------------------------ */
  /* kill feed / hit feedback                                           */
  /* ------------------------------------------------------------------ */
  function addFeedEntry(ev) {
    var wrap = refs['ds-killfeed'];
    if (!wrap || !ev.victim) return;
    var killer = ev.killer;
    var el = document.createElement('div');
    el.className = 'ds-kf ' + (killer && killer.team === 't' ? 't' : 'ct');
    if (game && killer === game.player) el.classList.add('you-killer');
    if (game && ev.victim === game.player) el.classList.add('you-victim');
    el.innerHTML =
      '<span class="ds-kf-k">' + esc(displayName(killer)) + '</span>' +
      '<span class="ds-kf-w">' + esc(weaponName(ev.weapon)) + '</span>' +
      (ev.headshot ? '<span class="ds-kf-hs">HS</span>' : '') +
      '<span class="ds-kf-v">' + esc(displayName(ev.victim)) + '</span>';
    wrap.appendChild(el);
    feed.push({ el: el, until: nowSec() + KILL_FEED_LIFE, fading: false });
    while (feed.length > MAX_KILL_FEED) {
      var old = feed.shift();
      if (old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
  }
  function clearFeed() {
    for (var i = 0; i < feed.length; i++) {
      if (feed[i].el && feed[i].el.parentNode) feed[i].el.parentNode.removeChild(feed[i].el);
    }
    feed.length = 0;
    if (refs['ds-killfeed']) refs['ds-killfeed'].innerHTML = '';
  }
  function flashHitmarker(headshot, kill) {
    var el = refs['ds-hitmarker'];
    if (!el) return;
    el.classList.remove('show', 'hs', 'kill');
    void el.offsetWidth;
    if (headshot) el.classList.add('hs');
    if (kill) el.classList.add('kill');
    el.classList.add('show');
  }
  function flashDamage(attacker) {
    var flash = refs['ds-dmgflash'];
    if (flash) {
      flash.classList.remove('flash');
      void flash.offsetWidth;
      flash.classList.add('flash');
    }
    var p = game && game.player;
    var dir = refs['ds-hitdir'];
    if (!dir) return;
    var rel = 0;
    if (p && p.pos && attacker && attacker.pos) {
      var dx = attacker.pos[0] - p.pos[0];
      var dz = attacker.pos[2] - p.pos[2];
      rel = Math.atan2(dx, -dz) - (p.yaw || 0);
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    }
    dir.style.transform = 'rotate(' + rel + 'rad)';
    dir.classList.remove('flash');
    void dir.offsetWidth;
    dir.classList.add('flash');
  }

  /* ------------------------------------------------------------------ */
  /* match end                                                          */
  /* ------------------------------------------------------------------ */
  H.showMatchEnd = function (winner) {
    if (!inited) return;
    var st = rulesState();
    if (winner == null && st) winner = st.matchWinner;
    if (winner && typeof winner === 'object') winner = winner.team || winner.id;
    var myTeam = playerTeam();
    var draw = !winner;
    var win = winner === myTeam;
    flags.matchEndOpen = true;
    flags.pauseOpen = false;
    flags.buyOpen = false;
    var rank = refs['ds-me-rank'];
    setText(rank, draw ? '平局' : (win ? '胜利' : '失败'));
    toggleClass(rank, 'win', !draw && win);
    toggleClass(rank, 'lose', !draw && !win);
    setText(refs['ds-me-sub'], draw ? '比赛结束' : (win ? '反恐精英赢得比赛' : '恐怖分子赢得比赛'));
    var score = (st && st.score) || { ct: 0, t: 0 };
    setText(refs['ds-me-score'], 'CT ' + (score.ct || 0) + ' : ' + (score.t || 0) + ' T');
    syncOverlays();
  };

  /* ------------------------------------------------------------------ */
  /* per-frame sub-updates                                              */
  /* ------------------------------------------------------------------ */
  function updateTop(st) {
    var score = (st && st.score) || { ct: 0, t: 0 };
    setText(refs['ds-score-ct'], score.ct || 0);
    setText(refs['ds-score-t'], score.t || 0);
    var phase = st ? st.phase : '';
    var timerText = '—';
    var phaseText = '';
    if (phase === 'buy') {
      timerText = fmtTime(st.buyTimeLeft);
      phaseText = '购买阶段 · ' + Math.max(0, Math.ceil(st.buyTimeLeft || 0)) + ' 秒';
    } else if (phase === 'live') {
      timerText = fmtTime(st.roundTimeLeft);
      phaseText = '战斗阶段';
    } else if (phase === 'roundEnd') {
      timerText = '0:00';
      phaseText = '回合结束';
    } else if (phase === 'matchEnd') {
      timerText = '—';
      phaseText = '比赛结束';
    }
    setText(refs['ds-timer'], timerText);
    setText(refs['ds-phase'], phaseText);
    toggleClass(refs['ds-timer'], 'warn', phase === 'live' && st.roundTimeLeft <= 10);
    toggleClass(refs['ds-timer'], 'buy', phase === 'buy');
    setText(refs['ds-round'], '第 ' + ((st && st.round) || 0) + ' 回合 · 先到 ' + TARGET_SCORE + ' 胜');
  }

  function updateVitals(player, st) {
    var hp = player.health == null ? 100 : Math.max(0, Math.round(player.health));
    var armor = player.armor == null ? 0 : Math.max(0, Math.round(player.armor));
    setText(refs['ds-hp'], hp);
    setBar(refs['ds-hpfill'], hp);
    toggleClass(refs['ds-hpbar'], 'low', hp <= 25);
    toggleClass(refs['ds-hp'], 'low', hp <= 25);
    setText(refs['ds-armor'], armor);
    setBar(refs['ds-armorfill'], armor);
    var money = st && typeof st.money === 'number' ? st.money : (typeof player.money === 'number' ? player.money : 0);
    setText(refs['ds-money'], '$' + money);
    if (lastMoney != null && money !== lastMoney && refs['ds-money']) {
      var el = refs['ds-money'];
      el.classList.remove('up', 'down');
      void el.offsetWidth;
      el.classList.add(money > lastMoney ? 'up' : 'down');
    }
    lastMoney = money;
  }

  function updateAmmo(player) {
    var def = playerDef(player);
    var wid = def ? def.id : player.current;
    var isKnife = wid === 'knife' || !def || def.mag == null;
    var label = def && def.name ? def.name : (wid ? String(wid).toUpperCase() : '—');
    var mag = '—', reserve = '—';
    var ammo = (player.ammo && wid) ? player.ammo[wid] : null;
    if (!isKnife) {
      if (ammo && typeof ammo.mag === 'number') {
        mag = ammo.mag;
        reserve = typeof ammo.reserve === 'number' ? ammo.reserve : 0;
      } else if (def) {
        mag = def.mag;
        reserve = def.reserve;
      }
    }
    setText(refs['ds-weapon'], label);
    setText(refs['ds-mag'], mag);
    setText(refs['ds-reserve'], reserve);
    toggleClass(refs['ds-ammo'], 'low', !isKnife && typeof mag === 'number' && mag <= 5);
    toggleClass(refs['ds-reload'], 'on', !!player.reloading);
  }

  function updateCrosshair(player) {
    var el = refs['ds-crosshair'];
    if (!el) return;
    var hidden = !player || player.alive === false || player.scoped === true ||
      flags.startOpen || flags.buyOpen || flags.matchEndOpen || pauseVisible() || scoreboardVisible();
    toggleClass(el, 'off', hidden);
    if (hidden) return;
    var gap = null;
    if (typeof player.crosshairPixels === 'function') {
      try { gap = +player.crosshairPixels(game); } catch (e) { gap = null; }
    }
    if (gap == null || !isFinite(gap)) {
      var sp = +player.crosshairSpread;
      if (!isFinite(sp)) sp = 0;
      gap = 3 + clamp(sp, 0, 1) * 23;
    }
    gap = clamp(gap, 2, 40);
    if (Math.abs(gap - lastGap) > 0.05) {
      lastGap = gap;
      el.style.setProperty('--gap', gap.toFixed(1) + 'px');
      el.style.setProperty('--len', Math.round(6 + gap * 0.16) + 'px');
    }
  }

  function updateScope(player) {
    var el = refs['ds-scope'];
    if (!el) return;
    var scoped = !!player && player.scoped === true && player.alive !== false;
    var blocked = flags.startOpen || flags.buyOpen || flags.matchEndOpen ||
      pauseVisible() || scoreboardVisible();
    toggleClass(el, 'on', scoped && !blocked);
  }

  function updateDamageLayers(player) {
    var hp = player && typeof player.health === 'number' ? player.health : 100;
    var low = !!player && player.alive !== false && hp > 0 && hp <= 35 &&
      !flags.startOpen && !flags.matchEndOpen && !flags.buyOpen;
    toggleClass(refs['ds-lowhp'], 'active', low);
  }

  function updateDeath(player, st) {
    var dead = !!player && player.alive === false;
    var show = dead && flags.started && !flags.startOpen && !flags.matchEndOpen;
    var el = refs['ds-death'];
    if (!el) return;
    if (show) {
      var sub;
      if (deathInfo.killer) {
        sub = '被 ' + deathInfo.killer + (deathInfo.weapon ? ' 使用 ' + deathInfo.weapon : '') + ' 击杀' +
          (deathInfo.headshot ? ' · 爆头' : '');
      } else {
        sub = '你被击杀了';
      }
      setText(refs['ds-death-sub'], sub);
      setText(refs['ds-death-hint'], (st && st.phase === 'roundEnd') ? '等待回合结束…' : '等待下一回合…');
    }
    if (show !== deadShown) { deadShown = show; toggleClass(el, 'show', show); }
  }

  function updateBuyTip(st, player) {
    var show = !!st && st.canBuy === true && !flags.startOpen && !flags.buyOpen &&
      !flags.matchEndOpen && !pauseVisible() && !!player && player.alive !== false;
    toggleClass(refs['ds-buytip'], 'show', show);
    if (show) setText(refs['ds-buytime'], Math.max(0, Math.ceil(st.buyTimeLeft || 0)));
  }

  function updateFeed(t) {
    for (var i = feed.length - 1; i >= 0; i--) {
      var f = feed[i];
      if (!f.fading && t >= f.until) {
        f.fading = true;
        f.el.classList.add('fade');
      }
      if (f.fading && t >= f.until + 0.55) {
        if (f.el.parentNode) f.el.parentNode.removeChild(f.el);
        feed.splice(i, 1);
      }
    }
  }
  function updateBanner(t) {
    if (timer.bannerUntil && t >= timer.bannerUntil) hideBanner();
  }
  function updateToast(t) {
    if (timer.toastUntil && t >= timer.toastUntil) hideToast();
  }

  function buildScoreboard() {
    var wrap = refs['ds-sb-cols'];
    if (!wrap) return;
    var player = game && game.player;
    var ctRows = [], tRows = [];
    if (player) {
      ctRows.push({
        name: player.name || '你',
        k: player.kills || 0,
        d: player.deaths || 0,
        alive: player.alive !== false,
        you: true
      });
    }
    var bots = (game && game.bots) || [];
    for (var i = 0; i < bots.length; i++) {
      var b = bots[i];
      if (!b) continue;
      var row = {
        name: b.name || 'BOT',
        k: b.kills || 0,
        d: b.deaths || 0,
        alive: b.alive !== false,
        you: false
      };
      if (b.team === 't') tRows.push(row); else ctRows.push(row);
    }
    ctRows.sort(function (a, b) { return b.k - a.k; });
    tRows.sort(function (a, b) { return b.k - a.k; });
    wrap.innerHTML = scoreCol('ct', '反恐精英', ctRows) + scoreCol('t', '恐怖分子', tRows);
    var st = rulesState();
    var score = (st && st.score) || { ct: 0, t: 0 };
    setText(refs['ds-sb-score'], 'CT ' + (score.ct || 0) + ' : ' + (score.t || 0) + ' T');
  }
  function scoreCol(team, title, rows) {
    var h = '<div class="ds-sb-team ds-sb-' + team + '">' +
      '<div class="ds-sb-teamhead"><span>' + esc(title) + '</span><span class="ds-sb-teamcount">' + rows.length + '</span></div>' +
      '<div class="ds-sb-hrow"><span>玩家</span><span>K</span><span>D</span><span>状态</span></div>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      h += '<div class="ds-sb-row' + (r.you ? ' you' : '') + (r.alive ? '' : ' dead') + '">' +
        '<span class="ds-sb-name">' + esc(r.name) + '</span>' +
        '<span class="ds-sb-k">' + r.k + '</span>' +
        '<span class="ds-sb-d">' + r.d + '</span>' +
        '<span class="ds-sb-state">' + (r.alive ? '存活' : '阵亡') + '</span></div>';
    }
    return h + '</div>';
  }
  function updateScoreboard(t) {
    var show = scoreboardVisible();
    setShown(refs['ds-scoreboard'], show);
    if (show && (scoreboardDirty || t - lastSbBuild > 0.3)) {
      scoreboardDirty = false;
      lastSbBuild = t;
      buildScoreboard();
    }
  }

  function updateMatchEnd(st) {
    if (!st) return;
    if (st.phase === 'matchEnd' && st.matchWinner && !flags.matchEndOpen) {
      H.showMatchEnd(st.matchWinner);
    }
  }

  /* ------------------------------------------------------------------ */
  /* menu input                                                         */
  /* ------------------------------------------------------------------ */
  function handleMenuInput() {
    if (!game) return;
    var inp = input();
    var pressed = inp.pressed || {};
    var keys = inp.keys || {};

    if (pressed.buy) {
      if (!flags.startOpen && !flags.matchEndOpen && !pauseVisible()) {
        if (flags.buyOpen) closeBuy(true);
        else openBuy();
      }
    }
    if (pressed.pause && flags.buyOpen) {
      closeBuy(true);
    }
    var tabHeld = !!keys['Tab'] || ownTabHeld;
    flags.scoreboardHeld = tabHeld && !flags.startOpen;
  }

  /* ------------------------------------------------------------------ */
  /* settings / start screen                                            */
  /* ------------------------------------------------------------------ */
  function syncStartSettings() {
    var s = (game && game.settings) || {};
    var diff = s.difficulty || 'normal';
    if (refs['ds-diff']) {
      var btns = refs['ds-diff'].querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        toggleClass(btns[i], 'sel', btns[i].getAttribute('data-diff') === diff);
      }
    }
    var sens = typeof s.sensitivity === 'number' ? s.sensitivity : 1;
    if (refs['ds-sens']) refs['ds-sens'].value = sens;
    setText(refs['ds-sens-val'], sens.toFixed(1) + '×');
    var vol = typeof s.volume === 'number' ? s.volume : 0.8;
    if (refs['ds-vol']) refs['ds-vol'].value = vol;
    setText(refs['ds-vol-val'], Math.round(vol * 100) + '%');
  }
  function saveSettings() {
    if (game && typeof game.saveSettings === 'function') {
      try { game.saveSettings(); } catch (e) {}
    }
  }
  function setDifficulty(value) {
    if (!game) return;
    game.settings = game.settings || {};
    game.settings.difficulty = value;
    if (typeof game.setDifficulty === 'function') {
      try { game.setDifficulty(value); } catch (e) {}
    }
    saveSettings();
  }
  function setSensitivity(value) {
    if (!game) return;
    game.settings = game.settings || {};
    game.settings.sensitivity = value;
    saveSettings();
  }
  function setVolume(value) {
    if (!game) return;
    game.settings = game.settings || {};
    game.settings.volume = value;
    if (CS.audio) { try { CS.audio.setVolume(value); } catch (e) {} }
    saveSettings();
  }

  /* ------------------------------------------------------------------ */
  /* event bindings                                                     */
  /* ------------------------------------------------------------------ */
  function bindEvents() {
    if (!root) return;

    /* start screen */
    var startBtn = refs['ds-start-btn'];
    if (startBtn) startBtn.addEventListener('click', function () {
      if (!game) return;
      try { if (CS.audio) { CS.audio.init(); CS.audio.setVolume((game.settings && game.settings.volume) || 0.8); } } catch (e) {}
      H.hideStart();
      callCallback('start');
    });

    var diffWrap = refs['ds-diff'];
    if (diffWrap) diffWrap.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-diff]') : null;
      if (!btn) return;
      var value = btn.getAttribute('data-diff');
      setDifficulty(value);
      var btns = diffWrap.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) toggleClass(btns[i], 'sel', btns[i] === btn);
    });

    if (refs['ds-sens']) refs['ds-sens'].addEventListener('input', function () {
      var v = parseFloat(this.value);
      if (!isFinite(v)) v = 1;
      setText(refs['ds-sens-val'], v.toFixed(1) + '×');
      setSensitivity(v);
    });
    if (refs['ds-vol']) refs['ds-vol'].addEventListener('input', function () {
      var v = parseFloat(this.value);
      if (!isFinite(v)) v = 0.8;
      setText(refs['ds-vol-val'], Math.round(v * 100) + '%');
      setVolume(v);
    });

    /* pause menu */
    if (refs['ds-resume-btn']) refs['ds-resume-btn'].addEventListener('click', function () {
      callCallback('resume');
    });
    if (refs['ds-restart-btn']) refs['ds-restart-btn'].addEventListener('click', function () {
      flags.pauseOpen = false;
      syncOverlays();
      callCallback('restart');
    });

    /* match end */
    if (refs['ds-again-btn']) refs['ds-again-btn'].addEventListener('click', function () {
      flags.matchEndOpen = false;
      flags.pauseOpen = false;
      syncOverlays();
      callCallback('restart');
    });

    /* buy overlay: click on the dark backdrop = cancel */
    if (refs['ds-buy']) refs['ds-buy'].addEventListener('click', function (ev) {
      if (ev.target === refs['ds-buy']) closeBuy(true);
    });

    /* keyboard fallbacks (Tab hold + buy digits). B / Esc go through
       game.input.pressed which main fills. */
    window.addEventListener('keydown', function (ev) {
      if (!inited) return;
      if (ev.code === 'Tab') {
        if (!flags.startOpen && !flags.matchEndOpen) {
          ownTabHeld = true;
          if (ev.preventDefault) ev.preventDefault();
        }
        return;
      }
      if (flags.buyOpen) {
        var idx = -1;
        if (ev.code === 'Digit1' || ev.code === 'Numpad1') idx = 0;
        else if (ev.code === 'Digit2' || ev.code === 'Numpad2') idx = 1;
        else if (ev.code === 'Digit3' || ev.code === 'Numpad3') idx = 2;
        else if (ev.code === 'Digit4' || ev.code === 'Numpad4') idx = 3;
        if (idx >= 0) {
          if (ev.preventDefault) ev.preventDefault();
          attemptBuy(BUY_ORDER[idx]);
        }
      }
    }, true);
    window.addEventListener('keyup', function (ev) {
      if (ev.code === 'Tab') ownTabHeld = false;
    }, true);
    window.addEventListener('blur', function () { ownTabHeld = false; });
  }

  /* ------------------------------------------------------------------ */
  /* init                                                               */
  /* ------------------------------------------------------------------ */
  H.init = function (g) {
    if (g) game = g;
    else if (!game) game = CS.game || null;
    if (inited) { syncStartSettings(); return; }

    var search = '';
    try { search = String(window.location.search || ''); } catch (e) {}
    autoMode = /[?&]auto=1/.test(search);
    hideuiMode = /[?&]hideui=1/.test(search);

    injectStyle();
    buildDom();
    bindEvents();
    inited = true;

    if (hideuiMode && root) root.style.display = 'none';

    flags.started = !!(game && game.started) || autoMode;
    flags.startOpen = !flags.started;
    syncStartSettings();
    syncOverlays();
    H.update(game, 0);
  };

  /* ------------------------------------------------------------------ */
  /* events                                                             */
  /* ------------------------------------------------------------------ */
  H.onEvent = function (ev) {
    if (!ev || !inited) return;
    var t = nowSec();
    switch (ev.type) {
      case 'kill': {
        addFeedEntry(ev);
        if (game && ev.victim === game.player) {
          deathInfo.killer = displayName(ev.killer);
          deathInfo.weapon = weaponName(ev.weapon);
          deathInfo.headshot = !!ev.headshot;
        }
        break;
      }
      case 'damage': {
        if (!game) break;
        if (ev.target === game.player) {
          flashDamage(ev.attacker);
        } else if (ev.attacker === game.player) {
          flashHitmarker(ev.zone === 'head', false);
        }
        break;
      }
      case 'hitmarker':
        flashHitmarker(!!ev.headshot, !!ev.kill);
        break;
      case 'roundStart': {
        var st = rulesState();
        clearFeed();
        hideBanner();
        deathInfo = { killer: '', weapon: '', headshot: false };
        toggleClass(refs['ds-death'], 'show', false);
        deadShown = false;
        if (refs['ds-dmgflash']) refs['ds-dmgflash'].classList.remove('flash');
        var round = (typeof ev.round === 'number' ? ev.round : (st && st.round)) || 1;
        H.banner('第 ' + round + ' 回合', '击杀所有敌人以赢下回合', 2.4);
        if (flags.buyOpen) closeBuy(false);
        refreshBuyCards(true);
        scoreboardDirty = true;
        break;
      }
      case 'roundEnd': {
        var w = ev.winner;
        if (w && typeof w === 'object') w = w.team || w.id;
        var label = w === 'ct' ? 'CT 胜利' : (w === 't' ? 'T 胜利' : '回合结束');
        H.banner(label, ev.reason ? String(ev.reason) : '', 2.8);
        if (flags.buyOpen) closeBuy(false);
        scoreboardDirty = true;
        break;
      }
      case 'matchEnd':
        H.showMatchEnd(ev.winner);
        break;
      case 'buy':
        refreshBuyCards(true);
        if (t > suppressBuyToastUntil) {
          H.toast(ev.ok === false ? '购买失败' : '购买成功');
        }
        break;
      default:
        break;
    }
  };

  /* ------------------------------------------------------------------ */
  /* per-frame update                                                   */
  /* ------------------------------------------------------------------ */
  H.update = function (g, dt) {
    if (!inited) return;
    if (g) game = g;
    else if (!game) game = CS.game || null;
    if (!game) return;

    var st = rulesState();
    var player = game.player || null;
    var t = nowSec();

    handleMenuInput();

    if (player) {
      updateVitals(player, st);
      updateAmmo(player);
      updateCrosshair(player);
      updateScope(player);
      updateDamageLayers(player);
      updateDeath(player, st);
      updateBuyTip(st, player);
    }
    updateTop(st);
    updateFeed(t);
    updateBanner(t);
    updateToast(t);
    updateMatchEnd(st);
    updateScoreboard(t);
    if (flags.buyOpen) refreshBuyCards(false);
    if (refs['ds-game'] && refs['ds-game'].classList.contains('ds-hidden')) {
      /* no-op: kept for forward compatibility */
    }
    syncOverlays();
  };

})();
