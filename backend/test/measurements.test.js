const chai = require('chai');
const chaiHttp = require('chai-http');
const expect = chai.expect;

const app = require('../src/server');
const config = require('../src/config');
const database = require('../src/database');

chai.use(chaiHttp);

// NOTA: mismo patrón manual de stubbing que test/bill.test.js y
// test/customersRoutes.test.js -- el proyecto no tiene sinon/proxyquire
// instalados, así que se stubea reasignando una propiedad sobre el mismo
// singleton de knex que server.js importa vía require(). `database.raw` y
// `database.table` son propiedades heredadas del prototipo de knex (no
// asignables con `=` directo en modo no estricto), por eso se usa
// Object.defineProperty.
const stubRaw = (fn) => {
  Object.defineProperty(database, 'raw', {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false
  });
};

const stubTable = (fn) => {
  Object.defineProperty(database, 'table', {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false
  });
};

describe('POST /api/measurements -- TAREA 1: fix SQL injection / bug de comillas en el INSERT', () => {
  let originalRaw;
  let originalTable;

  beforeEach(() => {
    originalRaw = database.raw;
    originalTable = database.table;
  });

  afterEach(() => {
    stubRaw(originalRaw);
    stubTable(originalTable);
  });

  const basePayload = {
    measurer_id: 1,
    sbmqb_customer_name: 'Cliente Demo',
    description: 'Lectura normal',
    current_measure_value: 100,
    current_measure_date: '2026-09-01 10:00:00',
    status: 'PENDIENTE'
  };

  it('crea la medición sin medida anterior con un description que contiene comillas dobles (antes rompía la sintaxis SQL)', (done) => {
    stubRaw(() => Promise.resolve([[]])); // SELECT ... ORDER BY id desc -> sin fila previa

    let insertedTable = null;
    let insertedValues = null;
    stubTable((tableName) => {
      insertedTable = tableName;
      return {
        insert: (values) => {
          insertedValues = values;
          return Promise.resolve([1]);
        }
      };
    });

    chai.request(app)
      .post('/api/measurements')
      .set('api-key', config.apiKey)
      .send({ ...basePayload, description: 'Medidor con comentario "raro" del técnico' })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(201);
        expect(insertedTable).to.equal('measurements');
        expect(insertedValues).to.deep.equal({
          measurer_id: 1,
          sbmqb_customer_name: 'Cliente Demo',
          description: 'Medidor con comentario "raro" del técnico',
          current_measure_value: 100,
          current_measure_date: '2026-09-01 10:00:00',
          status: 'PENDIENTE'
        });
        done();
      });
  });

  it('crea la medición con medida anterior y description con comillas dobles (segunda rama del INSERT, no pierde ningún campo)', (done) => {
    const previousRow = {
      current_measure_value: 50,
      current_measure_date: '2026-08-01T00:00:00.000Z'
    };
    stubRaw(() => Promise.resolve([[previousRow]]));

    let insertedValues = null;
    stubTable(() => ({
      insert: (values) => {
        insertedValues = values;
        return Promise.resolve([2]);
      }
    }));

    chai.request(app)
      .post('/api/measurements')
      .set('api-key', config.apiKey)
      .send({ ...basePayload, description: 'Otra "nota" con comillas', sbmqb_service: 'servicio-x' })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(201);
        expect(insertedValues).to.deep.equal({
          measurer_id: 1,
          sbmqb_customer_name: 'Cliente Demo',
          description: 'Otra "nota" con comillas',
          last_measure_value: 50,
          last_measure_date: '2026-08-01 00:00:00',
          current_measure_value: 100,
          current_measure_date: '2026-09-01 10:00:00',
          sbmqb_service: 'servicio-x',
          status: 'PENDIENTE'
        });
        done();
      });
  });
});

describe('PUT /api/measurements/:id -- TAREA 1: fix SQL injection / coma faltante / bug de comillas en el UPDATE', () => {
  let originalRaw;
  let originalTable;

  beforeEach(() => {
    originalRaw = database.raw;
    originalTable = database.table;
  });

  afterEach(() => {
    stubRaw(originalRaw);
    stubTable(originalTable);
  });

  it('actualiza la medición con un description que contiene comillas dobles (antes: coma faltante rompía la sintaxis SQL en TODA ejecución)', (done) => {
    stubRaw(() => Promise.resolve([[{ id: 7 }]])); // SELECT * FROM measurements WHERE id = 7 -> existe

    const whereCalls = [];
    let updateValues = null;
    stubTable((tableName) => {
      expect(tableName).to.equal('measurements');
      return {
        where: (column, value) => {
          whereCalls.push({ column, value });
          return {
            update: (values) => {
              updateValues = values;
              return Promise.resolve(1);
            }
          };
        }
      };
    });

    chai.request(app)
      .put('/api/measurements/7')
      .set('api-key', config.apiKey)
      .send({
        sbmqb_customer_name: 'Cliente "VIP"',
        description: 'Comentario con "comillas" del técnico',
        current_measure_value: 250
      })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(res.body.message).to.equal('Measurement updated.');
        expect(whereCalls).to.deep.equal([{ column: 'id', value: '7' }]);
        // Solo se envían al query builder los campos realmente provistos en el
        // body (contrato real del frontend: sbmqb_customer_name, description,
        // current_measure_value) -- no se pisan columnas no enviadas.
        expect(updateValues).to.deep.equal({
          sbmqb_customer_name: 'Cliente "VIP"',
          description: 'Comentario con "comillas" del técnico',
          current_measure_value: 250
        });
        done();
      });
  });

  it('responde 404 cuando la medición no existe', (done) => {
    stubRaw(() => Promise.resolve([[]]));

    chai.request(app)
      .put('/api/measurements/999')
      .set('api-key', config.apiKey)
      .send({ description: 'x' })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(404);
        expect(res.body.message).to.equal('Measurement not found');
        done();
      });
  });

  it('propaga al error handler cuando el query builder falla (no revienta el proceso)', (done) => {
    stubRaw(() => Promise.resolve([[{ id: 7 }]]));
    stubTable(() => ({
      where: () => ({
        update: () => Promise.reject(new Error('boom'))
      })
    }));

    chai.request(app)
      .put('/api/measurements/7')
      .set('api-key', config.apiKey)
      .send({ description: 'x' })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res.status).to.be.at.least(400);
        done();
      });
  });
});

describe('PUT /api/measurements/:id -- code review 2026-09-27: validación de tipos y alcance de columnas', () => {
  let originalRaw;
  let originalTable;

  beforeEach(() => {
    originalRaw = database.raw;
    originalTable = database.table;
  });

  afterEach(() => {
    stubRaw(originalRaw);
    stubTable(originalTable);
  });

  it('rechaza con 400 un current_measure_value no numérico, sin tocar la base de datos', (done) => {
    let rawCalled = false;
    let tableCalled = false;
    stubRaw(() => {
      rawCalled = true;
      return Promise.resolve([[{ id: 7 }]]);
    });
    stubTable(() => {
      tableCalled = true;
      return { where: () => ({ update: () => Promise.resolve(1) }) };
    });

    chai.request(app)
      .put('/api/measurements/7')
      .set('api-key', config.apiKey)
      .send({ current_measure_value: 'no-es-un-numero' })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(400);
        expect(res.body.errors).to.be.an('array').that.is.not.empty;
        expect(rawCalled).to.equal(false);
        expect(tableCalled).to.equal(false);
        done();
      });
  });

  it('ignora silenciosamente status/measurer_id enviados en el body -- no rompen la request, pero tampoco se aplican', (done) => {
    stubRaw(() => Promise.resolve([[{ id: 7 }]]));

    const whereCalls = [];
    let updateValues = null;
    stubTable((tableName) => {
      expect(tableName).to.equal('measurements');
      return {
        where: (column, value) => {
          whereCalls.push({ column, value });
          return {
            update: (values) => {
              updateValues = values;
              return Promise.resolve(1);
            }
          };
        }
      };
    });

    chai.request(app)
      .put('/api/measurements/7')
      .set('api-key', config.apiKey)
      .send({
        description: 'Nota válida',
        status: 'FACTURADO',
        measurer_id: 999
      })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(res.body.message).to.equal('Measurement updated.');
        // status/measurer_id no forman parte del contrato de este endpoint --
        // se ignoran silenciosamente, solo se aplica description.
        expect(updateValues).to.deep.equal({ description: 'Nota válida' });
        expect(whereCalls).to.deep.equal([{ column: 'id', value: '7' }]);
        done();
      });
  });
});

describe('calculateTotalMeasurements -- TAREA 2: fallback a last_measure_value para filas baseline', () => {
  const { calculateTotalMeasurements } = app;

  it('usa last_measure_value como fallback cuando current_measure_value es null (fila baseline), resultado coherente sin NaN', () => {
    const grouped = {
      'Cliente Baseline-itfjrbk-1-itfjrbk-PENDIENTE': [
        {
          id: 500,
          sbmqb_customer_name: 'Cliente Baseline',
          measurer_id: 1,
          status: 'PENDIENTE',
          sbmqb_service: 'servicio-x',
          pedestal_id: 'DOCK-01',
          current_measure_value: null,
          current_measure_date: null,
          last_measure_value: 320,
          last_measure_date: '2026-08-30 00:00:00'
        }
      ]
    };

    const result = calculateTotalMeasurements(grouped, '2026-09-01', '2026-09-30');

    expect(result).to.have.lengthOf(1);
    const [entry] = result;
    expect(entry.initial_measure_value).to.equal(320);
    expect(entry.current_measure_value).to.equal(320);
    expect(entry.total_measure_value).to.equal(0);
    expect(entry.total_measure_value).to.not.be.NaN;
  });

  it('calcula normalmente cuando hay lecturas reales (sin filas baseline), sin alterar el cálculo existente', () => {
    const grouped = {
      'Cliente Normal-itfjrbk-2-itfjrbk-PENDIENTE': [
        {
          id: 501,
          sbmqb_customer_name: 'Cliente Normal',
          measurer_id: 2,
          status: 'PENDIENTE',
          sbmqb_service: 'servicio-y',
          pedestal_id: 'DOCK-02',
          current_measure_value: 100,
          last_measure_value: null
        },
        {
          id: 502,
          sbmqb_customer_name: 'Cliente Normal',
          measurer_id: 2,
          status: 'PENDIENTE',
          sbmqb_service: 'servicio-y',
          pedestal_id: 'DOCK-02',
          current_measure_value: 250,
          last_measure_value: 100
        }
      ]
    };

    const result = calculateTotalMeasurements(grouped, '2026-09-01', '2026-09-30');
    expect(result[0].total_measure_value).to.equal(150);
    expect(result[0].initial_measure_value).to.equal(100);
    expect(result[0].current_measure_value).to.equal(250);
    expect(result[0].needsReview).to.equal(false);
  });

  it('code review 2026-09-27 (ALTA): un total que daría negativo (fila baseline con last_measure_value sembrado por encima de la primera lectura real) se clampea a 0 y queda marcado needsReview, nunca se manda negativo a facturación', () => {
    const grouped = {
      'Cliente Baseline Roto-itfjrbk-3-itfjrbk-PENDIENTE': [
        {
          id: 700,
          sbmqb_customer_name: 'Cliente Baseline Roto',
          measurer_id: 3,
          status: 'PENDIENTE',
          sbmqb_service: 'servicio-z',
          pedestal_id: 'DOCK-03',
          // Fila baseline sembrada (incidente 2026-08-30): sin current_measure_value,
          // con un last_measure_value inflado por encima de la primera lectura real.
          current_measure_value: null,
          current_measure_date: null,
          last_measure_value: 900
        },
        {
          id: 701,
          sbmqb_customer_name: 'Cliente Baseline Roto',
          measurer_id: 3,
          status: 'PENDIENTE',
          sbmqb_service: 'servicio-z',
          pedestal_id: 'DOCK-03',
          current_measure_value: 300,
          last_measure_value: 900
        }
      ]
    };

    const result = calculateTotalMeasurements(grouped, '2026-09-01', '2026-09-30');

    expect(result).to.have.lengthOf(1);
    const [entry] = result;
    expect(entry.total_measure_value).to.equal(0);
    expect(entry.total_measure_value).to.not.be.below(0);
    expect(entry.needsReview).to.equal(true);
  });
});

describe('GET /api/measurements/total -- TAREA 2: incluye filas baseline filtrando por last_measure_date', () => {
  let originalRaw;

  beforeEach(() => {
    originalRaw = database.raw;
  });

  afterEach(() => {
    stubRaw(originalRaw);
  });

  it('incluye una fila baseline (current_measure_date NULL) cuyo last_measure_date cae en el rango solicitado, en vez de excluirla', (done) => {
    let capturedSql = null;
    let capturedBindings = null;

    const baselineRow = {
      id: 900,
      measurer_id: 10,
      sbmqb_customer_name: 'Cliente Baseline QBO',
      sbmqb_service: 'servicio-baseline',
      status: 'PENDIENTE',
      current_measure_value: null,
      current_measure_date: null,
      last_measure_value: 500,
      last_measure_date: '2026-09-15',
      measurer_code: 'DOCK-99',
      pedestal_id: 'DOCK-99'
    };

    stubRaw((sql, bindings) => {
      capturedSql = sql;
      capturedBindings = bindings;
      return Promise.resolve([[baselineRow]]);
    });

    chai.request(app)
      .get('/api/measurements/total')
      .set('api-key', config.apiKey)
      .query({ from: '2026-09-01', to: '2026-09-30' })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        // Query parametrizada (sin interpolación cruda de from/to en el string SQL).
        expect(capturedSql).to.include('current_measure_date IS NULL');
        expect(capturedSql).to.not.include('2026-09-01');
        expect(capturedBindings).to.deep.equal(['2026-09-01', '2026-09-30', '2026-09-01', '2026-09-30']);

        expect(res.body.message).to.have.lengthOf(1);
        expect(res.body.message[0].sbmqb_customer_name).to.equal('Cliente Baseline QBO');
        expect(res.body.message[0].total_measure_value).to.equal(0);
        expect(res.body.message[0].total_measure_value).to.not.be.NaN;
        done();
      });
  });

  it('sigue filtrando correctamente por measurer_code y customer_name (parametrizado, sin interpolación cruda)', (done) => {
    let capturedSql = null;
    let capturedBindings = null;

    stubRaw((sql, bindings) => {
      capturedSql = sql;
      capturedBindings = bindings;
      return Promise.resolve([[]]);
    });

    chai.request(app)
      .get('/api/measurements/total')
      .set('api-key', config.apiKey)
      .query({ from: '2026-09-01', to: '2026-09-30', measurer_code: 'DOCK-05', customer_name: 'Cliente X' })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(capturedSql).to.include('y.measurer_code = ?');
        expect(capturedSql).to.include('x.sbmqb_customer_name = ?');
        expect(capturedBindings).to.deep.equal(['2026-09-01', '2026-09-30', '2026-09-01', '2026-09-30', 'DOCK-05', 'Cliente X']);
        done();
      });
  });
});
