const config = require('./config');

const apiKeyValidator = (req, res, next) => {
  const apiKey = req.headers['api-key'];

  console.log(apiKey)
  console.log(config.apiKey)
  if (!apiKey) {
    return res.status(401).json({ error: 'API key is missing' });
  }

  if (apiKey !== config.apiKey) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
};

module.exports = apiKeyValidator;