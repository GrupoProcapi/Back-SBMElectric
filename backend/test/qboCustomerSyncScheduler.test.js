const chai = require('chai');
const expect = chai.expect;

const { createQboCustomerSyncScheduler } = require('../src/services/qboCustomerSyncScheduler');

// El proyecto no tiene sinon/proxyquire instalado (ver comentarios en
// test/qboClient.test.js), así que en vez de mockear los timers globales de
// Node (setInterval/clearInterval) o esperar minutos reales, el módulo bajo
// test acepta `setIntervalFn`/`clearIntervalFn` inyectables (mismo patrón de
// factory con dependency injection que `createQboCustomerService`). Estas
// fakes capturan el callback y el delay sin ejecutar nada de verdad.
const makeFakeTimers = () => {
  const scheduled = [];
  const cleared = [];

  const setIntervalFn = (fn, delay) => {
    const handle = { fn, delay };
    scheduled.push(handle);
    return handle;
  };

  const clearIntervalFn = (handle) => {
    cleared.push(handle);
  };

  return { setIntervalFn, clearIntervalFn, scheduled, cleared };
};

const fakeSyncResult = (overrides = {}) => ({
  totalQbo: 0,
  matched: [],
  unmatched: [],
  ambiguous: [],
  wouldUpdate: 0,
  wouldCreate: 0,
  yaCreado: 0,
  ...overrides
});

describe('qboCustomerSyncScheduler', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('startCustomerSyncSchedule - deshabilitado por defecto', () => {
    it('no arranca ningún interval si QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED no está seteada', () => {
      delete process.env.QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED;
      const { setIntervalFn, scheduled } = makeFakeTimers();
      const scheduler = createQboCustomerSyncScheduler({
        setIntervalFn,
        qboCustomerService: { syncCustomers: async () => fakeSyncResult() }
      });

      const handle = scheduler.startCustomerSyncSchedule();

      expect(handle).to.equal(null);
      expect(scheduled).to.have.lengthOf(0);
    });

    it('no arranca ningún interval si QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED es distinto de "true" (typo/case)', () => {
      process.env.QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED = 'True';
      const { setIntervalFn, scheduled } = makeFakeTimers();
      const scheduler = createQboCustomerSyncScheduler({
        setIntervalFn,
        qboCustomerService: { syncCustomers: async () => fakeSyncResult() }
      });

      scheduler.startCustomerSyncSchedule();

      expect(scheduled).to.have.lengthOf(0);
    });
  });

  describe('startCustomerSyncSchedule - habilitado', () => {
    it('arranca un interval de 15 min por defecto si QBO_CUSTOMER_SYNC_INTERVAL_MINUTES no está seteada', () => {
      process.env.QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED = 'true';
      delete process.env.QBO_CUSTOMER_SYNC_INTERVAL_MINUTES;
      const { setIntervalFn, scheduled } = makeFakeTimers();
      const scheduler = createQboCustomerSyncScheduler({
        setIntervalFn,
        qboCustomerService: { syncCustomers: async () => fakeSyncResult() }
      });

      const handle = scheduler.startCustomerSyncSchedule();

      expect(scheduled).to.have.lengthOf(1);
      expect(scheduled[0].delay).to.equal(15 * 60 * 1000);
      expect(handle).to.equal(scheduled[0]);
    });

    it('arranca un interval con el período custom cuando se setea QBO_CUSTOMER_SYNC_INTERVAL_MINUTES', () => {
      process.env.QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED = 'true';
      process.env.QBO_CUSTOMER_SYNC_INTERVAL_MINUTES = '5';
      const { setIntervalFn, scheduled } = makeFakeTimers();
      const scheduler = createQboCustomerSyncScheduler({
        setIntervalFn,
        qboCustomerService: { syncCustomers: async () => fakeSyncResult() }
      });

      scheduler.startCustomerSyncSchedule();

      expect(scheduled[0].delay).to.equal(5 * 60 * 1000);
    });

    it('usa el default de 15 min si QBO_CUSTOMER_SYNC_INTERVAL_MINUTES no es un número válido', () => {
      process.env.QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED = 'true';
      process.env.QBO_CUSTOMER_SYNC_INTERVAL_MINUTES = 'not-a-number';
      const { setIntervalFn, scheduled } = makeFakeTimers();
      const scheduler = createQboCustomerSyncScheduler({
        setIntervalFn,
        qboCustomerService: { syncCustomers: async () => fakeSyncResult() }
      });

      scheduler.startCustomerSyncSchedule();

      expect(scheduled[0].delay).to.equal(15 * 60 * 1000);
    });

    it('usa el default de 15 min si QBO_CUSTOMER_SYNC_INTERVAL_MINUTES es <= 0', () => {
      process.env.QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED = 'true';
      process.env.QBO_CUSTOMER_SYNC_INTERVAL_MINUTES = '0';
      const { setIntervalFn, scheduled } = makeFakeTimers();
      const scheduler = createQboCustomerSyncScheduler({
        setIntervalFn,
        qboCustomerService: { syncCustomers: async () => fakeSyncResult() }
      });

      scheduler.startCustomerSyncSchedule();

      expect(scheduled[0].delay).to.equal(15 * 60 * 1000);
    });
  });

  describe('callback del interval', () => {
    it('llama a syncCustomers con { dryRun: false, includeInactive: true }', async () => {
      process.env.QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED = 'true';
      let receivedArgs = null;
      const fakeQboCustomerService = {
        syncCustomers: async (args) => {
          receivedArgs = args;
          return fakeSyncResult();
        }
      };
      const { setIntervalFn, scheduled } = makeFakeTimers();
      const scheduler = createQboCustomerSyncScheduler({
        setIntervalFn,
        qboCustomerService: fakeQboCustomerService
      });

      scheduler.startCustomerSyncSchedule();
      await scheduled[0].fn();

      expect(receivedArgs).to.deep.equal({ dryRun: false, includeInactive: true });
    });

    it('un error de QBO_SYNC_APPLY_ENABLED deshabilitado no rompe el proceso -- se loguea y sigue', async () => {
      process.env.QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED = 'true';
      const fakeQboCustomerService = {
        syncCustomers: async () => {
          throw new Error(
            'QBO sync apply mode is disabled. Set QBO_SYNC_APPLY_ENABLED=true in the environment ' +
              'to allow syncCustomers to write qbo_id updates.'
          );
        }
      };
      const { setIntervalFn, scheduled } = makeFakeTimers();
      const scheduler = createQboCustomerSyncScheduler({
        setIntervalFn,
        qboCustomerService: fakeQboCustomerService
      });

      scheduler.startCustomerSyncSchedule();

      // No debe lanzar ni rechazar -- runSync atrapa el error internamente.
      await scheduled[0].fn();
    });

    it('un error genérico (no relacionado a QBO_SYNC_APPLY_ENABLED) tampoco rompe el proceso', async () => {
      process.env.QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED = 'true';
      const fakeQboCustomerService = {
        syncCustomers: async () => {
          throw new Error('Connection refused');
        }
      };
      const { setIntervalFn, scheduled } = makeFakeTimers();
      const scheduler = createQboCustomerSyncScheduler({
        setIntervalFn,
        qboCustomerService: fakeQboCustomerService
      });

      scheduler.startCustomerSyncSchedule();

      await scheduled[0].fn();
    });
  });

  describe('stopCustomerSyncSchedule', () => {
    it('limpia el interval activo iniciado por startCustomerSyncSchedule', () => {
      process.env.QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED = 'true';
      const { setIntervalFn, clearIntervalFn, scheduled, cleared } = makeFakeTimers();
      const scheduler = createQboCustomerSyncScheduler({
        setIntervalFn,
        clearIntervalFn,
        qboCustomerService: { syncCustomers: async () => fakeSyncResult() }
      });

      scheduler.startCustomerSyncSchedule();
      scheduler.stopCustomerSyncSchedule();

      expect(cleared).to.have.lengthOf(1);
      expect(cleared[0]).to.equal(scheduled[0]);
    });

    it('no falla si se llama sin haber arrancado ningún interval', () => {
      const { clearIntervalFn, cleared } = makeFakeTimers();
      const scheduler = createQboCustomerSyncScheduler({
        clearIntervalFn,
        qboCustomerService: { syncCustomers: async () => fakeSyncResult() }
      });

      scheduler.stopCustomerSyncSchedule();

      expect(cleared).to.have.lengthOf(0);
    });
  });
});
