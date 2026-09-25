const chai = require('chai');
const chaiHttp = require('chai-http');
const expect = chai.expect;

const app = require('../src/server');
const qboOAuthState = require('../src/services/qboOAuthState');
const qboClient = require('../src/services/qboClient');
const qboPublicRoutes = require('../src/routes/qboPublicRoutes');

chai.use(chaiHttp);

// ---------------------------------------------------------------------------
// No mocking library available in this project (sinon/proxyquire are not
// installed — see qboClient.test.js / qboCustomerService.js for the same
// note). qboClient is a singleton module object; both this test file and
// qboPublicRoutes.js hold the SAME reference (require() caches modules), so
// mutating qboClient.handleCallback here is visible to the route without
// needing a mocking library. It's restored in afterEach.
// ---------------------------------------------------------------------------

const buildValidCallbackRequest = ({ realmId }) => {
  // Bypasses the real /auth redirect round-trip: generates a valid CSRF state
  // directly via the same singleton store the route uses, so the callback's
  // consumeState() check passes and we can focus purely on the realm guard.
  const state = qboOAuthState.generateState();
  return chai.request(app)
    .get('/api/qbo/callback')
    .query({ code: 'fake-code', realmId, state })
    .set('Cookie', `qbo_oauth_state=${state}`);
};

describe('GET /api/qbo/callback — realm allow-list guard (fail-closed)', () => {
  const originalAllowedRealmIds = process.env.QBO_ALLOWED_REALM_IDS;
  const originalFirstConnectMode = process.env.QBO_FIRST_CONNECT_MODE;
  const originalHandleCallback = qboClient.handleCallback;

  afterEach(() => {
    if (originalAllowedRealmIds === undefined) {
      delete process.env.QBO_ALLOWED_REALM_IDS;
    } else {
      process.env.QBO_ALLOWED_REALM_IDS = originalAllowedRealmIds;
    }

    if (originalFirstConnectMode === undefined) {
      delete process.env.QBO_FIRST_CONNECT_MODE;
    } else {
      process.env.QBO_FIRST_CONNECT_MODE = originalFirstConnectMode;
    }

    qboClient.handleCallback = originalHandleCallback;
    qboPublicRoutes.__testables.resetFirstConnectExemption();
  });

  it('rejects (fail-closed) when QBO_ALLOWED_REALM_IDS is not set and QBO_FIRST_CONNECT_MODE is not set', (done) => {
    delete process.env.QBO_ALLOWED_REALM_IDS;
    delete process.env.QBO_FIRST_CONNECT_MODE;

    buildValidCallbackRequest({ realmId: '999999' }).end((err, res) => {
      expect(res).to.have.status(500);
      expect(res.body.error).to.match(/QBO_ALLOWED_REALM_IDS/);
      done();
    });
  });

  it('rejects when QBO_ALLOWED_REALM_IDS is set but the realm does not match', (done) => {
    process.env.QBO_ALLOWED_REALM_IDS = '111,222';
    delete process.env.QBO_FIRST_CONNECT_MODE;

    buildValidCallbackRequest({ realmId: '999999' }).end((err, res) => {
      expect(res).to.have.status(403);
      expect(res.body.error).to.not.match(/QBO_ALLOWED_REALM_IDS/);
      done();
    });
  });

  it('accepts when QBO_ALLOWED_REALM_IDS is set and the realm matches', (done) => {
    process.env.QBO_ALLOWED_REALM_IDS = '111,222';
    delete process.env.QBO_FIRST_CONNECT_MODE;
    qboClient.handleCallback = async () => ({ realmId: '222', expiresIn: 3600 });

    buildValidCallbackRequest({ realmId: '222' }).end((err, res) => {
      expect(res).to.have.status(200);
      done();
    });
  });

  it('accepts any realm exactly once when QBO_FIRST_CONNECT_MODE=true, and logs the warning', (done) => {
    delete process.env.QBO_ALLOWED_REALM_IDS;
    process.env.QBO_FIRST_CONNECT_MODE = 'true';
    qboClient.handleCallback = async () => ({ realmId: '777888', expiresIn: 3600 });

    const originalWarn = console.warn;
    const warnMessages = [];
    console.warn = (...args) => {
      warnMessages.push(args.join(' '));
    };

    buildValidCallbackRequest({ realmId: '777888' }).end((err, res) => {
      console.warn = originalWarn;

      expect(res).to.have.status(200);
      expect(warnMessages.some((msg) => msg.includes('QBO_FIRST_CONNECT_MODE activo') && msg.includes('777888'))).to.equal(true);
      done();
    });
  });

  it('does not let a second connection reuse the QBO_FIRST_CONNECT_MODE exemption once it has been consumed', (done) => {
    delete process.env.QBO_ALLOWED_REALM_IDS;
    process.env.QBO_FIRST_CONNECT_MODE = 'true';
    qboClient.handleCallback = async () => ({ realmId: '777888', expiresIn: 3600 });

    buildValidCallbackRequest({ realmId: '777888' }).end((err, firstRes) => {
      expect(firstRes).to.have.status(200);

      buildValidCallbackRequest({ realmId: '999999' }).end((err2, secondRes) => {
        expect(secondRes).to.have.status(500);
        expect(secondRes.body.error).to.match(/QBO_ALLOWED_REALM_IDS/);
        done();
      });
    });
  });
});
