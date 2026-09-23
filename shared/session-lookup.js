'use strict';

/* ============================================================
   SESSION-LOOKUP — module partagé (PAS un serveur, pas de port)
   ------------------------------------------------------------
   Permet à chacun des 3 serveurs de jeu (blackjack/roulette/poker)
   de résoudre le compte connecté d'un joueur à partir de l'en-tête
   "Cookie" de sa requête HTTP d'upgrade websocket, SANS passer par
   auth-server.js en réseau : lecture directe, sur disque, du même
   fichier de sessions que celui-ci écrit (les 3 jeux et le service
   d'auth tournent sur la même machine — c'est plus simple et plus
   rapide qu'un aller-retour HTTP à chaque connexion).

   Le fichier est relu à CHAQUE appel plutôt que mis en cache : le
   volume (une résolution par connexion websocket, pas par message)
   ne justifie pas un cache, et ça évite tout état périmé si une
   session vient d'être créée ou invalidée entre deux appels.
   ============================================================ */

const fs = require('fs');
const path = require('path');

// Même dossier de données que auth-server.js par défaut (ce module vit
// dans shared/, comme lui) — surchargeable via la même variable
// d'environnement si jamais les deux étaient un jour déployés séparément.
const DATA_DIR = process.env.AUTH_DATA_DIR || path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const SESSION_COOKIE_NAME = 'm21_session';

// Parsing manuel simple de l'en-tête "Cookie" (pas de dépendance
// "cookie-parser") : "a=1; b=2" -> { a: '1', b: '2' }.
function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  });
  return out;
}

function readSessionsDB() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    // Fichier absent (service d'auth jamais démarré/aucune session créée)
    // ou illisible : aucun joueur connecté, comportement anonyme partout.
    return {};
  }
}

// Résout le nom d'utilisateur (avec sa casse d'origine, telle
// qu'enregistrée à l'inscription) à partir de l'en-tête "Cookie" brut d'une
// requête HTTP. Renvoie null si aucune session valide n'est trouvée (cookie
// absent, jeton inconnu, ou session expirée) — c'est le signal pour le
// serveur appelant de retomber sur le comportement anonyme habituel.
function resolveSessionFromCookieHeader(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  const sessions = readSessionsDB();
  const session = sessions[token];
  if (!session || typeof session.username !== 'string' || !session.username) return null;
  if (Number.isFinite(session.expiresAt) && session.expiresAt < Date.now()) return null;

  return session.username;
}

module.exports = { resolveSessionFromCookieHeader };
