const defaultQboCustomerService = require('./qboCustomerService');

// Minutos por defecto entre corridas del sync automático si
// QBO_CUSTOMER_SYNC_INTERVAL_MINUTES no está seteada o no es un número válido.
const DEFAULT_INTERVAL_MINUTES = 15;

const parseIntervalMinutes = (rawValue) => {
  const parsed = Number(rawValue);
  if (!rawValue || Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_INTERVAL_MINUTES;
  }
  return parsed;
};

/**
 * Sync automático de clientes QBO -> DB local (Jefe crea clientes nuevos
 * directo en QuickBooks Online; sin esto, alguien tenía que acordarse de
 * pegarle manualmente a POST /api/qbo/customers/sync para que aparecieran
 * localmente).
 *
 * Sigue el mismo patrón de factory con inyección de dependencias que
 * `qboCustomerService` (ver `createQboCustomerService`), acá extendido para
 * inyectar también `setIntervalFn`/`clearIntervalFn` -- el proyecto no tiene
 * sinon/proxyquire (ver comentarios en test/qboClient.test.js), así que los
 * tests inyectan implementaciones fake de esos dos en vez de mockear los
 * globals de Node o esperar minutos reales.
 */
const createQboCustomerSyncScheduler = ({
  qboCustomerService = defaultQboCustomerService,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) => {
  let intervalHandle = null;

  // Corre una vez el sync y absorbe cualquier error -- este callback vive
  // dentro de un setInterval de larga vida, una excepción sin atrapar acá
  // tumbaría el proceso entero (o, en Node moderno, mataría el timer).
  const runSync = async () => {
    try {
      const result = await qboCustomerService.syncCustomers({ dryRun: false, includeInactive: true });
      console.log(
        `[qboCustomerSyncScheduler] Sync automático completado: matched=${result.matched.length}, ` +
          `wouldUpdate=${result.wouldUpdate}, wouldCreate/created=${result.wouldCreate}, ` +
          `ambiguous=${result.ambiguous.length}, yaCreado=${result.yaCreado}`
      );
    } catch (error) {
      if (error.message && error.message.includes('QBO_SYNC_APPLY_ENABLED')) {
        // Gate de seguridad ya existente dentro de syncCustomers -- el sync
        // automático está configurado pero no puede escribir. Warn en cada
        // tick mientras el flag siga apagado (no hace falta lógica de
        // "solo la primera vez").
        console.warn(
          '[qboCustomerSyncScheduler] Sync automático de clientes configurado (QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED=true) ' +
            'pero QBO_SYNC_APPLY_ENABLED no está en "true" -- no se puede escribir en la DB local. ' +
            'Seteá QBO_SYNC_APPLY_ENABLED=true para que el sync automático tenga efecto.'
        );
        return;
      }

      console.error(`[qboCustomerSyncScheduler] Error en sync automático de clientes: ${error.message}`);
    }
  };

  /**
   * Arranca el interval si QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED === 'true'.
   * Devuelve el handle del interval, o `null` si quedó deshabilitado (no
   * arranca ningún timer en ese caso).
   */
  const startCustomerSyncSchedule = () => {
    if (process.env.QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED !== 'true') {
      console.log(
        'QBO: Sync automático de clientes deshabilitado (seteá QBO_CUSTOMER_SYNC_SCHEDULE_ENABLED=true para activarlo)'
      );
      return null;
    }

    const intervalMinutes = parseIntervalMinutes(process.env.QBO_CUSTOMER_SYNC_INTERVAL_MINUTES);
    const intervalMs = intervalMinutes * 60 * 1000;

    intervalHandle = setIntervalFn(() => {
      runSync();
    }, intervalMs);

    console.log(`QBO: Sync automático de clientes iniciado (cada ${intervalMinutes} min)`);
    return intervalHandle;
  };

  // Detiene el interval activo, si hay uno. Pensado para tests (evitar
  // timers colgados) y para uso futuro si hiciera falta apagarlo en caliente.
  const stopCustomerSyncSchedule = () => {
    if (intervalHandle !== null) {
      clearIntervalFn(intervalHandle);
      intervalHandle = null;
    }
  };

  return { startCustomerSyncSchedule, stopCustomerSyncSchedule, runSync };
};

const defaultScheduler = createQboCustomerSyncScheduler();

module.exports = {
  ...defaultScheduler,
  createQboCustomerSyncScheduler
};
