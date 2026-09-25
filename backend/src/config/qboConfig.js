// Configuración de facturación QBO derivada de variables de entorno.
//
// Reemplaza los valores hardcodeados de precio ("0.48") y tax code ("7") que
// existían en qboInvoiceService.js. La tabla `sbmqb_services` está vacía --
// en la práctica el "servicio" real de un cliente vive como texto libre en
// `sbmqb_customers.sbmqb_service` (ej. "...Electricity T. @ 0.48/KW" o
// "...Metered elect. @ 0.415/KW"), por eso el mapeo es servicio -> { itemId,
// unitPrice } vía QBO_SERVICE_MAP_JSON en vez de una tabla relacional.
//
// NOTA (dependencias): el proyecto no tiene `zod` instalado (ver
// package.json). Por política de dependencias de RVSolutions no se instala
// ningún paquete sin aprobación explícita del Jefe, así que la validación
// se implementa a mano acá. Si se aprueba agregar zod a futuro, este archivo
// es el único punto a migrar (la función buildConfig ya centraliza toda la
// validación).
//
// Fail-closed: si falta configuración esencial (mapa de servicios, tax code
// o sales term), el servicio de facturación QBO queda deshabilitado
// (isEnabled = false) pero el resto de la app sigue funcionando normal. Se
// loguea claramente qué falta, sin tirar el proceso.

const DEFAULT_MAX_BATCH = 1;

const isNonEmptyString = value => typeof value === 'string' && value.trim() !== '';

const parseServiceMap = (raw) => {
  const errors = [];

  if (!isNonEmptyString(raw)) {
    errors.push('QBO_SERVICE_MAP_JSON no está definida');
    return { map: null, errors };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    errors.push(`QBO_SERVICE_MAP_JSON no es JSON válido: ${e.message}`);
    return { map: null, errors };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push('QBO_SERVICE_MAP_JSON debe ser un objeto { "servicio": { itemId, unitPrice } }');
    return { map: null, errors };
  }

  const serviceKeys = Object.keys(parsed);
  if (serviceKeys.length === 0) {
    errors.push('QBO_SERVICE_MAP_JSON está vacío, debe tener al menos un servicio mapeado');
    return { map: null, errors };
  }

  const map = {};
  for (const key of serviceKeys) {
    const entry = parsed[key];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`QBO_SERVICE_MAP_JSON["${key}"] debe ser un objeto { itemId, unitPrice }`);
      continue;
    }
    const { itemId, unitPrice } = entry;
    if (!isNonEmptyString(itemId)) {
      errors.push(`QBO_SERVICE_MAP_JSON["${key}"].itemId debe ser un string no vacío (placeholder permitido, ej. "PENDING_ITEM_ID_..." hasta tener el Item real de QBO)`);
      continue;
    }
    if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      errors.push(`QBO_SERVICE_MAP_JSON["${key}"].unitPrice debe ser un número positivo`);
      continue;
    }
    map[key] = { itemId, unitPrice };
  }

  if (errors.length > 0) {
    return { map: null, errors };
  }

  return { map, errors: [] };
};

const parseMaxBatch = (raw) => {
  if (raw === undefined || raw === null || raw === '') {
    return { value: DEFAULT_MAX_BATCH, warning: null };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      value: DEFAULT_MAX_BATCH,
      warning: `QBO_PROCESS_MAX_BATCH="${raw}" inválido (debe ser entero positivo), usando default ${DEFAULT_MAX_BATCH}`
    };
  }
  return { value: parsed, warning: null };
};

const buildConfig = (env = process.env) => {
  const errors = [];
  const warnings = [];

  const { map: serviceMap, errors: serviceMapErrors } = parseServiceMap(env.QBO_SERVICE_MAP_JSON);
  errors.push(...serviceMapErrors);

  const taxCodeId = isNonEmptyString(env.QBO_TAX_CODE_ID) ? env.QBO_TAX_CODE_ID : null;
  if (!taxCodeId) {
    errors.push('QBO_TAX_CODE_ID no está definida');
  }

  const salesTermId = isNonEmptyString(env.QBO_SALES_TERM_ID) ? env.QBO_SALES_TERM_ID : null;
  if (!salesTermId) {
    errors.push('QBO_SALES_TERM_ID no está definida');
  }

  const classId = isNonEmptyString(env.QBO_CLASS_ID) ? env.QBO_CLASS_ID : null;

  const { value: maxBatch, warning: maxBatchWarning } = parseMaxBatch(env.QBO_PROCESS_MAX_BATCH);
  if (maxBatchWarning) warnings.push(maxBatchWarning);

  const isEnabled = errors.length === 0;

  if (!isEnabled) {
    // eslint-disable-next-line no-console
    console.error(
      '[qboConfig] Servicio de facturación QBO DESHABILITADO por configuración incompleta (fail-closed):\n' +
      errors.map(e => `  - ${e}`).join('\n')
    );
  }
  warnings.forEach(w => console.warn(`[qboConfig] ${w}`)); // eslint-disable-line no-console

  return {
    isEnabled,
    errors,
    serviceMap: serviceMap || {},
    taxCodeId,
    salesTermId,
    classId,
    maxBatch
  };
};

// Se computa al cargar el módulo (primer require, efectivamente "al arrancar"
// la app ya que qboInvoiceService.js -> qboConfig.js se requiere al montar
// las rutas de QBO). No lanza: solo deja isEnabled=false y logea.
let cachedConfig = buildConfig();

const getConfig = () => cachedConfig;

// Solo para uso en tests / recarga explícita: recalcula a partir del
// process.env actual.
const reloadConfig = () => {
  cachedConfig = buildConfig();
  return cachedConfig;
};

const getServiceConfig = (sbmqbService) => {
  const config = getConfig();
  if (!config.isEnabled) {
    throw new Error(
      `Facturación QBO deshabilitada por configuración incompleta: ${config.errors.join('; ')}`
    );
  }
  const serviceConfig = config.serviceMap[sbmqbService];
  if (!serviceConfig) {
    throw new Error(
      `No hay mapeo de precio/item configurado para el servicio "${sbmqbService}" en QBO_SERVICE_MAP_JSON`
    );
  }
  return serviceConfig;
};

module.exports = {
  getConfig,
  reloadConfig,
  getServiceConfig,
  __testables: {
    buildConfig,
    parseServiceMap,
    parseMaxBatch
  }
};
