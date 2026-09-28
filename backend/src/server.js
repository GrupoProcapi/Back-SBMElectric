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
const qboPublicRoutes = require('./routes/qboPublicRoutes');
const qboAdminRoutes = require('./routes/qboAdminRoutes');
const qboInvoiceService = require('./services/qboInvoiceService');
const qboConfig = require('./config/qboConfig');
// Api
const app = express();
app.use(bodyParser.json());
app.use(morgan("common"));

// Public QBO endpoints (OAuth start + Intuit's redirect callback) — these can NEVER
// require the internal api-key, since the browser redirect from Intuit doesn't carry it.
// Every other QBO endpoint lives in qboAdminRoutes and is mounted below, after apiKeyValidator.
app.use('/api/qbo', qboPublicRoutes);

const isEmpty = (str) => {
  return str === null || str === undefined || str.trim() === '';
};

// Deriva un label legible para el dropdown de tarifas a partir de una key de
// QBO_SERVICE_MAP_JSON (ej. "4113 · INGRESOS ELECTRIDIDAD:70000:70004-Electricity
// T. @ 0.48/KW" -> "Electricity T. @ 0.48/KW"). Puramente cosmético: si el
// formato no matchea lo esperado, devuelve la key completa tal cual en vez de
// romper (usada solo por GET /api/customers/rate-options).
const deriveServiceLabel = (key) => {
  const lastSegment = key.split(':').pop();
  const match = lastSegment.match(/^\d+-(.+)$/);
  return match ? match[1] : key;
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

          // Fallback para filas "baseline" sembradas desde el histórico de QuickBooks
          // (incidente 2026-08-30): esas filas tienen current_measure_value en NULL
          // porque representan el punto de partida antes de la primera lectura real.
          // Mismo fallback que ya existe en el frontend (MedidorForm.tsx, fix
          // 2026-08-31): si no hay lectura actual, se usa la última lectura conocida
          // (last_measure_value). El fallback final a 0 blinda contra el caso extremo
          // de que ninguna de las dos exista, para no producir NaN en total_measure_value.
          const firstRow = measurements[0];
          const lastRow = measurements[measurements.length - 1];
          const firstMeasurement = firstRow.current_measure_value ?? firstRow.last_measure_value ?? 0;
          const lastMeasurement = lastRow.current_measure_value ?? lastRow.last_measure_value ?? 0;
          const measurementIds = measurements.map(measurement => measurement.id);
          const sbmqb_service = measurements[measurements.length - 1].sbmqb_service;
          const measurer_code = measurements[0].pedestal_id;
          const [sbmqb_customer_name, measurer_id, status] = key.split('-itfjrbk-');

          // Fix ALTO (code review 2026-09-27): con el fallback a last_measure_value
          // agregado más arriba, una fila "baseline" (326 filas sembradas en la
          // recuperación de datos del 2026-08-30, sin current_measure_value) puede
          // dar un total negativo si el valor sembrado en last_measure_value quedó
          // más alto que la primera lectura real registrada después (margen de
          // error de la recuperación, medidor reemplazado, etc.). Ese total se
          // manda literalmente como cantidad de factura a QBO -- nunca debe pasar
          // un valor negativo. Se clampea a 0 y se marca needsReview para que
          // Facturación revise manualmente en vez de que el error se silencie.
          const rawTotal = lastMeasurement - firstMeasurement;
          const needsReview = rawTotal < 0;
          const totalMeasurementValue = needsReview ? 0 : rawTotal;

          if (needsReview) {
            console.warn(
              `total_measure_value negativo (${rawTotal}) para cliente="${sbmqb_customer_name}" measurer_id=${measurer_id} pedestal_id=${measurer_code} -- clampeado a 0 y marcado needsReview.`
            );
          }

          //Utilizaremos jwt para  que podamos acceder a la información sin tener que hacer un post del body compuesto.
          const secretKey = 'bdd05bf894011885ff44';
          clientData = {
            sbmqb_customer_name: sbmqb_customer_name,
            sbmqb_service: sbmqb_service,
            measurer_id : measurer_id,
            measurer_code: measurer_code,
            initial_measure_value: firstMeasurement,
            current_measure_value: lastMeasurement,
            total_measure_value: totalMeasurementValue,
            needsReview: needsReview,
            status:status,
            begin_date:from,
            end_date:to,
            ids: measurementIds
          }

          const clientToken = jwt.sign(clientData, secretKey, { expiresIn: '24h' });

          /*
          var precio = "0.48"
          switch (sbmqb_service) {
            case "4113 &#183; INGRESOS ELECTRIDIDAD:70000:70004-Electricity T. @ 0.48/KW":
              precio = "0.48/KW"
              break;
            case "4113 &#183; INGRESOS ELECTRIDIDAD:70000:70003-Metered elect. @ 0.21/KW":
              precio = "0.21/KW"
              break;
            case "4113 &#183; INGRESOS ELECTRIDIDAD:70000:70002-Metered elect. @ 0.415/KW":
              precio = "0.415/KW"
              break;
            case "4113 &#183; INGRESOS ELECTRIDIDAD:70000:70001-Metered elect. @ 0.415/KW":
              precio = "0.415/KW"
              break;
            default:
              precio = "0.48/KW"
              break;
          }*/

          totalMeasurements.push({
            sbmqb_customer_name: sbmqb_customer_name,
            sbmqb_service: sbmqb_service,
            measurer_id : measurer_id,
            measurer_code: measurer_code,
            initial_measure_value: firstMeasurement,
            current_measure_value: lastMeasurement,
            total_measure_value: totalMeasurementValue,
            needsReview: needsReview,
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
  const allowedOrigins = ['http://localhost:5173','https://zlsjlkmn-5173.use2.devtunnels.ms','https://electric.shelterbaymarina.com', 'https://sbm-electricmeter-imns8.ondigitalocean.app','https://sbmelectric-app-v6qdd.ondigitalocean.app','https://electric.shelterbaymarina.com','*'];
  const origin = req.headers.origin;
  
  if (allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  // Si es una solicitud OPTIONS, responde inmediatamente con 200 OK
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
});

app.get("/", function(req, res, next) {
  res.json({ application: "SBM Measurer API", version: 1 })
});

//Log In
// IMPORTANT: this route MUST stay registered before app.use(apiKeyValidator) below.
// Client apps authenticate here to obtain a session and don't have the internal
// api-key — if this route is ever moved after apiKeyValidator, login breaks for
// every client without that key.
// TODO(rate-limit): this endpoint needs dedicated rate limiting (e.g. express-rate-limit)
// to slow down credential-stuffing/brute-force attempts. express-rate-limit is NOT
// currently a dependency of this project — do not add it without Jefe's approval.
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

app.use(apiKeyValidator);

// Admin QBO endpoints (customers/invoices/items sync, status) — protected by the
// internal api-key like every other admin route below.
app.use('/api/qbo', qboAdminRoutes);

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

// DEPRECADO Y DESHABILITADO POR SEGURIDAD (2026-09-27, ver reporte a Jefe).
// Este endpoint tenía 3 problemas serios:
//  1. El primer UPDATE no tenía WHERE: reseteaba `sbmqb_service` de TODOS los
//     clientes de `sbmqb_customers` sin filtro alguno.
//  2. Escribía el string con la entidad HTML `&#183;` en vez del carácter real
//     `·` -- el mismo bug de encoding que ya se corrigió en QBO_SERVICE_MAP_JSON.
//  3. Tenía 21 sbmqb_id hardcodeados en el código fuente para asignarles la
//     tarifa de 0.415/KW, en vez de usar un input validado.
// Reemplazado por PUT /api/customers/:sbmqb_id/rate, que valida `serviceKey`
// contra las keys reales de QBO_SERVICE_MAP_JSON y escribe con WHERE
// parametrizado, una sola fila a la vez. No se borra la ruta (por si algo
// externo le sigue pegando) pero queda inutilizada con 410 Gone.
app.get("/api/updateServices", function(req, res, next) {
  res.status(410).json({
    error: 'Endpoint deprecado y deshabilitado por seguridad. Usar PUT /api/customers/:sbmqb_id/rate'
  });
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
        // NOTA (BUG ALTO, seguridad + funcional, corregido): antes se armaba con
        // `database.raw` interpolando los valores directo en un string SQL con
        // comillas dobles -- inyectable, y además rompía con un error genérico si
        // `description` (comentario del técnico) contenía una comilla doble. Se
        // usa el query builder parametrizado de knex (`database.table(...)`, mismo
        // patrón que GET/PUT /api/customers, para que el singleton siga siendo
        // interceptable en tests), sin cambiar ningún campo ni la lógica
        // condicional con/sin medida anterior.
        database.table('measurements').insert({
          measurer_id: newMeasurer.measurer_id,
          sbmqb_customer_name: newMeasurer.sbmqb_customer_name,
          description: newMeasurer.description ?? null,
          current_measure_value: newMeasurer.current_measure_value,
          current_measure_date: newMeasurer.current_measure_date,
          status: newMeasurer.status
        })
        .then(() => res.status(201).json({message : "Measurement Created"}))
        .catch(next);
        return
      }
      // manejar la medida anterior para asignar lastmeasure

      const dateStr = row.current_measure_date;
      const date = new Date(dateStr);
      const formattedDate = date.toISOString().slice(0, 19).replace('T', ' ');
      //console.log(formattedDate);  // '2024-05-25 18:27:09'

      database.table('measurements').insert({
        measurer_id: newMeasurer.measurer_id,
        sbmqb_customer_name: newMeasurer.sbmqb_customer_name,
        description: newMeasurer.description ?? null,
        last_measure_value: row.current_measure_value,
        last_measure_date: formattedDate,
        current_measure_value: newMeasurer.current_measure_value,
        current_measure_date: newMeasurer.current_measure_date,
        sbmqb_service: newMeasurer.sbmqb_service || '',
        status: newMeasurer.status
      })
      .then(() => res.status(201).json({message : "Measurement Created"}))
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
    const from = req.query.from;
    const to = req.query.to;
    const measurerCode = req.query.measurer_code
    const customerName = req.query.customer_name

    // NOTA (BUG ALTO, seguridad + funcional, corregido): antes se armaba el WHERE
    // interpolando from/to/measurerCode/customerName directo en el string SQL
    // (inyectable), y el filtro `DATE(x.current_measure_date) BETWEEN ...` excluía
    // TOTALMENTE las filas "baseline" sembradas del histórico de QuickBooks (326
    // filas, incidente 2026-08-30) porque tienen current_measure_date en NULL --
    // `NULL BETWEEN ...` nunca es verdadero en SQL, así que esos clientes
    // desaparecían silenciosamente de Facturación. `from`/`to` son siempre
    // strings no vacíos acá porque el middleware `validateDate` los exige. Se
    // parametriza con bindings y se agrega el fallback: si current_measure_date es
    // NULL, se filtra por last_measure_date en su lugar (mismo criterio que el
    // fallback aplicado en calculateTotalMeasurements).
    // Fix CRÍTICO (code review 2026-09-27): antes el WHERE solo filtraba por rango
    // de fechas, sin importar el status de la medición -- devolvía grupos (y
    // firmaba un data_token nuevo, JWT) para mediciones ya FACTURADO o PROCESANDO
    // dentro del rango. Ese token, si llegaba a POST /api/bill, podía generar una
    // factura local duplicada para mediciones que ya estaban facturadas o en
    // proceso (ver fix compare-and-set en POST /api/bill). 'PENDIENTE' es un
    // literal fijo del código (no input del usuario), no requiere bind param.
    let query = "WHERE ((x.current_measure_date IS NOT NULL AND DATE(x.current_measure_date) BETWEEN ? AND ?)" +
      " OR (x.current_measure_date IS NULL AND DATE(x.last_measure_date) BETWEEN ? AND ?))" +
      " AND x.status = 'PENDIENTE'";
    const bindings = [from, to, from, to];

    if(measurerCode != null)
      {
        query += ' AND y.measurer_code = ?';
        bindings.push(measurerCode);
      }
    if(customerName != null)
      {
        query += ' AND x.sbmqb_customer_name = ?';
        bindings.push(customerName);
      }
    database.raw(`SELECT x.*, y.measurer_code, y.pedestal_id FROM measurements x INNER JOIN measurers y ON x.measurer_id = y.id ${query} ORDER BY x.id desc`, bindings)
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
    // NOTA (BUG CRÍTICO, seguridad + funcional, corregido): la query armaba el
    // UPDATE interpolando valores directo en un string SQL con comillas dobles --
    // inyectable, Y además tenía una coma faltante entre "measurer_id=..." y
    // "sbmqb_customer_name=..." que rompía la sintaxis SQL en TODA ejecución (este
    // endpoint nunca llegó a actualizar una fila en producción, sin importar el
    // contenido enviado). Se reemplaza por el query builder parametrizado de knex
    // (`database.table(...)`, mismo patrón que GET/PUT /api/customers) y se arma el
    // objeto de update solo con los campos realmente enviados en el body -- el
    // contrato real del frontend (Frontend-SBMElectric/src/api/history.ts,
    // UpdateMeasurementPayload) únicamente envía sbmqb_customer_name, description y
    // current_measure_value, así que no tiene sentido pisar el resto de columnas con
    // valores no provistos.
    database.raw(`SELECT * FROM measurements WHERE id = ${measurementId}`)
    .then(([rows]) => rows[0])
    .then((row) => {
      if (!row) {
        return res.status(404).json({ message: 'Measurement not found' });
      }

      // Fix ADVERTENCIA (code review 2026-09-27): el alcance de columnas
      // aceptadas por este endpoint se restringe al contrato real del
      // frontend (Frontend-SBMElectric/src/api/history.ts,
      // UpdateMeasurementPayload) -- sbmqb_customer_name, description y
      // current_measure_value. Antes se aceptaban 9 columnas, incluyendo
      // measurer_id/status/last_measure_*/sbmqb_service, que con un api-key
      // válido y sin validación de tipos permitían manipular datos fuera del
      // contrato (ej. status directamente, o un current_measure_value no
      // numérico que produce NaN aguas abajo en facturación -- ya bloqueado
      // por validateUpdateMeasurements). Si en el futuro hace falta
      // actualizar esas otras columnas, debe ser un endpoint separado con su
      // propia autorización, no ampliar este.
      const updateFields = {};
      if (measurement.sbmqb_customer_name !== undefined) updateFields.sbmqb_customer_name = measurement.sbmqb_customer_name;
      if (measurement.description !== undefined) updateFields.description = measurement.description;
      if (measurement.current_measure_value !== undefined) updateFields.current_measure_value = measurement.current_measure_value;

      if (Object.keys(updateFields).length === 0) {
        return res.json({ message: 'Measurement updated.' });
      }

      return database.table('measurements')
        .where('id', measurementId)
        .update(updateFields)
        .then(() => res.json({ message: 'Measurement updated.' }));
    })
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

// Fix CRÍTICO (code review 2026-09-27): marcador para detectar dentro del
// catch de cada lote que el aborto fue por compare-and-set (mediciones ya
// reclamadas), y no un error real de DB/red -- ver POST /api/bill más abajo.
class MeasurementsAlreadyClaimedError extends Error {}

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

      if (newInvoice.sbmqb_customer_name == "MEDIDOR VACIO")
        return { status: 'skipped', invoiceId: null }; // No se crea factura local, nada que enviar a QBO

      // Fix CRÍTICO (code review 2026-09-27, riesgo de facturación duplicada real
      // en QBO): antes se insertaba la factura primero y recién después se movían
      // las measurements a PROCESANDO, sin verificar que siguieran PENDIENTE. Un
      // reintento de red del cliente HTTP (o repetir la acción) sobre el mismo
      // rango de fechas generaba una factura LOCAL nueva para las MISMAS
      // mediciones -- y como la idempotencia hacia QBO se basa en
      // requestid=sbm-inv-{id local}, QBO no podía detectar el duplicado y creaba
      // una factura real duplicada.
      //
      // Ahora, dentro de la MISMA transacción que crea la factura, primero se
      // "reclaman" las mediciones con un UPDATE compare-and-set (solo si siguen
      // PENDIENTE). Si el conteo de filas afectadas no coincide con la cantidad
      // de ids pedidos, una o más ya fueron reclamadas (facturadas o en proceso
      // por otro request) -- se aborta tirando un error DENTRO del callback de
      // trx, lo que hace que knex haga rollback automático del UPDATE de reclamo
      // (no queda ningún rastro) y NO se crea ninguna factura para ese lote.
      let createdInvoiceId = null;
      try {
        await database.transaction(async trx => {
          const claimedCount = await trx('measurements')
            .whereIn('id', newInvoice.ids)
            .andWhere('status', 'PENDIENTE')
            .update({ status: 'PROCESANDO' });

          if (claimedCount !== newInvoice.ids.length) {
            throw new MeasurementsAlreadyClaimedError(
              `Una o más mediciones del lote (ids: ${newInvoice.ids.join(', ')}) ya no estaban PENDIENTE.`
            );
          }

          // Fix CRÍTICO (2026-09-27, bloqueaba el 100% de la facturación nueva):
          // `.returning('*')` es un no-op silencioso en MySQL/MariaDB vía knex --
          // el insert real devuelve `[insertId]` (un número), nunca una fila. Con
          // `.returning('*')`, `insertedInvoice` quedaba `undefined` y
          // `insertedInvoice.id` tiraba TypeError / undefined, lo que después
          // provocaba un `.update({ sbmqb_invoices_id: undefined })` vacío y
          // knex abortaba con "Empty .update() call detected!", haciendo rollback
          // de toda la transacción antes de llegar a QBO.
          const [insertId] = await trx('sbmqb_invoices')
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
            });

          createdInvoiceId = insertId;

          // Fix acompañante (mismo bloque, mismo riesgo de facturación): antes se
          // guardaba el objeto `insertedInvoice` completo en esta columna entera
          // (sbmqb_invoices_id integer, ver migrations/20240530151200_v2.js) en vez
          // de su id -- eso rompía el `.where('sbmqb_invoices_id', invoiceData.id)`
          // que usa qboInvoiceService.js (línea ~313) para marcar las mediciones
          // FACTURADO después de un envío exitoso a QBO. Las mediciones quedaban
          // atascadas en PROCESANDO para siempre tras un sync exitoso.
          await trx('measurements')
            .whereIn('id', newInvoice.ids)
            .update({ sbmqb_invoices_id: insertId });
        });
      } catch (transactionError) {
        if (transactionError instanceof MeasurementsAlreadyClaimedError) {
          return { status: 'conflict', invoiceId: null };
        }
        throw transactionError;
      }

      return { status: 'created', invoiceId: createdInvoiceId };
    });

    const tokenResults = await Promise.all(tokenPromises);

    const createdInvoiceIds = tokenResults
      .filter((result) => result.status === 'created')
      .map((result) => result.invoiceId);

    const conflictCount = tokenResults.filter((result) => result.status === 'conflict').length;

    // Facturacion.tsx permite seleccionar varios clientes y facturarlos en un
    // solo POST (data_token es un array). Si NINGUNA factura se creó y hubo al
    // menos un conflicto, todo el request era un duplicado (ej. reintento de
    // red del mismo lote ya procesado) -- se responde 409 y ni se intenta
    // hablar con QBO. Si el lote era mixto (algunos legítimos + algún
    // conflicto puntual), las facturas legítimas SÍ se crean y sincronizan; el
    // conflicto puntual solo se informa más abajo, para no penalizar el resto
    // del lote por una medición que otro request ya reclamó.
    if (createdInvoiceIds.length === 0 && conflictCount > 0) {
      return res.status(409).json({
        message: 'Una o más mediciones ya fueron facturadas o están en proceso. No se creó ninguna factura nueva para evitar duplicados.'
      });
    }

    // Intentar sincronizar con QuickBooks Online. Por defecto queda en modo dry-run
    // (vista previa, sin escritura real). Solo pasa a envío real (dryRun: false)
    // cuando QBO_AUTO_INVOICE_ENABLED='true' -- el kill switch de fondo
    // QBO_WRITES_ENABLED (ver qboClient.js) sigue siendo la protección real contra
    // escrituras no deseadas, esto solo controla el dryRun de esta llamada puntual.
    // Esto NUNCA debe bloquear ni fallar la creación de la factura local: es un
    // intento best-effort informativo.
    const autoInvoiceEnabled = process.env.QBO_AUTO_INVOICE_ENABLED === 'true';

    let qboSync = {
      attempted: false,
      status: 'skipped',
      message: 'No se crearon facturas locales nuevas, no se intentó sincronizar con QBO.'
    };

    if (createdInvoiceIds.length > 0) {
      qboSync.attempted = true;
      const dryRun = !autoInvoiceEnabled;
      try {
        const qboResult = await qboInvoiceService.processPendingInvoices({
          invoiceIds: createdInvoiceIds,
          dryRun
        });

        const configIncomplete = qboResult.results.some(
          (result) =>
            typeof result.error === 'string' &&
            (result.error.includes('deshabilitada por configuración incompleta') ||
              result.error.includes('No hay mapeo de precio/item configurado'))
        );

        if (configIncomplete) {
          console.warn(
            `QBO aún no configurado completamente, factura(s) local(es) #${createdInvoiceIds.join(', ')} creada(s) sin intento de sincronización con QBO.`
          );
          qboSync.status = 'skipped';
          qboSync.message = 'QBO aún no configurado completamente (faltan credenciales/mapeo de servicios). La factura local se creó sin sincronizar con QBO.';
          qboSync.result = qboResult;
        } else if (dryRun) {
          qboSync.status = 'preview';
          qboSync.message = 'Preview de sincronización con QBO calculado en modo dry-run.';
          qboSync.result = qboResult;
        } else {
          qboSync.status = 'sent';
          qboSync.message = 'Factura enviada a QuickBooks Online.';
          qboSync.result = qboResult;
        }
      } catch (qboError) {
        console.error('Error inesperado ejecutando el preview de QBO (las facturas locales quedaron PENDIENTE):', qboError.message);
        qboSync.status = 'error';
        qboSync.message = qboError.message;
      }
    }

    // Lote mixto (ver nota más arriba): se avisa igual si alguna medición del
    // lote quedó afuera por conflicto, sin dejar de informar el resultado
    // exitoso del resto.
    const responseBody = {
      message: conflictCount > 0
        ? `Se completaron las operaciones, pero ${conflictCount} lote(s) de mediciones ya estaban facturados o en proceso y se omitieron para evitar duplicados.`
        : "Todas las operaciones se completaron con éxito",
      qboSync
    };
    if (conflictCount > 0) {
      responseBody.conflicts = conflictCount;
    }

    res.status(200).json(responseBody);

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
        database.raw(`UPDATE sbmqb_invoices SET status="${invoice.status}",
        sbmqb_service="${invoice.sbmqb_service}"
        WHERE id = ${invoiceId}`)
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

// GET /api/customers/rate-options -- tarifas disponibles para asignar a un
// cliente, leídas EXCLUSIVAMENTE desde las keys de QBO_SERVICE_MAP_JSON (nunca
// derivadas de campos genéricos del Item de QBO -- esa convención contable no
// es derivable de forma segura). Se refresca `unitPrice` consultando el Item
// real en QBO por su itemId; si esa consulta falla (red/token), se responde
// igual con el unitPrice configurado como fallback, en vez de romper el
// dropdown completo. IMPORTANTE: esta ruta debe quedar registrada ANTES que
// GET /api/customers/:id, si no Express matchea ":id" = "rate-options" primero.
app.get('/api/customers/rate-options', async (req, res, next) => {
  try {
    const { serviceMap } = qboConfig.getConfig();
    const keys = Object.keys(serviceMap);

    if (keys.length === 0) {
      return res.status(503).json({
        message: 'No hay tarifas configuradas: QBO_SERVICE_MAP_JSON está vacío o no definido'
      });
    }

    const itemIds = keys.map((key) => serviceMap[key].itemId);
    let qboItems = [];
    try {
      qboItems = await qboInvoiceService.getQBOItemsByIds(itemIds);
    } catch (qboError) {
      console.error('Error consultando items QBO para rate-options (se usa unitPrice configurado como fallback):', qboError.message);
    }
    const itemsById = new Map(qboItems.map((item) => [String(item.Id), item]));

    const options = keys.map((key) => {
      const { itemId, unitPrice } = serviceMap[key];
      const qboItem = itemsById.get(String(itemId));
      const currentUnitPrice = qboItem && typeof qboItem.UnitPrice === 'number' ? qboItem.UnitPrice : unitPrice;
      return { key, itemId, unitPrice: currentUnitPrice, label: deriveServiceLabel(key) };
    });

    res.json({ message: options });
  } catch (err) {
    console.error('Error obteniendo opciones de tarifa:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// Get single Customer
// NOTA (BUG ALTO, seguridad): antes se armaba con `database.raw` interpolando
// `customerId` sin comillas ni parametrizar, lo cual era una inyección SQL
// preexistente y además rompía con sbmqb_id sintéticos tipo "QBO-555" (MySQL
// intentaba resolverlo como expresión aritmética `QBO - 555`). Se usa el
// query builder parametrizado de knex (`database.table(...)` en vez de
// `database(...)` para que el singleton siga siendo interceptable en tests,
// ver test/customersRoutes.test.js).
app.get('/api/customers/:id', async (req, res, next) => {
  try {
    const customerId = req.params.id;
    database.table('sbmqb_customers').where('sbmqb_id', customerId).first()
    .then((row) => row ? res.json({ message: row }) : res.status(404).json({ message: 'Customer not found' }))
    .catch(next);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Put Customers
// NOTA: convertido a query builder parametrizado por consistencia/seguridad
// (mismo fix que GET /api/customers/:id), sin cambiar el comportamiento.
app.put('/api/customers', async (req, res, next) => {
  try {
    const customer = req.body;
    database.table('sbmqb_customers')
      .where('sbmqb_id', customer.sbmqb_id)
      .update({ sbmqb_service: customer.sbmqb_service })
    .then(() => res.json({ message: "Se actualizo el servicio del cliente a: "+customer.sbmqb_service }))
    .catch(next);

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/customers/:sbmqb_id/rate -- asigna la tarifa a UN cliente puntual.
// Reemplaza al viejo GET /api/updateServices (ver arriba, ahora 410 Gone).
// Ruta y método ya esperados por el frontend (src/api/customers.ts,
// useUpdateCustomerRateMutation) -- no requiere cambios ahí.
app.put('/api/customers/:sbmqb_id/rate', async (req, res, next) => {
  try {
    const { sbmqb_id } = req.params;
    // El hook del frontend manda el campo como `sbmqb_service` (mismo nombre
    // que la columna en sbmqb_customers, ver UpdateCustomerRatePayload en
    // src/api/customers.ts). Se acepta también `serviceKey` como alias
    // explícito para no acoplar el contrato de esta ruta a un nombre de
    // columna interno.
    const serviceKey = req.body ? (req.body.serviceKey || req.body.sbmqb_service) : undefined;

    if (typeof serviceKey !== 'string' || serviceKey.trim() === '') {
      return res.status(400).json({
        message: 'serviceKey (o sbmqb_service) es requerido y debe ser un string no vacío'
      });
    }

    const { serviceMap } = qboConfig.getConfig();
    if (!Object.prototype.hasOwnProperty.call(serviceMap, serviceKey)) {
      return res.status(400).json({
        message: `"${serviceKey}" no es una tarifa válida. Usá GET /api/customers/rate-options para ver las opciones disponibles.`
      });
    }

    const existing = await database.table('sbmqb_customers').where('sbmqb_id', sbmqb_id).first();
    if (!existing) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    await database.table('sbmqb_customers').where('sbmqb_id', sbmqb_id).update({ sbmqb_service: serviceKey });

    res.json({ success: true, sbmqb_id, sbmqb_service: serviceKey });
  } catch (err) {
    console.error('Error asignando tarifa al cliente:', err.message);
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
// Exportado adicionalmente para tests unitarios directos (ver test/measurements.test.js,
// TAREA 2 -- fallback a last_measure_value en filas baseline). `app` sigue siendo el
// export por defecto (una función de Express), esto solo le agrega una propiedad.
module.exports.calculateTotalMeasurements = calculateTotalMeasurements;
