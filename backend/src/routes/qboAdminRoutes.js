/**
 * Admin QuickBooks Online endpoints. Mounted in server.js AFTER apiKeyValidator,
 * so every route here requires the internal api-key header.
 *
 * SECOND LAYER: on top of that generic api-key, every route in this router also
 * requires `x-qbo-admin-key` (validated by qboAdminAuth, see below). These
 * endpoints handle personal data for 7,566+ customers and can create real
 * invoices in QuickBooks Online, so they need a secret stronger than API_KEY
 * (which is embedded in the frontend bundle and readable by anyone).
 */
const express = require('express');
const router = express.Router();

const database = require('../database');
const qboCustomerService = require('../services/qboCustomerService');
const qboInvoiceService = require('../services/qboInvoiceService');
const qboAdminAuth = require('../middleware/qboAdminAuth');

router.use(qboAdminAuth);

const MAX_INVOICE_IDS = 20;

// --- Lightweight input validation -------------------------------------------------
// Zod is not a dependency of this project yet (see report to Jefe). express-validator
// IS already a dependency and used elsewhere in the app, but its string-oriented
// validators (isBoolean/isInt) don't map cleanly onto JSON-typed booleans/number
// arrays coming from body-parser. Plain manual guards keep the contract explicit
// and avoid coercion surprises (e.g. accepting "false" as truthy).

/**
 * @param {unknown} value
 * @returns {boolean|null} parsed boolean (default true when absent), or null if invalid
 */
const parseDryRun = (value) => {
  if (value === undefined || value === null) return true; // safe default: preview only
  if (typeof value !== 'boolean') return null;
  return value;
};

/**
 * @param {unknown} value
 * @returns {number[]|null} validated array of 1-20 positive integers, or null if invalid
 */
const parseInvoiceIds = (value) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INVOICE_IDS) {
    return null;
  }
  const ids = [];
  for (const item of value) {
    if (!Number.isInteger(item) || item <= 0) {
      return null;
    }
    ids.push(item);
  }
  return ids;
};

// --- Status -------------------------------------------------------------------------

// GET /api/qbo/status — connection status only, NEVER the token values themselves.
router.get('/status', async (req, res) => {
  try {
    const tokenRow = await database('qbo_tokens')
      .select('realm_id', 'token_expiry', 'refresh_token_expiry')
      .orderBy('updated_at', 'desc')
      .first();

    if (!tokenRow) {
      return res.json({ connected: false, realmId: null, tokenExpiry: null, refreshTokenExpiry: null });
    }

    res.json({
      connected: true,
      realmId: tokenRow.realm_id,
      tokenExpiry: tokenRow.token_expiry,
      refreshTokenExpiry: tokenRow.refresh_token_expiry
    });
  } catch (error) {
    console.error('Error obteniendo estado de QBO:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- Customers ------------------------------------------------------------------------

router.post('/customers/sync', async (req, res) => {
  const dryRun = parseDryRun(req.body ? req.body.dryRun : undefined);
  if (dryRun === null) {
    return res.status(400).json({ error: 'dryRun debe ser un valor booleano (true/false)' });
  }

  try {
    // qboCustomerService.syncCustomers() already defaults to dryRun=true, does its own
    // COUNT-vs-pagination integrity check, and gates real writes behind
    // QBO_SYNC_APPLY_ENABLED — we just forward the validated flag through.
    const result = await qboCustomerService.syncCustomers({ dryRun });
    res.json({
      message: dryRun
        ? 'Vista previa (dryRun=true): no se realizó ningún cambio'
        : 'Clientes sincronizados exitosamente',
      dryRun,
      ...result
    });
  } catch (error) {
    console.error('Error sincronizando clientes QBO:', error.message);
    res.status(400).json({ error: error.message });
  }
});

router.get('/customers', async (req, res) => {
  try {
    const customers = await qboCustomerService.getQBOCustomers();
    res.json({ message: customers });
  } catch (error) {
    console.error('Error obteniendo clientes QBO:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- Invoices ---------------------------------------------------------------------------

router.post('/invoices/process', async (req, res) => {
  const dryRun = parseDryRun(req.body ? req.body.dryRun : undefined);
  if (dryRun === null) {
    return res.status(400).json({ error: 'dryRun debe ser un valor booleano (true/false)' });
  }

  const invoiceIds = parseInvoiceIds(req.body ? req.body.invoiceIds : undefined);
  if (!invoiceIds) {
    return res.status(400).json({
      error: `invoiceIds es requerido: debe ser un arreglo de 1 a ${MAX_INVOICE_IDS} enteros positivos`
    });
  }

  try {
    // qboInvoiceService.processPendingInvoices() ya tiene el contrato completo:
    // exige invoiceIds explícito (nunca "todas las PENDIENTE"), respeta el tope
    // QBO_PROCESS_MAX_BATCH y por defecto corre en dryRun. Acá solo reenviamos
    // los valores ya validados arriba y traducimos su resultado al formato de
    // respuesta HTTP que este endpoint ya venía usando.
    const result = await qboInvoiceService.processPendingInvoices({ invoiceIds, dryRun });

    // ids pedidos que el servicio no incluyó en `results` (no estaban en estado
    // PENDIENTE en `sbmqb_invoices`).
    const processedIds = result.results.map((item) => item.id);
    const skipped = invoiceIds.filter((id) => !processedIds.includes(id));

    if (dryRun) {
      return res.json({
        message: 'Vista previa (dryRun=true): no se envió nada a QuickBooks Online',
        dryRun: true,
        wouldProcess: result.results,
        skipped
      });
    }

    res.json({
      message: 'Facturas procesadas',
      dryRun: false,
      processed: result.processed,
      skipped,
      results: result.results
    });
  } catch (error) {
    console.error('Error procesando facturas QBO:', error.message);
    // Tras la validación de forma de arriba (1-20 enteros positivos), el único
    // error de negocio que processPendingInvoices puede lanzar acá es superar
    // el tope QBO_PROCESS_MAX_BATCH (configurable, puede ser menor a 20) — eso
    // es un error de input del caller, no una falla del servidor.
    const isBatchLimitError = /QBO_PROCESS_MAX_BATCH/.test(error.message);
    res.status(isBatchLimitError ? 400 : 500).json({ error: error.message });
  }
});

// NOTE: POST /invoices/create was removed (BUG ALTO de code review). Aceptaba
// el body del cliente tal cual (id, sbmqb_invoice_id, total_measure_value,
// sbmqb_customer_name) y llamaba a qboInvoiceService.createInvoice(req.body)
// directo, sin cargar la fila real desde `sbmqb_invoices` -- eso permitía
// facturas con montos/clientes inventados y dejaba evadir la idempotencia
// (bastaba con omitir sbmqb_invoice_id en el request). POST /invoices/process
// con { invoiceIds, dryRun } cubre el mismo caso de uso y sí carga los datos
// reales desde la DB vía qboInvoiceService.processPendingInvoices() -- se
// eligió eliminar el endpoint en vez de repararlo porque ya era 100%
// redundante una vez agregado ese validado.

router.get('/items', async (req, res) => {
  try {
    const items = await qboInvoiceService.getQBOItems();
    res.json({ message: items });
  } catch (error) {
    console.error('Error obteniendo items QBO:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/invoices', async (req, res) => {
  try {
    const invoices = await qboInvoiceService.getQBOInvoices();
    res.json({ message: invoices });
  } catch (error) {
    console.error('Error obteniendo facturas QBO:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
