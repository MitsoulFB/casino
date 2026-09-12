'use strict';

/* ============================================================
   SON — synthèse audio légère via Web Audio API (aucun fichier
   externe, aucune dépendance). Chaque jeu du site a sa propre
   copie autonome de ce module, avec sa propre clé de mute.
   ============================================================ */

const SOUND_MUTE_KEY = 'maison21_blackjack_sound_muted';

let audioCtx = null;
let muted = loadMuted();

function loadMuted() {
  try { return localStorage.getItem(SOUND_MUTE_KEY) === '1'; } catch { return false; }
}
function saveMuted(v) {
  try { localStorage.setItem(SOUND_MUTE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

// L'AudioContext ne doit être créé qu'APRÈS un geste utilisateur (clic),
// sinon Chrome/Safari le bloquent et polluent la console d'avertissements.
// `primeAudio()` est appelé au premier clic sur la page (voir script.js).
function ensureCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function primeAudio() { ensureCtx(); }
function isMuted() { return muted; }
function setMuted(v) { muted = v; saveMuted(v); }
function toggleMuted() { setMuted(!muted); return muted; }

// ---------- Primitives de synthèse ----------
// Une note simple : oscillateur + enveloppe d'amplitude courte (attaque
// rapide, relâchement exponentiel) pour un son "casino" net et discret.
function tone(freq, duration, { type = 'sine', gain = 0.12, delay = 0, freqEnd = null } = {}) {
  if (muted) return;
  const ctx = ensureCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + duration);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

// Bruit blanc filtré (passe-bas) : utile pour un "whoosh" de carte ou une
// bille qui roule. Le filtre glisse d'une fréquence haute vers une basse
// pour donner une sensation de ralentissement/atténuation.
function noiseSweep(duration, { gain = 0.1, delay = 0, freqStart = 4000, freqEnd = 200 } = {}) {
  if (muted) return;
  const ctx = ensureCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(freqStart, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 20), t0 + duration);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filter).connect(g).connect(ctx.destination);
  src.start(t0);
  src.stop(t0 + duration + 0.02);
}

// ---------- Sons "métier" ----------
const Sound = {
  primeAudio, isMuted, setMuted, toggleMuted,

  // Carte distribuée/retournée : bref "whoosh" descendant.
  cardDeal() { noiseSweep(0.09, { gain: 0.05, freqStart: 3200, freqEnd: 600 }); },

  // Jeton posé/sélectionné : clic métallique bref.
  chip() { tone(920, 0.045, { type: 'square', gain: 0.045, freqEnd: 700 }); },

  // Victoire normale : petit arpège montant satisfaisant.
  win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.16, { delay: i * 0.07, gain: 0.1 })); },

  // Blackjack naturel : arpège plus marqué/étincelant.
  blackjackWin() { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.18, { delay: i * 0.06, gain: 0.12, type: 'triangle' })); },

  // Défaite/bust : descente discrète, reste léger (jeu 100% gratuit).
  lose() { tone(320, 0.28, { type: 'sawtooth', gain: 0.07, freqEnd: 130 }); },

  // Égalité/push : ton neutre bref.
  push() { tone(440, 0.12, { type: 'sine', gain: 0.07 }); },
};

window.Maison21Sound = Sound;
