const qboClient = require('./qboClient');
const qboCustomerService = require('./qboCustomerService');
const qboConfig = require('../config/qboConfig');
const database = require('../database');

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const getQBOItems = async () => {
  const response = await qboClient.makeApiCall('/query?query=SELECT * FROM Item WHERE Active = true');
  return response.QueryResponse?.Item || [];
};

const getQBOInvoices = async (maxResults = 100) => {
  const response = await qboClient.makeApiCall(
    `/query?query=SELECT * FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS ${maxResults}`
  );
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
  __testables: {
    buildDescription,
    buildInvoiceBody,
    buildRequestId,
    previewInvoice
  }
};
