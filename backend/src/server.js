// simple node web server that displays hello world
// optimized for Docker image

const express = require("express");
// this example uses express web framework so we know what longer build times
// do and how Dockerfile layer ordering matters. If you mess up Dockerfile ordering
// you'll see long build times on every code change + build. If done correctly,
// code changes should be only a few seconds to build locally due to build cache.

const morgan = require("morgan");
// morgan provides easy logging for express, and by default it logs to stdout
// which is a best practice in Docker. Friends don't let friends code their apps to
// do app logging to files in containers.
const bodyParser = require('body-parser');
const database = require("./database");

// Api
const app = express();
app.use(bodyParser.json());
app.use(morgan("common"));

app.get("/", function(req, res, next) {
  database.raw('select VERSION() version')
    .then(([rows, columns]) => rows[0])
    .then((row) => res.json({ message: `Hello from MySQL ${row.version}` }))
    .catch(next);
});

app.get("/schema", function(req, res, next) {
  database.raw('CREATE DATABASE sbm_electric_measurement')
    .then(([rows, columns]) => rows[0])
    .then((row) => res.json({ message: row }))
    .catch(next);
});

app.get("/database", function(req, res, next) {
  database.raw('SHOW DATABASES')
    .then(([rows, columns]) => rows)
    .then((row) => res.json({ message: row }))
    .catch(next);
});

app.get("/tablas", function(req, res, next) {
  database.raw('SHOW TABLES')
    .then(([rows, columns]) => rows)
    .then((row) => res.json({ message: row }))
    .catch(next);
});

app.get("/drop", function(req, res, next) {
  database.raw(`DROP TABLE users`)
    .then(([rows, columns]) => rows)
    .then((row) => res.json({ message: row }))
    .catch(next);
});

app.get("/healthz", function(req, res) {
  // do app logic here to determine if app is truly healthy
  // you should return 200 if healthy, and anything else will fail
  // if you want, you should be able to restrict this to localhost (include ipv4 and ipv6)
  res.send("I am happy and healthy\n");
});

// User Routes 
// Create User
app.post('/api/users', async (req, res, next) => {
  try {
    const newUser = req.body;
    database.raw(`INSERT INTO users (id, username, password, rol) VALUES(NULL,"${newUser.username}", "${btoa(newUser.password)}", "${newUser.role}")`)
    .then(([rows, columns]) => rows[0])
    .then((row) => res.status(201).json({message : "User Created"}))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Get all Users
app.get('/api/users', async (req, res, next) => {
  try {
    database.raw('SELECT * FROM users')
    .then(([rows, columns]) => rows[0])
    .then((row) => res.json({ message: row }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get single User
app.get('/api/users/:id', async (req, res, next) => {
  try {
    const userId = req.params.id;
    database.raw(`SELECT * FROM users WHERE id = ${userId}`)
    .then(([rows, columns]) => rows[0])
    .then((row) => row ? res.json({ message: row }) : res.status(404).json({ message: 'User not found' }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update User
app.put('/api/users/:id', async (req, res, next) => {
  try {
    const userId = req.params.id;
    const user = req.body;
    database.raw(`SELECT * FROM users WHERE id = ${userId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? 
        database.raw(`UPDATE users SET username="${user.username}", password="${btoa(user.password)}", rol="${user.role}" WHERE id = ${userId}`)
        .then(([rows]) => rows[0])
        .then((row) => res.json({ message: 'User updated.' }))
    : res.status(404).json({ message: 'User not found' }))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete User
app.delete('/api/users/:id', async (req, res, next) => {
  try {
    const userId = req.params.id;
    database.raw(`SELECT * FROM users WHERE id = ${userId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? 
        database.raw(`DELETE FROM users WHERE id = ${userId}`)
        .then(([rows]) => rows[0])
        .then((row) => res.json({ message: 'User deleted.' }))
    : res.status(404).json({ message: 'User not found' }))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

//Log In
app.post('/api/log', async (req, res, next) => {
  try {
    const newUser = req.body;
    database.raw(`SELECT username,rol FROM users WHERE username = "${newUser.username}" AND password = "${btoa(newUser.password)}"`)
    .then(([rows, columns]) => rows[0])
    .then((row) => row ? res.json({ message: row }) : res.status(404).json({ message: 'Wrong username or password' }))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Get all Customers
app.get('/api/customers', async (req, res, next) => {
  try {
    database.raw('SELECT * FROM sbmqb_customers')
    .then(([rows, columns]) => rows)
    .then((row) => res.json({ message: row }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get single Customer
app.get('/api/customers/:id', async (req, res, next) => {
  try {
    const customerId = req.params.id;
    database.raw(`SELECT * FROM sbmqb_customers WHERE sbmqb_id = ${customerId}`)
    .then(([rows, columns]) => rows[0])
    .then((row) => row ? res.json({ message: row }) : res.status(404).json({ message: 'Customer not found' }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all Services
app.get('/api/services', async (req, res, next) => {
  try {
    database.raw('SELECT * FROM sbmqb_services')
    .then(([rows, columns]) => rows)
    .then((row) => res.json({ message: row }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get single Services
app.get('/api/services/:id', async (req, res, next) => {
  try {
    const serviceId = req.params.id;
    database.raw(`SELECT * FROM sbmqb_services WHERE sbmqb_id = ${serviceId}`)
    .then(([rows, columns]) => rows[0])
    .then((row) => row ? res.json({ message: row }) : res.status(404).json({ message: 'Service not found' }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = app;
