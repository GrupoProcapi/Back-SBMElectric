const chai = require('chai');
const expect = chai.expect;

const qboOAuthState = require('../src/services/qboOAuthState');

// Helper to build a fake Express req with a cookie header
const fakeReq = ({ queryState, cookieState } = {}) => ({
  query: queryState !== undefined ? { state: queryState } : {},
  headers: cookieState !== undefined
    ? { cookie: `qbo_oauth_state=${encodeURIComponent(cookieState)}` }
    : {}
});

describe('qboOAuthState', () => {
  describe('generateState', () => {
    it('should generate a 64-char hex string (32 random bytes)', () => {
      const state = qboOAuthState.generateState();
      expect(state).to.be.a('string');
      expect(state).to.match(/^[a-f0-9]{64}$/);
    });

    it('should generate a different value on every call', () => {
      const a = qboOAuthState.generateState();
      const b = qboOAuthState.generateState();
      expect(a).to.not.equal(b);
    });
  });

  describe('consumeState', () => {
    it('should accept a state that matches query, cookie and the in-memory store', () => {
      const state = qboOAuthState.generateState();
      const req = fakeReq({ queryState: state, cookieState: state });
      expect(qboOAuthState.consumeState(req)).to.equal(true);
    });

    it('should be single-use: a second attempt with the same state must fail', () => {
      const state = qboOAuthState.generateState();
      const req = fakeReq({ queryState: state, cookieState: state });
      expect(qboOAuthState.consumeState(req)).to.equal(true);
      expect(qboOAuthState.consumeState(req)).to.equal(false);
    });

    it('should reject when query state and cookie state do not match', () => {
      const state = qboOAuthState.generateState();
      const req = fakeReq({ queryState: state, cookieState: 'a'.repeat(64) });
      expect(qboOAuthState.consumeState(req)).to.equal(false);
    });

    it('should reject a state that was never generated (not in the store)', () => {
      const fabricated = 'f'.repeat(64);
      const req = fakeReq({ queryState: fabricated, cookieState: fabricated });
      expect(qboOAuthState.consumeState(req)).to.equal(false);
    });

    it('should reject when the query state is missing', () => {
      const state = qboOAuthState.generateState();
      const req = fakeReq({ cookieState: state });
      expect(qboOAuthState.consumeState(req)).to.equal(false);
    });

    it('should reject when the cookie is missing', () => {
      const state = qboOAuthState.generateState();
      const req = fakeReq({ queryState: state });
      expect(qboOAuthState.consumeState(req)).to.equal(false);
    });

    it('should reject an expired state even if query and cookie match', (done) => {
      const state = qboOAuthState.generateStateWithTtl(1); // 1ms TTL, test-only helper
      setTimeout(() => {
        const req = fakeReq({ queryState: state, cookieState: state });
        expect(qboOAuthState.consumeState(req)).to.equal(false);
        done();
      }, 20);
    });
  });

  describe('attachStateCookie / clearStateCookie', () => {
    it('should set an HttpOnly, Secure, SameSite=Lax cookie scoped to /api/qbo', () => {
      let capturedName;
      let capturedValue;
      let capturedOptions;
      const res = {
        cookie: (name, value, options) => {
          capturedName = name;
          capturedValue = value;
          capturedOptions = options;
        }
      };
      qboOAuthState.attachStateCookie(res, 'some-state-value');
      expect(capturedName).to.equal('qbo_oauth_state');
      expect(capturedValue).to.equal('some-state-value');
      expect(capturedOptions).to.include({
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/api/qbo'
      });
    });

    it('should clear the cookie scoped to /api/qbo', () => {
      let cleared;
      const res = { clearCookie: (name, options) => { cleared = { name, options }; } };
      qboOAuthState.clearStateCookie(res);
      expect(cleared.name).to.equal('qbo_oauth_state');
      expect(cleared.options).to.include({ path: '/api/qbo' });
    });
  });
});
