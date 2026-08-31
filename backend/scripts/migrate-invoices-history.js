#!/usr/bin/env node
/**
 * Migración histórica: sbmqb_invoices_read -> sbmqb_invoices + baseline de measurements
 *
 * Alcance: SOLO líneas de electricidad (item_ref de 4113 · INGRESOS ELECTRIDIDAD, dos variantes)
 * cuyo line_desc matchea el patrón DOCK/INITIAL/FINAL/USED. Excluye agua e item_ref NULL.
 *
 * Uso:
 *   node scripts/migrate-invoices-history.js --dry-run   (default, no escribe nada)
 *   node scripts/migrate-invoices-history.js --execute   (inserta de verdad, en transacción, batches de 500)
 *
 * Reusa la conexión Knex existente del proyecto (src/database.js -> src/config.js).
 */

const knex = require('../src/database');

const BATCH_SIZE = 500;
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const STALE_BASELINE_DAYS = 60;

// Los dos únicos item_ref de electricidad confirmados contra la DB real.
// El agua ("...15001-Metered water @ 0.10/gal") queda fuera de alcance a propósito.
const ELECTRICITY_ITEM_REFS = [
  '4113 · INGRESOS ELECTRIDIDAD:70000:70004-Electricity T. @ 0.48/KW',
  '4113 · INGRESOS ELECTRIDIDAD:70000:70001-Metered elect. @ 0.415/KW',
];

const HARD_INACTIVE_STATUSES = new Set(['SUSPENDED', 'TERMINATED']);

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const execute = argv.includes('--execute');
  const dryRun = !execute; // default seguro: dry-run salvo --execute explícito
  return { execute, dryRun };
}

// ---------------------------------------------------------------------------
// Parsing de line_desc
// ---------------------------------------------------------------------------

const DOCK_RE = /^DOCK\s+(\S+)/i;
const INITIAL_RE = /^INITIAL\s+([\d,]+\.?\d*)/i;
const FINAL_RE = /^FINAL\s+([\d,]+\.?\d*)/i;
const USED_RE = /^USED\s+([\d,]+\.?\d*)/i;
const PERIOD_RE = /([A-Z]{3})\s+(\d{1,2})\s+TO\s+([A-Z]{3})\s+(\d{1,2})/i;

function parseNumber(str) {
  return parseFloat(str.replace(/,/g, ''));
}

/**
 * Parsea el bloque line_desc en sus componentes crudos.
 * Soporta tanto saltos de línea reales como "\n" literal (dos caracteres) en el dump.
 */
function parseLineDesc(rawLineDesc) {
  if (!rawLineDesc) return null;

  const normalized = rawLineDesc.replace(/\\n/g, '\n');
  const lines = normalized.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const result = {
    pedestalIdGuess: null,
    initialValue: null,
    finalValue: null,
    usedValue: null,
    periodText: null,
    beginMonth: null,
    beginDay: null,
    endMonth: null,
    endDay: null,
  };

  for (const line of lines) {
    let m;
    if ((m = line.match(DOCK_RE))) {
      result.pedestalIdGuess = m[1];
      continue;
    }
    if ((m = line.match(INITIAL_RE))) {
      result.initialValue = parseNumber(m[1]);
      continue;
    }
    if ((m = line.match(FINAL_RE))) {
      result.finalValue = parseNumber(m[1]);
      continue;
    }
    if ((m = line.match(USED_RE))) {
      result.usedValue = parseNumber(m[1]);
      continue;
    }
    if ((m = line.match(PERIOD_RE))) {
      result.periodText = `${m[1].toUpperCase()} ${m[2]} TO ${m[3].toUpperCase()} ${m[4]}`;
      result.beginMonth = MONTHS[m[1].toUpperCase()];
      result.beginDay = parseInt(m[2], 10);
      result.endMonth = MONTHS[m[3].toUpperCase()];
      result.endDay = parseInt(m[4], 10);
      continue;
    }
  }

  const hasAllFields =
    result.pedestalIdGuess &&
    Number.isFinite(result.initialValue) &&
    Number.isFinite(result.finalValue) &&
    Number.isFinite(result.usedValue) &&
    result.initialValue >= 0 &&
    result.finalValue >= 0 &&
    result.finalValue >= result.initialValue &&
    result.finalValue < 1_000_000 &&
    result.periodText !== null;

  return hasAllFields ? result : null;
}

/**
 * Resuelve begin_date/end_date probando el año de txn_date como ancla,
 * luego año-1 y año+1. Valida que la duración del período esté entre 25-35 días
 * y elige el candidato más cercano a txn_date. Si ninguno pasa la validación,
 * devuelve null (la fila queda para revisión manual, no se adivina).
 */
function resolveDates(beginMonth, beginDay, endMonth, endDay, txnDate) {
  if (beginMonth === undefined || endMonth === undefined || !txnDate) return null;

  const txnYear = txnDate.getUTCFullYear();
  const candidateEndYears = [txnYear, txnYear - 1, txnYear + 1];

  let best = null;

  for (const endYear of candidateEndYears) {
    // Si el mes de inicio es numéricamente mayor al de fin, el período cruza año nuevo.
    const beginYear = beginMonth > endMonth ? endYear - 1 : endYear;

    const begin = new Date(Date.UTC(beginYear, beginMonth, beginDay));
    const end = new Date(Date.UTC(endYear, endMonth, endDay));
    const diffDays = (end - begin) / MS_PER_DAY;

    if (diffDays < 25 || diffDays > 35) continue;

    const distanceToTxn = Math.abs((txnDate - end) / MS_PER_DAY);

    if (!best || distanceToTxn < best.distanceToTxn) {
      best = { begin, end, diffDays, distanceToTxn };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Introspección de schema real (MySQL ALTER TABLE MODIFY puede resetear
// silenciosamente un NOT NULL si el alter no lo re-declara explícitamente —
// no confiamos ciegamente en el archivo de migración, verificamos en vivo).
// ---------------------------------------------------------------------------

async function getColumnNullability(trxOrKnex, tableName, columnName) {
  const dbNameRow = await trxOrKnex.raw('SELECT DATABASE() AS db');
  const dbName = dbNameRow[0][0].db;

  const rows = await trxOrKnex.raw(
    `SELECT IS_NULLABLE FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
    [dbName, tableName, columnName]
  );

  const row = rows[0][0];
  if (!row) return null; // columna no encontrada, tratar con cautela aguas arriba
  return row.IS_NULLABLE === 'YES';
}

// ---------------------------------------------------------------------------
// Carga de datos de referencia
// ---------------------------------------------------------------------------

async function loadMeasurersByPedestalId(db) {
  const rows = await db('measurers').select('id', 'pedestal_id', 'measurer_code');
  const map = new Map();
  for (const row of rows) {
    map.set(row.pedestal_id, row);
  }
  return map;
}

function normalizeName(name) {
  if (!name) return '';
  return name.trim().toUpperCase().replace(/\s+/g, ' ');
}

async function loadCustomerIndex(db) {
  const rows = await db('sbmqb_customers').select('name', 'full_name', 'company_name', 'status');
  const byName = new Map();
  const byFullName = new Map();
  for (const row of rows) {
    const nameKey = normalizeName(row.name);
    const fullNameKey = normalizeName(row.full_name);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, row);
    if (fullNameKey && !byFullName.has(fullNameKey)) byFullName.set(fullNameKey, row);
  }
  return { byName, byFullName };
}

function matchCustomer(customerIndex, customerName) {
  const key = normalizeName(customerName);
  if (!key) return { status: 'NOT_FOUND', matchedField: null };

  const byFullName = customerIndex.byFullName.get(key);
  if (byFullName) return { status: byFullName.status || 'UNKNOWN', matchedField: 'full_name' };

  const byName = customerIndex.byName.get(key);
  if (byName) return { status: byName.status || 'UNKNOWN', matchedField: 'name' };

  return { status: 'NOT_FOUND', matchedField: null };
}

async function findRvargasUserId(db) {
  const row = await db('users')
    .whereRaw('LOWER(username) LIKE ?', ['%rvargas%'])
    .select('id', 'username')
    .first();
  return row || null;
}

// ---------------------------------------------------------------------------
// Paso 1: cargar y parsear filas candidatas de sbmqb_invoices_read
// ---------------------------------------------------------------------------

async function loadCandidateRows(db) {
  return db('sbmqb_invoices_read')
    .whereIn('item_ref', ELECTRICITY_ITEM_REFS)
    .andWhere('line_desc', 'like', '%DOCK%')
    .andWhere('line_desc', 'like', '%INITIAL%')
    .andWhere('line_desc', 'like', '%FINAL%')
    .andWhere('line_desc', 'like', '%USED%')
    .select(
      'id',
      'sbmqb_ref_number',
      'sbmqb_txn_line_id',
      'sbmqb_customer_ref',
      'txn_date',
      'item_ref',
      'line_desc'
    );
}

/**
 * Procesa todas las filas candidatas: parsea, resuelve measurer y fechas,
 * y clasifica cada una en OK / huérfana (measurer no encontrado) / fecha inválida.
 */
function processRows(rawRows, measurersByPedestalId) {
  const ok = [];
  const orphanPedestals = new Map(); // pedestal_id_guess -> count
  const invalidDates = [];

  for (const row of rawRows) {
    const parsed = parseLineDesc(row.line_desc);

    if (!parsed) {
      invalidDates.push({
        reason: 'LINE_DESC_UNPARSEABLE',
        sbmqb_ref_number: row.sbmqb_ref_number,
        sbmqb_txn_line_id: row.sbmqb_txn_line_id,
        line_desc: row.line_desc,
      });
      continue;
    }

    const measurer = measurersByPedestalId.get(parsed.pedestalIdGuess);
    if (!measurer) {
      orphanPedestals.set(
        parsed.pedestalIdGuess,
        (orphanPedestals.get(parsed.pedestalIdGuess) || 0) + 1
      );
      continue;
    }

    const txnDate = row.txn_date ? new Date(row.txn_date) : null;
    const dates = resolveDates(parsed.beginMonth, parsed.beginDay, parsed.endMonth, parsed.endDay, txnDate);

    if (!dates) {
      invalidDates.push({
        reason: 'DATE_SANITY_CHECK_FAILED',
        sbmqb_ref_number: row.sbmqb_ref_number,
        sbmqb_txn_line_id: row.sbmqb_txn_line_id,
        periodText: parsed.periodText,
        txn_date: row.txn_date,
      });
      continue;
    }

    ok.push({
      sbmqb_invoice_id: row.sbmqb_ref_number,
      sbmqb_txn_line_id: row.sbmqb_txn_line_id,
      sbmqb_customer_name: row.sbmqb_customer_ref,
      sbmqb_service: row.item_ref,
      measurer_id: measurer.id,
      measurer_code: measurer.measurer_code,
      pedestal_id: parsed.pedestalIdGuess,
      initial_measure_value: parsed.initialValue,
      current_measure_value: parsed.finalValue,
      total_measure_value: parsed.usedValue,
      periodText: parsed.periodText,
      begin_date: dates.begin,
      end_date: dates.end,
      status: 'FACTURADO',
    });
  }

  return { ok, orphanPedestals, invalidDates };
}

// ---------------------------------------------------------------------------
// Paso 2: idempotencia contra sbmqb_invoices ya existente
// ---------------------------------------------------------------------------

function invoiceLineKey(row) {
  return `${row.sbmqb_invoice_id}|${row.measurer_code}|${row.initial_measure_value}|${row.current_measure_value}`;
}

async function loadExistingInvoiceKeys(db, okRows) {
  const refs = [...new Set(okRows.map((r) => r.sbmqb_invoice_id))];
  const existingKeys = new Set();

  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const chunk = refs.slice(i, i + BATCH_SIZE);
    const existing = await db('sbmqb_invoices')
      .whereIn('sbmqb_invoice_id', chunk)
      .select('sbmqb_invoice_id', 'measurer_code', 'initial_measure_value', 'current_measure_value');

    for (const row of existing) {
      existingKeys.add(
        `${row.sbmqb_invoice_id}|${row.measurer_code}|${Number(row.initial_measure_value)}|${Number(row.current_measure_value)}`
      );
    }
  }

  return existingKeys;
}

// ---------------------------------------------------------------------------
// Paso 3: baseline de measurements (solo pedestales con última factura
// de cliente que no esté explícitamente inactivo)
// ---------------------------------------------------------------------------

function buildBaselineCandidates(okRows) {
  const latestByPedestal = new Map();
  for (const row of okRows) {
    const current = latestByPedestal.get(row.pedestal_id);
    if (!current || row.end_date > current.end_date) {
      latestByPedestal.set(row.pedestal_id, row);
    }
  }
  return [...latestByPedestal.values()];
}

function evaluateBaselineCandidate(candidate, customerIndex, datasetMaxDate) {
  const { status, matchedField } = matchCustomer(customerIndex, candidate.sbmqb_customer_name);
  const daysSinceLastInvoice = datasetMaxDate
    ? Math.round((datasetMaxDate - candidate.end_date) / MS_PER_DAY)
    : null;

  const hardExcludeInactive = HARD_INACTIVE_STATUSES.has(status);
  const warnNotFound = status === 'NOT_FOUND';
  const warnStale = daysSinceLastInvoice !== null && daysSinceLastInvoice > STALE_BASELINE_DAYS;

  return {
    ...candidate,
    customerStatus: status,
    customerMatchedField: matchedField,
    daysSinceLastInvoice,
    hardExcludeInactive,
    warnNotFound,
    warnStale,
  };
}

async function loadExistingMeasurerIdsInMeasurements(db) {
  const rows = await db('measurements').distinct('measurer_id');
  return new Set(rows.map((r) => r.measurer_id));
}

// ---------------------------------------------------------------------------
// Reporte de dry-run
// ---------------------------------------------------------------------------

function printSummary({
  totalCandidates,
  okRows,
  orphanPedestals,
  invalidDates,
  alreadyExistingCount,
  toInsertCount,
  baselineEvaluated,
  baselineHardExcluded,
  baselineNotFound,
  baselineStale,
  baselineAlreadyHasRow,
  baselineToInsertCount,
  rvargasUser,
  currentMeasureValueNullable,
}) {
  console.log('\n========== RESUMEN sbmqb_invoices ==========');
  console.log(`Total filas candidatas (electricidad, patrón DOCK/INITIAL/FINAL/USED): ${totalCandidates}`);
  console.log(`OK, listas para insertar (nuevas):                                    ${toInsertCount}`);
  console.log(`Ya existentes en sbmqb_invoices (idempotencia, se omiten):            ${alreadyExistingCount}`);
  console.log(`Con measurer_code/pedestal_id huérfano (sin match en measurers):      ${orphanPedestals.size} pedestal_id distintos`);
  console.log(`Con fecha inválida (fuera de rango sanidad 25-35 días o unparseable): ${invalidDates.length}`);

  if (orphanPedestals.size > 0) {
    console.log('\n--- pedestal_id huérfanos (top 20 por conteo) ---');
    const sorted = [...orphanPedestals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [pedestalId, count] of sorted) {
      console.log(`  ${pedestalId}: ${count} línea(s)`);
    }
  }

  if (invalidDates.length > 0) {
    console.log('\n--- 5 ejemplos de fecha inválida ---');
    for (const example of invalidDates.slice(0, 5)) {
      console.log(`  ref=${example.sbmqb_ref_number} line=${example.sbmqb_txn_line_id} reason=${example.reason} period=${example.periodText || '-'} txn_date=${example.txn_date || '-'}`);
    }
  }

  console.log('\n--- Muestra de 15 filas listas para insertar en sbmqb_invoices ---');
  for (const row of okRows.slice(0, 15)) {
    console.log(
      `  invoice_id=${row.sbmqb_invoice_id} customer="${row.sbmqb_customer_name}" service="${row.sbmqb_service}" ` +
      `measurer_code=${row.measurer_code} initial=${row.initial_measure_value} current=${row.current_measure_value} ` +
      `total=${row.total_measure_value} begin=${row.begin_date.toISOString().slice(0, 10)} end=${row.end_date.toISOString().slice(0, 10)}`
    );
  }

  console.log('\n========== RESUMEN baseline de measurements ==========');
  console.log(`Pedestales candidatos a baseline (última factura eléctrica por pedestal_id): ${baselineEvaluated}`);
  console.log(`Excluidos DURO por cliente INACTIVO (status SUSPENDED/TERMINATED):            ${baselineHardExcluded.length}`);
  console.log(`Advertencia: cliente NO encontrado en sbmqb_customers (no se excluye):         ${baselineNotFound.length}`);
  console.log(`Advertencia: última factura con más de ${STALE_BASELINE_DAYS} días vs fecha máxima del dataset:  ${baselineStale.length}`);
  console.log(`Ya tienen fila en measurements (se omiten, no se duplica):                     ${baselineAlreadyHasRow}`);
  console.log(`Listos para insertar en measurements:                                          ${baselineToInsertCount}`);

  if (baselineHardExcluded.length > 0) {
    console.log('\n--- Excluidos por cliente INACTIVO (ejemplos) ---');
    for (const row of baselineHardExcluded.slice(0, 15)) {
      console.log(`  measurer_code=${row.measurer_code} customer="${row.sbmqb_customer_name}" status=${row.customerStatus}`);
    }
  }

  if (baselineNotFound.length > 0) {
    console.log('\n--- Cliente NO encontrado en sbmqb_customers (ejemplos, revisar) ---');
    for (const row of baselineNotFound.slice(0, 15)) {
      console.log(`  measurer_code=${row.measurer_code} customer="${row.sbmqb_customer_name}" end_date=${row.end_date.toISOString().slice(0, 10)}`);
    }
  }

  if (baselineStale.length > 0) {
    console.log(`\n--- Última factura con más de ${STALE_BASELINE_DAYS} días de antigüedad (ejemplos, revisar) ---`);
    for (const row of baselineStale.slice(0, 15)) {
      console.log(
        `  measurer_code=${row.measurer_code} customer="${row.sbmqb_customer_name}" status=${row.customerStatus} ` +
        `end_date=${row.end_date.toISOString().slice(0, 10)} dias_desde_ultima_factura=${row.daysSinceLastInvoice}`
      );
    }
  }

  console.log('\n========== Notas de entorno ==========');
  console.log(
    rvargasUser
      ? `Usuario 'rvargas' encontrado: id=${rvargasUser.id}, username=${rvargasUser.username}`
      : `ATENCION: no se encontró un usuario con username tipo 'rvargas' en la tabla users. -- TODO: user_id de rvargas`
  );
  console.log(
    currentMeasureValueNullable
      ? `measurements.current_measure_value es NULLABLE en esta DB -> se insertará NULL como pidió el Jefe.`
      : `ATENCION: measurements.current_measure_value es NOT NULL en esta DB (a pesar de que la migración v1 lo definía así y v4 solo altera el tipo) -> ` +
        `se rellenará con el mismo valor de last_measure_value como placeholder, ya que no se puede insertar NULL. Confirmar con el Jefe si esto es aceptable.`
  );
  console.log('=========================================\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { execute, dryRun } = parseArgs(process.argv.slice(2));

  console.log(`Modo: ${execute ? 'EXECUTE (escribe en la DB)' : 'DRY-RUN (no escribe nada)'}`);

  const [measurersByPedestalId, customerIndex, rvargasUser, rawRows, maxDateRow] = await Promise.all([
    loadMeasurersByPedestalId(knex),
    loadCustomerIndex(knex),
    findRvargasUserId(knex),
    loadCandidateRows(knex),
    knex('sbmqb_invoices_read').max('txn_date as maxDate').first(),
  ]);

  const datasetMaxDate = maxDateRow && maxDateRow.maxDate ? new Date(maxDateRow.maxDate) : null;

  const { ok, orphanPedestals, invalidDates } = processRows(rawRows, measurersByPedestalId);

  const existingInvoiceKeys = await loadExistingInvoiceKeys(knex, ok);
  const newInvoiceRows = ok.filter((row) => !existingInvoiceKeys.has(invoiceLineKey(row)));
  const alreadyExistingCount = ok.length - newInvoiceRows.length;

  // Baseline: agrupar por pedestal_id (sobre TODAS las filas válidas, no solo las nuevas,
  // porque el baseline debe reflejar el estado real de facturación, ya esté o no recién insertado).
  const baselineCandidatesRaw = buildBaselineCandidates(ok);
  const baselineEvaluatedRows = baselineCandidatesRaw.map((c) =>
    evaluateBaselineCandidate(c, customerIndex, datasetMaxDate)
  );

  const baselineHardExcluded = baselineEvaluatedRows.filter((r) => r.hardExcludeInactive);
  const baselineNotFound = baselineEvaluatedRows.filter((r) => r.warnNotFound);
  const baselineStale = baselineEvaluatedRows.filter((r) => r.warnStale);
  const baselineEligible = baselineEvaluatedRows.filter((r) => !r.hardExcludeInactive);

  const existingMeasurerIds = await loadExistingMeasurerIdsInMeasurements(knex);
  const baselineAlreadyHasRow = baselineEligible.filter((r) => existingMeasurerIds.has(r.measurer_id)).length;
  const baselineToInsertRows = baselineEligible.filter((r) => !existingMeasurerIds.has(r.measurer_id));

  const currentMeasureValueNullable = await getColumnNullability(knex, 'measurements', 'current_measure_value');

  printSummary({
    totalCandidates: rawRows.length,
    okRows: newInvoiceRows,
    orphanPedestals,
    invalidDates,
    alreadyExistingCount,
    toInsertCount: newInvoiceRows.length,
    baselineEvaluated: baselineEvaluatedRows.length,
    baselineHardExcluded,
    baselineNotFound,
    baselineStale,
    baselineAlreadyHasRow,
    baselineToInsertCount: baselineToInsertRows.length,
    rvargasUser,
    currentMeasureValueNullable: currentMeasureValueNullable === null ? true : currentMeasureValueNullable,
  });

  if (dryRun) {
    console.log('Dry-run finalizado. No se escribió nada en la base de datos.');
    console.log('Cuando el resumen se vea correcto, correr con --execute para insertar de verdad.');
    await knex.destroy();
    return;
  }

  // --------------------------------------------------------------------
  // EXECUTE: insert real en transacción, batches de 500
  // --------------------------------------------------------------------

  await knex.transaction(async (trx) => {
    for (let i = 0; i < newInvoiceRows.length; i += BATCH_SIZE) {
      const chunk = newInvoiceRows.slice(i, i + BATCH_SIZE).map((row) => ({
        sbmqb_customer_name: row.sbmqb_customer_name,
        sbmqb_service: row.sbmqb_service,
        measurer_code: row.measurer_code,
        initial_measure_value: row.initial_measure_value,
        current_measure_value: row.current_measure_value,
        total_measure_value: row.total_measure_value,
        begin_date: row.begin_date,
        end_date: row.end_date,
        status: row.status,
        sbmqb_invoice_id: row.sbmqb_invoice_id,
      }));
      await trx('sbmqb_invoices').insert(chunk);
    }
    console.log(`sbmqb_invoices: ${newInvoiceRows.length} filas insertadas.`);

    const nullableCurrentValue =
      currentMeasureValueNullable === null ? true : currentMeasureValueNullable;

    for (let i = 0; i < baselineToInsertRows.length; i += BATCH_SIZE) {
      const chunk = baselineToInsertRows.slice(i, i + BATCH_SIZE).map((row) => ({
        user_id: rvargasUser ? rvargasUser.id : null,
        measurer_id: row.measurer_id,
        sbmqb_customer_name: row.sbmqb_customer_name,
        sbmqb_service: row.sbmqb_service,
        description: `Historical import from QBWC — ${row.periodText}`.slice(0, 300),
        // measurements.last_measure_value / current_measure_value son INTEGER (migración v4),
        // se redondea explícitamente en vez de confiar en el truncado implícito de MySQL.
        last_measure_value: Math.round(row.current_measure_value),
        last_measure_date: row.end_date,
        current_measure_value: nullableCurrentValue ? null : Math.round(row.current_measure_value),
        current_measure_date: null,
        status: 'PENDIENTE',
      }));
      await trx('measurements').insert(chunk);
    }
    console.log(`measurements (baseline): ${baselineToInsertRows.length} filas insertadas.`);
  });

  console.log('Execute finalizado con éxito.');
  await knex.destroy();
}

main().catch(async (err) => {
  console.error('Error ejecutando la migración:', err);
  try {
    await knex.destroy();
  } catch (_) {
    // no-op
  }
  process.exit(1);
});
