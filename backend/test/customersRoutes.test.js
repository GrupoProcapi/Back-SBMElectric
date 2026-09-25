const chai = require('chai');
const chaiHttp = require('chai-http');
const expect = chai.expect;

const app = require('../src/server');
const config = require('../src/config');
const database = require('../src/database');

chai.use(chaiHttp);

// NOTA: mismo patrón que test/bill.test.js -- el proyecto no tiene
// sinon/proxyquire instalados, así que se stubea reasignando una propiedad
// sobre el mismo singleton de knex que server.js importa vía require()
// (Node cachea módulos por ruta resuelta, así que ambos apuntan a la misma
// instancia).
//
// Los handlers de /api/customers usan `database.table(tableName)` en vez de
// invocar `database(tableName)` directamente: `database` es una función
// callable creada por knex y su [[Call]] interno no puede reemplazarse desde
// afuera una vez que server.js ya capturó la referencia al requerir el
// módulo. `database.table`, en cambio, es una propiedad normal
// (`knex[method] = function () {...}` en knex-builder/make-knex.js), así que
// sí es sobreescribible con Object.defineProperty -- funcionalmente
// `database.table('x')` y `database('x')` generan exactamente la misma
// query en knex, es solo la forma de invocarlo.
const stubTable = (fn) => {
  Object.defineProperty(database, 'table', {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false
  });
};

describe('GET/PUT /api/customers -- BUG ALTO fix (query builder parametrizado, sbmqb_id sintético)', () => {
  let originalTable;

  beforeEach(() => {
    originalTable = database.table;
  });

  afterEach(() => {
    stubTable(originalTable);
  });

  describe('GET /api/customers/:id', () => {
    it('devuelve el cliente cuando sbmqb_id es puramente hex/numérico (caso QBO Desktop, ya funcionaba antes)', (done) => {
      const whereCalls = [];
      stubTable((tableName) => {
        expect(tableName).to.equal('sbmqb_customers');
        return {
          where: (column, value) => {
            whereCalls.push({ column, value });
            return {
              first: async () => ({ sbmqb_id: value, sbmqb_customer_name: 'Cliente Desktop' })
            };
          }
        };
      });

      chai.request(app)
        .get('/api/customers/800004FE-1559630569')
        .set('api-key', config.apiKey)
        .end((err, res) => {
          expect(err).to.be.null;
          expect(res).to.have.status(200);
          expect(res.body.message).to.deep.equal({
            sbmqb_id: '800004FE-1559630569',
            sbmqb_customer_name: 'Cliente Desktop'
          });
          expect(whereCalls).to.deep.equal([{ column: 'sbmqb_id', value: '800004FE-1559630569' }]);
          done();
        });
    });

    it('devuelve el cliente cuando sbmqb_id es sintético con letras y guion (ej. QBO-555) -- antes rompía porque MySQL interpretaba `QBO-555` como la resta `QBO - 555` al interpolarse sin comillas', (done) => {
      const whereCalls = [];
      stubTable(() => ({
        where: (column, value) => {
          whereCalls.push({ column, value });
          return {
            first: async () => ({ sbmqb_id: value, sbmqb_customer_name: 'Cliente Sintético QBO' })
          };
        }
      }));

      chai.request(app)
        .get('/api/customers/QBO-555')
        .set('api-key', config.apiKey)
        .end((err, res) => {
          expect(err).to.be.null;
          expect(res).to.have.status(200);
          expect(res.body.message).to.deep.equal({
            sbmqb_id: 'QBO-555',
            sbmqb_customer_name: 'Cliente Sintético QBO'
          });
          // El id sintético debe llegar intacto al query builder (parametrizado),
          // sin interpolarse en un string SQL crudo -- eso es justamente lo que
          // rompía antes, y lo que hacía la query inyectable.
          expect(whereCalls).to.deep.equal([{ column: 'sbmqb_id', value: 'QBO-555' }]);
          done();
        });
    });

    it('responde 404 cuando no encuentra el cliente', (done) => {
      stubTable(() => ({
        where: () => ({ first: async () => undefined })
      }));

      chai.request(app)
        .get('/api/customers/QBO-999')
        .set('api-key', config.apiKey)
        .end((err, res) => {
          expect(err).to.be.null;
          expect(res).to.have.status(404);
          expect(res.body.message).to.equal('Customer not found');
          done();
        });
    });

    it('propaga al error handler cuando la query falla (no revienta el proceso)', (done) => {
      stubTable(() => ({
        where: () => ({ first: async () => { throw new Error('boom'); } })
      }));

      chai.request(app)
        .get('/api/customers/QBO-1')
        .set('api-key', config.apiKey)
        .end((err, res) => {
          expect(err).to.be.null;
          expect(res.status).to.be.at.least(400);
          done();
        });
    });
  });

  describe('PUT /api/customers', () => {
    it('actualiza el servicio del cliente usando query builder parametrizado, con sbmqb_id sintético', (done) => {
      const whereCalls = [];
      const updateCalls = [];
      stubTable((tableName) => {
        expect(tableName).to.equal('sbmqb_customers');
        return {
          where: (column, value) => {
            whereCalls.push({ column, value });
            return {
              update: async (values) => {
                updateCalls.push(values);
                return 1;
              }
            };
          }
        };
      });

      chai.request(app)
        .put('/api/customers')
        .set('api-key', config.apiKey)
        .send({ sbmqb_id: 'QBO-555', sbmqb_service: 'Nuevo Servicio' })
        .end((err, res) => {
          expect(err).to.be.null;
          expect(res).to.have.status(200);
          expect(res.body.message).to.equal('Se actualizo el servicio del cliente a: Nuevo Servicio');
          expect(whereCalls).to.deep.equal([{ column: 'sbmqb_id', value: 'QBO-555' }]);
          expect(updateCalls).to.deep.equal([{ sbmqb_service: 'Nuevo Servicio' }]);
          done();
        });
    });
  });
});
