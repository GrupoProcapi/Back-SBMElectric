/**
 * Public QuickBooks Online OAuth endpoints.
 *
 * These two routes (start of the OAuth dance + Intuit's redirect back) must be
 * reachable WITHOUT the internal api-key, because Intuit's browser redirect
 * can't attach that header. Every other QBO endpoint lives in qboAdminRoutes.js
 * and is mounted behind apiKeyValidator in server.js.
 */
const express = require('express');
const router = express.Router();
const OAuthClient = require('intuit-oauth');

const qboClient = require('../services/qboClient');
const qboOAuthState = require('../services/qboOAuthState');

const parseAllowedRealmIds = () => {
  const raw = process.env.QBO_ALLOWED_REALM_IDS;
  if (!raw || !raw.trim()) return null; // not configured
  return raw.split(',').map((id) => id.trim()).filter(Boolean);
};

// Anyone can spin up a free QBO sandbox/company and hit /auth + /callback with
// it — Intuit's OAuth dance doesn't know or care which company is "ours". So
// this filter is FAIL-CLOSED: no QBO_ALLOWED_REALM_IDS configured means NO
// realm is authorized, not "let everything through" like before this fix.
//
// QBO_FIRST_CONNECT_MODE is a one-shot manual escape hatch for the initial
// reauthorization, before we know the final realm_id. It is consumed (in
// memory) on the first *successful* callback so it can't be reused by anyone
// who finds the callback URL afterwards. Like qboOAuthState's state store,
// this flag is process-local — fine for this single-instance deployment, but
// would need to move to the DB/Redis if this app is ever scaled horizontally.
let firstConnectExemptionUsed = false;

const isFirstConnectModeActive = () => (
  process.env.QBO_FIRST_CONNECT_MODE === 'true' && !firstConnectExemptionUsed
);

// GET /api/qbo/auth — starts the OAuth flow (kept as "auth" to match the
// redirect URI already registered in the Intuit developer dashboard; the
// task referred to this as "/connect" but renaming would break the existing
// production app registration).
router.get('/auth', (req, res) => {
  try {
    const state = qboOAuthState.generateState();
    qboOAuthState.attachStateCookie(res, state);

    const authUri = qboClient.getOAuthClient().authorizeUri({
      scope: [OAuthClient.scopes.Accounting],
      state
    });

    res.redirect(authUri);
  } catch (error) {
    console.error('Error iniciando flujo OAuth de QBO:', error.message);
    res.status(500).json({ error: 'No se pudo iniciar la autenticación con QuickBooks Online' });
  }
});

// GET /api/qbo/callback — Intuit redirects here with ?code&realmId&state
router.get('/callback', async (req, res) => {
  const stateIsValid = qboOAuthState.consumeState(req);
  qboOAuthState.clearStateCookie(res);

  if (!stateIsValid) {
    return res.status(400).json({ error: 'Solicitud inválida o expirada' });
  }

  const realmId = typeof req.query.realmId === 'string' ? req.query.realmId : null;
  const allowedRealmIds = parseAllowedRealmIds();
  const firstConnectActive = isFirstConnectModeActive();

  if (!firstConnectActive) {
    if (!allowedRealmIds) {
      console.error(
        'QBO: QBO_ALLOWED_REALM_IDS no está configurado — rechazando conexión (fail-closed)'
      );
      return res.status(500).json({
        error: 'QBO_ALLOWED_REALM_IDS no está configurado — no se puede autorizar ninguna empresa hasta fijar el realm permitido'
      });
    }

    if (!realmId || !allowedRealmIds.includes(realmId)) {
      console.warn('QBO: intento de conexión con realm no autorizado');
      return res.status(403).json({ error: 'La empresa de QuickBooks conectada no está autorizada' });
    }
  }

  try {
    const result = await qboClient.handleCallback(req.url);

    if (firstConnectActive) {
      firstConnectExemptionUsed = true;
      console.warn(
        `⚠️ QBO_FIRST_CONNECT_MODE activo — conectado a realm ${result.realmId}. `
        + `AHORA fijá QBO_ALLOWED_REALM_IDS=${result.realmId} y apagá QBO_FIRST_CONNECT_MODE antes de seguir.`
      );
    }

    res.set('Content-Type', 'text/html');
    return res.status(200).send(
      '<html><body><p>Autenticación con QuickBooks Online completada correctamente. '
      + 'Puede cerrar esta ventana.</p></body></html>'
    );
  } catch (error) {
    console.error('Error en callback OAuth de QBO:', error.message);
    return res.status(500).json({ error: 'No se pudo completar la autenticación con QuickBooks Online' });
  }
});

// Expuesto únicamente para tests unitarios (strict TDD) — permite resetear el
// flag one-shot de QBO_FIRST_CONNECT_MODE entre casos. No usar fuera de tests.
router.__testables = {
  resetFirstConnectExemption: () => {
    firstConnectExemptionUsed = false;
  }
};

module.exports = router;
