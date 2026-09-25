/**
 * Second authentication layer for QBO admin endpoints (backend/src/routes/qboAdminRoutes.js).
 *
 * WHY: those endpoints already sit behind the generic `apiKeyValidator` (header
 * `api-key`, checked against `API_KEY`), but that same `API_KEY` is also used by
 * the frontend and ships embedded inside its JS bundle -- anyone opening devtools
 * on the public site can read it. That's an acceptable secret for read-mostly
 * public traffic, but it is NOT enough to protect endpoints that expose personal
 * data for 7,566+ customers and that (once writes are enabled) can create real
 * invoices in QuickBooks Online.
 *
 * This middleware requires a SEPARATE, stronger secret (`QBO_ADMIN_KEY`, header
 * `x-qbo-admin-key`) that must never be shipped to the frontend. It is meant to be
 * called only from trusted server-to-server contexts (internal tooling, Jefe's own
 * scripts/Postman), never from the browser bundle.
 *
 * Fail-closed by design: if `QBO_ADMIN_KEY` is missing, or if it has been
 * accidentally set to the same value as `API_KEY` (which would defeat the whole
 * point of a separate, non-public secret), EVERY request is rejected. A
 * misconfiguration must never silently degrade into "admin endpoints are only as
 * protected as the public API key".
 */
const crypto = require('crypto');

const ADMIN_KEY_HEADER = 'x-qbo-admin-key';

/**
 * Constant-time string comparison. Falls back to `false` on length mismatch
 * instead of calling crypto.timingSafeEqual with mismatched buffer lengths
 * (which throws) -- callers never see stack traces from this helper either way.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
const timingSafeEquals = (a, b) => {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
};

const qboAdminAuth = (req, res, next) => {
  const configuredAdminKey = process.env.QBO_ADMIN_KEY;

  if (!configuredAdminKey) {
    console.error(
      '[qboAdminAuth] QBO_ADMIN_KEY no está configurada en el entorno: se rechazan TODOS los ' +
        'endpoints admin de QBO (fail-closed). Agregá QBO_ADMIN_KEY=<valor largo y random>, ' +
        'distinto de API_KEY, al .env antes de desplegar.'
    );
    return res.status(500).json({ error: 'QBO admin endpoints are not configured' });
  }

  const configuredApiKey = process.env.API_KEY;
  if (configuredApiKey && timingSafeEquals(configuredAdminKey, configuredApiKey)) {
    console.error(
      '[qboAdminAuth] QBO_ADMIN_KEY tiene el mismo valor que API_KEY: esto anula la protección ' +
        'adicional, porque API_KEY viaja embebido en el bundle del frontend. Configurá un valor ' +
        'distinto para QBO_ADMIN_KEY.'
    );
    return res.status(500).json({ error: 'QBO admin endpoints are not configured' });
  }

  const providedKey = req.headers[ADMIN_KEY_HEADER];

  if (!providedKey) {
    return res.status(401).json({ error: `${ADMIN_KEY_HEADER} header is missing` });
  }

  if (typeof providedKey !== 'string' || !timingSafeEquals(providedKey, configuredAdminKey)) {
    return res.status(403).json({ error: 'Invalid admin key' });
  }

  next();
};

module.exports = qboAdminAuth;
