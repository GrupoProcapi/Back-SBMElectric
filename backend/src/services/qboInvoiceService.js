const qboClient = require('./qboClient');
const qboCustomerService = require('./qboCustomerService');
const qboConfig = require('../config/qboConfig');
const database = require('../database');

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// --- getQBOItems: paginación + filtro opcional por nombre -----------------
// Antes traía solo la primera tanda de resultados (default de QBO sin
// STARTPOSITION/MAXRESULTS, ~100 registros). El catálogo real tiene cientos
// de items, así que items como "Electricidad" podían quedar fuera de esa
// primera página. Mismo patrón de paginación que getQBOCustomers() en
// qboCustomerService.js (STARTPOSITION/MAXRESULTS 1000 en loop).
const ITEM_PAGE_SIZE = 1000;
// Safety guard contra un loop descontrolado si QBO devolviera siempre una
// página llena. El catálogo real es de a lo sumo unos cientos de items; 200
// páginas (200,000 items) es un techo muy por encima de cualquier volumen
// realista, igual que el guard equivalente en qboCustomerService.js.
const ITEM_MAX_PAGES = 200;

// Solo letras, números, espacios y guiones. Esto es lo que evita que alguien
// inyecte sintaxis de query de QBO (ej. cerrar el literal del LIKE con un
// `'` y agregar cláusulas propias) a través del query param `?search=`.
const ITEM_SEARCH_ALLOWED_CHARS = /^[A-Za-z0-9 -]+$/;

class InvalidItemSearchError extends Error {
  constructor(message = 'Parámetro "search" inválido: solo se permiten letras, números, espacios y guiones.') {
    super(message);
    this.name = 'InvalidItemSearchError';
  }
}

// Pura: valida y normaliza `search`. undefined/null/'' (tras trim) => sin
// filtro (undefined). Lanza InvalidItemSearchError ante cualquier caracter
// fuera de la whitelist -- nunca deja pasar el string crudo sin validar.
const sanitizeItemSearch = (search) => {
  if (search === undefined || search === null) {
    return undefined;
  }

  if (typeof search !== 'string') {
    throw new InvalidItemSearchError();
  }

  const trimmed = search.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (!ITEM_SEARCH_ALLOWED_CHARS.test(trimmed)) {
    throw new InvalidItemSearchError();
  }

  return trimmed;
};

// Pura: arma la query de QBO para una página dada. `search` DEBE venir ya
// sanitizado (ver sanitizeItemSearch) -- este builder no vuelve a validar,
// asume que el caller ya falló rápido ante un input inválido.
const buildItemsQuery = (sanitizedSearch, { startPosition, maxResults }) => {
  let query = 'SELECT * FROM Item WHERE Active = true';

  if (sanitizedSearch) {
    query += ` AND Name LIKE '%${sanitizedSearch}%'`;
  }

  return `${query} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
};

const getQBOItems = async ({ search, client = qboClient } = {}) => {
  // Falla rápido ante un `search` inválido, antes de tocar la red.
  const sanitizedSearch = sanitizeItemSearch(search);

  const items = [];
  let startPosition = 1;
  let pageLength = 0;
  let pageCount = 0;

  do {
    if (pageCount >= ITEM_MAX_PAGES) {
      throw new Error(
        `QBO item pagination exceeded the safety limit of ${ITEM_MAX_PAGES} pages ` +
          `(${ITEM_MAX_PAGES * ITEM_PAGE_SIZE} records). Aborting instead of looping indefinitely.`
      );
    }

    const query = buildItemsQuery(sanitizedSearch, { startPosition, maxResults: ITEM_PAGE_SIZE });
    // encodeURIComponent es OBLIGATORIO acá: `query` es un string con espacios,
    // comillas simples y, cuando hay `search`, el wildcard `%` de LIKE. El
    // WHATWG URL parser (usado por axios dentro de intuit-oauth) SÍ encodea
    // espacios/comillas automáticamente, pero NUNCA toca un `%` crudo -- lo
    // deja tal cual porque podría ser ya una secuencia percent-encoded válida.
    // Eso mandaba un `%` literal (no `%25`) a QBO, que rompía su parser de
    // queries con un error genérico de "fallo del sistema" (500) apenas se
    // usaba `search` (LIKE). Sin `search` no había `%` en la query, por eso
    // ese camino nunca mostró el bug.
    const response = await client.makeApiCall(`/query?query=${encodeURIComponent(query)}`);
    const page = response.QueryResponse?.Item || [];

    items.push(...page);
    pageLength = page.length;
    startPosition += ITEM_PAGE_SIZE;
    pageCount += 1;
  } while (pageLength === ITEM_PAGE_SIZE);

  return items;
};

const getQBOInvoices = async (maxResults = 100) => {
  // Mismo motivo que en getQBOItems: encodeURIComponent sobre la query completa
  // antes de mandarla como querystring (ver comentario ahí para el detalle del
  // bug de `%` crudo).
  const query = `SELECT * FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS ${maxResults}`;
  const response = await qboClient.makeApiCall(`/query?query=${encodeURIComponent(query)}`);
  return response.QueryResponse?.Invoice || [];
};

// --- Builders puros (sin red/DB) --------------------------------------
// Extraídos para poder testearlos sin sinon/proxyquire (no instalados en
// el proyecto) y para que createInvoice() y el dryRun de
// processPendingInvoices() compartan exactamente la misma lógica.

const buildDescription = (invoiceData) => {
  const servicioExtraido = invoiceData.sbmqb_service
    ? invoiceData.sbmqb_service.match(/(\d+-)(.*)/)?.[2] || 'Electricity'
    : 'Electricity';

  const beginDate = new Date(invoiceData.begin_date);
  const endDate = new Date(invoiceData.end_date);

  return `${servicioExtraido}
DOCK    ${invoiceData.measurer_code}
INITIAL ${invoiceData.initial_measure_value}
FINAL   ${invoiceData.current_measure_value}
USED    ${invoiceData.total_measure_value} KWTS
${MONTH_NAMES[beginDate.getUTCMonth()]} ${beginDate.getUTCDate()} TO ${MONTH_NAMES[endDate.getUTCMonth()]} ${endDate.getUTCDate()}`;
};

const buildRequestId = (invoiceData) => `sbm-inv-${invoiceData.id}`;

// customer/serviceConfig/config ya resueltos por el caller -- esta función
// no hace I/O, solo arma el payload que se manda a QBO.
const buildInvoiceBody = (invoiceData, { customer, serviceConfig, config }) => {
  const description = buildDescription(invoiceData);
  const qty = invoiceData.total_measure_value;
  const amount = qty * serviceConfig.unitPrice;

  const invoiceBody = {
    Line: [{
      DetailType: 'SalesItemLineDetail',
      Amount: amount,
      Description: description,
      SalesItemLineDetail: {
        ItemRef: {
          value: serviceConfig.itemId
        },
        TaxCodeRef: {
          value: config.taxCodeId
        },
        Qty: qty,
        UnitPrice: serviceConfig.unitPrice
      }
    }],
    CustomerRef: {
      value: customer.qbo_id,
      name: customer.full_name || customer.name
    },
    // No se envía DocNumber: se deja que QBO lo autogenere.
    PrivateNote: `SBM-INV-${invoiceData.id}`
  };

  if (config.salesTermId) {
    invoiceBody.SalesTermRef = { value: config.salesTermId };
  }

  if (config.classId) {
    invoiceBody.ClassRef = { value: config.classId };
  }

  return invoiceBody;
};

// Preview 100% en memoria (sin red, sin DB) para el modo dryRun de
// processPendingInvoices(). No resuelve el customer en QBO a propósito
// (eso sí requiere red) -- solo muestra qué línea/monto/refs se armarían.
const previewInvoice = (invoiceData) => {
  if (!invoiceData || !invoiceData.id) {
    throw new Error('previewInvoice requiere invoiceData.id (factura local) para garantizar PrivateNote/requestid determinísticos');
  }

  if (invoiceData.sbmqb_invoice_id) {
    return {
      skipped: true,
      reason: 'La factura local ya tiene sbmqb_invoice_id asignado, no se crearía de nuevo en QBO',
      sbmqb_invoice_id: invoiceData.sbmqb_invoice_id
    };
  }

  const serviceConfig = qboConfig.getServiceConfig(invoiceData.sbmqb_service);
  const config = qboConfig.getConfig();

  const qty = invoiceData.total_measure_value;
  const amount = qty * serviceConfig.unitPrice;

  return {
    skipped: false,
    requestId: buildRequestId(invoiceData),
    privateNote: `SBM-INV-${invoiceData.id}`,
    itemId: serviceConfig.itemId,
    unitPrice: serviceConfig.unitPrice,
    qty,
    amount,
    taxCodeId: config.taxCodeId,
    salesTermId: config.salesTermId || null,
    classId: config.classId || null,
    description: buildDescription(invoiceData)
  };
};

// --- Orquestación (red + DB) --------------------------------------------

const createInvoice = async (invoiceData) => {
  if (!invoiceData || !invoiceData.id) {
    throw new Error('createInvoice requiere invoiceData.id (factura local) para garantizar PrivateNote/requestid determinísticos');
  }

  // Idempotencia a nivel local: si ya tiene qbo_invoice_id guardado, no se
  // vuelve a crear en QBO.
  if (invoiceData.sbmqb_invoice_id) {
    return {
      skipped: true,
      reason: 'La factura local ya tiene sbmqb_invoice_id asignado, no se vuelve a crear en QBO',
      sbmqb_invoice_id: invoiceData.sbmqb_invoice_id
    };
  }

  // Falla rápido y explícito si no hay mapeo de servicio/config, antes de
  // gastar una llamada de red a QBO para resolver el customer.
  const serviceConfig = qboConfig.getServiceConfig(invoiceData.sbmqb_service);
  const config = qboConfig.getConfig();

  const customer = await qboCustomerService.findCustomerByName(invoiceData.sbmqb_customer_name);
  if (!customer || !customer.qbo_id) {
    throw new Error(`Cliente no encontrado en QBO: ${invoiceData.sbmqb_customer_name}. Ejecuta primero /api/qbo/customers/sync`);
  }

  const invoiceBody = buildInvoiceBody(invoiceData, { customer, serviceConfig, config });
  const requestId = buildRequestId(invoiceData);

  // requestid determinístico (sbm-inv-{id}): si Intuit recibe el mismo
  // requestid dos veces, no duplica la factura.
  const response = await qboClient.makeApiCall(`/invoice?requestid=${requestId}`, 'POST', invoiceBody);

  if (!response.Invoice) {
    throw new Error('Error creando factura en QBO: ' + JSON.stringify(response));
  }

  await database('sbmqb_invoices')
    .where('id', invoiceData.id)
    .update({
      status: 'FACTURADO',
      sbmqb_invoice_id: response.Invoice.DocNumber || response.Invoice.Id
    });

  await database('measurements')
    .where('sbmqb_invoices_id', invoiceData.id)
    .update({ status: 'FACTURADO' });

  return response.Invoice;
};

// Contrato: SIEMPRE requiere invoiceIds explícito (nunca "todas las
// PENDIENTE"). dryRun=true por default: calcula sin tocar red ni escribir.
const processPendingInvoices = async ({ invoiceIds, dryRun = true } = {}) => {
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    throw new Error('processPendingInvoices requiere invoiceIds: un array explícito y no vacío de IDs a procesar (no se permite procesar todas las PENDIENTE sin especificar cuáles)');
  }

  const config = qboConfig.getConfig();
  if (invoiceIds.length > config.maxBatch) {
    throw new Error(`processPendingInvoices: se recibieron ${invoiceIds.length} invoiceIds, supera el tope QBO_PROCESS_MAX_BATCH=${config.maxBatch}`);
  }

  const invoices = await database('sbmqb_invoices')
    .whereIn('id', invoiceIds)
    .andWhere('status', 'PENDIENTE');

  if (invoices.length === 0) {
    return { dryRun, processed: 0, successful: 0, failed: 0, results: [] };
  }

  const results = [];

  for (const invoice of invoices) {
    if (dryRun) {
      try {
        results.push({ id: invoice.id, ...previewInvoice(invoice) });
      } catch (error) {
        results.push({ id: invoice.id, error: error.message });
      }
      continue;
    }

    try {
      const createdInvoice = await createInvoice(invoice);
      if (createdInvoice && createdInvoice.skipped) {
        results.push({ id: invoice.id, success: true, skipped: true, reason: createdInvoice.reason });
      } else {
        results.push({
          id: invoice.id,
          success: true,
          qboId: createdInvoice.Id,
          docNumber: createdInvoice.DocNumber
        });
      }
    } catch (error) {
      console.error(`Error procesando factura ${invoice.id}:`, error.message);
      results.push({ id: invoice.id, success: false, error: error.message });
    }
  }

  const failed = results.filter(r => r.success === false || r.error !== undefined).length;
  const successful = results.length - failed;

  return {
    dryRun,
    processed: invoices.length,
    successful,
    failed,
    results
  };
};

module.exports = {
  getQBOItems,
  getQBOInvoices,
  createInvoice,
  processPendingInvoices,
  InvalidItemSearchError,
  __testables: {
    buildDescription,
    buildInvoiceBody,
    buildRequestId,
    previewInvoice,
    sanitizeItemSearch,
    buildItemsQuery,
    ITEM_PAGE_SIZE,
    ITEM_MAX_PAGES
  }
};
