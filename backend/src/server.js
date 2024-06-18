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
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const database = require("./database");
const apiKeyValidator = require("./apiKeyValidator");
const { validationResult } = require('express-validator');
const { validateCreateUser, validateUpdateUser, validateId, validateDate, validateLogin, validateCreateMeasurer, validateUpdateMeasurer, validateUpdateInvoice, validateCreateMeasurements, validateUpdateMeasurements, validateCreateInvoice } = require('./validationRules');
const jwt = require('jsonwebtoken');
// Api
const app = express();
app.use(bodyParser.json());
app.use(morgan("common"));

const isEmpty = (str) => {
  return str === null || str === undefined || str.trim() === '';
};

const groupMeasurementsByClientName = (measurements) => {
  return measurements.reduce((acc, measurement) => {
      const { sbmqb_customer_name,  measurer_id, status } = measurement;
      const key = `${sbmqb_customer_name}-itfjrbk-${measurer_id}-itfjrbk-${status}`
      if (!acc[key]) {
          acc[key] = [];
      }
      acc[key].push(measurement);
      return acc;
  }, {});
};

const calculateTotalMeasurements = (groupedMeasurements, from, to) => {
  const totalMeasurements = [];

  for (const key in groupedMeasurements) {
      if (groupedMeasurements.hasOwnProperty(key)) {
          const measurements = groupedMeasurements[key];
          measurements.sort((a, b) => a.id - b.id);

          const firstMeasurement = measurements[0].current_measure_value;
          const lastMeasurement = measurements[measurements.length - 1].current_measure_value;
          const measurementIds = measurements.map(measurement => measurement.id);
          const sbmqb_service = measurements[0].sbmqb_service;
          const measurer_code = measurements[0].pedestal_id;
          const [sbmqb_customer_name, measurer_id, status] = key.split('-itfjrbk-');

          //Utilizaremos jwt para  que podamos acceder a la información sin tener que hacer un post del body compuesto.
          const secretKey = 'bdd05bf894011885ff44';
          clientData = {
            sbmqb_customer_name: sbmqb_customer_name,
            sbmqb_service: sbmqb_service,
            measurer_id : measurer_id,
            measurer_code: measurer_code,
            initial_measure_value: firstMeasurement,
            current_measure_value: lastMeasurement,
            total_measure_value: lastMeasurement - firstMeasurement,
            status:status,
            begin_date:from,
            end_date:to,
            ids: measurementIds
          }

          const clientToken = jwt.sign(clientData, secretKey, { expiresIn: '24h' });

          totalMeasurements.push({
            sbmqb_customer_name: sbmqb_customer_name,
            sbmqb_service: sbmqb_service,
            measurer_id : measurer_id,
            measurer_code: measurer_code,
            initial_measure_value: firstMeasurement,
            current_measure_value: lastMeasurement,
            total_measure_value: lastMeasurement - firstMeasurement,
            status:status,
            begin_date:from,
            end_date:to,
            ids: measurementIds,
            data_token: clientToken
          });
      }
  }

  return totalMeasurements;
};

// Middleware para permitir CORS desde múltiples dominios
app.use((req, res, next) => {
  const allowedOrigins = ['http://localhost:5173','*'];
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Api-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  next();
});

app.get("/", function(req, res, next) {
  res.json({ application: "SBM Measurer API", version: 1 })
});

app.use(apiKeyValidator);

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

app.get("/api/updateServices", function(req, res, next) {
  database.raw(`UPDATE sbmqb_customers SET sbmqb_service = '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70004-Electricity T. @ 0.48/KW' `)
    .then(([rows, columns]) => {
      database.raw(`UPDATE sbmqb_customers SET sbmqb_service = '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70001-Metered elect. @ 0.415/KW' WHERE sbmqb_id IN ('800004FE-1559630569', '8000153F-1651439918', '800006AB-1559694362', '800015FD-1656190661', '800003B8-1559630368', '8000097D-1560200598', '80001643-1659555617', '80001545-1651767472', '8000168F-1662581531', '80000F65-1610125439', '8000168C-1662564298', '80001596-1653594896', '80000426-1559630566', '800006A6-1559694362', '80000483-1559630567', '800009D9-1561573293', '80000844-1559694369', '800001F4-1559630361', '800005DF-1559694358', '80001090-1618934076', '800007F5-1559694368')`)
      .then(([rows, columns]) => rows )
      .then((row) => res.json({ message: row }))
    })
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
app.post('/api/users', validateCreateUser, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
  try {
    const newUser = req.body;
    database.raw(`INSERT INTO users (id, username, password, role) VALUES(NULL,"${newUser.username}", "${btoa(newUser.password)}", "${newUser.role}") RETURNING id`)
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
    database.raw('SELECT id, username, role FROM users')
    .then(([rows]) => res.json({ message: rows }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get single User
app.get('/api/users/:id', validateId, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
  try {
    const userId = req.params.id;
    database.raw(`SELECT id, username, role FROM users WHERE id = ${userId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? res.json({ message: row }) : res.status(404).json({ message: 'User not found' }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update User
app.put('/api/users/:id', validateUpdateUser, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
  try {
    const userId = req.params.id;
    const user = req.body;
    database.raw(`SELECT * FROM users WHERE id = ${userId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? 
        database.raw(`UPDATE users SET username="${user.username}", password="${btoa(user.password)}", role="${user.role}" WHERE id = ${userId}`)
        .then(([rows]) => rows[0])
        .then((row) => res.json({ message: 'User updated.' }))
    : res.status(404).json({ message: 'User not found' }))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete User
app.delete('/api/users/:id', validateId, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
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
app.post('/api/login', validateLogin, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
  try {
    const newUser = req.body;
    database.raw(`SELECT id, username, role FROM users WHERE username = "${newUser.username}" AND password = "${btoa(newUser.password)}"`)
    .then(([rows]) => rows[0])
    .then((row) => row ? res.json({ message: row }) : res.status(404).json({ message: 'Wrong username or password' }))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Measures  Routes 
// Create Measurer
app.post('/api/measurers', validateCreateMeasurer, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
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
app.get('/api/measurers/:id', validateId, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
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
app.put('/api/measurers/:id', validateUpdateMeasurer, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
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
app.delete('/api/measurers/:id', validateId, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
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
app.post('/api/measurements', validateCreateMeasurements, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
  try {
    const newMeasurer = req.body;

    
    database.raw(`SELECT * FROM measurements WHERE measurer_id=${newMeasurer.measurer_id} ORDER BY id desc`)
    .then(([rows]) => rows[0])
    .then((row) => {
      //No existe medida anterior
      if (!row) {
        //registrarla como nueva medida.
        database.raw(`INSERT INTO measurements ( measurer_id, sbmqb_customer_name, description, 
          current_measure_value, current_measure_date, status) VALUES( ${newMeasurer.measurer_id}, "${newMeasurer.sbmqb_customer_name}", "${newMeasurer.description}", ${newMeasurer.current_measure_value}, "${newMeasurer.current_measure_date}", "${newMeasurer.status}")`)
        .then(([rows]) => rows[0])
        .then((row) => res.status(201).json({message : "Measurement Created"}))
        .catch(next);
        return
      }
      // manejar la medida anterior para asignar lastmeasure

      const dateStr = row.last_measure_date;
      const date = new Date(dateStr);
      const formattedDate = date.toISOString().slice(0, 19).replace('T', ' ');
      //console.log(formattedDate);  // '2024-05-25 18:27:09'

      database.raw(`INSERT INTO measurements ( measurer_id, sbmqb_customer_name, description, last_measure_value, last_measure_date, current_measure_value, current_measure_date, sbmqb_service, status) VALUES( ${newMeasurer.measurer_id}, "${newMeasurer.sbmqb_customer_name}", "${newMeasurer.description}", ${row.current_measure_value}, "${formattedDate}", ${newMeasurer.current_measure_value}, "${newMeasurer.current_measure_date}","${newMeasurer.sbmqb_service || ''}", "${newMeasurer.status}")`)
      .then(([lineas]) => lineas[0])
      .then((lin) => res.status(201).json({message : "Measurement Created"}))
      .catch(next);
    })
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Get all Measurements
app.get('/api/measurements', async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
  try {
    var query = "";
    const from = req.query.from;
    const to = req.query.to;
    const measurerId = req.query.measurer_id 
    const customerName = req.query.customer_name
    if(from != null && to != null)
      {
        isEmpty(query) ? query += " WHERE" : query += " AND"; 
        query += ` DATE(last_measure_date) BETWEEN "${from}" and "${to}"`;
      }
    if(measurerId != null)
      {
        isEmpty(query) ? query += " WHERE" : query += " AND"; 
        query += ` measurer_id = ${measurerId}`;
      }
    if(customerName != null)
      {
        isEmpty(query) ? query += " WHERE" : query += " AND"; 
        query += ` sbmqb_customer_name = "${customerName}"`;
      }
    database.raw(`SELECT * FROM measurements ${query} ORDER BY id desc`)
    .then(([rows]) => res.json({ message: rows }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all Measurements for a specific Measurer
app.get('/api/measurers/:id/measurements', validateId, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
  try {
    const measurerId = req.params.id;
    database.raw(`SELECT * FROM measurements WHERE measurer_id=${measurerId} ORDER BY id desc`)
    .then(([rows]) => res.json({ message: rows }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get total consumption for all Measurements
app.get('/api/measurements/total', validateDate, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
  try {
    var query = "";
    const from = req.query.from;
    const to = req.query.to;
    const measurerCode = req.query.measurer_code 
    const customerName = req.query.customer_name

    if(from != null && to != null)
      {
        query += `WHERE DATE(x.current_measure_date) BETWEEN "${from}" and "${to}"`;
      }
    if(measurerCode != null)
      {
        query += ` AND y.measurer_code = "${measurerCode}"`;
      }
    if(customerName != null)
      {
        query += ` AND x.sbmqb_customer_name = "${customerName}"`;
      }
    database.raw(`SELECT x.*, y.measurer_code, y.pedestal_id FROM measurements x INNER JOIN measurers y ON x.measurer_id = y.id ${query} ORDER BY x.id desc`)
    .then(([rows]) => { 
      const groupedMeasurements = groupMeasurementsByClientName(rows);
      const totalMeasurements = calculateTotalMeasurements(groupedMeasurements, from, to);
      res.json({ message: totalMeasurements })
    })
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get single Measurements
app.get('/api/measurements/:id', validateId, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
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
app.put('/api/measurements/:id', validateUpdateMeasurements, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
  try {
    const measurementId = req.params.id;
    const measurement = req.body;
    //database.raw(`UPDATE measurements SET user_id=${measurement.user_id}, measurer_id=${measurement.measurer_id}, sbmqb_customer_name="${measurement.sbmqb_customer_name}", sbmqb_customer_id="${measurement.sbmqb_customer_id}", sbmqb_service="${measurement.sbmqb_service}", description="${measurement.description}",  last_measure_value=${measurement.last_measure_value}, last_measure_date="${measurement.last_measure_date}", current_measure_value=${measurement.current_measure_value}, current_measure_date="${measurement.current_measure_date}", status="${measurement.status}" WHERE id = ${measurementId}`)
    //database.raw(`UPDATE measurements SET sbmqb_customer_name="${measurement.sbmqb_customer_name}", sbmqb_service="${measurement.sbmqb_service}", description="${measurement.description}", current_measure_value=${measurement.current_measure_value}, current_measure_date="${measurement.current_measure_date}", status="${measurement.status}" WHERE id = ${measurementId}`)
    database.raw(`SELECT * FROM measurements WHERE id = ${measurementId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? 
        database.raw(`UPDATE measurements SET status="${measurement.status}" WHERE id = ${measurementId}`)
        .then(([rows]) => rows[0])
        .then((row) => res.json({ message: 'Measurement updated.' }))
    : res.status(404).json({ message: 'Measurement not found' }))
    .catch(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete Measurement
app.delete('/api/measurements/:id', validateId, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
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

// Post Bill
app.post('/api/bill', validateCreateInvoice, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
  try {
    const secretKey = 'bdd05bf894011885ff44';

    const tokenPromises = req.body.data_token.map(async element => {

      // Decodificacion del token recibido
      var newInvoice = await new Promise((resolve, reject) => {
        jwt.verify(element.dataToken, secretKey, (err, decoded) => {
            if (err) {
                return reject(err);
            }
            resolve(decoded);
        });
      });

      await database.transaction(async trx => {
        const [insertedInvoice] = await trx('sbmqb_invoices')
          .insert({
            sbmqb_customer_name: newInvoice.sbmqb_customer_name,
            sbmqb_service: newInvoice.sbmqb_service,
            measurer_code: newInvoice.measurer_code,
            initial_measure_value: newInvoice.initial_measure_value,
            current_measure_value: newInvoice.current_measure_value,
            total_measure_value: newInvoice.total_measure_value,
            begin_date: newInvoice.begin_date,
            end_date: newInvoice.end_date,
            status: 'PENDIENTE',
            sbmqb_invoice_id: "" 
          })
          .returning('*');

        await trx('measurements')
          .update({
            status: 'PROCESANDO',
            sbmqb_invoices_id: insertedInvoice
          })
          .whereIn('id', newInvoice.ids);
      })
      
    });

    await Promise.all(tokenPromises);
    res.status(200).json({ message:  "Todas las operaciones se completaron con éxito" });

  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Get all Invoices
app.get('/api/invoices', async (req, res, next) => {
  try {
    database.raw('SELECT * FROM sbmqb_invoices')
    .then(([rows]) => res.json({ message: rows }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get single Invoice
app.get('/api/invoices/:id', validateId, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
  try {
    const invoiceId = req.params.id;
    database.raw(`SELECT * FROM sbmqb_invoices WHERE id = ${invoiceId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? res.json({ message: row }) : res.status(404).json({ message: 'Invoice not found' }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update Invoice
app.put('/api/invoices/:id', validateUpdateInvoice, async (req, res, next) => {
  const errors = validationResult(req);
  if(!errors.isEmpty())
    {
      return res.status(400).json({ errors: errors.array() });
    }
  try {
    const invoiceId = req.params.id;
    const invoice = req.body;
    database.raw(`SELECT id FROM sbmqb_invoices WHERE id = ${invoiceId}`)
    .then(([rows]) => rows[0])
    .then((row) => row ? 
        database.raw(`UPDATE sbmqb_invoices SET status="${invoice.status}" WHERE id = ${invoiceId}`)
        .then(([rows]) => rows[0])
        .then((row) => res.json({ message: 'Invoice updated.' }))
    : res.status(404).json({ message: 'Invoice not found' }))
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

// Put Customers
app.put('/api/customers', async (req, res, next) => {
  try {
    const customer = req.body;
    database.raw(`UPDATE sbmqb_customers SET sbmqb_service = "${customer.sbmqb_service}" where sbmqb_id = "${customer.sbmqb_id}"`)
    .then(([rows, columns]) => rows)
    .then((row) => res.json({ message: "Se actualizo el servicio del cliente a: "+customer.sbmqb_service }))
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
