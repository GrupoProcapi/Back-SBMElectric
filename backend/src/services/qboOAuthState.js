/**
 * CSRF protection for the QuickBooks Online OAuth 2.0 flow.
 *
 * The Intuit OAuth "state" parameter is generated per-attempt, stored server-side
 * (in-memory, single-use, short TTL) and mirrored into an HttpOnly cookie scoped
 * to /api/qbo. On callback we require all three sources (query, cookie, store) to
 * agree before we trust the request and exchange the authorization code.
 *
 * NOTE: the in-memory Map means state is not shared across multiple app instances.
 * This app currently runs as a single process/container, so that's acceptable for
 * now — if it's ever scaled horizontally, this store needs to move to Redis/DB.
 */
const crypto = require('crypto');

const COOKIE_NAME = 'qbo_oauth_state';
const COOKIE_PATH = '/api/qbo';
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

// state (hex string) -> { value: state, expiresAt: epochMs }
const stateStore = new Map();

const purgeExpired = () => {
  const now = Date.now();
  for (const [key, record] of stateStore.entries()) {
    if (record.expiresAt <= now) {
      stateStore.delete(key);
    }
  }
};

/**
 * Generates and stores a new single-use CSRF state token.
 * @param {number} ttlMs how long the state stays valid
 * @returns {string} 64-char hex state value
 */
const generateStateWithTtl = (ttlMs) => {
  purgeExpired();
  const state = crypto.randomBytes(32).toString('hex');
  stateStore.set(state, { value: state, expiresAt: Date.now() + ttlMs });
  return state;
};

const generateState = () => generateStateWithTtl(DEFAULT_TTL_MS);

const attachStateCookie = (res, state) => {
  res.cookie(COOKIE_NAME, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: COOKIE_PATH,
    maxAge: DEFAULT_TTL_MS
  });
};

const clearStateCookie = (res) => {
  res.clearCookie(COOKIE_NAME, { path: COOKIE_PATH });
};

/**
 * Manually parses the Cookie header to read qbo_oauth_state.
 * cookie-parser is not a dependency of this project; adding it just for this
 * one read-only lookup was not worth a new dependency approval, so we parse
 * the single header we need by hand.
 */
const readStateCookie = (req) => {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;

  const parts = header.split(';');
  for (const part of parts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex).trim();
    if (key === COOKIE_NAME) {
      const rawValue = part.slice(separatorIndex + 1).trim();
      try {
        return decodeURIComponent(rawValue);
      } catch (_err) {
        return null;
      }
    }
  }
  return null;
};

/**
 * Constant-time string comparison. crypto.timingSafeEqual requires
 * equal-length buffers, so a length mismatch is treated as a straight
 * rejection (still consuming comparable time so we don't leak length
 * via an early return before hashing/allocating).
 */
const timingSafeEqualStrings = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Validates the OAuth callback's CSRF state. Requires the query `state`,
 * the `qbo_oauth_state` cookie, and the server-side stored value to all
 * match (pairwise, via timingSafeEqual) and to not be expired. Single-use:
 * the stored value is deleted on every attempt (success or failure) so a
 * captured callback URL can't be replayed.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
const consumeState = (req) => {
  purgeExpired();

  const queryState = req.query && typeof req.query.state === 'string' ? req.query.state : null;
  const cookieState = readStateCookie(req);

  if (!queryState || !cookieState) {
    return false;
  }

  if (!timingSafeEqualStrings(queryState, cookieState)) {
    return false;
  }

  const record = stateStore.get(queryState);
  // Always invalidate on first use attempt, regardless of outcome.
  stateStore.delete(queryState);

  if (!record || record.expiresAt <= Date.now()) {
    return false;
  }

  return timingSafeEqualStrings(queryState, record.value);
};

module.exports = {
  generateState,
  generateStateWithTtl,
  attachStateCookie,
  clearStateCookie,
  consumeState,
  COOKIE_NAME,
  COOKIE_PATH
};
