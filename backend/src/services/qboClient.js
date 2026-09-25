const OAuthClient = require('intuit-oauth');
const config = require('../config');
const database = require('../database');

/**
 * Error dedicado para el kill switch de escrituras a QBO.
 * Se lanza cuando alguien intenta hacer un POST/PUT contra QuickBooks Online
 * y la variable de entorno QBO_WRITES_ENABLED no está seteada exactamente en 'true'.
 */
class QboWritesDisabledError extends Error {
  constructor(message = "Escrituras a QBO deshabilitadas: seteá QBO_WRITES_ENABLED='true' para habilitarlas") {
    super(message);
    this.name = 'QboWritesDisabledError';
    this.code = 'QBO_WRITES_DISABLED';
  }
}

let oauthClient = null;
let requestCounter = 0;

const WRITE_METHODS = new Set(['POST', 'PUT']);

const generateRequestId = () => {
  requestCounter += 1;
  return `qbo-${Date.now()}-${requestCounter}`;
};

const isWritesEnabled = () => process.env.QBO_WRITES_ENABLED === 'true';

/**
 * Kill switch centralizado: se ejecuta SIEMPRE antes de tocar la red/DB.
 * Los GET nunca se bloquean; los POST/PUT requieren QBO_WRITES_ENABLED='true'.
 * Se expone en __testables para poder testearlo sin dependencias de infraestructura.
 */
const assertWriteAllowed = (method, path, requestId) => {
  const httpMethod = (method || 'GET').toUpperCase();
  if (WRITE_METHODS.has(httpMethod) && !isWritesEnabled()) {
    const id = requestId || generateRequestId();
    throw new QboWritesDisabledError(
      `[${id}] Escritura QBO bloqueada (${httpMethod} ${path}): QBO_WRITES_ENABLED no está en 'true'`
    );
  }
};

// --- Redacción de secretos en logs ---------------------------------------
// Nunca deben imprimirse en logs los valores completos de tokens/secrets,
// aunque vengan embebidos dentro del body de un request o de una respuesta de Intuit.
const SENSITIVE_KEYS = new Set([
  'access_token', 'accessToken',
  'refresh_token', 'refreshToken',
  'client_secret', 'clientSecret',
  'id_token', 'idToken'
]);

const maskSecretValue = (value) => {
  const stringValue = typeof value === 'string' ? value : String(value ?? '');
  if (stringValue.length === 0) return stringValue;
  return `${stringValue.slice(0, 8)}...`;
};

const redactSensitive = (input) => {
  if (Array.isArray(input)) {
    return input.map(redactSensitive);
  }
  if (input && typeof input === 'object') {
    const output = {};
    for (const [key, value] of Object.entries(input)) {
      if (SENSITIVE_KEYS.has(key)) {
        output[key] = maskSecretValue(value);
      } else if (value && typeof value === 'object') {
        output[key] = redactSensitive(value);
      } else {
        output[key] = value;
      }
    }
    return output;
  }
  return input;
};

// Extrae el mensaje real de error de Intuit sin importar si vino de una respuesta
// HTTP (wrappedError.error_description / originalMessage, ver intuit-oauth OAuthClient.createError)
// o de una validación local del SDK (Error plano, ej. "Refresh token is invalid...").
const extractIntuitErrorMessage = (error) => {
  if (!error) return 'Error desconocido';
  return error.error_description || error.originalMessage || error.message || 'Error desconocido';
};

// El logging interno de intuit-oauth escribe en logs/oAuthClient-log.log la respuesta
// COMPLETA de createToken/refresh (incluye access_token/refresh_token en texto plano,
// sin pasar por nuestro redactSensitive()). Queda apagado por defecto; solo se activa
// explícitamente con QBO_SDK_LOGGING='true' para debug puntual, nunca en producción.
const isSdkLoggingEnabled = () => process.env.QBO_SDK_LOGGING === 'true';

const getOAuthClient = () => {
  if (!oauthClient) {
    oauthClient = new OAuthClient({
      clientId: config.qbo.clientId,
      clientSecret: config.qbo.clientSecret,
      environment: config.qbo.environment,
      redirectUri: config.qbo.redirectUri,
      logging: isSdkLoggingEnabled()
    });
  }
  return oauthClient;
};

const getAuthUri = () => {
  return getOAuthClient().authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: 'sbm-electric-state'
  });
};

const handleCallback = async (url) => {
  const client = getOAuthClient();
  const authResponse = await client.createToken(url);
  const tokens = authResponse.getJson();

  await saveTokens({
    realm_id: client.getToken().realmId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expiry: new Date(Date.now() + tokens.expires_in * 1000),
    refresh_token_expiry: new Date(Date.now() + tokens.x_refresh_token_expires_in * 1000)
  });

  return {
    realmId: client.getToken().realmId,
    expiresIn: tokens.expires_in
  };
};

const saveTokens = async (tokenData) => {
  const existing = await database('qbo_tokens').where('realm_id', tokenData.realm_id).first();
  if (existing) {
    // access_token y refresh_token se escriben SIEMPRE en la misma operación de UPDATE:
    // nunca queda un estado a medias donde uno se actualizó y el otro no.
    await database('qbo_tokens').where('id', existing.id).update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_expiry: tokenData.token_expiry,
      refresh_token_expiry: tokenData.refresh_token_expiry,
      updated_at: new Date()
    });
  } else {
    await database('qbo_tokens').insert(tokenData);
  }
};

// Arma el payload a persistir tras un refresh. Asunción clave: Intuit no siempre
// devuelve un refresh_token nuevo en la respuesta (solo cuando rota); si no viene,
// hay que conservar el actual en la MISMA escritura para no perderlo/dejarlo en null.
const buildRotatedTokenData = (previousTokens, newTokens) => {
  const rotated = Boolean(newTokens.refresh_token) && newTokens.refresh_token !== previousTokens.refresh_token;

  return {
    tokenData: {
      realm_id: previousTokens.realm_id,
      access_token: newTokens.access_token,
      refresh_token: newTokens.refresh_token || previousTokens.refresh_token,
      token_expiry: new Date(Date.now() + newTokens.expires_in * 1000),
      refresh_token_expiry: newTokens.x_refresh_token_expires_in
        ? new Date(Date.now() + newTokens.x_refresh_token_expires_in * 1000)
        : previousTokens.refresh_token_expiry
    },
    rotated
  };
};

// Asunción: hoy existe una única fila activa en qbo_tokens. Si en el futuro se soportan
// múltiples realms/companies, acá hay que filtrar por el realm correspondiente en vez
// de tomar "la más reciente" a ciegas.
const getActiveTokenRow = async () => {
  return database('qbo_tokens').orderBy('updated_at', 'desc').first();
};

const getAuthenticatedClient = async () => {
  const tokens = await getActiveTokenRow();
  if (!tokens) {
    throw new Error('No hay tokens de QBO. Debes autenticarte primero en /api/qbo/auth');
  }

  const client = getOAuthClient();
  client.setToken({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    realmId: tokens.realm_id,
    token_type: 'bearer'
  });

  if (new Date() > new Date(tokens.token_expiry)) {
    console.log('Token expirado, refrescando...');
    try {
      const authResponse = await client.refresh();
      const newTokens = authResponse.getJson();
      const { tokenData } = buildRotatedTokenData(tokens, newTokens);
      await saveTokens(tokenData);
      console.log('Token refrescado exitosamente');
    } catch (error) {
      console.error(`[QBO_REFRESH_FAILED] Error refrescando token: ${extractIntuitErrorMessage(error)}`);
      throw new Error('Error refrescando token. Debes re-autenticarte en /api/qbo/auth');
    }
  }

  // El realm_id sale SIEMPRE de la fila guardada en DB, nunca de config.qbo.realmId (env).
  // Confirmado que ese env puede desincronizarse del realm_id real con el que se autenticó QBO.
  return { client, realmId: tokens.realm_id };
};

const getBaseUrl = () => {
  return config.qbo.environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
};

/**
 * Punto único de entrada a la API de QuickBooks Online.
 * TODAS las escrituras (POST/PUT) pasan por acá y quedan sujetas al kill switch
 * QBO_WRITES_ENABLED antes de siquiera pedir el token/DB. Los GET no lo requieren.
 */
const request = async (method, path, body = null, { requestId } = {}) => {
  const httpMethod = (method || 'GET').toUpperCase();
  const id = requestId || generateRequestId();

  assertWriteAllowed(httpMethod, path, id);

  const { client, realmId } = await getAuthenticatedClient();
  const url = `${getBaseUrl()}/v3/company/${realmId}${path}`;

  console.log(`QBO API Call [${id}]: ${httpMethod} ${url}`);
  if (body) {
    console.log(`QBO Request Body [${id}]:`, JSON.stringify(redactSensitive(body), null, 2));
  }

  const options = {
    url,
    method: httpMethod,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await client.makeApiCall(options);

  let result;
  if (response.getJson && typeof response.getJson === 'function') {
    result = response.getJson();
  } else if (response.json && typeof response.json === 'object') {
    result = response.json;
  } else if (typeof response.body === 'string') {
    result = JSON.parse(response.body);
  } else {
    result = response;
  }

  console.log(`QBO Response [${id}]:`, JSON.stringify(redactSensitive(result), null, 2));

  if (result.Fault) {
    const errorMsg = result.Fault.Error?.[0]?.Message || 'Error desconocido de QBO';
    const errorDetail = result.Fault.Error?.[0]?.Detail || '';
    throw new Error(`QBO Error: ${errorMsg} - ${errorDetail}`);
  }

  return result;
};

// Se mantiene por compatibilidad con qboCustomerService.js y qboInvoiceService.js
// (únicos consumidores externos hoy). Delega TODO en `request`, que es el único
// punto que aplica el kill switch de escrituras — así ninguna escritura real
// puede saltarse el chequeo, sin necesidad de tocar esos otros archivos.
const makeApiCall = async (endpoint, method = 'GET', body = null) => {
  return request(method, endpoint, body);
};

const refreshTokenPreventively = async () => {
  try {
    const tokens = await getActiveTokenRow();
    if (!tokens) {
      console.error('[QBO_TOKEN_MISSING] No hay tokens guardados en qbo_tokens. No se puede refrescar preventivamente.');
      return { success: false, code: 'QBO_TOKEN_MISSING', message: 'No hay tokens' };
    }

    const client = getOAuthClient();
    client.setToken({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      realmId: tokens.realm_id,
      token_type: 'bearer'
    });

    console.log('QBO: Refrescando token preventivamente...');
    const authResponse = await client.refresh();
    const newTokens = authResponse.getJson();

    const { tokenData, rotated } = buildRotatedTokenData(tokens, newTokens);
    await saveTokens(tokenData);

    console.log(`QBO: Token refrescado exitosamente${rotated ? ' (refresh_token rotado)' : ''}`);
    return { success: true, message: 'Token refrescado', rotated };
  } catch (error) {
    const intuitMessage = extractIntuitErrorMessage(error);
    console.error(`[QBO_REFRESH_FAILED] Error refrescando token preventivamente: ${intuitMessage}`);
    return { success: false, code: 'QBO_REFRESH_FAILED', message: intuitMessage };
  }
};

// Refrescar token cada 45 minutos para mantenerlo activo
const startTokenRefreshInterval = () => {
  const REFRESH_INTERVAL = 45 * 60 * 1000; // 45 minutos

  setInterval(async () => {
    await refreshTokenPreventively();
  }, REFRESH_INTERVAL);

  console.log('QBO: Intervalo de refresh de token iniciado (cada 45 min)');
};

module.exports = {
  getOAuthClient,
  getAuthUri,
  handleCallback,
  getAuthenticatedClient,
  makeApiCall,
  request,
  getBaseUrl,
  refreshTokenPreventively,
  startTokenRefreshInterval,
  QboWritesDisabledError,
  // Expuestos únicamente para tests unitarios (strict TDD). No usar fuera de este módulo.
  __testables: {
    assertWriteAllowed,
    isWritesEnabled,
    isSdkLoggingEnabled,
    redactSensitive,
    extractIntuitErrorMessage,
    buildRotatedTokenData,
    getActiveTokenRow
  }
};
