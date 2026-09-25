const defaultQboClient = require('./qboClient');
const defaultDatabase = require('../database');

const TABLE = 'sbmqb_customers';
const PAGE_SIZE = 1000;
// Safety guard: 7,566 customers today. 200 pages = 200,000 customers, a sane
// ceiling well above current volume that still stops a runaway loop instead
// of hammering the QBO API forever if something is wrong with pagination.
const MAX_PAGES = 200;

const buildActiveClause = (includeInactive) => (includeInactive ? 'Active IN (true, false)' : 'Active = true');

/**
 * Matches a single QBO customer against the local customer roster using a
 * strict priority cascade:
 *   1. qbo_id (already linked — kept for robustness, should be rare/never)
 *   2. FullyQualifiedName (QBO) vs full_name (local)
 *   3. DisplayName (QBO) vs name (local)
 *
 * The first strategy that yields ANY candidate decides the outcome: exactly
 * one candidate => matched, more than one => ambiguous (does not fall
 * through to the next strategy). Zero candidates => try the next strategy.
 */
const matchCustomer = (qboCustomer, localCustomers) => {
  const byQboId = localCustomers.filter(
    (local) => local.qbo_id != null && String(local.qbo_id) === String(qboCustomer.Id)
  );
  if (byQboId.length === 1) {
    return { status: 'matched', matchedBy: 'qbo_id', local: byQboId[0] };
  }
  if (byQboId.length > 1) {
    return { status: 'ambiguous', matchedBy: 'qbo_id', candidates: byQboId };
  }

  if (qboCustomer.FullyQualifiedName) {
    const byFullName = localCustomers.filter((local) => local.full_name === qboCustomer.FullyQualifiedName);
    if (byFullName.length === 1) {
      return { status: 'matched', matchedBy: 'full_name', local: byFullName[0] };
    }
    if (byFullName.length > 1) {
      return { status: 'ambiguous', matchedBy: 'full_name', candidates: byFullName };
    }
  }

  if (qboCustomer.DisplayName) {
    const byName = localCustomers.filter((local) => local.name === qboCustomer.DisplayName);
    if (byName.length === 1) {
      return { status: 'matched', matchedBy: 'name', local: byName[0] };
    }
    if (byName.length > 1) {
      return { status: 'ambiguous', matchedBy: 'name', candidates: byName };
    }
  }

  return { status: 'unmatched' };
};

const createQboCustomerService = ({ qboClient = defaultQboClient, database = defaultDatabase } = {}) => {
  const getCustomerCount = async ({ includeInactive = false } = {}) => {
    const query = `SELECT COUNT(*) FROM Customer WHERE ${buildActiveClause(includeInactive)}`;
    // encodeURIComponent es OBLIGATORIO acá: mismo bug que en getQBOItems()
    // (ver comentario en qboInvoiceService.js) -- el WHATWG URL parser usado
    // por axios dentro de intuit-oauth NUNCA encodea un `%` crudo, lo que
    // rompería la query si en el futuro `buildActiveClause` u otro filtro
    // agrega un LIKE. Se mantiene la misma disciplina aunque hoy esta query
    // no tenga `%` (solo espacios/paréntesis, que sí encodea el parser).
    const response = await qboClient.makeApiCall(`/query?query=${encodeURIComponent(query)}`);
    const totalCount = response.QueryResponse?.totalCount;

    if (typeof totalCount !== 'number') {
      throw new Error('QBO COUNT query did not return a numeric totalCount. Aborting to avoid a silent partial sync.');
    }

    return totalCount;
  };

  const getQBOCustomers = async ({ includeInactive = false } = {}) => {
    const customers = [];
    let startPosition = 1;
    let pageLength = 0;
    let pageCount = 0;

    do {
      if (pageCount >= MAX_PAGES) {
        throw new Error(
          `QBO customer pagination exceeded the safety limit of ${MAX_PAGES} pages ` +
            `(${MAX_PAGES * PAGE_SIZE} records). Aborting instead of looping indefinitely.`
        );
      }

      const query =
        `SELECT * FROM Customer WHERE ${buildActiveClause(includeInactive)} ` +
        `STARTPOSITION ${startPosition} MAXRESULTS ${PAGE_SIZE}`;
      // encodeURIComponent obligatorio -- mismo motivo que en getCustomerCount()
      // de acá arriba y en getQBOItems() (qboInvoiceService.js).
      const response = await qboClient.makeApiCall(`/query?query=${encodeURIComponent(query)}`);
      const page = response.QueryResponse?.Customer || [];

      customers.push(...page);
      pageLength = page.length;
      startPosition += PAGE_SIZE;
      pageCount += 1;
    } while (pageLength === PAGE_SIZE);

    return customers;
  };

  const syncCustomers = async ({ dryRun = true, includeInactive = true } = {}) => {
    if (!dryRun && process.env.QBO_SYNC_APPLY_ENABLED !== 'true') {
      throw new Error(
        'QBO sync apply mode is disabled. Set QBO_SYNC_APPLY_ENABLED=true in the environment ' +
          'to allow syncCustomers to write qbo_id updates.'
      );
    }

    const expectedTotal = await getCustomerCount({ includeInactive });
    const qboCustomers = await getQBOCustomers({ includeInactive });

    if (qboCustomers.length !== expectedTotal) {
      throw new Error(
        `QBO customer sync count mismatch: COUNT query reported ${expectedTotal} customers but ` +
          `pagination fetched ${qboCustomers.length}. Aborting sync instead of writing partial/incomplete data.`
      );
    }

    const localCustomers = await database(TABLE).select('sbmqb_id', 'qbo_id', 'full_name', 'name');

    const matched = [];
    const unmatched = [];
    const ambiguous = [];

    for (const qboCustomer of qboCustomers) {
      const result = matchCustomer(qboCustomer, localCustomers);

      if (result.status === 'matched') {
        const willUpdate = String(result.local.qbo_id ?? '') !== String(qboCustomer.Id);
        matched.push({
          qboId: qboCustomer.Id,
          qboDisplayName: qboCustomer.DisplayName,
          sbmqbId: result.local.sbmqb_id,
          matchedBy: result.matchedBy,
          willUpdate
        });
      } else if (result.status === 'ambiguous') {
        ambiguous.push({
          qboId: qboCustomer.Id,
          qboDisplayName: qboCustomer.DisplayName,
          matchedBy: result.matchedBy,
          candidateSbmqbIds: result.candidates.map((candidate) => candidate.sbmqb_id)
        });
      } else {
        unmatched.push({
          qboId: qboCustomer.Id,
          qboDisplayName: qboCustomer.DisplayName,
          qboFullyQualifiedName: qboCustomer.FullyQualifiedName
        });
      }
    }

    const wouldUpdate = matched.filter((match) => match.willUpdate).length;

    if (!dryRun) {
      for (const match of matched) {
        if (!match.willUpdate) {
          continue;
        }

        // Only ever UPDATE qbo_id on an existing row. Never INSERT and never
        // touch any other column — customers already exist in QBO (imported
        // from the QuickBooks Desktop file), we are only linking them.
        await database(TABLE).where('sbmqb_id', match.sbmqbId).update({ qbo_id: match.qboId });
      }
    }

    return { totalQbo: qboCustomers.length, matched, unmatched, ambiguous, wouldUpdate };
  };

  /**
   * READ-ONLY lookup of a single local customer by name (matches either
   * full_name or name). Does NOT query QBO live and does NOT write qbo_id.
   *
   * Linking local customers to QBO records is the sole responsibility of
   * `syncCustomers`, which already resolves ambiguous name collisions
   * safely (via `matchCustomer`) and respects QBO_SYNC_APPLY_ENABLED before
   * writing anything. Duplicating that write logic here — on the invoicing
   * hot path, without the ambiguity check or the apply-mode gate — is what
   * caused this function to risk billing the wrong customer.
   *
   * Callers (e.g. invoice creation) must check that the returned customer
   * already has a qbo_id and fail explicitly if it doesn't (instructing the
   * caller to run syncCustomers first) — this function never links on the
   * fly.
   *
   * Throws when there are zero or more than one local matches: returning an
   * arbitrary row when names collide is exactly the bug this closes.
   */
  const findCustomerByName = async (customerName) => {
    const localCustomers = await database(TABLE).select('sbmqb_id', 'qbo_id', 'full_name', 'name');

    const matches = localCustomers.filter(
      (local) => local.full_name === customerName || local.name === customerName
    );

    if (matches.length === 0) {
      throw new Error(
        `No se encontró ningún cliente local con el nombre "${customerName}". ` +
          'Ejecuta primero /api/qbo/customers/sync si el cliente fue agregado recientemente.'
      );
    }

    if (matches.length > 1) {
      throw new Error(
        `Nombre de cliente ambiguo "${customerName}": coincide con ${matches.length} clientes locales ` +
          `(sbmqb_id: ${matches.map((match) => match.sbmqb_id).join(', ')}). ` +
          'Se aborta en vez de adivinar cuál es el correcto; resolvé el nombre duplicado manualmente.'
      );
    }

    return matches[0];
  };

  return {
    getCustomerCount,
    getQBOCustomers,
    matchCustomer,
    syncCustomers,
    findCustomerByName
  };
};

const defaultService = createQboCustomerService();

module.exports = {
  ...defaultService,
  createQboCustomerService
};
