/* =========================================================================
 * DUST STRIKE — round flow, economy and buy logic
 * Owned by: Lead. Depends on: CONTRACT.md §12.
 * ========================================================================= */
(function () {
  'use strict';
  var CS = window.CS = window.CS || {};
  var R = CS.rules = CS.rules || {};
  var M = CS.math;

  var ROUNDS_TO_WIN = 8;
  var BUY_FREEZE = 8;          // seconds of frozen buy phase
  var BUY_TIME_TOTAL = 28;     // freeze 8 + 20s of buying while live
  var ROUND_TIME = 115;
  var ROUND_END_TIME = 5;

  var PRICES = { ak47: 2700, m4a1: 2900, awp: 4750, armor: 650 };
  var NAMES = { ak47: 'AK-47', m4a1: 'M4A1-S', awp: 'AWP', armor: '护甲+头盔' };

  /* remembered across rounds */
  var carry = { playerAlive: false, armor: 0 };

  var state = R.state = {
    phase: 'idle',
    phaseTime: 0,
    round: 0,
    score: { ct: 0, t: 0 },
    money: 800,
    buyTimeLeft: 0,
    roundTimeLeft: 0,
    canBuy: false,
    winner: null,
    reason: '',
    matchWinner: null
  };

  function emit(game, e) {
    if (game && game.emit) game.emit(e);
  }

  function spawnPoint(game) {
    var w = game && game.world;
    if (w && w.spawns && w.spawns.ct && w.spawns.ct.length) return w.spawns.ct[0];
    return { pos: [0, 0, -25], yaw: 0 };
  }

  function nearSpawn(game) {
    var p = game.player, sp = spawnPoint(game);
    if (!p || !p.pos) return false;
    var d = M.dist2D(p.pos[0], p.pos[2], sp.pos[0], sp.pos[2]);
    return d <= 10;
  }

  function countAlive(game) {
    var ct = game.player && game.player.alive ? 1 : 0;
    var t = 0;
    var bots = game.bots || [];
    for (var i = 0; i < bots.length; i++) {
      var b = bots[i];
      if (!b || !b.alive) continue;
      if (b.team === 't') t++; else if (b.team === 'ct') ct++;
    }
    return { ct: ct, t: t };
  }

  function resetRoundPositions(game) {
    if (CS.player && CS.player.resetForRound) {
      var sp = spawnPoint(game);
      CS.player.resetForRound(game, {
        pos: sp.pos.slice ? sp.pos.slice() : [sp.pos[0], sp.pos[1], sp.pos[2]],
        yaw: sp.yaw || 0,
        keepWeapons: !!carry.playerAlive,
        armor: carry.playerAlive ? (carry.armor | 0) : 0
      });
    }
    if (CS.bots && CS.bots.spawnRound) CS.bots.spawnRound(game);
    if (CS.fx && CS.fx.clear) CS.fx.clear();
  }

  function beginRound(game) {
    state.round++;
    state.phase = 'buy';
    state.phaseTime = BUY_FREEZE;
    state.roundTimeLeft = ROUND_TIME;
    state.buyTimeLeft = BUY_TIME_TOTAL;
    state.canBuy = true;
    state.winner = null;
    state.reason = '';
    game.frozen = true;
    resetRoundPositions(game);
    emit(game, { type: 'roundStart', round: state.round, phase: 'buy' });
  }

  function reasonText(reason) {
    if (reason === 'elimination') return '全灭';
    if (reason === 'time') return '时间耗尽';
    return reason || '';
  }

  function endRound(game, winner, reason) {
    if (state.phase !== 'live') return;
    if (winner !== 'ct' && winner !== 't') return;
    state.score[winner] = (state.score[winner] || 0) + 1;
    state.winner = winner;
    state.reason = reasonText(reason);
    state.phase = 'roundEnd';
    state.phaseTime = ROUND_END_TIME;
    state.canBuy = false;
    game.frozen = true;

    carry.playerAlive = !!(game.player && game.player.alive);
    carry.armor = carry.playerAlive ? (game.player.armor || 0) : 0;

    var playerWon = winner === 'ct';
    state.money = Math.min(16000, state.money + (playerWon ? 3250 : 1400));

    if (state.score[winner] >= ROUNDS_TO_WIN) state.matchWinner = winner;

    emit(game, {
      type: 'roundEnd',
      winner: winner,
      reason: state.reason,
      reasonCode: reason,
      score: { ct: state.score.ct, t: state.score.t }
    });
  }

  R.init = function (game) {
    R.game = game;
    game.rules = R;
    state.phase = 'idle';
    return R;
  };

  R.startMatch = function (game) {
    game = game || R.game;
    state.score.ct = 0;
    state.score.t = 0;
    state.round = 0;
    state.money = 800;
    state.winner = null;
    state.reason = '';
    state.matchWinner = null;
    carry.playerAlive = false;
    carry.armor = 0;
    if (CS.hud && CS.hud.reset) { try { CS.hud.reset(); } catch (e) {} }
    beginRound(game);
  };

  R.update = function (game, dt) {
    if (!game) return;
    var st = state;
    st.canBuy = nearSpawn(game) && (st.phase === 'buy' || (st.phase === 'live' && st.buyTimeLeft > 0));

    if (st.phase === 'buy') {
      st.phaseTime -= dt;
      st.buyTimeLeft = Math.max(0, st.buyTimeLeft - dt);
      if (st.phaseTime <= 0) {
        st.phase = 'live';
        st.phaseTime = ROUND_TIME;
        st.roundTimeLeft = ROUND_TIME;
        game.frozen = false;
        st.canBuy = nearSpawn(game) && st.buyTimeLeft > 0;
      }
      return;
    }

    if (st.phase === 'live') {
      st.roundTimeLeft = Math.max(0, st.roundTimeLeft - dt);
      st.phaseTime = st.roundTimeLeft;
      st.buyTimeLeft = Math.max(0, st.buyTimeLeft - dt);
      var alive = countAlive(game);
      if (alive.t === 0) { endRound(game, 'ct', 'elimination'); return; }
      if (alive.ct === 0) { endRound(game, 't', 'elimination'); return; }
      if (st.roundTimeLeft <= 0) { endRound(game, 'ct', 'time'); return; }
      return;
    }

    if (st.phase === 'roundEnd') {
      st.phaseTime -= dt;
      if (st.phaseTime <= 0) {
        if (st.matchWinner) {
          st.phase = 'matchEnd';
          st.phaseTime = 0;
          game.frozen = true;
          emit(game, { type: 'matchEnd', winner: st.matchWinner, score: { ct: st.score.ct, t: st.score.t } });
        } else {
          beginRound(game);
        }
      }
      return;
    }
    /* idle / matchEnd: nothing ticking */
  };

  R.onEvent = function (event) {
    if (!event || event.type !== 'kill') return;
    var game = R.game;
    var killer = event.killer || null;
    var victim = event.victim || null;
    if (victim && victim !== killer) victim.deaths = (victim.deaths || 0) + 1;
    if (killer && killer !== victim) killer.kills = (killer.kills || 0) + 1;
    if (game && killer === game.player && victim && victim.team && victim.team !== 'ct') {
      state.money = Math.min(16000, state.money + 300);
    }
  };

  R.buy = function (game, itemId) {
    game = game || R.game;
    if (!game || !game.player) return { ok: false, msg: '游戏未开始' };
    if (!state.canBuy) return { ok: false, msg: '现在无法购买' };
    if (!game.player.alive) return { ok: false, msg: '你已阵亡' };
    var price = PRICES[itemId];
    if (!price) return { ok: false, msg: '无效商品' };
    if (state.money < price) return { ok: false, msg: '资金不足' };
    if (itemId === 'armor') {
      if ((game.player.armor || 0) >= 100) return { ok: false, msg: '已经拥有护甲' };
      state.money -= price;
      game.player.armor = 100;
    } else {
      state.money -= price;
      if (!CS.player || !CS.player.equip) return { ok: false, msg: '武器系统未就绪' };
      CS.player.equip(game, itemId);
    }
    emit(game, { type: 'buy', itemId: itemId, ok: true, price: price, money: state.money });
    return { ok: true, msg: '已购买 ' + (NAMES[itemId] || itemId) };
  };

  R.prices = PRICES;
  R.names = NAMES;
  R.ROUNDS_TO_WIN = ROUNDS_TO_WIN;
})();
