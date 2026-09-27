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
  let measurementUpdates;
  let nextId;
  // Fix CRÍTICO (code review 2026-09-27): por defecto el mock simula que TODAS
  // las mediciones pedidas siguen PENDIENTE (compare-and-set exitoso, el
  // comportamiento normal). Los tests de conflicto lo sobreescriben para
  // simular que ya fueron reclamadas por otro request.
  let claimedCountOverride;

  beforeEach(() => {
    originalTransaction = database.transaction;
    originalProcessPendingInvoices = qboInvoiceService.processPendingInvoices;

    insertedRows = [];
    measurementUpdates = [];
    nextId = 1000;
    claimedCountOverride = null;

    // Mock de la transacción: nunca toca la base de datos real, solo registra
    // qué se insertó/actualizó para poder verificar que la factura local se
    // creó igual, sin importar lo que pase con QBO. Si el callback (server.js)
    // tira una excepción (ej. MeasurementsAlreadyClaimedError), esta promesa
    // se rechaza -- igual que haría knex real con rollback automático.
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
            whereIn: (column, ids) => ({
              // Paso 1 del compare-and-set: reclamar solo las que siguen PENDIENTE.
              andWhere: () => ({
                update: async (values) => {
                  measurementUpdates.push({ ids, values, step: 'claim' });
                  return claimedCountOverride !== null ? claimedCountOverride : ids.length;
                }
              }),
              // Paso 2: una vez creada la factura, anota sbmqb_invoices_id.
              update: async (values) => {
                measurementUpdates.push({ ids, values, step: 'attach' });
                return ids.length;
              }
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
    delete process.env.QBO_AUTO_INVOICE_ENABLED;
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

  it('llama a processPendingInvoices con { dryRun: false } cuando QBO_AUTO_INVOICE_ENABLED="true" y responde qboSync.status "sent"', (done) => {
    process.env.QBO_AUTO_INVOICE_ENABLED = 'true';

    let receivedArgs = null;
    qboInvoiceService.processPendingInvoices = async (args) => {
      receivedArgs = args;
      return { dryRun: args.dryRun, processed: 1, successful: 1, failed: 0, results: [{ id: args.invoiceIds[0], skipped: false, amount: 62.25 }] };
    };

    chai.request(app)
      .post('/api/bill')
      .set('api-key', config.apiKey)
      .send({ data_token: [buildDataToken()] })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(receivedArgs).to.not.be.null;
        expect(receivedArgs.dryRun).to.equal(false);
        // Con envío real exitoso (dryRun: false), el status/mensaje deben
        // reflejar que la factura se mandó de verdad, no una preview.
        expect(res.body.qboSync.status).to.equal('sent');
        expect(res.body.qboSync.message).to.equal('Factura enviada a QuickBooks Online.');
        expect(res.body.qboSync.result.dryRun).to.equal(false);
        done();
      });
  });

  it('sigue llamando a processPendingInvoices con { dryRun: true } cuando QBO_AUTO_INVOICE_ENABLED="false" (comportamiento por defecto) y responde qboSync.status "preview"', (done) => {
    process.env.QBO_AUTO_INVOICE_ENABLED = 'false';

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
        // Sin el auto-invoice enabled, el status/mensaje se mantienen igual
        // que antes del fix: preview de dry-run, no envío real.
        expect(res.body.qboSync.status).to.equal('preview');
        expect(res.body.qboSync.message).to.equal('Preview de sincronización con QBO calculado en modo dry-run.');
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

  it('reclama las mediciones (compare-and-set) ANTES de crear la factura, y guarda el id (no el objeto) en sbmqb_invoices_id -- comportamiento normal, mediciones siguen PENDIENTE', (done) => {
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
      .send({ data_token: [buildDataToken({ ids: [11, 12] })] })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(insertedRows).to.have.lengthOf(1);

        const claimStep = measurementUpdates.find((u) => u.step === 'claim');
        const attachStep = measurementUpdates.find((u) => u.step === 'attach');
        expect(claimStep.ids).to.deep.equal([11, 12]);
        expect(claimStep.values).to.deep.equal({ status: 'PROCESANDO' });
        expect(attachStep.values).to.deep.equal({ sbmqb_invoices_id: insertedRows[0].id });

        expect(res.body.qboSync.attempted).to.equal(true);
        expect(res.body.conflicts).to.be.undefined;
        done();
      });
  });

  it('responde 409 y NO crea ninguna factura ni llama a QBO cuando las mediciones ya no están PENDIENTE (reintento de red / doble click del mismo lote)', (done) => {
    claimedCountOverride = 0; // simula que ninguna medición seguía PENDIENTE (ya reclamada por el intento anterior)

    let wasCalled = false;
    qboInvoiceService.processPendingInvoices = async () => {
      wasCalled = true;
      return { dryRun: true, processed: 0, successful: 0, failed: 0, results: [] };
    };

    chai.request(app)
      .post('/api/bill')
      .set('api-key', config.apiKey)
      .send({ data_token: [buildDataToken()] })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(409);
        expect(res.body.message).to.be.a('string');
        expect(insertedRows).to.have.lengthOf(0); // no se creó ninguna factura nueva
        expect(wasCalled).to.equal(false); // no se llamó a QBO
        done();
      });
  });

  it('lote mixto: crea y sincroniza la factura legítima, e informa el conflicto puntual sin bloquear el resto (selección múltiple en Facturación.tsx)', (done) => {
    // El primer token del lote sigue PENDIENTE (se factura normalmente); el
    // segundo ya fue reclamado por otro request -- solo ese debe fallar.
    let callCount = 0;
    stubTransaction(async (callback) => {
      callCount += 1;
      const isSecondCall = callCount === 2;
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
            whereIn: (column, ids) => ({
              andWhere: () => ({
                update: async () => (isSecondCall ? 0 : ids.length)
              }),
              update: async () => ids.length
            })
          };
        }
        throw new Error(`Tabla no esperada en el mock de trx: ${tableName}`);
      };
      return callback(trx);
    });

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
      .send({
        data_token: [
          buildDataToken({ ids: [1] }),
          buildDataToken({ ids: [2], sbmqb_customer_name: 'Cliente Ya Facturado' })
        ]
      })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(insertedRows).to.have.lengthOf(1); // solo la factura legítima
        expect(res.body.conflicts).to.equal(1);
        expect(res.body.qboSync.attempted).to.equal(true);
        done();
      });
  });
});
