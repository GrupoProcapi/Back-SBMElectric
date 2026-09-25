const chai = require('chai');
const chaiHttp = require('chai-http');
const expect = chai.expect;

const app = require('../src/server');
const config = require('../src/config');

chai.use(chaiHttp);

// qboAdminAuth reads process.env.QBO_ADMIN_KEY on every request (not cached at
// require time), so tests can toggle it per-suite without reloading the app.
const TEST_ADMIN_KEY = 'test-qbo-admin-key-do-not-use-in-prod';
const ADMIN_KEY_HEADER = 'x-qbo-admin-key';

describe('QBO routes — public vs admin split', () => {
  let originalAdminKeyEnv;

  before(() => {
    originalAdminKeyEnv = process.env.QBO_ADMIN_KEY;
    process.env.QBO_ADMIN_KEY = TEST_ADMIN_KEY;
  });

  after(() => {
    if (originalAdminKeyEnv === undefined) {
      delete process.env.QBO_ADMIN_KEY;
    } else {
      process.env.QBO_ADMIN_KEY = originalAdminKeyEnv;
    }
  });

  describe('GET /api/qbo/auth (public)', () => {
    it('should redirect to Intuit without requiring an api-key header', (done) => {
      chai.request(app)
        .get('/api/qbo/auth')
        .redirects(0)
        .end((err, res) => {
          expect(res).to.have.status(302);
          done();
        });
    });

    it('should set an HttpOnly qbo_oauth_state cookie', (done) => {
      chai.request(app)
        .get('/api/qbo/auth')
        .redirects(0)
        .end((err, res) => {
          const setCookie = res.headers['set-cookie'] || [];
          const stateCookie = setCookie.find((c) => c.startsWith('qbo_oauth_state='));
          expect(stateCookie).to.exist;
          expect(stateCookie.toLowerCase()).to.include('httponly');
          done();
        });
    });
  });

  describe('GET /api/qbo/callback (public)', () => {
    it('should reject with 400 generic error when there is no state/cookie at all', (done) => {
      chai.request(app)
        .get('/api/qbo/callback')
        .query({ code: 'fake-code', realmId: '123' })
        .end((err, res) => {
          expect(res).to.have.status(400);
          expect(res.body).to.not.have.property('stack');
          done();
        });
    });

    it('should reject with 400 when query state and cookie state do not match', (done) => {
      chai.request(app)
        .get('/api/qbo/callback')
        .query({ code: 'fake-code', realmId: '123', state: 'abc' })
        .set('Cookie', 'qbo_oauth_state=def')
        .end((err, res) => {
          expect(res).to.have.status(400);
          done();
        });
    });
  });

  describe('Admin QBO endpoints require api-key (first layer)', () => {
    const adminEndpoints = [
      { method: 'get', path: '/api/qbo/customers' },
      { method: 'get', path: '/api/qbo/items' },
      { method: 'get', path: '/api/qbo/invoices' },
      { method: 'get', path: '/api/qbo/status' },
      { method: 'post', path: '/api/qbo/customers/sync' },
      { method: 'post', path: '/api/qbo/invoices/process' }
    ];

    adminEndpoints.forEach(({ method, path }) => {
      it(`${method.toUpperCase()} ${path} should return 401 without an api-key header`, (done) => {
        chai.request(app)[method](path).end((err, res) => {
          expect(res).to.have.status(401);
          done();
        });
      });
    });
  });

  describe('Admin QBO endpoints require x-qbo-admin-key (second layer, BUG ALTO fix)', () => {
    const adminEndpoints = [
      { method: 'get', path: '/api/qbo/customers' },
      { method: 'get', path: '/api/qbo/items' },
      { method: 'get', path: '/api/qbo/invoices' },
      { method: 'get', path: '/api/qbo/status' },
      { method: 'post', path: '/api/qbo/customers/sync' },
      { method: 'post', path: '/api/qbo/invoices/process' }
    ];

    adminEndpoints.forEach(({ method, path }) => {
      it(`${method.toUpperCase()} ${path} should return 401 with a valid api-key but WITHOUT x-qbo-admin-key`, (done) => {
        chai.request(app)[method](path)
          .set('api-key', config.apiKey)
          .end((err, res) => {
            expect(res).to.have.status(401);
            done();
          });
      });
    });

    it('should return 403 when x-qbo-admin-key is present but wrong', (done) => {
      chai.request(app)
        .get('/api/qbo/status')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, 'not-the-right-key')
        .end((err, res) => {
          expect(res).to.have.status(403);
          done();
        });
    });

    it('should let the request past auth (not 401/403) when both api-key and x-qbo-admin-key are correct', (done) => {
      chai.request(app)
        .get('/api/qbo/status')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .end((err, res) => {
          // No aseveramos 200: /status hace una query real a la DB y este entorno
          // de test puede no tener una DB alcanzable. Lo que valida este test es
          // que la autenticación (api-key + x-qbo-admin-key) ya no bloquea.
          expect(res.status).to.not.equal(401);
          expect(res.status).to.not.equal(403);
          done();
        });
    });
  });

  describe('QBO_ADMIN_KEY misconfiguration — fail-closed (BUG ALTO fix)', () => {
    afterEach(() => {
      // Restaurar el valor válido usado por el resto de la suite.
      process.env.QBO_ADMIN_KEY = TEST_ADMIN_KEY;
    });

    it('should reject every admin request with 500 when QBO_ADMIN_KEY is not set at all, even with a correct api-key', (done) => {
      delete process.env.QBO_ADMIN_KEY;
      chai.request(app)
        .get('/api/qbo/status')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .end((err, res) => {
          expect(res).to.have.status(500);
          done();
        });
    });

    it('should reject every admin request with 500 when QBO_ADMIN_KEY equals API_KEY (defeats the whole point of a separate secret)', (done) => {
      process.env.QBO_ADMIN_KEY = config.apiKey;
      chai.request(app)
        .get('/api/qbo/status')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, config.apiKey)
        .end((err, res) => {
          expect(res).to.have.status(500);
          done();
        });
    });
  });

  describe('POST /api/qbo/invoices/process — input validation', () => {
    it('should reject when invoiceIds is missing', (done) => {
      chai.request(app)
        .post('/api/qbo/invoices/process')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .send({})
        .end((err, res) => {
          expect(res).to.have.status(400);
          done();
        });
    });

    it('should reject when invoiceIds is an empty array', (done) => {
      chai.request(app)
        .post('/api/qbo/invoices/process')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .send({ invoiceIds: [] })
        .end((err, res) => {
          expect(res).to.have.status(400);
          done();
        });
    });

    it('should reject when invoiceIds has more than 20 items', (done) => {
      const invoiceIds = Array.from({ length: 21 }, (_, i) => i + 1);
      chai.request(app)
        .post('/api/qbo/invoices/process')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .send({ invoiceIds })
        .end((err, res) => {
          expect(res).to.have.status(400);
          done();
        });
    });

    it('should reject when invoiceIds contains a non-integer value', (done) => {
      chai.request(app)
        .post('/api/qbo/invoices/process')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .send({ invoiceIds: [1, 'abc'] })
        .end((err, res) => {
          expect(res).to.have.status(400);
          done();
        });
    });

    it('should reject when invoiceIds contains a negative or zero value', (done) => {
      chai.request(app)
        .post('/api/qbo/invoices/process')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .send({ invoiceIds: [0, -1] })
        .end((err, res) => {
          expect(res).to.have.status(400);
          done();
        });
    });

    it('should reject when dryRun is not a boolean', (done) => {
      chai.request(app)
        .post('/api/qbo/invoices/process')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .send({ invoiceIds: [1], dryRun: 'yes' })
        .end((err, res) => {
          expect(res).to.have.status(400);
          done();
        });
    });
  });

  describe('POST /api/qbo/invoices/process — delegates to qboInvoiceService.processPendingInvoices', () => {
    afterEach(() => {
      delete process.env.QBO_PROCESS_MAX_BATCH;
    });

    it('should return 400 (not 500) when invoiceIds exceeds QBO_PROCESS_MAX_BATCH, proving the route no longer runs its own inline query/loop', (done) => {
      // Con QBO_PROCESS_MAX_BATCH sin setear, el default de qboConfig es 1 (ver
      // qboConfig.js). Este batch de 2 pasa la validación de forma del propio
      // endpoint (1-20 enteros positivos) pero es rechazado por
      // qboInvoiceService.processPendingInvoices() ANTES de tocar la DB -- si
      // el handler todavía tuviera la lógica inline vieja, este límite no
      // existiría y la respuesta sería otra (probablemente 200 dryRun).
      chai.request(app)
        .post('/api/qbo/invoices/process')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .send({ invoiceIds: [1, 2], dryRun: true })
        .end((err, res) => {
          expect(res).to.have.status(400);
          expect(res.body).to.have.property('error');
          expect(res.body.error).to.match(/QBO_PROCESS_MAX_BATCH/);
          done();
        });
    });
  });

  describe('POST /api/qbo/customers/sync — input validation', () => {
    it('should reject when dryRun is not a boolean', (done) => {
      chai.request(app)
        .post('/api/qbo/customers/sync')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .send({ dryRun: 'nope' })
        .end((err, res) => {
          expect(res).to.have.status(400);
          done();
        });
    });
  });

  describe('POST /api/qbo/invoices/create — removed (BUG ALTO fix)', () => {
    it('should no longer exist as a route: 404 even with both valid api-key and x-qbo-admin-key', (done) => {
      chai.request(app)
        .post('/api/qbo/invoices/create')
        .set('api-key', config.apiKey)
        .set(ADMIN_KEY_HEADER, TEST_ADMIN_KEY)
        .send({ id: 1, sbmqb_customer_name: 'Anyone', total_measure_value: 999999 })
        .end((err, res) => {
          expect(res).to.have.status(404);
          done();
        });
    });
  });
});

describe('POST /api/login — must run before apiKeyValidator', () => {
  it('should NOT return the apiKeyValidator "API key is missing" error when no api-key header is sent', (done) => {
    chai.request(app)
      .post('/api/login')
      .send({})
      .end((err, res) => {
        // If apiKeyValidator ran first, this would be 401 with "API key is missing".
        // validateLogin should intercept first and return a 400 with field errors instead.
        expect(res).to.have.status(400);
        expect(res.body).to.have.property('errors');
        done();
      });
  });

  it('should return validation errors (not an auth error) when password is missing', (done) => {
    chai.request(app)
      .post('/api/login')
      .send({ username: 'someone' })
      .end((err, res) => {
        expect(res).to.have.status(400);
        expect(res.body).to.have.property('errors');
        done();
      });
  });
});
