const { expect } = require('chai');

const qboClient = require('../src/services/qboClient');

// NOTA: estos tests son unitarios puros. Ninguno debe tocar la base de datos real
// ni hacer llamadas de red a QuickBooks: el kill switch (QBO_WRITES_ENABLED) se
// valida ANTES de tocar la DB/red, lo que permite testearlo de forma aislada.
// El proyecto no tiene sinon/proxyquire instalado (ver package.json), por eso no
// se testea acá el camino completo de refreshTokenPreventively() cuando SÍ hay
// tokens guardados (requeriría stubear knex). Queda documentado como gap conocido.

describe('qboClient - QboWritesDisabledError', () => {
  it('es una subclase de Error con código estable', () => {
    const error = new qboClient.QboWritesDisabledError();
    expect(error).to.be.instanceOf(Error);
    expect(error.name).to.equal('QboWritesDisabledError');
    expect(error.code).to.equal('QBO_WRITES_DISABLED');
    expect(error.message).to.be.a('string').and.not.equal('');
  });

  it('acepta un mensaje custom', () => {
    const error = new qboClient.QboWritesDisabledError('mensaje custom');
    expect(error.message).to.equal('mensaje custom');
  });
});

describe('qboClient - kill switch (assertWriteAllowed)', () => {
  const ORIGINAL_ENV = process.env.QBO_WRITES_ENABLED;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.QBO_WRITES_ENABLED;
    } else {
      process.env.QBO_WRITES_ENABLED = ORIGINAL_ENV;
    }
  });

  it('bloquea POST cuando QBO_WRITES_ENABLED no está seteada', () => {
    delete process.env.QBO_WRITES_ENABLED;
    expect(() => qboClient.__testables.assertWriteAllowed('POST', '/invoice'))
      .to.throw(qboClient.QboWritesDisabledError);
  });

  it('bloquea PUT cuando QBO_WRITES_ENABLED es "false"', () => {
    process.env.QBO_WRITES_ENABLED = 'false';
    expect(() => qboClient.__testables.assertWriteAllowed('PUT', '/customer'))
      .to.throw(qboClient.QboWritesDisabledError);
  });

  it('bloquea POST cuando QBO_WRITES_ENABLED no es exactamente "true" (typo/case)', () => {
    process.env.QBO_WRITES_ENABLED = 'True';
    expect(() => qboClient.__testables.assertWriteAllowed('post', '/invoice'))
      .to.throw(qboClient.QboWritesDisabledError);
  });

  it('permite POST/PUT cuando QBO_WRITES_ENABLED es exactamente "true"', () => {
    process.env.QBO_WRITES_ENABLED = 'true';
    expect(() => qboClient.__testables.assertWriteAllowed('POST', '/invoice')).to.not.throw();
    expect(() => qboClient.__testables.assertWriteAllowed('PUT', '/customer')).to.not.throw();
  });

  it('nunca bloquea GET, sin importar el flag', () => {
    delete process.env.QBO_WRITES_ENABLED;
    expect(() => qboClient.__testables.assertWriteAllowed('GET', '/query')).to.not.throw();
    expect(() => qboClient.__testables.assertWriteAllowed('get', '/query')).to.not.throw();
  });
});

describe('qboClient - request()/makeApiCall() centralizan el kill switch antes de tocar DB/red', () => {
  const ORIGINAL_ENV = process.env.QBO_WRITES_ENABLED;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.QBO_WRITES_ENABLED;
    } else {
      process.env.QBO_WRITES_ENABLED = ORIGINAL_ENV;
    }
  });

  it('request() rechaza un POST con QboWritesDisabledError sin llegar a la DB/red', async () => {
    delete process.env.QBO_WRITES_ENABLED;
    let thrown = null;
    try {
      await qboClient.request('POST', '/invoice', { Line: [] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(qboClient.QboWritesDisabledError);
  });

  it('makeApiCall() (usado por qboCustomerService/qboInvoiceService) queda bloqueado porque delega en request()', async () => {
    process.env.QBO_WRITES_ENABLED = 'false';
    let thrown = null;
    try {
      await qboClient.makeApiCall('/invoice', 'POST', {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(qboClient.QboWritesDisabledError);
  });
});

describe('qboClient - redactSensitive (no filtrar tokens/secrets en logs)', () => {
  const { redactSensitive } = qboClient.__testables;

  it('enmascara access_token y refresh_token en primer nivel', () => {
    const input = { access_token: 'abcdefghij1234', refresh_token: 'zzzzzzzzzz9999', foo: 'bar' };
    const output = redactSensitive(input);
    expect(output.access_token).to.equal('abcdefgh...');
    expect(output.refresh_token).to.equal('zzzzzzzz...');
    expect(output.foo).to.equal('bar');
  });

  it('enmascara client_secret anidado dentro de un objeto', () => {
    const input = { config: { client_secret: 'supersecretvalue' } };
    const output = redactSensitive(input);
    expect(output.config.client_secret).to.equal('supersec...');
  });

  it('enmascara elementos sensibles dentro de arrays', () => {
    const input = [{ access_token: 'tokenvalue123456' }];
    const output = redactSensitive(input);
    expect(output[0].access_token).to.equal('tokenval...');
  });

  it('no modifica valores no sensibles ni estructuras primitivas', () => {
    expect(redactSensitive('hello')).to.equal('hello');
    expect(redactSensitive(null)).to.equal(null);
    expect(redactSensitive(42)).to.equal(42);
    const input = { Invoice: { Id: '123', DocNumber: '1001' } };
    expect(redactSensitive(input)).to.deep.equal(input);
  });
});

describe('qboClient - extractIntuitErrorMessage', () => {
  const { extractIntuitErrorMessage } = qboClient.__testables;

  it('prioriza error_description cuando existe (respuesta real de Intuit)', () => {
    const error = { error_description: 'invalid_grant', originalMessage: 'x', message: 'y' };
    expect(extractIntuitErrorMessage(error)).to.equal('invalid_grant');
  });

  it('cae a originalMessage si no hay error_description', () => {
    const error = { originalMessage: 'wrapped message', message: 'y' };
    expect(extractIntuitErrorMessage(error)).to.equal('wrapped message');
  });

  it('cae al message plano (ej. "Refresh token is invalid, please Authorize again.")', () => {
    const error = new Error('The Refresh token is invalid, please Authorize again.');
    expect(extractIntuitErrorMessage(error)).to.equal('The Refresh token is invalid, please Authorize again.');
  });

  it('devuelve un mensaje por defecto si no hay error', () => {
    expect(extractIntuitErrorMessage(null)).to.equal('Error desconocido');
  });
});

describe('qboClient - isSdkLoggingEnabled (kill switch del logging interno de intuit-oauth)', () => {
  const { isSdkLoggingEnabled } = qboClient.__testables;
  const ORIGINAL_ENV = process.env.QBO_SDK_LOGGING;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.QBO_SDK_LOGGING;
    } else {
      process.env.QBO_SDK_LOGGING = ORIGINAL_ENV;
    }
  });

  it('queda apagado por defecto (sin la variable de entorno seteada)', () => {
    delete process.env.QBO_SDK_LOGGING;
    expect(isSdkLoggingEnabled()).to.equal(false);
  });

  it('queda apagado con cualquier valor que no sea exactamente "true" (typo/case)', () => {
    process.env.QBO_SDK_LOGGING = 'True';
    expect(isSdkLoggingEnabled()).to.equal(false);
  });

  it('se activa solo cuando la variable es exactamente "true"', () => {
    process.env.QBO_SDK_LOGGING = 'true';
    expect(isSdkLoggingEnabled()).to.equal(true);
  });
});

// NOTA: getOAuthClient() cachea la instancia en una variable a nivel de módulo
// (singleton), y ese singleton puede quedar ya creado por otro test/suite que
// corrió antes en el mismo proceso (ej. request()/makeApiCall() de arriba
// disparan getAuthenticatedClient() -> getOAuthClient()). Verificar acá que
// oauthClient.logging refleje QBO_SDK_LOGGING en runtime requeriría reimportar
// el módulo con cache-busting (delete require.cache) y sin sinon/proxyquire
// disponibles eso agrega fragilidad sin aportar cobertura real adicional a la
// que ya da isSdkLoggingEnabled() (la función que realmente decide el valor
// pasado a `new OAuthClient({ logging: ... })`). Queda documentado como gap
// conocido y aceptado.

describe('qboClient - buildRotatedTokenData (persistencia atómica del refresh_token)', () => {
  const { buildRotatedTokenData } = qboClient.__testables;
  const previousTokens = {
    realm_id: '934145576895981',
    refresh_token: 'old-refresh-token',
    refresh_token_expiry: new Date('2026-01-01T00:00:00Z')
  };

  it('usa el refresh_token nuevo y marca rotated=true cuando Intuit devuelve uno distinto', () => {
    const newTokens = {
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 3600,
      x_refresh_token_expires_in: 8726400
    };
    const { tokenData, rotated } = buildRotatedTokenData(previousTokens, newTokens);
    expect(rotated).to.equal(true);
    expect(tokenData.refresh_token).to.equal('new-refresh-token');
    expect(tokenData.access_token).to.equal('new-access-token');
    expect(tokenData.realm_id).to.equal(previousTokens.realm_id);
    expect(tokenData.token_expiry).to.be.instanceOf(Date);
    expect(tokenData.refresh_token_expiry).to.be.instanceOf(Date);
  });

  it('conserva el refresh_token anterior y marca rotated=false si Intuit no manda uno nuevo', () => {
    const newTokens = {
      access_token: 'new-access-token',
      expires_in: 3600
    };
    const { tokenData, rotated } = buildRotatedTokenData(previousTokens, newTokens);
    expect(rotated).to.equal(false);
    expect(tokenData.refresh_token).to.equal(previousTokens.refresh_token);
    expect(tokenData.refresh_token_expiry).to.equal(previousTokens.refresh_token_expiry);
  });

  it('marca rotated=false si Intuit devuelve el mismo refresh_token de siempre', () => {
    const newTokens = {
      access_token: 'new-access-token',
      refresh_token: previousTokens.refresh_token,
      expires_in: 3600
    };
    const { rotated } = buildRotatedTokenData(previousTokens, newTokens);
    expect(rotated).to.equal(false);
  });
});

// NOTA: buildClientTokenParams recalcula expires_in/x_refresh_token_expires_in en
// segundos restantes reales (ver comentario en qboClient.js sobre el bug de
// intuit-oauth que defaultea esos campos a 0 si no se los recalcula). Se usa una
// tolerancia de ±2s en las comparaciones para no ser flaky por el tiempo que toma
// correr el propio test (Date.now() interno de la función vs. el que arma el fixture).
describe('qboClient - buildClientTokenParams (recalculo de expiración para intuit-oauth)', () => {
  const { buildClientTokenParams } = qboClient.__testables;
  const FALLBACK_REFRESH_TOKEN_TTL_SECONDS = 100 * 24 * 60 * 60;
  const TOLERANCE_SECONDS = 2;

  it('con token_expiry y refresh_token_expiry en el futuro, devuelve ambos "expires_in" positivos y consistentes con la diferencia real', () => {
    const tokenExpiresInSeconds = 3600; // 1 hora
    const refreshExpiresInSeconds = 8726400; // 101 días
    const tokens = {
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      realm_id: '934145576895981',
      token_expiry: new Date(Date.now() + tokenExpiresInSeconds * 1000),
      refresh_token_expiry: new Date(Date.now() + refreshExpiresInSeconds * 1000)
    };

    const result = buildClientTokenParams(tokens);

    expect(result.expires_in).to.be.a('number').and.be.greaterThan(0);
    expect(result.expires_in).to.be.closeTo(tokenExpiresInSeconds, TOLERANCE_SECONDS);

    expect(result.x_refresh_token_expires_in).to.be.a('number').and.be.greaterThan(0);
    expect(result.x_refresh_token_expires_in).to.be.closeTo(refreshExpiresInSeconds, TOLERANCE_SECONDS);
  });

  it('con token_expiry en el pasado (ya vencido), devuelve expires_in=0 (comportamiento real: cae al fallback de la función, no un negativo)', () => {
    const tokens = {
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      realm_id: '934145576895981',
      token_expiry: new Date(Date.now() - 60 * 1000), // vencido hace 1 minuto
      refresh_token_expiry: new Date(Date.now() + 8726400 * 1000)
    };

    const result = buildClientTokenParams(tokens);

    expect(result.expires_in).to.equal(0);
  });

  it('con refresh_token_expiry en el pasado (fecha válida pero vencida), devuelve x_refresh_token_expires_in=0 y NO el fallback de 100 días', () => {
    const tokens = {
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      realm_id: '934145576895981',
      token_expiry: new Date(Date.now() + 3600 * 1000),
      refresh_token_expiry: new Date(Date.now() - 60 * 1000) // vencido hace 1 minuto
    };

    const result = buildClientTokenParams(tokens);

    expect(result.x_refresh_token_expires_in).to.equal(0);
    expect(result.x_refresh_token_expires_in).to.not.equal(FALLBACK_REFRESH_TOKEN_TTL_SECONDS);
  });

  it('con refresh_token_expiry null, aplica el fallback de 100 días', () => {
    const tokens = {
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      realm_id: '934145576895981',
      token_expiry: new Date(Date.now() + 3600 * 1000),
      refresh_token_expiry: null
    };

    const result = buildClientTokenParams(tokens);

    expect(result.x_refresh_token_expires_in).to.equal(FALLBACK_REFRESH_TOKEN_TTL_SECONDS);
  });

  it('con refresh_token_expiry undefined, aplica el mismo fallback de 100 días', () => {
    const tokens = {
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      realm_id: '934145576895981',
      token_expiry: new Date(Date.now() + 3600 * 1000)
      // refresh_token_expiry ausente a propósito
    };

    const result = buildClientTokenParams(tokens);

    expect(result.x_refresh_token_expires_in).to.equal(FALLBACK_REFRESH_TOKEN_TTL_SECONDS);
  });

  it('incluye access_token, refresh_token, realmId y token_type tal como los recibió, además de los campos de expiración', () => {
    const tokens = {
      access_token: 'my-access-token',
      refresh_token: 'my-refresh-token',
      realm_id: '934145576895981',
      token_expiry: new Date(Date.now() + 3600 * 1000),
      refresh_token_expiry: new Date(Date.now() + 8726400 * 1000)
    };

    const result = buildClientTokenParams(tokens);

    expect(result.access_token).to.equal('my-access-token');
    expect(result.refresh_token).to.equal('my-refresh-token');
    expect(result.realmId).to.equal('934145576895981');
    expect(result.token_type).to.equal('bearer');
    expect(result.createdAt).to.be.a('number');
  });
});
