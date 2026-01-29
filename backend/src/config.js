require('dotenv').config();
const fs = require("fs");

const readFileSync = filename => {
  try {
    return fs.readFileSync(filename).toString("utf8").trim();
  } catch (e) {
    return null;
  }
};

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
  apiKey: process.env.API_KEY || 'a2a47f86-c361-4fed-98ec-6b36eeef0266',
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
