const chai = require('chai');
const chaiHttp = require('chai-http');
const jwt = require('jsonwebtoken');
const expect = chai.expect;

const app = require('../src/server');
const config = require('../src/config');
const database = require('../src/database');
const qboInvoiceService = require('../src/services/qboInvoiceService');

chai.use(chaiHttp);

// NOTA: el proyecto no tiene sinon/proxyquire instalados (ver package.json y
// test/qboInvoiceService.test.js). Se stubea manualmente reasignando métodos
// sobre los mismos objetos-módulo (`database`, `qboInvoiceService`) que
// server.js importa vía require() -- Node cachea módulos por ruta resuelta,
// así que ambos apuntan a la misma instancia y el reemplazo de propiedad se
// resuelve en tiempo de llamada.
//
// GOTCHA: `database` es una instancia de knex; su método `transaction` es una
// propiedad heredada con `writable: false` (aunque `configurable: true`). Una
// asignación directa (`database.transaction = fn`) falla en silencio en modo
// no estricto (CommonJS sin 'use strict') y el mock nunca se activa -- hay
// que usar Object.defineProperty para reemplazarlo de verdad.
const stubTransaction = (fn) => {
  Object.defineProperty(database, 'transaction', {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false
  });
};

const JWT_SECRET = 'bdd05bf894011885ff44'; // mismo secreto hardcodeado en server.js

const buildDataToken = (overrides = {}) => {
  const payload = {
    sbmqb_customer_name: 'Cliente Demo',
    sbmqb_service: 'servicio-electricidad-tarifa',
    measurer_code: 'DOCK-01',
    initial_measure_value: 100,
    current_measure_value: 250,
    total_measure_value: 150,
    begin_date: '2026-01-01T00:00:00.000Z',
    end_date: '2026-01-31T00:00:00.000Z',
    ids: [1],
    ...overrides
  };
  return { dataToken: jwt.sign(payload, JWT_SECRET) };
};

describe('POST /api/bill — wiring de processPendingInvoices (qboSync)', () => {
  let originalTransaction;
  let originalProcessPendingInvoices;
  let insertedRows;
  let nextId;

  beforeEach(() => {
    originalTransaction = database.transaction;
    originalProcessPendingInvoices = qboInvoiceService.processPendingInvoices;

    insertedRows = [];
    nextId = 1000;

    // Mock de la transacción: nunca toca la base de datos real, solo registra
    // qué se insertó/actualizó para poder verificar que la factura local se
    // creó igual, sin importar lo que pase con QBO.
    stubTransaction(async (callback) => {
      const trx = (tableName) => {
        if (tableName === 'sbmqb_invoices') {
          return {
            insert: (data) => ({
              returning: async () => {
                const row = { id: nextId++, ...data };
                insertedRows.push(row);
                return [row];
              }
            })
          };
        }
        if (tableName === 'measurements') {
          return {
            update: () => ({
              whereIn: async () => [1]
            })
          };
        }
        throw new Error(`Tabla no esperada en el mock de trx: ${tableName}`);
      };
      return callback(trx);
    });
  });

  afterEach(() => {
    stubTransaction(originalTransaction);
    qboInvoiceService.processPendingInvoices = originalProcessPendingInvoices;
  });

  it('crea la factura local y responde 200 con qboSync.status "skipped" cuando QBO está deshabilitado por configuración incompleta', (done) => {
    qboInvoiceService.processPendingInvoices = async ({ invoiceIds, dryRun }) => ({
      dryRun,
      processed: invoiceIds.length,
      successful: 0,
      failed: invoiceIds.length,
      results: invoiceIds.map((id) => ({
        id,
        error: 'Facturación QBO deshabilitada por configuración incompleta: QBO_TAX_CODE_ID no está definida'
      }))
    });

    chai.request(app)
      .post('/api/bill')
      .set('api-key', config.apiKey)
      .send({ data_token: [buildDataToken()] })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(insertedRows).to.have.lengthOf(1); // la factura local se creó igual
        expect(res.body.qboSync).to.exist;
        expect(res.body.qboSync.attempted).to.equal(true);
        expect(res.body.qboSync.status).to.equal('skipped');
        expect(res.body.qboSync.message).to.be.a('string');
        done();
      });
  });

  it('crea la factura local y responde 200 con qboSync.status "error" cuando processPendingInvoices lanza un error inesperado', (done) => {
    qboInvoiceService.processPendingInvoices = async () => {
      throw new Error('DB unavailable while checking pending invoices');
    };

    chai.request(app)
      .post('/api/bill')
      .set('api-key', config.apiKey)
      .send({ data_token: [buildDataToken()] })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(insertedRows).to.have.lengthOf(1); // la factura local se creó igual
        expect(res.body.qboSync).to.exist;
        expect(res.body.qboSync.attempted).to.equal(true);
        expect(res.body.qboSync.status).to.equal('error');
        expect(res.body.qboSync.message).to.equal('DB unavailable while checking pending invoices');
        done();
      });
  });

  it('llama a processPendingInvoices con { invoiceIds: [idCreado], dryRun: true }', (done) => {
    let receivedArgs = null;
    qboInvoiceService.processPendingInvoices = async (args) => {
      receivedArgs = args;
      return { dryRun: args.dryRun, processed: 0, successful: 0, failed: 0, results: [] };
    };

    chai.request(app)
      .post('/api/bill')
      .set('api-key', config.apiKey)
      .send({ data_token: [buildDataToken()] })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(receivedArgs).to.not.be.null;
        expect(receivedArgs.dryRun).to.equal(true);
        expect(receivedArgs.invoiceIds).to.deep.equal([insertedRows[0].id]);
        expect(res.body.qboSync.status).to.equal('preview');
        done();
      });
  });

  it('responde 200 con qboSync.status "preview" y el resultado del dry-run cuando QBO ya está configurado', (done) => {
    qboInvoiceService.processPendingInvoices = async ({ invoiceIds, dryRun }) => ({
      dryRun,
      processed: invoiceIds.length,
      successful: invoiceIds.length,
      failed: 0,
      results: invoiceIds.map((id) => ({ id, skipped: false, amount: 62.25 }))
    });

    chai.request(app)
      .post('/api/bill')
      .set('api-key', config.apiKey)
      .send({ data_token: [buildDataToken()] })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(res.body.qboSync.status).to.equal('preview');
        expect(res.body.qboSync.result.dryRun).to.equal(true);
        expect(res.body.qboSync.result.successful).to.equal(1);
        done();
      });
  });

  it('no intenta sincronizar con QBO (qboSync.attempted=false) cuando no se crea ninguna factura local nueva (MEDIDOR VACIO)', (done) => {
    let wasCalled = false;
    qboInvoiceService.processPendingInvoices = async () => {
      wasCalled = true;
      return { dryRun: true, processed: 0, successful: 0, failed: 0, results: [] };
    };

    chai.request(app)
      .post('/api/bill')
      .set('api-key', config.apiKey)
      .send({ data_token: [buildDataToken({ sbmqb_customer_name: 'MEDIDOR VACIO' })] })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(insertedRows).to.have.lengthOf(0);
        expect(wasCalled).to.equal(false);
        expect(res.body.qboSync.attempted).to.equal(false);
        expect(res.body.qboSync.status).to.equal('skipped');
        done();
      });
  });
});
