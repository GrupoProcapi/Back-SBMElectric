const defaultQboClient = require('./qboClient');
const defaultDatabase = require('../database');

const TABLE = 'sbmqb_customers';
const PAGE_SIZE = 1000;

// Defaults applied to customers created from QBO (Jefe's real workflow: new
// customers are created directly in QuickBooks Online, never in this app --
// the Medición screen dropdown only reads from the local sbmqb_customers
// table, so a QBO-only customer is unusable here until synced in).
//
// This exact string (byte for byte, including the `&#183;` HTML-entity
// artifact) is the same tariff already stored on all 7,552 existing
// customers. Do NOT "fix" the encoding -- matching the existing data is the
// point, not correctness of the entity itself.
const DEFAULT_NEW_CUSTOMER_SERVICE =
  '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70004-Electricity T. @ 0.48/KW';
const DEFAULT_NEW_CUSTOMER_CLASS = 'MARINA';

// Synthetic local id for customers that only exist in QBO. sbmqb_id never
// existed for these customers before this system created it -- this format
// keeps it unique and lets the rest of the app (customer edit screen,
// customer picker, etc.), which key off sbmqb_id, work unmodified.
const buildSyntheticSbmqbId = (qboId) => `QBO-${qboId}`;
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
    // Tracks sbmqb_id values that already exist locally, so unmatched QBO
    // customers pending creation aren't inserted twice if this sync runs
    // more than once (or somehow sees the same QBO customer twice within a
    // single run). Updated as rows are created below.
    const existingSbmqbIds = new Set(localCustomers.map((local) => local.sbmqb_id));

    const matched = [];
    const unmatched = [];
    // Keeps the raw QBO record for each `unmatched` entry, same index, so the
    // apply step below has every field it needs (CompanyName, Active, etc.)
    // without bloating the returned `unmatched` array with QBO's raw shape.
    const unmatchedQboCustomers = [];
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
        const sbmqbId = buildSyntheticSbmqbId(qboCustomer.Id);
        const willCreate = !existingSbmqbIds.has(sbmqbId);
        unmatched.push({
          qboId: qboCustomer.Id,
          qboDisplayName: qboCustomer.DisplayName,
          qboFullyQualifiedName: qboCustomer.FullyQualifiedName,
          sbmqbId,
          willCreate
        });
        unmatchedQboCustomers.push(qboCustomer);
      }
    }

    if (!dryRun) {
      for (const match of matched) {
        if (!match.willUpdate) {
          continue;
        }

        // Only ever UPDATE qbo_id on an existing row. Never touch any other
        // column here -- this branch is for customers that already exist
        // locally (imported from the QuickBooks Desktop file), we are only
        // linking them.
        await database(TABLE).where('sbmqb_id', match.sbmqbId).update({ qbo_id: match.qboId });
      }

      for (let i = 0; i < unmatched.length; i += 1) {
        const entry = unmatched[i];

        if (!entry.willCreate) {
          // Already created by a previous run (or already present locally
          // under this synthetic sbmqb_id) -- skip instead of duplicating.
          continue;
        }

        const qboCustomer = unmatchedQboCustomers[i];

        // INSERT path: this is the one case where syncCustomers creates a
        // brand-new local row. Jefe's real workflow creates customers
        // directly in QBO, and the Medición screen dropdown only reads from
        // this local table -- so a QBO-only customer needs a local row
        // before it's usable anywhere in the app.
        //
        // Each row is wrapped individually: the in-memory `existingSbmqbIds`
        // Set is only a best-effort guard (computed once at the start of the
        // run), not a real lock -- two overlapping non-dry-run syncs can both
        // decide to create the same synthetic sbmqb_id. The DB-level unique
        // index (see migration 20260925120000) is the real guard and reports
        // the collision as ER_DUP_ENTRY. Treat that specific case as "already
        // created" instead of aborting the whole batch. Any OTHER error on a
        // single row (bad data, connection blip, etc.) must not take down the
        // rest of the batch either -- log it and surface it on the matching
        // `unmatched` entry via `createError` so it's visible in the response.
        try {
          await database(TABLE).insert({
            sbmqb_id: entry.sbmqbId,
            name: qboCustomer.DisplayName,
            full_name: qboCustomer.FullyQualifiedName || qboCustomer.DisplayName,
            company_name: qboCustomer.CompanyName || '',
            sbmqb_service: DEFAULT_NEW_CUSTOMER_SERVICE,
            class: DEFAULT_NEW_CUSTOMER_CLASS,
            status: qboCustomer.Active ? 'ACTIVE' : 'SUSPENDED',
            qbo_id: qboCustomer.Id
          });

          existingSbmqbIds.add(entry.sbmqbId);
        } catch (error) {
          if (error.code === 'ER_DUP_ENTRY') {
            // Lost the race to another overlapping sync run (or the row was
            // otherwise created between the initial `existingSbmqbIds` read
            // and this INSERT) -- not a real failure, count it as already
            // created rather than propagating.
            entry.willCreate = false;
            existingSbmqbIds.add(entry.sbmqbId);
          } else {
            console.error(
              `[qboCustomerService.syncCustomers] Failed to create local customer for QBO id ${qboCustomer.Id} ` +
                `(sbmqb_id ${entry.sbmqbId}): ${error.message}`
            );
            entry.createError = error.message;
          }
        }
      }
    }

    // Computed after the apply block (if it ran) so a row that hit
    // ER_DUP_ENTRY and got reclassified as "already created" is reflected
    // correctly in the counts returned to the caller.
    const wouldUpdate = matched.filter((match) => match.willUpdate).length;
    const wouldCreate = unmatched.filter((entry) => entry.willCreate).length;
    const yaCreado = unmatched.length - wouldCreate;

    return { totalQbo: qboCustomers.length, matched, unmatched, ambiguous, wouldUpdate, wouldCreate, yaCreado };
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
