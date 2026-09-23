'use strict';

/* ============================================================
   POKER TEXAS HOLD'EM — client de la table partagée
   ------------------------------------------------------------
   Ce script ne décide plus de rien : le serveur (server.js) fait
   autorité sur le sabot, les mains, les tours, l'IA et les soldes.
   Le client se contente d'envoyer les actions du joueur et de
   rendre à l'écran chaque "state" reçu par websocket — un state
   déjà personnalisé par le serveur pour ce viewer précis (ses
   propres cartes visibles, celles des autres masquées). Le client
   n'a donc JAMAIS à décider lui-même quoi cacher : il affiche
   fidèlement ce qu'on lui envoie.

   Important (sécurité) : tout texte contrôlé par un joueur (pseudo)
   est injecté via textContent, jamais via innerHTML, pour ne
   jamais exécuter de HTML/JS arbitraire saisi par un utilisateur.

   Reconnexion auto en cas de coupure, avec ré-identification par
   playerId persistant (localStorage) pour retrouver le même siège.
   ============================================================ */

const PLAYER_ID_KEY = 'maison21_playerId';
const NAME_CACHE_KEY = 'maison21_poker_name';
const BANKROLL_CACHE_KEY = 'maison21_poker_bankroll';
const SEAT_COUNT = 6;

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

function cacheName(n) { try { localStorage.setItem(NAME_CACHE_KEY, n); } catch { /* ignore */ } }
function loadCachedName() { try { return localStorage.getItem(NAME_CACHE_KEY) || ''; } catch { return ''; } }
function cacheBankroll(n) { try { localStorage.setItem(BANKROLL_CACHE_KEY, String(n)); } catch { /* ignore */ } }

// ---------- DOM refs ----------
const els = {
  bankroll: document.getElementById('bankroll'),
  identityPill: document.getElementById('identityPill'),
  connDot: document.getElementById('connDot'),
  myName: document.getElementById('myName'),
  nameBtn: document.getElementById('nameBtn'),
  nameModal: document.getElementById('nameModal'),
  nameInput: document.getElementById('nameInput'),
  saveNameBtn: document.getElementById('saveNameBtn'),
  closeNameBtn: document.getElementById('closeNameBtn'),

  rulesBtn: document.getElementById('rulesBtn'),
  closeRulesBtn: document.getElementById('closeRulesBtn'),
  rulesModal: document.getElementById('rulesModal'),
  soundBtn: document.getElementById('soundBtn'),

  // Classement (leaderboard)
  leaderboardBtn: document.getElementById('leaderboardBtn'),
  leaderboardModal: document.getElementById('leaderboardModal'),
  closeLeaderboardBtn: document.getElementById('closeLeaderboardBtn'),
  leaderboardList: document.getElementById('leaderboardList'),

  handSubText: document.getElementById('handSubText'),
  seatsRing: document.getElementById('seatsRing'),
  communityCards: document.getElementById('communityCards'),
  potAmount: document.getElementById('potAmount'),
  dealerCallout: document.getElementById('dealerCallout'),
  statusMessage: document.getElementById('statusMessage'),
  nextHandNote: document.getElementById('nextHandNote'),

  turnTimerBar: document.getElementById('turnTimerBar'),
  turnTimerFill: document.getElementById('turnTimerFill'),
  turnTimerText: document.getElementById('turnTimerText'),

  gameActions: document.getElementById('gameActions'),
  foldBtn: document.getElementById('foldBtn'),
  checkCallBtn: document.getElementById('checkCallBtn'),
  raiseBtn: document.getElementById('raiseBtn'),
  raiseZone: document.getElementById('raiseZone'),
  raiseSlider: document.getElementById('raiseSlider'),
  raiseAmountDisplay: document.getElementById('raiseAmountDisplay'),
  presetHalfPot: document.getElementById('presetHalfPot'),
  presetPot: document.getElementById('presetPot'),
  presetAllin: document.getElementById('presetAllin'),
  confirmRaiseBtn: document.getElementById('confirmRaiseBtn'),
  cancelRaiseBtn: document.getElementById('cancelRaiseBtn'),

  waitZone: document.getElementById('waitZone'),
  waitMessage: document.getElementById('waitMessage'),

  toast: document.getElementById('toast'),
};

// ============================================================
// RENDU DES CARTES (identique dans l'esprit au Blackjack) —
// diffing léger pour n'animer que les cartes réellement nouvelles
// et gérer le retournement (face cachée -> face visible).
// ============================================================
function fillCardFront(slot, card) {
  const front = slot.querySelector('.card-front');
  front.classList.toggle('red', card.color === 'red');
  front.innerHTML = '';
  const top = document.createElement('div');
  top.className = 'card-rank-top';
  const topRank = document.createElement('span'); topRank.textContent = card.rank;
  const topSuit = document.createElement('span'); topSuit.className = 'card-suit-small'; topSuit.textContent = card.symbol;
  top.append(topRank, topSuit);

  const center = document.createElement('div');
  center.className = 'card-suit-center';
  center.textContent = card.symbol;

  const bottom = document.createElement('div');
  bottom.className = 'card-rank-bottom';
  const botRank = document.createElement('span'); botRank.textContent = card.rank;
  const botSuit = document.createElement('span'); botSuit.className = 'card-suit-small'; botSuit.textContent = card.symbol;
  bottom.append(botRank, botSuit);

  front.append(top, center, bottom);
}

function createCardSlot(card) {
  const slot = document.createElement('div');
  slot.className = 'card-slot';
  const inner = document.createElement('div');
  inner.className = 'card-inner';
  const front = document.createElement('div');
  front.className = 'card-face card-front';
  const back = document.createElement('div');
  back.className = 'card-face card-back';
  inner.append(front, back);
  slot.appendChild(inner);

  if (card.hidden) {
    slot.classList.add('flipped');
    slot.dataset.hidden = '1';
  } else {
    fillCardFront(slot, card);
    slot.dataset.hidden = '0';
    slot.dataset.sig = card.rank + card.suit;
  }
  return slot;
}

// Synchronise le contenu d'un conteneur de cartes avec le tableau
// `cards` reçu du serveur, sans tout reconstruire (pour préserver les
// animations CSS et éviter un flip visuel intempestif).
// Conteneurs déjà rendus au moins une fois : sert à ne PAS jouer le son de
// distribution lors du tout premier rendu (chargement de page/reconnexion,
// où toutes les cartes déjà en jeu apparaissent d'un coup).
const cardContainersSeen = new WeakSet();

function syncCards(container, cards) {
  const isFirstRender = !cardContainersSeen.has(container);
  cardContainersSeen.add(container);
  const hadChildren = container.children.length;
  while (container.children.length > cards.length) container.removeChild(container.lastChild);
  cards.forEach((card, i) => {
    let slot = container.children[i];
    if (!slot) {
      container.appendChild(createCardSlot(card));
      if (!isFirstRender && i >= hadChildren) Maison21Sound.cardDeal();
      return;
    }
    const isHidden = !!card.hidden;
    const wasHidden = slot.dataset.hidden === '1';
    if (wasHidden && !isHidden) {
      fillCardFront(slot, card);
      slot.dataset.sig = card.rank + card.suit;
      slot.dataset.hidden = '0';
      slot.classList.remove('flipped');
    } else if (!isHidden) {
      const sig = card.rank + card.suit;
      if (slot.dataset.sig !== sig) { fillCardFront(slot, card); slot.dataset.sig = sig; }
    } else if (!wasHidden && isHidden) {
      // Ne devrait pas arriver (le serveur ne re-cache jamais une carte
      // révélée), mais on reste défensif.
      slot.classList.add('flipped');
      slot.dataset.hidden = '1';
    }
  });
}

// ============================================================
// ANNEAU DE SIÈGES (6 positions visuelles fixes autour de la table)
// ------------------------------------------------------------
// Les positions visuelles pos0..pos5 sont fixes en CSS ; pos0 est
// toujours "vous" quand vous êtes assis (rotation de l'affichage),
// sinon l'ordre brut des sièges serveur est utilisé (spectateur).
// ============================================================
const seatSlots = []; // { root, avatar, connBadge, badges, name, tag, cards, stack, bet, callout }

function buildSeatSkeleton(pos) {
  const root = document.createElement('div');
  root.className = `seat seat-pos-${pos}`;

  const callout = document.createElement('div');
  callout.className = 'seat-callout';

  const head = document.createElement('div');
  head.className = 'seat-head';
  const avatar = document.createElement('div');
  avatar.className = 'seat-avatar';
  const badges = document.createElement('div');
  badges.className = 'seat-badges';
  head.append(avatar, badges);

  const name = document.createElement('div');
  name.className = 'seat-name';
  const tag = document.createElement('div');
  tag.className = 'seat-tag';

  const cards = document.createElement('div');
  cards.className = 'seat-cards';

  const hand = document.createElement('div');
  hand.className = 'seat-hand-label';

  const statsRow = document.createElement('div');
  statsRow.className = 'seat-stats-row';
  const stack = document.createElement('span');
  stack.className = 'seat-stack';
  const bet = document.createElement('span');
  bet.className = 'seat-bet';
  statsRow.append(stack, bet);

  root.append(callout, head, name, tag, cards, hand, statsRow);
  els.seatsRing.appendChild(root);
  return { root, callout, avatar, badges, name, tag, cards, hand, stack, bet };
}

function ensureSeatSlots() {
  if (seatSlots.length) return;
  for (let p = 0; p < SEAT_COUNT; p++) seatSlots.push(buildSeatSkeleton(p));
}

let calloutTimers = new Map();
function showCallout(el, text, duration) {
  el.textContent = text; // texte fixe côté serveur (répliques RP), mais textContent par prudence
  el.classList.add('show');
  clearTimeout(calloutTimers.get(el));
  calloutTimers.set(el, setTimeout(() => { el.classList.remove('show'); }, duration));
}

function updateSeatSlot(slot, seatData, ctx) {
  const { root } = slot;
  root.classList.toggle('seat--empty', seatData.type === 'empty');
  root.classList.toggle('seat--you', !!seatData.isYou);
  root.classList.toggle('seat--folded', !!seatData.folded);
  root.classList.toggle('seat--allin', !!seatData.allIn);
  root.classList.toggle('seat--disconnected', seatData.type === 'human' && !seatData.connected);
  root.classList.toggle('seat--active-turn', ctx.turnSeat === seatData.index && ctx.handInProgress);
  root.classList.toggle('seat--winner', ctx.winners.includes(seatData.index));

  if (seatData.type === 'empty') {
    slot.avatar.textContent = '💺';
    slot.badges.innerHTML = '';
    slot.name.textContent = 'Siège libre';
    slot.tag.textContent = '';
    syncCards(slot.cards, []);
    slot.hand.textContent = '';
    slot.stack.textContent = '';
    slot.bet.textContent = '';
    return;
  }

  slot.avatar.textContent = seatData.avatar || '🂠';
  slot.name.textContent = seatData.name || '';
  slot.tag.textContent = seatData.tag || '';

  const badges = [];
  if (ctx.dealerSeat === seatData.index) badges.push({ cls: 'd', text: 'D' });
  if (ctx.sbSeat === seatData.index) badges.push({ cls: 'sb', text: 'SB' });
  if (ctx.bbSeat === seatData.index) badges.push({ cls: 'bb', text: 'BB' });
  slot.badges.innerHTML = '';
  badges.forEach((b) => {
    const span = document.createElement('span');
    span.className = `seat-badge ${b.cls}`;
    span.textContent = b.text;
    slot.badges.appendChild(span);
  });
  if (seatData.type === 'human' && !seatData.connected) {
    const off = document.createElement('span');
    off.className = 'seat-badge offline';
    off.title = 'Déconnecté';
    off.textContent = '⏻';
    slot.badges.appendChild(off);
  }

  syncCards(slot.cards, seatData.cards || []);
  slot.hand.textContent = seatData.isYou ? (ctx.bestHandLabel || '') : '';
  slot.stack.textContent = seatData.stack.toLocaleString('fr-FR');
  slot.bet.textContent = seatData.streetBet > 0 ? seatData.streetBet.toLocaleString('fr-FR') : '';
}

// ============================================================
// ÉTAT COURANT + BOUCLE DE RENDU PRINCIPALE
// ============================================================
let latestState = null;
let lastSoundedWinHand = -1; // numéro de main pour laquelle le chime de victoire a déjà joué

function render(state) {
  latestState = state;
  ensureSeatSlots();

  // ---------- Rotation d'affichage : "vous" toujours en position 0 ----------
  const iAmSeated = state.you && !state.you.waiting && state.you.seatIndex != null;
  const rotationOffset = iAmSeated ? state.you.seatIndex : 0;

  const ctx = {
    turnSeat: state.turnSeat,
    handInProgress: state.handInProgress,
    winners: state.winners || [],
    dealerSeat: state.dealerSeat,
    sbSeat: state.sbSeat,
    bbSeat: state.bbSeat,
    bestHandLabel: state.you ? state.you.bestHandLabel : '',
  };

  for (let pos = 0; pos < SEAT_COUNT; pos++) {
    const actualIndex = (rotationOffset + pos) % SEAT_COUNT;
    const seatData = state.seats[actualIndex];
    updateSeatSlot(seatSlots[pos], seatData, ctx);
  }

  // ---------- Cartes communes + pot ----------
  syncCards(els.communityCards, state.community || []);
  els.potAmount.textContent = state.potTotal.toLocaleString('fr-FR');

  // ---------- Bandeau d'info (main / rue / blinds) ----------
  const streetLabels = { idle: 'En attente', preflop: 'Préflop', flop: 'Flop', turn: 'Turn', river: 'Rivière', showdown: 'Abattage' };
  const streetLabel = streetLabels[state.street] || '';
  els.handSubText.textContent = state.handNumber > 0
    ? `Main #${state.handNumber} · ${streetLabel} · Blinds ${state.smallBlind} / ${state.bigBlind}`
    : `Table partagée · Blinds ${state.smallBlind} / ${state.bigBlind}`;

  // ---------- Statut central ----------
  els.statusMessage.textContent = state.statusMessage || '';
  els.statusMessage.className = 'status-message';
  if (state.statusKind) els.statusMessage.classList.add(state.statusKind);

  // Chime de victoire au showdown : une seule fois par main gagnée, et
  // uniquement si MON siège fait partie des gagnants.
  if (
    state.street === 'showdown' &&
    state.you && state.you.seatIndex != null &&
    ctx.winners.includes(state.you.seatIndex) &&
    state.handNumber !== lastSoundedWinHand
  ) {
    lastSoundedWinHand = state.handNumber;
    Maison21Sound.win();
  }

  if (state.nextHandAt) {
    tickNextHand(); // démarre/relance le compte à rebours affiché
  } else {
    els.nextHandNote.textContent = '';
  }

  // ---------- Identité / solde ----------
  if (state.you) {
    els.bankroll.textContent = state.you.bankroll.toLocaleString('fr-FR');
    els.myName.textContent = state.you.name;
    cacheBankroll(state.you.bankroll);
    cacheName(state.you.name);
    if (!nameModalOpen) els.nameInput.value = state.you.name;
  }

  // ---------- Contrôles de jeu ----------
  renderControls(state);

  // ---------- Minuteur de tour (public : visible pour tout le monde) ----------
  renderTurnTimer(state);
}

function tickNextHand() {
  if (!latestState || !latestState.nextHandAt) { els.nextHandNote.textContent = ''; return; }
  const remain = Math.max(0, Math.ceil((latestState.nextHandAt - Date.now()) / 1000));
  els.nextHandNote.textContent = remain > 0 ? `Main suivante dans ${remain}s` : '';
}

// ============================================================
// CONTRÔLES DU JOUEUR
// ============================================================
let raiseOpen = false;

function renderControls(state) {
  const you = state.you;
  const canAct = you && !you.waiting && you.isYourTurn && state.handInProgress;

  if (!you || you.waiting) {
    els.gameActions.hidden = true;
    els.raiseZone.hidden = true;
    raiseOpen = false;
    els.waitZone.hidden = false;
    els.waitMessage.textContent = you && you.waiting
      ? 'Table complète — vous rejoindrez un siège dès qu\'une place se libère.'
      : 'Connexion à la table…';
    return;
  }

  if (!canAct) {
    els.gameActions.hidden = true;
    if (!raiseOpen) els.raiseZone.hidden = true;
    els.waitZone.hidden = false;
    els.waitMessage.textContent = state.handInProgress
      ? 'En attente des autres joueurs…'
      : 'En attente de la prochaine main…';
    return;
  }

  els.waitZone.hidden = true;

  if (raiseOpen) {
    els.gameActions.hidden = true;
    els.raiseZone.hidden = false;
    return;
  }

  els.gameActions.hidden = false;
  els.raiseZone.hidden = true;

  const call = you.toCall;
  els.foldBtn.disabled = false;
  els.checkCallBtn.textContent = call > 0 ? `Suivre (${call.toLocaleString('fr-FR')})` : 'Parole';
  els.raiseBtn.disabled = !you.canRaise;
  els.raiseBtn.textContent = call > 0 ? 'Relancer' : 'Miser';
}

function openRaiseZone(state) {
  const you = state.you;
  if (!you || !you.canRaise) return;
  raiseOpen = true;
  const min = Math.min(you.minRaiseTo, you.maxRaiseTo);
  const max = you.maxRaiseTo;
  els.raiseSlider.min = String(min);
  els.raiseSlider.max = String(max);
  els.raiseSlider.value = String(Math.min(Math.max(min, min), max));
  updateRaiseReadout();
  renderControls(state);
}

function closeRaiseZone(state) {
  raiseOpen = false;
  renderControls(state);
}

function updateRaiseReadout() {
  els.raiseAmountDisplay.textContent = parseInt(els.raiseSlider.value, 10).toLocaleString('fr-FR');
}
function clampSlider(v) {
  const min = parseInt(els.raiseSlider.min, 10), max = parseInt(els.raiseSlider.max, 10);
  return Math.min(Math.max(v, min), max);
}

els.foldBtn.addEventListener('click', () => { Maison21Sound.fold(); send({ type: 'action', action: 'fold' }); });
els.checkCallBtn.addEventListener('click', () => {
  if (!latestState || !latestState.you) return;
  Maison21Sound.betAction();
  send({ type: 'action', action: latestState.you.toCall > 0 ? 'call' : 'check' });
});
els.raiseBtn.addEventListener('click', () => { if (latestState) openRaiseZone(latestState); });
els.cancelRaiseBtn.addEventListener('click', () => { if (latestState) closeRaiseZone(latestState); });
els.raiseSlider.addEventListener('input', updateRaiseReadout);
els.presetHalfPot.addEventListener('click', () => {
  if (!latestState || !latestState.you) return;
  const mySeat = latestState.seats[latestState.you.seatIndex];
  const target = mySeat.streetBet + Math.round(latestState.potTotal * 0.5);
  els.raiseSlider.value = clampSlider(target);
  updateRaiseReadout();
});
els.presetPot.addEventListener('click', () => {
  if (!latestState || !latestState.you) return;
  const mySeat = latestState.seats[latestState.you.seatIndex];
  const target = mySeat.streetBet + latestState.potTotal;
  els.raiseSlider.value = clampSlider(target);
  updateRaiseReadout();
});
els.presetAllin.addEventListener('click', () => {
  els.raiseSlider.value = els.raiseSlider.max;
  updateRaiseReadout();
});
els.confirmRaiseBtn.addEventListener('click', () => {
  const amount = parseInt(els.raiseSlider.value, 10);
  Maison21Sound.betAction();
  send({ type: 'action', action: 'raise', amount });
  raiseOpen = false;
});

// Raccourcis clavier (uniquement actifs quand c'est votre tour)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    els.rulesModal.classList.remove('open');
    els.nameModal.classList.remove('open');
    if (els.leaderboardModal) els.leaderboardModal.classList.remove('open');
    if (raiseOpen && latestState) closeRaiseZone(latestState);
    return;
  }
  if (!latestState || !latestState.you || !latestState.you.isYourTurn) return;
  const k = e.key.toLowerCase();
  if (k === 'f') send({ type: 'action', action: 'fold' });
  else if (k === 'c') send({ type: 'action', action: latestState.you.toCall > 0 ? 'call' : 'check' });
  else if (k === 'r' && !raiseOpen) openRaiseZone(latestState);
});

// ============================================================
// MINUTEUR DE TOUR (public — visible pour tous, affiché en bas
// uniquement quand c'est VOTRE tour pour créer l'urgence)
// ============================================================
function renderTurnTimer(state) {
  const isMine = state.you && !state.you.waiting && state.you.isYourTurn;
  if (!isMine || !state.turnDeadline) {
    els.turnTimerBar.hidden = true;
    return;
  }
  els.turnTimerBar.hidden = false;
}

let timerRaf = null;
function timerLoop() {
  if (latestState && latestState.turnDeadline && latestState.you && latestState.you.isYourTurn && !latestState.you.waiting) {
    const totalMs = 22000; // valeur d'affichage par défaut, cohérente avec TURN_TIMEOUT_MS côté serveur
    const remainMs = Math.max(0, latestState.turnDeadline - Date.now());
    const pct = Math.max(0, Math.min(1, remainMs / totalMs));
    els.turnTimerFill.style.width = `${(pct * 100).toFixed(1)}%`;
    els.turnTimerText.textContent = `${Math.ceil(remainMs / 1000)}s`;
    els.turnTimerFill.classList.toggle('urgent', remainMs < 6000);
    els.turnTimerBar.hidden = false;
  } else {
    els.turnTimerBar.hidden = true;
  }
  tickNextHand();
  timerRaf = requestAnimationFrame(timerLoop);
}
timerRaf = requestAnimationFrame(timerLoop);

// ============================================================
// PSEUDO
// ============================================================
let nameModalOpen = false;
function openNameModal() {
  nameModalOpen = true;
  els.nameInput.value = (latestState && latestState.you) ? latestState.you.name : loadCachedName();
  els.nameModal.classList.add('open');
  setTimeout(() => els.nameInput.focus(), 50);
}
function closeNameModal() {
  nameModalOpen = false;
  els.nameModal.classList.remove('open');
}
els.nameBtn.addEventListener('click', openNameModal);
els.closeNameBtn.addEventListener('click', closeNameModal);
els.nameModal.addEventListener('click', (e) => { if (e.target === els.nameModal) closeNameModal(); });
function submitName() {
  const raw = els.nameInput.value;
  const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 20);
  if (!cleaned) { closeNameModal(); return; }
  send({ type: 'setName', name: cleaned });
  closeNameModal();
}
els.saveNameBtn.addEventListener('click', submitName);
els.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitName(); });

// ============================================================
// TOAST + rachat automatique (détection par comparaison de solde)
// ============================================================
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove('show'), 2200);
}
let lastKnownBankroll = null;
function checkAutoRebuy(state) {
  if (!state.you) return;
  const bankroll = state.you.bankroll;
  if (lastKnownBankroll !== null && lastKnownBankroll <= 0 && bankroll > lastKnownBankroll) {
    showToast('Rachat automatique : jetons crédités.');
  }
  lastKnownBankroll = bankroll;
}

// ============================================================
// RÈGLES (modale)
// ============================================================
// ---------- Son ----------
document.addEventListener('click', () => Maison21Sound.primeAudio(), { once: true });

function updateSoundBtn() {
  const muted = Maison21Sound.isMuted();
  els.soundBtn.textContent = muted ? '🔇' : '🔊';
  els.soundBtn.title = muted ? 'Activer le son' : 'Couper le son';
}
els.soundBtn.addEventListener('click', () => { Maison21Sound.toggleMuted(); updateSoundBtn(); });
updateSoundBtn();

els.rulesBtn.addEventListener('click', () => els.rulesModal.classList.add('open'));
els.closeRulesBtn.addEventListener('click', () => els.rulesModal.classList.remove('open'));
els.rulesModal.addEventListener('click', (e) => { if (e.target === els.rulesModal) els.rulesModal.classList.remove('open'); });

// ============================================================
// CLASSEMENT (leaderboard)
// ============================================================
function renderLeaderboard(entries) {
  els.leaderboardList.innerHTML = '';
  if (!entries || entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'leaderboard-empty';
    empty.textContent = 'Aucun joueur enregistré pour le moment.';
    els.leaderboardList.appendChild(empty);
    return;
  }
  entries.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'leaderboard-row' + (entry.id === myPlayerId ? ' mine' : '');

    const rank = document.createElement('span');
    rank.className = 'leaderboard-rank';
    rank.textContent = `#${i + 1}`;

    const name = document.createElement('span');
    name.className = 'leaderboard-name';
    // Pseudo potentiellement personnalisé par un joueur : toujours en
    // textContent (jamais innerHTML), pour empêcher toute injection
    // HTML/JS (XSS) — voir aussi updateSeatSlot() plus haut.
    name.textContent = entry.name;

    const record = document.createElement('span');
    record.className = 'leaderboard-record';
    record.textContent = `${entry.record.toLocaleString('fr-FR')} jetons`;

    row.appendChild(rank);
    row.appendChild(name);
    row.appendChild(record);
    els.leaderboardList.appendChild(row);
  });
}

if (els.leaderboardBtn && els.leaderboardModal) {
  els.leaderboardBtn.addEventListener('click', () => {
    els.leaderboardList.innerHTML = '<p class="leaderboard-loading">Chargement du classement…</p>';
    els.leaderboardModal.classList.add('open');
    send({ type: 'getLeaderboard' });
  });
  els.closeLeaderboardBtn.addEventListener('click', () => els.leaderboardModal.classList.remove('open'));
  els.leaderboardModal.addEventListener('click', (e) => {
    if (e.target === els.leaderboardModal) els.leaderboardModal.classList.remove('open');
  });
}

// ============================================================
// CONNEXION WEBSOCKET (avec reconnexion automatique)
// ============================================================
let ws = null;
let reconnectDelay = 1000;
const RECONNECT_MAX = 10000;
let reconnectTimer = null;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Chemin de base = dossier de la page actuelle (enlève le nom de
  // fichier éventuel). Le websocket reste ainsi toujours relatif, que
  // le jeu soit servi à la racine du domaine ou sous /poker/ derrière
  // un reverse proxy nginx.
  const basePath = location.pathname.replace(/[^/]*$/, '');
  return `${proto}//${location.host}${basePath}ws`;
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function setConnUI(online) {
  els.connDot.classList.toggle('online', online);
  els.connDot.title = online ? 'Connecté' : 'Connexion perdue — reconnexion…';
}

function connect() {
  clearTimeout(reconnectTimer);
  setConnUI(false);
  if (!latestState) {
    els.statusMessage.textContent = 'Connexion à la table…';
  }

  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    setConnUI(true);
    send({ type: 'hello', playerId: myPlayerId, name: loadCachedName() || undefined });
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'welcome') {
      cacheName(msg.name);
      cacheBankroll(msg.bankroll);
    } else if (msg.type === 'state') {
      checkAutoRebuy(msg);
      render(msg);
    } else if (msg.type === 'dealerSay') {
      showCallout(els.dealerCallout, msg.text, msg.duration || 2400);
    } else if (msg.type === 'aiSay') {
      // seatIndex ici = index BRUT côté serveur ; il faut retrouver la
      // position visuelle actuelle (après rotation) pour cibler le bon
      // encart de réplique.
      const iAmSeated = latestState && latestState.you && !latestState.you.waiting && latestState.you.seatIndex != null;
      const rotationOffset = iAmSeated ? latestState.you.seatIndex : 0;
      const pos = ((msg.seatIndex - rotationOffset) % SEAT_COUNT + SEAT_COUNT) % SEAT_COUNT;
      const slot = seatSlots[pos];
      if (slot) showCallout(slot.callout, msg.text, msg.duration || 2400);
    } else if (msg.type === 'leaderboard') {
      renderLeaderboard(msg.entries);
    }
  });

  const onDown = () => {
    latestState = null; // évite d'afficher un tour/minuteur périmé pendant la coupure
    setConnUI(false);
    els.gameActions.hidden = true;
    els.raiseZone.hidden = true;
    raiseOpen = false;
    els.turnTimerBar.hidden = true;
    els.waitZone.hidden = false;
    els.waitMessage.textContent = 'Connexion perdue — reconnexion…';
    els.statusMessage.textContent = 'Connexion perdue — reconnexion…';
    els.statusMessage.className = 'status-message';
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, RECONNECT_MAX);
  };
  ws.addEventListener('close', onDown);
  ws.addEventListener('error', () => { try { ws.close(); } catch { /* ignore */ } });
}

// ---------- Menu inter-jeux ----------
// Petit panneau dupliqué à l'identique sur les 4 pages du site (lobby,
// blackjack, roulette, poker) pour changer de jeu en un clic, sans repasser
// par l'accueil. Pas de dépendance à un module JS partagé : logique simple
// et autonome, cohérente partout.
(function initGameMenu() {
  const btn = document.getElementById('gameMenuBtn');
  const panel = document.getElementById('gameMenuPanel');
  if (!btn || !panel) return;

  function closeMenu() {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  function openMenu() {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.hidden) openMenu(); else closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
})();

// ---------- Compte utilisateur (connexion / inscription / déconnexion) ----------
// Système de comptes partagé sur tout le site (voir shared/auth-server.js) :
// un cookie de session HttpOnly (m21_session), posé avec Path=/ et sans
// Domain explicite, est automatiquement envoyé à toutes les pages du même
// domaine (lobby + 3 jeux, même sous des chemins différents) — un seul
// login vaut donc pour tout le site. Widget dupliqué à l'identique sur les
// 4 pages (même logique que le menu inter-jeux ci-dessus), sans dépendance
// à un module JS partagé entre pages.
(function initAuthWidget() {
  const pill = document.getElementById('authPill');
  const modal = document.getElementById('authModal');
  if (!pill || !modal) return;

  const pillIcon = document.getElementById('authPillIcon');
  const pillLabel = document.getElementById('authPillLabel');
  const closeBtn = document.getElementById('closeAuthBtn');
  const loggedInView = document.getElementById('authLoggedInView');
  const loggedOutView = document.getElementById('authLoggedOutView');
  const accountNameEl = document.getElementById('authAccountName');
  const logoutBtn = document.getElementById('authLogoutBtn');
  const tabLogin = document.getElementById('authTabLogin');
  const tabRegister = document.getElementById('authTabRegister');
  const loginForm = document.getElementById('authLoginForm');
  const registerForm = document.getElementById('authRegisterForm');
  const errorEl = document.getElementById('authError');

  let currentAccount = null; // pseudo du compte connecté, ou null si anonyme

  function setAuthError(message) {
    if (!message) { errorEl.hidden = true; errorEl.textContent = ''; return; }
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function updateAuthPill() {
    if (currentAccount) {
      pill.classList.add('connected');
      pillIcon.textContent = '👤';
      pillLabel.textContent = currentAccount;
      pill.title = `Connecté en tant que ${currentAccount} — cliquez pour gérer votre compte`;
    } else {
      pill.classList.remove('connected');
      pillIcon.textContent = '🔐';
      pillLabel.textContent = 'Se connecter';
      pill.title = 'Connexion / inscription';
    }
  }

  function showAuthTab(which) {
    const isLogin = which === 'login';
    tabLogin.classList.toggle('active', isLogin);
    tabRegister.classList.toggle('active', !isLogin);
    loginForm.hidden = !isLogin;
    registerForm.hidden = isLogin;
    setAuthError(null);
  }

  // Interroge le service d'auth pour savoir si un compte est déjà connecté
  // (cookie de session posé lors d'une visite précédente, éventuellement
  // depuis une autre page du site) : c'est la source de vérité pour cette
  // pastille, plus simple et cohérente sur les 4 pages qu'un état dérivé du
  // "welcome" websocket (voir aussi son champ "account", utilisé côté
  // serveur pour l'identité de jeu, mais pas repris ici pour ne pas avoir
  // deux sources d'affichage différentes).
  function refreshAuthFromServer() {
    return fetch('/auth/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { username: null }))
      .then((data) => {
        currentAccount = (data && data.username) || null;
        updateAuthPill();
      })
      .catch(() => { /* hors-ligne : on garde le dernier état affiché */ });
  }

  function openAuthModal() {
    setAuthError(null);
    if (currentAccount) {
      loggedInView.hidden = false;
      loggedOutView.hidden = true;
      accountNameEl.textContent = currentAccount;
    } else {
      loggedInView.hidden = true;
      loggedOutView.hidden = false;
      showAuthTab('login');
      loginForm.reset();
      registerForm.reset();
    }
    modal.classList.add('open');
  }
  function closeAuthModal() { modal.classList.remove('open'); }

  pill.addEventListener('click', openAuthModal);
  closeBtn.addEventListener('click', closeAuthModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeAuthModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAuthModal(); });

  tabLogin.addEventListener('click', () => showAuthTab('login'));
  tabRegister.addEventListener('click', () => showAuthTab('register'));

  async function postAuthJson(url, body) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, data: { message: 'Connexion au serveur impossible.' } };
    }
    let data = null;
    try { data = await res.json(); } catch { /* réponse sans corps JSON */ }
    return { ok: res.ok, data };
  }

  // Après une connexion/inscription/déconnexion réussie DEPUIS un jeu, le
  // websocket de CE jeu doit se reconnecter pour relire le nouveau cookie
  // et basculer sur (ou quitter) l'identité du compte : un simple
  // rechargement de page fait ça proprement, sans logique de reconnexion
  // manuelle à dupliquer ici.
  function afterAuthChange() {
    location.reload();
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthError(null);
    const username = document.getElementById('authLoginUsername').value;
    const password = document.getElementById('authLoginPassword').value;
    const submitBtn = loginForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const { ok, data } = await postAuthJson('/auth/login', { username, password });
    if (ok && data && data.ok) { afterAuthChange(); return; }
    submitBtn.disabled = false;
    setAuthError((data && data.message) || 'Connexion impossible.');
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthError(null);
    const username = document.getElementById('authRegisterUsername').value;
    const password = document.getElementById('authRegisterPassword').value;
    const submitBtn = registerForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const { ok, data } = await postAuthJson('/auth/register', { username, password });
    if (ok && data && data.ok) { afterAuthChange(); return; }
    submitBtn.disabled = false;
    setAuthError((data && data.message) || 'Impossible de créer ce compte.');
  });

  logoutBtn.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch { /* on recharge de toute façon, l'état repartira à jour */ }
    afterAuthChange();
  });

  refreshAuthFromServer();
})();

// ============================================================
// INITIALISATION
// ============================================================
ensureSeatSlots();
els.bankroll.textContent = '—';
els.myName.textContent = loadCachedName() || '…';
connect();
