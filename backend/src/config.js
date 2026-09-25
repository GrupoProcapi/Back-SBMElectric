require('dotenv').config();
const fs = require("fs");

const readFileSync = filename => {
  try {
    return fs.readFileSync(filename).toString("utf8").trim();
  } catch (e) {
    return null;
  }
};

// Security-sensitive: unlike other config values in this file (which fall back
// to safe/optional defaults or stay null/undefined), the API key must never
// have a hardcoded fallback, since that would let the app boot with a known,
// predictable credential. Fail fast instead of starting in an insecure state.
if (!process.env.API_KEY) {
  console.error('FATAL: Missing required environment variable API_KEY. The application cannot start without it.');
  process.exit(1);
}

// Constants
module.exports = {
  database: {
    host: process.env.DATABASE_HOST || "localhost",
    port: process.env.DATABASE_PORT,
    database: process.env.DATABASE_DB,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD_FILE
      ? readFileSync(process.env.DATABASE_PASSWORD_FILE)
      : process.env.DATABASE_PASSWORD || null
  },
  port: process.env.PORT || 8080,
  portSOAP: process.env.PORTSOAP || 4747,
  apiKey: process.env.API_KEY,
  jwt: {
    secret: process.env.JWT_SECRET || 'bdd05bf894011885ff44'
  },
  qbo: {
    clientId: process.env.QBO_CLIENT_ID,
    clientSecret: process.env.QBO_CLIENT_SECRET,
    redirectUri: process.env.QBO_REDIRECT_URI || 'https://electric-api.shelterbaymarina.com/api/qbo/callback',
    environment: process.env.QBO_ENVIRONMENT || 'sandbox',
    realmId: process.env.QBO_REALM_ID || null
  }
};
