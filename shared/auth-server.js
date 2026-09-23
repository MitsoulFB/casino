'use strict';

/* ============================================================
   AUTH-SERVER — micro-service de comptes partagé sur tout le site
   ------------------------------------------------------------
   Petit serveur Node indépendant (Express, un seul port) qui gère
   UNIQUEMENT les comptes (nom d'utilisateur + mot de passe) et les
   sessions de connexion — aucune logique de jeu ici. Il est déployé
   à part des 3 jeux, mais sur le MÊME nom de domaine derrière nginx
   (ex. https://exemple.com/auth/...), ce qui permet au cookie de
   session posé ici d'être automatiquement envoyé par le navigateur
   à TOUTES les pages du site (lobby + blackjack + roulette + poker),
   même si elles sont servies par des process Node différents : c'est
   ça, et seulement ça, qui fait qu'un seul login vaut pour tout le
   site (voir setSessionCookie plus bas — Path=/, pas de Domain).

   Les 3 serveurs de jeu ne parlent JAMAIS en HTTP à ce service : ils
   lisent directement le même fichier de sessions sur disque via
   shared/session-lookup.js (voir ce fichier), plus rapide et plus
   simple qu'un aller-retour réseau à chaque connexion websocket.

   Aucune exigence de robustesse sur les identifiants (c'est un site
   de jeu 100% gratuit, sans données sensibles) : un nom d'utilisateur
   de 2 caractères et un mot de passe de 3 caractères sont acceptés
   sans broncher. Les mots de passe ne sont en revanche JAMAIS stockés
   en clair : hachage scrypt (module "crypto" natif de Node, aucune
   dépendance npm supplémentaire) avec un sel aléatoire par compte.
   ============================================================ */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

// ---------- Configuration ----------
const PORT = process.env.PORT || 3036;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const SESSION_COOKIE_NAME = 'm21_session';
const SESSION_MAX_AGE_SEC = 365 * 24 * 60 * 60; // 1 an — "pas besoin de se reloguer à chaque fois"

const MIN_USERNAME_LENGTH = 2;
const MAX_USERNAME_LENGTH = 24;
const MIN_PASSWORD_LENGTH = 3;
const MAX_PASSWORD_LENGTH = 200; // borne haute large, juste pour éviter un abus (scrypt n'a pas de limite pratique)

const SCRYPT_KEYLEN = 64;

// ---------- Persistance des comptes ----------
// { [usernameLowerCase]: { username, salt, hash, createdAt } }
// La casse d'origine du pseudo est conservée dans "username" (affichage) ;
// la clé de l'objet, elle, est toujours en minuscules pour garantir
// l'unicité insensible à la casse ("Alice" et "alice" sont le même compte).
let accountsDB = {};

// ---------- Persistance des sessions ----------
// { [token]: { username, createdAt, expiresAt } }
// C'est exactement ce fichier que shared/session-lookup.js relit, en
// lecture seule, depuis les 3 serveurs de jeu — voir ce module pour le
// détail du format attendu.
let sessionsDB = {};

function loadAccountsDB() {
  try {
    accountsDB = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch {
    accountsDB = {};
  }
}

function saveAccountsDB() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accountsDB, null, 2));
  } catch (err) {
    console.error('Erreur écriture accounts.json :', err);
  }
}

function loadSessionsDB() {
  try {
    sessionsDB = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    sessionsDB = {};
  }
}

function saveSessionsDB() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsDB, null, 2));
  } catch (err) {
    console.error('Erreur écriture sessions.json :', err);
  }
}
// NB : écritures synchrones (contrairement au pattern différé des 3 jeux) —
// le volume ici est faible (inscriptions/connexions, pas un state de jeu
// diffusé en boucle) et la fiabilité prime : on veut être certain que le
// fichier est à jour sur disque avant de répondre au client, puisque les 3
// serveurs de jeu vont le relire de leur côté juste après.

// ---------- Mots de passe : hachage scrypt salé (jamais de clair stocké) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

// Comparaison en temps constant (timingSafeEqual) pour ne pas laisser fuiter
// d'information via le temps de réponse — bonne pratique même sur un site
// sans enjeu réel.
function verifyPassword(password, salt, expectedHashHex) {
  try {
    const computed = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(expectedHashHex, 'hex');
    if (computed.length !== expected.length) return false;
    return crypto.timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}

// ---------- Sessions ----------
function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessionsDB[token] = { username, createdAt: now, expiresAt: now + SESSION_MAX_AGE_SEC * 1000 };
  saveSessionsDB();
  return token;
}

function destroySession(token) {
  if (token && sessionsDB[token]) {
    delete sessionsDB[token];
    saveSessionsDB();
  }
}

// Renvoie le pseudo (casse d'origine) associé à un jeton de session encore
// valide, ou null (absent, inconnu, expiré). Purge au passage les sessions
// expirées croisées ici — nettoyage paresseux, suffisant vu le volume.
function resolveUsernameFromToken(token) {
  if (!token) return null;
  const session = sessionsDB[token];
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < Date.now()) {
    destroySession(token);
    return null;
  }
  return session.username;
}

// ---------- Cookies : parsing manuel (pas de dépendance "cookie-parser") ----------
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

// Vrai si la requête arrive en HTTPS — soit directement, soit via le
// reverse proxy nginx (qui transmettra X-Forwarded-Proto en prod). En local
// en HTTP simple, les deux sont absents/faux et on n'ajoute donc PAS
// "Secure" au cookie (sinon le navigateur le refuserait silencieusement et
// personne ne resterait connecté en dev).
function isRequestSecure(req) {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto !== 'string') return false;
  return proto.split(',')[0].trim().toLowerCase() === 'https';
}

// Pose le cookie de session. Point le plus important de tout ce fichier :
// Path=/ et AUCUN Domain explicite. Comme le lobby et les 3 jeux vivent
// tous sous le même nom de domaine (juste des chemins différents, ex.
// /blackjack/), un cookie ainsi posé est automatiquement renvoyé par le
// navigateur à TOUTES les pages du site — c'est uniquement ça qui permet à
// un seul login de valoir partout. Ajouter un Domain explicite ou
// restreindre le Path casserait ce partage.
function setSessionCookie(req, res, token) {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
  ];
  if (isRequestSecure(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isRequestSecure(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// ---------- Validation des champs d'inscription/connexion ----------
// Volontairement permissif (voir en-tête du fichier) : juste de quoi éviter
// les valeurs vides/absurdes, aucune règle de complexité.
function validateUsername(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim();
  if (cleaned.length < MIN_USERNAME_LENGTH || cleaned.length > MAX_USERNAME_LENGTH) return null;
  return cleaned;
}
function validatePassword(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length < MIN_PASSWORD_LENGTH || raw.length > MAX_PASSWORD_LENGTH) return null;
  return raw;
}

// ---------- Application Express ----------
const app = express();
app.use(express.json());

app.post('/auth/register', (req, res) => {
  const body = req.body || {};
  const username = validateUsername(body.username);
  const password = validatePassword(body.password);

  if (!username) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_username',
      message: `Le nom d'utilisateur doit contenir entre ${MIN_USERNAME_LENGTH} et ${MAX_USERNAME_LENGTH} caractères.`,
    });
  }
  if (!password) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_password',
      message: `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`,
    });
  }

  const key = username.toLowerCase();
  if (accountsDB[key]) {
    return res.status(409).json({
      ok: false,
      error: 'username_taken',
      message: 'Ce nom d\'utilisateur est déjà pris.',
    });
  }

  const { salt, hash } = hashPassword(password);
  accountsDB[key] = { username, salt, hash, createdAt: Date.now() };
  saveAccountsDB();

  // Inscription = connexion immédiate, pour l'ergonomie (pas d'étape "créer
  // le compte puis se reloguer").
  const token = createSession(username);
  setSessionCookie(req, res, token);
  res.json({ ok: true, username });
});

app.post('/auth/login', (req, res) => {
  const body = req.body || {};
  const usernameRaw = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const key = usernameRaw.toLowerCase();
  const account = accountsDB[key];
  const invalidResponse = () => res.status(401).json({
    ok: false,
    error: 'invalid_credentials',
    message: 'Nom d\'utilisateur ou mot de passe incorrect.',
  });

  if (!account || !password) return invalidResponse();
  if (!verifyPassword(password, account.salt, account.hash)) return invalidResponse();

  const token = createSession(account.username);
  setSessionCookie(req, res, token);
  res.json({ ok: true, username: account.username });
});

app.post('/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  destroySession(cookies[SESSION_COOKIE_NAME]);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/auth/me', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const username = resolveUsernameFromToken(cookies[SESSION_COOKIE_NAME]);
  res.json({ username: username || null });
});

// Route de secours pour tout le reste : ce service n'expose QUE l'API
// ci-dessus, aucun fichier statique (voir en-tête du fichier).
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

// Erreurs de parsing JSON (express.json()) ou autres : réponse JSON propre
// plutôt que la page d'erreur HTML par défaut d'Express.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Erreur auth-server :', err.message);
  res.status(400).json({ ok: false, error: 'bad_request', message: 'Requête invalide.' });
});

// ---------- Démarrage ----------
loadAccountsDB();
loadSessionsDB();
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`Auth-server (comptes partagés Maison21) en écoute sur le port ${PORT}`);
  console.log(`HTTP : http://localhost:${PORT}/auth/...`);
});
