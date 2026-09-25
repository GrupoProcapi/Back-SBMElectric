const { expect } = require('chai');

const qboConfig = require('../src/config/qboConfig');

// NOTA: el proyecto no tiene zod instalado (ver package.json) ni sinon/proxyquire.
// La validación se implementa a mano en qboConfig.js. buildConfig() recibe un
// objeto `env` explícito (en vez de leer process.env directamente) para poder
// testear todas las combinaciones sin mutar variables de entorno globales.
const { buildConfig } = qboConfig.__testables;

const VALID_SERVICE_MAP = {
  '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70004-Electricity T. @ 0.48/KW': {
    itemId: 'PENDING_ITEM_ID_ELECTRICITY_T',
    unitPrice: 0.48
  },
  '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70001-Metered elect. @ 0.415/KW': {
    itemId: 'PENDING_ITEM_ID_METERED',
    unitPrice: 0.415
  }
};

const validEnv = (overrides = {}) => ({
  QBO_SERVICE_MAP_JSON: JSON.stringify(VALID_SERVICE_MAP),
  QBO_TAX_CODE_ID: '7',
  QBO_SALES_TERM_ID: '3',
  ...overrides
});

describe('qboConfig - buildConfig (fail-closed, no debe tirar la app)', () => {
  it('nunca lanza una excepción, sin importar qué tan inválido sea el env', () => {
    expect(() => buildConfig({})).to.not.throw();
    expect(() => buildConfig({ QBO_SERVICE_MAP_JSON: '{not valid json' })).to.not.throw();
  });

  it('queda habilitado cuando toda la configuración requerida está presente', () => {
    const config = buildConfig(validEnv());
    expect(config.isEnabled).to.equal(true);
    expect(config.errors).to.deep.equal([]);
  });

  it('parsea correctamente el mapa de servicios', () => {
    const config = buildConfig(validEnv());
    const key = '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70004-Electricity T. @ 0.48/KW';
    expect(config.serviceMap[key]).to.deep.equal({
      itemId: 'PENDING_ITEM_ID_ELECTRICITY_T',
      unitPrice: 0.48
    });
  });

  it('deja classId en null cuando QBO_CLASS_ID no está configurado (es opcional)', () => {
    const config = buildConfig(validEnv());
    expect(config.classId).to.equal(null);
  });

  it('setea classId cuando QBO_CLASS_ID sí está configurado', () => {
    const config = buildConfig(validEnv({ QBO_CLASS_ID: 'class-123' }));
    expect(config.classId).to.equal('class-123');
  });

  it('usa QBO_PROCESS_MAX_BATCH=1 como default cuando no está seteada', () => {
    const config = buildConfig(validEnv());
    expect(config.maxBatch).to.equal(1);
  });

  it('respeta QBO_PROCESS_MAX_BATCH cuando es un entero positivo válido', () => {
    const config = buildConfig(validEnv({ QBO_PROCESS_MAX_BATCH: '5' }));
    expect(config.maxBatch).to.equal(5);
  });

  it('cae al default de maxBatch si QBO_PROCESS_MAX_BATCH es inválido (no numérico)', () => {
    const config = buildConfig(validEnv({ QBO_PROCESS_MAX_BATCH: 'abc' }));
    expect(config.maxBatch).to.equal(1);
  });

  it('cae al default de maxBatch si QBO_PROCESS_MAX_BATCH es cero o negativo', () => {
    expect(buildConfig(validEnv({ QBO_PROCESS_MAX_BATCH: '0' })).maxBatch).to.equal(1);
    expect(buildConfig(validEnv({ QBO_PROCESS_MAX_BATCH: '-2' })).maxBatch).to.equal(1);
  });

  describe('fail-closed: falta configuración esencial', () => {
    it('se deshabilita si falta QBO_SERVICE_MAP_JSON', () => {
      const config = buildConfig(validEnv({ QBO_SERVICE_MAP_JSON: undefined }));
      expect(config.isEnabled).to.equal(false);
      expect(config.errors.join(' ')).to.match(/QBO_SERVICE_MAP_JSON/);
    });

    it('se deshabilita si QBO_SERVICE_MAP_JSON no es JSON válido', () => {
      const config = buildConfig(validEnv({ QBO_SERVICE_MAP_JSON: '{not valid json' }));
      expect(config.isEnabled).to.equal(false);
      expect(config.errors.join(' ')).to.match(/JSON/);
    });

    it('se deshabilita si QBO_SERVICE_MAP_JSON es un array en vez de un objeto', () => {
      const config = buildConfig(validEnv({ QBO_SERVICE_MAP_JSON: '[]' }));
      expect(config.isEnabled).to.equal(false);
    });

    it('se deshabilita si QBO_SERVICE_MAP_JSON es un objeto vacío', () => {
      const config = buildConfig(validEnv({ QBO_SERVICE_MAP_JSON: '{}' }));
      expect(config.isEnabled).to.equal(false);
      expect(config.errors.join(' ')).to.match(/vacío/i);
    });

    it('se deshabilita si una entrada del mapa no tiene itemId', () => {
      const badMap = { servicioX: { unitPrice: 0.48 } };
      const config = buildConfig(validEnv({ QBO_SERVICE_MAP_JSON: JSON.stringify(badMap) }));
      expect(config.isEnabled).to.equal(false);
      expect(config.errors.join(' ')).to.match(/itemId/);
    });

    it('se deshabilita si una entrada del mapa tiene unitPrice no numérico', () => {
      const badMap = { servicioX: { itemId: 'x1', unitPrice: '0.48' } };
      const config = buildConfig(validEnv({ QBO_SERVICE_MAP_JSON: JSON.stringify(badMap) }));
      expect(config.isEnabled).to.equal(false);
      expect(config.errors.join(' ')).to.match(/unitPrice/);
    });

    it('se deshabilita si una entrada del mapa tiene unitPrice <= 0', () => {
      const badMap = { servicioX: { itemId: 'x1', unitPrice: 0 } };
      const config = buildConfig(validEnv({ QBO_SERVICE_MAP_JSON: JSON.stringify(badMap) }));
      expect(config.isEnabled).to.equal(false);
    });

    it('se deshabilita si falta QBO_TAX_CODE_ID', () => {
      const config = buildConfig(validEnv({ QBO_TAX_CODE_ID: undefined }));
      expect(config.isEnabled).to.equal(false);
      expect(config.errors.join(' ')).to.match(/QBO_TAX_CODE_ID/);
    });

    it('se deshabilita si falta QBO_SALES_TERM_ID', () => {
      const config = buildConfig(validEnv({ QBO_SALES_TERM_ID: undefined }));
      expect(config.isEnabled).to.equal(false);
      expect(config.errors.join(' ')).to.match(/QBO_SALES_TERM_ID/);
    });

    it('acumula todos los errores encontrados, no solo el primero', () => {
      const config = buildConfig({});
      expect(config.errors.length).to.be.greaterThan(1);
    });
  });
});

describe('qboConfig - getConfig()/reloadConfig() (singleton sobre process.env real)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    qboConfig.reloadConfig();
  });

  it('reloadConfig() recalcula a partir de process.env actual', () => {
    process.env.QBO_SERVICE_MAP_JSON = JSON.stringify(VALID_SERVICE_MAP);
    process.env.QBO_TAX_CODE_ID = '7';
    process.env.QBO_SALES_TERM_ID = '3';
    delete process.env.QBO_CLASS_ID;
    delete process.env.QBO_PROCESS_MAX_BATCH;

    const config = qboConfig.reloadConfig();
    expect(config.isEnabled).to.equal(true);
    expect(qboConfig.getConfig()).to.equal(config);
  });

  it('queda deshabilitado si se borra QBO_TAX_CODE_ID del entorno real', () => {
    process.env.QBO_SERVICE_MAP_JSON = JSON.stringify(VALID_SERVICE_MAP);
    delete process.env.QBO_TAX_CODE_ID;
    process.env.QBO_SALES_TERM_ID = '3';

    const config = qboConfig.reloadConfig();
    expect(config.isEnabled).to.equal(false);
  });
});

describe('qboConfig - getServiceConfig(sbmqbService)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    qboConfig.reloadConfig();
  });

  const enableWithValidMap = () => {
    process.env.QBO_SERVICE_MAP_JSON = JSON.stringify(VALID_SERVICE_MAP);
    process.env.QBO_TAX_CODE_ID = '7';
    process.env.QBO_SALES_TERM_ID = '3';
    delete process.env.QBO_CLASS_ID;
    return qboConfig.reloadConfig();
  };

  it('devuelve { itemId, unitPrice } para un servicio mapeado', () => {
    enableWithValidMap();
    const result = qboConfig.getServiceConfig(
      '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70001-Metered elect. @ 0.415/KW'
    );
    expect(result).to.deep.equal({ itemId: 'PENDING_ITEM_ID_METERED', unitPrice: 0.415 });
  });

  it('lanza un error explícito si el servicio no está en el mapa (nunca inventa precio/item)', () => {
    enableWithValidMap();
    expect(() => qboConfig.getServiceConfig('servicio-desconocido-no-mapeado'))
      .to.throw(/no hay mapeo/i);
  });

  it('lanza un error explícito si el servicio de facturación está deshabilitado', () => {
    process.env.QBO_SERVICE_MAP_JSON = undefined;
    delete process.env.QBO_SERVICE_MAP_JSON;
    delete process.env.QBO_TAX_CODE_ID;
    delete process.env.QBO_SALES_TERM_ID;
    qboConfig.reloadConfig();

    expect(() => qboConfig.getServiceConfig('cualquier-servicio')).to.throw(/deshabilitad/i);
  });
});
