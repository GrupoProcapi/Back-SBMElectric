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
    database.raw(`INSERT INTO users (id, username, password, rol) VALUES(NULL,"${newUser.username}", "${btoa(newUser.password)}", "${newUser.rol}") RETURNING id`)
    .then(([rows]) => rows[0])
    .then((row) => res.status(201).json({message : "User Created. UserId:" + row.id}))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Get all Users
app.get('/api/users', async (req, res, next) => {
  try {
    database.raw('SELECT * FROM users')
    .then(([rows]) => res.json({ message: rows }))
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
    .then(([rows]) => rows[0])
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
app.post('/api/login', async (req, res, next) => {
  try {
    const newUser = req.body;
    database.raw(`SELECT username,rol FROM users WHERE username = "${newUser.username}" AND password = "${btoa(newUser.password)}"`)
    .then(([rows]) => rows[0])
    .then((row) => row ? res.json({ message: row }) : res.status(404).json({ message: 'Wrong username or password' }))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Measures  Routes 
// Create Measurer
app.post('/api/measurers', async (req, res, next) => {
  try {
    const newMeasurer = req.body;
    database.raw(`INSERT INTO measurers (id, pedestal, pedestal_id, measurer_code) VALUES(NULL,"${newMeasurer.pedestal}", "${newMeasurer.pedestal_id}", "${newMeasurer.measurer_code}") RETURNING id`)
    .then(([rows]) => rows[0])
    .then((row) => res.status(201).json({message : "Measurer Created, Id:" + row.id}))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Get all Measurers
app.get('/api/measurers', async (req, res, next) => {
  try {
    database.raw('SELECT * FROM measurers')
    .then(([rows]) => res.json({ message: rows }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get single Measurer
app.get('/api/measurers/:id', async (req, res, next) => {
  try {
    const measurersId = req.params.id;
    database.raw(`SELECT * FROM measurers WHERE id = ${measurersId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? res.json({ message: row }) : res.status(404).json({ message: 'Measurer not found' }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update Measurer
app.put('/api/measurers/:id', async (req, res, next) => {
  try {
    const measurerId = req.params.id;
    const measurer = req.body;
    database.raw(`SELECT * FROM measurers WHERE id = ${measurerId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? 
        database.raw(`UPDATE measurers SET pedestal="${measurer.pedestal}", pedestal_id="${measurer.pedestal_id}", measurer_code="${measurer.measurer_code}" WHERE id = ${measurerId}`)
        .then(([rows]) => rows[0])
        .then((row) => res.json({ message: 'Measurer updated.' }))
    : res.status(404).json({ message: 'Measurer not found' }))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete Measurer
app.delete('/api/measurers/:id', async (req, res, next) => {
  try {
    const measurerId = req.params.id;
    database.raw(`SELECT * FROM measurers WHERE id = ${measurerId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? 
        database.raw(`DELETE FROM measurers WHERE id = ${measurerId}`)
        .then(([rows]) => rows[0])
        .then((row) => res.json({ message: 'Measurer deleted.' }))
    : res.status(404).json({ message: 'Measurer not found' }))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Measurements  Routes 
// Create Measurement
app.post('/api/measurements', async (req, res, next) => {
  try {
    const newMeasurer = req.body;
    database.raw(`INSERT INTO measurements (id, user_id, measurer_id, customer_sbm, last_measure_value, last_measure_date, current_measure_value, current_measure_date) VALUES(NULL, ${newMeasurer.user_id}, ${newMeasurer.measurer_id}, "${newMeasurer.customer_sbm}", ${newMeasurer.last_measure_value}, "${newMeasurer.last_measure_date}", ${newMeasurer.current_measure_value}, "${newMeasurer.current_measure_date}")`)
    .then(([rows]) => rows[0])
    .then((row) => res.status(201).json({message : "Measurement Created"}))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Get all Measurements
app.get('/api/measurements', async (req, res, next) => {
  try {
    database.raw('SELECT * FROM measurements')
    .then(([rows]) => res.json({ message: rows }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all Measurements for a specific Measurer
app.get('/api/measurers/:id/measurements', async (req, res, next) => {
  try {
    const measurerId = req.params.id;
    database.raw(`SELECT * FROM measurements WHERE measurer_id=${measurerId} ORDER BY id desc`)
    .then(([rows]) => res.json({ message: rows }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get single Measurements
app.get('/api/measurements/:id', async (req, res, next) => {
  try {
    const measurementId = req.params.id;
    database.raw(`SELECT * FROM measurements WHERE id = ${measurementId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? res.json({ message: row }) : res.status(404).json({ message: 'Measurement not found' }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update Measurement
app.put('/api/measurements/:id', async (req, res, next) => {
  try {
    const measurementId = req.params.id;
    const measurement = req.body;
    database.raw(`SELECT * FROM measurements WHERE id = ${measurementId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? 
        database.raw(`UPDATE measurements SET user_id=${measurement.user_id}, measurer_id=${measurement.measurer_id}, customer_sbm="${measurement.customer_sbm}", last_measure_value=${measurement.last_measure_value}, last_measure_date="${measurement.last_measure_date}", current_measure_value=${measurement.current_measure_value}, current_measure_date="${measurement.current_measure_date}" WHERE id = ${measurementId}`)
        .then(([rows]) => rows[0])
        .then((row) => res.json({ message: 'Measurement updated.' }))
    : res.status(404).json({ message: 'Measurement not found' }))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete Measurement
app.delete('/api/measurements/:id', async (req, res, next) => {
  try {
    const measurementId = req.params.id;
    database.raw(`SELECT * FROM measurements WHERE id = ${measurementId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? 
        database.raw(`DELETE FROM measurements WHERE id = ${measurementId}`)
        .then(([rows]) => rows[0])
        .then((row) => res.json({ message: 'Measurement deleted.' }))
    : res.status(404).json({ message: 'Measurements not found' }))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});




module.exports = app;
