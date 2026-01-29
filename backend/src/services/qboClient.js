const OAuthClient = require('intuit-oauth');
const config = require('../config');
const database = require('../database');

let oauthClient = null;

const getOAuthClient = () => {
  if (!oauthClient) {
    oauthClient = new OAuthClient({
      clientId: config.qbo.clientId,
      clientSecret: config.qbo.clientSecret,
      environment: config.qbo.environment,
      redirectUri: config.qbo.redirectUri,
      logging: true
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

const getAuthenticatedClient = async () => {
  const tokens = await database('qbo_tokens').orderBy('updated_at', 'desc').first();
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
      await saveTokens({
        realm_id: tokens.realm_id,
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        token_expiry: new Date(Date.now() + newTokens.expires_in * 1000),
        refresh_token_expiry: new Date(Date.now() + newTokens.x_refresh_token_expires_in * 1000)
      });
      console.log('Token refrescado exitosamente');
    } catch (error) {
      console.error('Error refrescando token:', error);
      throw new Error('Error refrescando token. Debes re-autenticarte en /api/qbo/auth');
    }
  }
  
  return { client, realmId: tokens.realm_id };
};

const getBaseUrl = () => {
  return config.qbo.environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
};

const makeApiCall = async (endpoint, method = 'GET', body = null) => {
  const { client, realmId } = await getAuthenticatedClient();
  const url = `${getBaseUrl()}/v3/company/${realmId}${endpoint}`;
  
  const options = {
    url,
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await client.makeApiCall(options);
  return response.getJson();
};

module.exports = {
  getOAuthClient,
  getAuthUri,
  handleCallback,
  getAuthenticatedClient,
  makeApiCall,
  getBaseUrl
};
