const chai = require('chai');
const chaiHttp = require('chai-http');
const expect = chai.expect;

const app = require('../src/server');
const config = require('../src/config');
const database = require('../src/database');
const qboConfig = require('../src/config/qboConfig');
const qboInvoiceService = require('../src/services/qboInvoiceService');

chai.use(chaiHttp);

// NOTA: mismo patrón hand-rolled que test/customersRoutes.test.js y
// test/qboInvoiceService.test.js -- el proyecto no tiene sinon/proxyquire/zod
// instalados, así que se stubea reasignando propiedades sobre los mismos
// singletons (`database`, `qboInvoiceService`) que server.js importa vía
// require() (Node cachea módulos por ruta resuelta).
const stubTable = (fn) => {
  Object.defineProperty(database, 'table', {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false
  });
};

const stubGetQBOItemsByIds = (fn) => {
  Object.defineProperty(qboInvoiceService, 'getQBOItemsByIds', {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false
  });
};

const VALID_SERVICE_MAP = {
  '4113 · INGRESOS ELECTRIDIDAD:70000:70004-Electricity T. @ 0.48/KW': { itemId: '105', unitPrice: 0.48 },
  '4113 · INGRESOS ELECTRIDIDAD:70000:70001-Metered elect. @ 0.415/KW': { itemId: '102', unitPrice: 0.415 }
};

const setValidServiceMap = (overrides) => {
  process.env.QBO_SERVICE_MAP_JSON = JSON.stringify(overrides || VALID_SERVICE_MAP);
  return qboConfig.reloadConfig();
};

describe('GET /api/customers/rate-options -- reemplazo seguro de GET /api/updateServices', () => {
  let originalGetQBOItemsByIds;

  beforeEach(() => {
    originalGetQBOItemsByIds = qboInvoiceService.getQBOItemsByIds;
    setValidServiceMap();
  });

  afterEach(() => {
    stubGetQBOItemsByIds(originalGetQBOItemsByIds);
    delete process.env.QBO_SERVICE_MAP_JSON;
    qboConfig.reloadConfig();
  });

  it('devuelve las tarifas configuradas con el unitPrice ACTUAL de QBO (no el guardado en el mapeo)', (done) => {
    stubGetQBOItemsByIds(async (ids) => {
      expect(ids).to.have.members(['105', '102']);
      return [
        { Id: '105', UnitPrice: 0.5 }, // precio cambió en QBO respecto al mapeo (0.48)
        { Id: '102', UnitPrice: 0.415 }
      ];
    });

    chai.request(app)
      .get('/api/customers/rate-options')
      .set('api-key', config.apiKey)
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(res.body.message).to.have.lengthOf(2);

        const tarifaAlta = res.body.message.find((opt) => opt.itemId === '105');
        expect(tarifaAlta.unitPrice).to.equal(0.5);
        expect(tarifaAlta.label).to.equal('Electricity T. @ 0.48/KW');
        expect(tarifaAlta.key).to.equal('4113 · INGRESOS ELECTRIDIDAD:70000:70004-Electricity T. @ 0.48/KW');

        const tarifaBaja = res.body.message.find((opt) => opt.itemId === '102');
        expect(tarifaBaja.unitPrice).to.equal(0.415);
        expect(tarifaBaja.label).to.equal('Metered elect. @ 0.415/KW');
        done();
      });
  });

  it('usa el unitPrice configurado como fallback si la consulta a QBO falla (no rompe el endpoint)', (done) => {
    stubGetQBOItemsByIds(async () => {
      throw new Error('QBO no responde');
    });

    chai.request(app)
      .get('/api/customers/rate-options')
      .set('api-key', config.apiKey)
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        const tarifaAlta = res.body.message.find((opt) => opt.itemId === '105');
        expect(tarifaAlta.unitPrice).to.equal(0.48); // fallback al valor del mapeo
        done();
      });
  });

  it('responde 503 si QBO_SERVICE_MAP_JSON no está configurado', (done) => {
    delete process.env.QBO_SERVICE_MAP_JSON;
    qboConfig.reloadConfig();

    chai.request(app)
      .get('/api/customers/rate-options')
      .set('api-key', config.apiKey)
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(503);
        done();
      });
  });
});

describe('PUT /api/customers/:sbmqb_id/rate -- reemplazo seguro de GET /api/updateServices', () => {
  let originalTable;

  beforeEach(() => {
    originalTable = database.table;
    setValidServiceMap();
  });

  afterEach(() => {
    stubTable(originalTable);
    delete process.env.QBO_SERVICE_MAP_JSON;
    qboConfig.reloadConfig();
  });

  const VALID_KEY = '4113 · INGRESOS ELECTRIDIDAD:70000:70001-Metered elect. @ 0.415/KW';

  it('asigna la tarifa a un cliente existente con WHERE parametrizado (afecta una sola fila)', (done) => {
    const whereCalls = [];
    const updateCalls = [];
    stubTable((tableName) => {
      expect(tableName).to.equal('sbmqb_customers');
      return {
        where: (column, value) => {
          whereCalls.push({ column, value });
          return {
            first: async () => ({ sbmqb_id: value, sbmqb_service: 'anterior' }),
            update: async (values) => {
              updateCalls.push(values);
              return 1;
            }
          };
        }
      };
    });

    chai.request(app)
      .put('/api/customers/800004FE-1559630569/rate')
      .set('api-key', config.apiKey)
      .send({ serviceKey: VALID_KEY })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(res.body).to.deep.equal({
          success: true,
          sbmqb_id: '800004FE-1559630569',
          sbmqb_service: VALID_KEY
        });
        expect(whereCalls).to.deep.equal([
          { column: 'sbmqb_id', value: '800004FE-1559630569' },
          { column: 'sbmqb_id', value: '800004FE-1559630569' }
        ]);
        expect(updateCalls).to.deep.equal([{ sbmqb_service: VALID_KEY }]);
        done();
      });
  });

  it('acepta `sbmqb_service` como alias de `serviceKey` (contrato real del hook del frontend)', (done) => {
    stubTable(() => ({
      where: () => ({
        first: async () => ({ sbmqb_id: '800004FE-1559630569' }),
        update: async () => 1
      })
    }));

    chai.request(app)
      .put('/api/customers/800004FE-1559630569/rate')
      .set('api-key', config.apiKey)
      .send({ sbmqb_service: VALID_KEY })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        expect(res.body.sbmqb_service).to.equal(VALID_KEY);
        done();
      });
  });

  it('responde 400 si serviceKey no existe en QBO_SERVICE_MAP_JSON', (done) => {
    chai.request(app)
      .put('/api/customers/800004FE-1559630569/rate')
      .set('api-key', config.apiKey)
      .send({ serviceKey: 'tarifa-inventada-que-no-existe' })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(400);
        done();
      });
  });

  it('responde 400 si no se manda serviceKey ni sbmqb_service', (done) => {
    chai.request(app)
      .put('/api/customers/800004FE-1559630569/rate')
      .set('api-key', config.apiKey)
      .send({})
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(400);
        done();
      });
  });

  it('responde 404 si el sbmqb_id no existe', (done) => {
    stubTable(() => ({
      where: () => ({ first: async () => undefined })
    }));

    chai.request(app)
      .put('/api/customers/QBO-NO-EXISTE/rate')
      .set('api-key', config.apiKey)
      .send({ serviceKey: VALID_KEY })
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(404);
        done();
      });
  });
});

describe('GET /api/updateServices -- deshabilitado por seguridad', () => {
  it('responde 410 Gone en vez de ejecutar el UPDATE sin WHERE', (done) => {
    chai.request(app)
      .get('/api/updateServices')
      .set('api-key', config.apiKey)
      .end((err, res) => {
        expect(err).to.be.null;
        expect(res).to.have.status(410);
        expect(res.body.error).to.match(/deprecado/i);
        done();
      });
  });
});
