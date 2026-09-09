'use strict';

/* ============================================================
   BLACKJACK — client de la table partagée
   ------------------------------------------------------------
   Ce script ne décide plus de rien : le serveur (server.js) fait
   autorité sur le sabot, les mains, les tours et les soldes. Le
   client se contente d'envoyer les actions du joueur et de rendre
   à l'écran chaque "state" reçu par websocket. Reconnexion auto en
   cas de coupure.
   ============================================================ */

const PLAYER_ID_KEY = 'maison21_playerId';
const BANKROLL_CACHE_KEY = 'maison21_bankroll'; // simple cache d'affichage hors-ligne
const MAX_HANDS = 4;

// ---------- Identité persistante du navigateur ----------
function loadOrCreatePlayerId() {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}
const myPlayerId = loadOrCreatePlayerId();

function cacheBankroll(n) {
  try { localStorage.setItem(BANKROLL_CACHE_KEY, String(n)); } catch { /* ignore */ }
}
function loadCachedBankroll() {
  const n = parseInt(localStorage.getItem(BANKROLL_CACHE_KEY), 10);
  return Number.isFinite(n) ? n : 1000;
}

// ---------- DOM refs ----------
const els = {
  bankroll: document.getElementById('bankroll'),
  bankrollPill: document.querySelector('.bankroll-pill'),
  playersCount: document.getElementById('playersCount'),
  playersPill: document.getElementById('playersPill'),
  connDot: document.getElementById('connDot'),
  chipRack: document.getElementById('chipRack'),
  clearBetBtn: document.getElementById('clearBetBtn'),
  addHandBtn: document.getElementById('addHandBtn'),
  betZone: document.getElementById('betZone'),
  ownHandsTabs: document.getElementById('ownHandsTabs'),
  gameActions: document.getElementById('gameActions'),
  hitBtn: document.getElementById('hitBtn'),
  standBtn: document.getElementById('standBtn'),
  doubleBtn: document.getElementById('doubleBtn'),
  waitingNote: document.getElementById('waitingNote'),
  dealerCards: document.getElementById('dealerCards'),
  dealerScore: document.getElementById('dealerScore'),
  handsRow: document.getElementById('handsRow'),
  statusMessage: document.getElementById('statusMessage'),
  bettingTimer: document.getElementById('bettingTimer'),
  toast: document.getElementById('toast'),
  rulesBtn: document.getElementById('rulesBtn'),
  closeRulesBtn: document.getElementById('closeRulesBtn'),
  rulesModal: document.getElementById('rulesModal'),
  shoeStack: document.getElementById('shoeStack'),
  shoeCount: document.getElementById('shoeCount'),
  shoeDecks: document.getElementById('shoeDecks'),
  dealerCallout: document.getElementById('dealerCallout'),
};

// ---------- État local ----------
let latestState = null;
let selectedHandIndex = 0;
let dealerCalloutTimer = null;
let bettingTickInterval = null;
const cardRenderCache = new Map(); // key -> { count, holeRevealed }
const podElements = new Map();     // key -> DOM element du pod de main

// ---------- Rendu des cartes ----------
function renderCardFace(card) {
  const isRed = card.color === 'red';
  return `
    <div class="card-face card-front${isRed ? ' red' : ''}">
      <div class="card-rank-top"><span>${card.rank}</span><span class="card-suit-small">${card.symbol}</span></div>
      <div class="card-suit-center">${card.symbol}</div>
      <div class="card-rank-bottom"><span>${card.rank}</span><span class="card-suit-small">${card.symbol}</span></div>
    </div>`;
}

function makeCardSlot(card) {
  const slot = document.createElement('div');
  slot.className = 'card-slot';
  if (card.hidden) {
    // Carte cachée : uniquement le dos, affiché grâce à la classe
    // "flipped" qui fait pivoter card-inner de 180° (voir style.css).
    slot.classList.add('flipped');
    slot.innerHTML = `<div class="card-inner"><div class="card-face card-back"></div></div>`;
  } else {
    slot.innerHTML = `<div class="card-inner">${renderCardFace(card)}<div class="card-face card-back"></div></div>`;
  }
  return slot;
}

// Rend une liste de cartes dans un conteneur en ne touchant qu'aux
// cartes nouvellement ajoutées (évite de rejouer les animations sur
// des mises à jour qui ne concernent pas cette main).
function renderCardsIncremental(container, cardsData, cacheKey, holeRevealed) {
  let cache = cardRenderCache.get(cacheKey);
  if (!cache) { cache = { count: 0, holeRevealed: false }; cardRenderCache.set(cacheKey, cache); }

  if (cardsData.length < cache.count) {
    container.innerHTML = '';
    cache.count = 0;
    cache.holeRevealed = false;
  }

  for (let i = cache.count; i < cardsData.length; i++) {
    container.appendChild(makeCardSlot(cardsData[i]));
  }

  // Révélation de la carte cachée du croupier : on remplace le contenu
  // du slot existant plutôt que de le recréer, pour un rendu propre.
  if (holeRevealed !== undefined && !cache.holeRevealed && holeRevealed) {
    const slot = container.children[1];
    const card = cardsData[1];
    if (slot && card && !card.hidden) {
      slot.querySelector('.card-inner').innerHTML = `${renderCardFace(card)}<div class="card-face card-back"></div>`;
      // Retire "flipped" pour déclencher l'animation de retournement CSS.
      requestAnimationFrame(() => slot.classList.remove('flipped'));
    }
  }

  cache.count = cardsData.length;
  if (holeRevealed !== undefined) cache.holeRevealed = holeRevealed;
}

function labelForHand(total, isSoft, cardsLength, state) {
  if (cardsLength === 0) return '';
  if (state === 'blackjack' || (cardsLength === 2 && total === 21)) return 'Blackjack !';
  if (total > 21) return `${total} — Sauté`;
  return isSoft && total !== 21 ? `${total} (souple)` : `${total}`;
}

function applyScoreBadgeClasses(el, total, cardsLength) {
  el.className = 'hand-score';
  if (total > 21) el.classList.add('bust');
  if (cardsLength === 2 && total === 21) el.classList.add('blackjack');
}

// ---------- Rendu du croupier ----------
function renderDealer(dealer) {
  renderCardsIncremental(els.dealerCards, dealer.cards, 'dealer', dealer.holeRevealed);

  if (dealer.cards.length === 0) {
    els.dealerScore.textContent = '';
    els.dealerScore.className = 'hand-score';
    return;
  }
  if (!dealer.holeRevealed) {
    const up = dealer.cards[0];
    els.dealerScore.textContent = up.hidden ? '' : `${up.rank}${up.symbol}`;
    els.dealerScore.className = 'hand-score';
    return;
  }
  const label = labelForHand(dealer.total, dealer.isSoft, dealer.cards.length, dealer.isBlackjack ? 'blackjack' : '');
  els.dealerScore.textContent = label;
  applyScoreBadgeClasses(els.dealerScore, dealer.total, dealer.cards.length);
}

// ---------- Rendu de la rangée de mains (tous les joueurs) ----------
function renderHandsRow(state) {
  const seenKeys = new Set();

  state.players.forEach((player) => {
    const isMe = player.id === myPlayerId;
    player.hands.forEach((hand, handIndex) => {
      const key = `${player.id}:${handIndex}`;

      // Table propre : on n'affiche pas les emplacements vides des
      // joueurs déconnectés (ils restent en mémoire pour retrouver
      // leur solde à la reconnexion, mais n'encombrent pas la table).
      const isEmpty = hand.bet <= 0 && hand.cards.length === 0;
      if (!player.connected && isEmpty && !isMe) return;

      seenKeys.add(key);

      let pod = podElements.get(key);
      if (!pod) {
        pod = document.createElement('div');
        pod.className = 'hand-pod';
        pod.innerHTML = `
          <div class="hand-pod-owner"></div>
          <div class="hand-score"></div>
          <div class="cards"></div>
          <div class="hand-pod-footer">
            <span class="hand-pod-bet"></span>
            <span class="hand-pod-result"></span>
          </div>`;
        podElements.set(key, pod);
      }
      els.handsRow.appendChild(pod); // no-op si déjà au bon endroit, sinon déplace sans recréer

      const isActive = state.activeTurn && state.activeTurn.playerId === player.id && state.activeTurn.handIndex === handIndex;
      pod.classList.toggle('mine', isMe);
      pod.classList.toggle('active-turn', !!isActive);
      pod.classList.toggle('empty', hand.cards.length === 0 && hand.bet === 0);

      const ownerLabel = player.hands.length > 1 ? `${player.name} · Main ${handIndex + 1}` : player.name;
      pod.querySelector('.hand-pod-owner').innerHTML = isMe
        ? `<span class="me-badge">Vous${player.hands.length > 1 ? ` · Main ${handIndex + 1}` : ''}</span>`
        : ownerLabel;

      const cardsEl = pod.querySelector('.cards');
      renderCardsIncremental(cardsEl, hand.cards, key, undefined);

      const scoreEl = pod.querySelector('.hand-score');
      scoreEl.textContent = labelForHand(hand.total, hand.isSoft, hand.cards.length, hand.state);
      applyScoreBadgeClasses(scoreEl, hand.total, hand.cards.length);

      const betEl = pod.querySelector('.hand-pod-bet');
      betEl.textContent = hand.bet > 0 ? `Mise : ${hand.bet.toLocaleString('fr-FR')}` : '';
      betEl.hidden = hand.bet <= 0;

      const resultEl = pod.querySelector('.hand-pod-result');
      if (hand.result) {
        const txt = hand.result === 'win' ? `+${hand.payout}` : hand.result === 'push' ? 'Push' : 'Perdu';
        resultEl.textContent = txt;
        resultEl.className = `hand-pod-result ${hand.result}`;
      } else {
        resultEl.textContent = '';
        resultEl.className = 'hand-pod-result';
      }
    });
  });

  // Nettoie les pods de mains qui n'existent plus (main retirée, joueur parti au reset).
  for (const [key, pod] of podElements) {
    if (!seenKeys.has(key)) {
      pod.remove();
      podElements.delete(key);
      cardRenderCache.delete(key);
    }
  }
}

// ---------- Mise / mes mains ----------
function myPlayer(state) {
  return state.players.find((p) => p.id === myPlayerId) || null;
}

function renderOwnHandsTabs(state) {
  const me = myPlayer(state);
  if (!me) { els.ownHandsTabs.innerHTML = ''; return; }

  if (selectedHandIndex >= me.hands.length) selectedHandIndex = Math.max(0, me.hands.length - 1);

  els.ownHandsTabs.innerHTML = '';
  me.hands.forEach((hand, i) => {
    const tab = document.createElement('div');
    tab.className = 'hand-tab' + (i === selectedHandIndex ? ' selected' : '');
    tab.innerHTML = `<span>Main ${i + 1}</span><span class="amount">${hand.bet.toLocaleString('fr-FR')}</span>`;
    tab.addEventListener('click', () => { selectedHandIndex = i; renderOwnHandsTabs(latestState); });
    if (me.hands.length > 1) {
      const rm = document.createElement('span');
      rm.className = 'remove-hand';
      rm.textContent = '×';
      rm.title = 'Retirer cette main';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        send({ type: 'removeHand', handIndex: i });
      });
      tab.appendChild(rm);
    }
    els.ownHandsTabs.appendChild(tab);
  });

  els.addHandBtn.disabled = me.hands.length >= MAX_HANDS;
}

function updateChipAvailability(state) {
  const me = myPlayer(state);
  const bankroll = me ? me.bankroll : loadCachedBankroll();
  const totalBet = me ? me.hands.reduce((s, h) => s + h.bet, 0) : 0;
  const chips = els.chipRack.querySelectorAll('.chip');
  chips.forEach((chip) => {
    const val = parseInt(chip.dataset.value, 10);
    chip.disabled = val > bankroll - totalBet;
  });
}

// ---------- Sabot ----------
function updateShoeVisual(shoeState) {
  const fraction = Math.max(shoeState.remaining / shoeState.total, 0);
  els.shoeStack.style.height = `${Math.max(fraction * 100, 2)}%`;
  els.shoeCount.textContent = shoeState.remaining;
  els.shoeCount.classList.toggle('low', shoeState.remaining <= shoeState.cutCardIndex + 20);
  els.shoeDecks.textContent = `${(shoeState.remaining / 52).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} jeux`;
}

// ---------- Statut / minuteur de mise ----------
function setStatus(message, kind = '') {
  if (els.statusMessage.textContent === message && els.statusMessage.className.includes(kind)) return;
  els.statusMessage.textContent = message;
  els.statusMessage.className = 'status-message';
  if (kind) els.statusMessage.classList.add(kind);
  void els.statusMessage.offsetWidth;
  els.statusMessage.classList.add('pop');
}

function tickBettingTimer() {
  if (!latestState || latestState.phase !== 'betting') {
    els.bettingTimer.hidden = true;
    return;
  }
  const remainingMs = latestState.bettingEndsAt - Date.now();
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  els.bettingTimer.hidden = false;
  els.bettingTimer.textContent = `Distribution dans ${seconds}s`;
  els.bettingTimer.classList.toggle('urgent', seconds <= 5);
}

// ---------- Toast / annonces du croupier ----------
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

function sayDealer(text, duration = 2600) {
  clearTimeout(dealerCalloutTimer);
  els.dealerCallout.innerHTML = `<span>${text}</span>`;
  dealerCalloutTimer = setTimeout(() => { els.dealerCallout.innerHTML = ''; }, duration);
}

// ---------- Rendu global à partir d'un "state" serveur ----------
function render(state) {
  latestState = state;

  // Connexion / joueurs à table
  els.playersCount.textContent = state.playersCount;

  // Bankroll (le mien)
  const me = myPlayer(state);
  const bankroll = me ? me.bankroll : loadCachedBankroll();
  els.bankroll.textContent = bankroll.toLocaleString('fr-FR');
  cacheBankroll(bankroll);

  updateShoeVisual(state.shoe);
  renderDealer(state.dealer);
  renderHandsRow(state);
  updateChipAvailability(state);

  setStatus(state.statusMessage, state.statusKind);
  tickBettingTimer();

  // Zone de mise visible seulement pendant la phase de mise.
  const betting = state.phase === 'betting';
  els.betZone.hidden = !betting;
  els.betZone.style.display = betting ? 'flex' : 'none';
  if (betting) renderOwnHandsTabs(state);

  // Actions de jeu : visibles pendant playing/dealer/resolved, actives
  // seulement si c'est mon tour.
  const showActions = state.phase === 'playing' || state.phase === 'dealer' || state.phase === 'resolved';
  els.gameActions.hidden = !showActions;

  const myTurn = state.phase === 'playing' && state.activeTurn && state.activeTurn.playerId === myPlayerId;
  els.hitBtn.hidden = !myTurn;
  els.standBtn.hidden = !myTurn;
  const activeHandMine = myTurn ? me.hands[state.activeTurn.handIndex] : null;
  els.doubleBtn.hidden = !myTurn || !activeHandMine || activeHandMine.cards.length !== 2;
  els.hitBtn.disabled = !myTurn;
  els.standBtn.disabled = !myTurn;
  els.doubleBtn.disabled = !myTurn || !activeHandMine || (bankroll < (activeHandMine ? activeHandMine.bet : Infinity));
  els.waitingNote.hidden = myTurn || !showActions;
}

// ---------- Connexion WebSocket ----------
let ws = null;
let reconnectDelay = 1000;
const RECONNECT_MAX = 10000;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function connect() {
  setStatus('Connexion à la table…');
  els.connDot.classList.remove('online');

  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    els.connDot.classList.add('online');
    send({ type: 'hello', playerId: myPlayerId });
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type === 'welcome') {
      cacheBankroll(msg.bankroll);
    } else if (msg.type === 'state') {
      render(msg);
    } else if (msg.type === 'dealerSay') {
      sayDealer(msg.text, msg.duration);
    } else if (msg.type === 'toast') {
      showToast(msg.text);
    }
  });

  const onDown = () => {
    latestState = null; // évite d'afficher un minuteur/état périmé pendant la coupure
    els.connDot.classList.remove('online');
    setStatus('Connexion perdue — reconnexion…');
    els.gameActions.hidden = true;
    els.betZone.hidden = true;
    els.bettingTimer.hidden = true;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, RECONNECT_MAX);
  };
  ws.addEventListener('close', onDown);
  ws.addEventListener('error', () => { try { ws.close(); } catch { /* ignore */ } });
}

// ---------- Actions du joueur ----------
els.chipRack.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || chip.disabled) return;
  send({ type: 'bet', handIndex: selectedHandIndex, amount: parseInt(chip.dataset.value, 10) });
});
els.clearBetBtn.addEventListener('click', () => send({ type: 'clearBet', handIndex: selectedHandIndex }));
els.addHandBtn.addEventListener('click', () => send({ type: 'addHand' }));
els.hitBtn.addEventListener('click', () => send({ type: 'hit' }));
els.standBtn.addEventListener('click', () => send({ type: 'stand' }));
els.doubleBtn.addEventListener('click', () => send({ type: 'double' }));

els.rulesBtn.addEventListener('click', () => els.rulesModal.classList.add('open'));
els.closeRulesBtn.addEventListener('click', () => els.rulesModal.classList.remove('open'));
els.rulesModal.addEventListener('click', (e) => {
  if (e.target === els.rulesModal) els.rulesModal.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') els.rulesModal.classList.remove('open');
  if (!latestState) return;
  const myTurn = latestState.phase === 'playing' && latestState.activeTurn && latestState.activeTurn.playerId === myPlayerId;
  if (myTurn) {
    if (e.key.toLowerCase() === 'h') send({ type: 'hit' });
    if (e.key.toLowerCase() === 's') send({ type: 'stand' });
    if (e.key.toLowerCase() === 'd' && !els.doubleBtn.disabled) send({ type: 'double' });
  }
});

// ---------- Init ----------
els.bankroll.textContent = loadCachedBankroll().toLocaleString('fr-FR');
els.gameActions.hidden = true;
els.betZone.hidden = true;
bettingTickInterval = setInterval(tickBettingTimer, 500);
connect();
