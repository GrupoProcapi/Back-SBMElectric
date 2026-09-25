const chai = require('chai');
const expect = chai.expect;

const { createQboCustomerService } = require('../src/services/qboCustomerService');

// ---------------------------------------------------------------------------
// Fakes (no mocking library available in this project — sinon/proxyquire are
// not installed and CLAUDE.md forbids installing new deps without approval).
// These are plain hand-rolled fakes that satisfy the same call shape the
// service uses from qboClient/database.
// ---------------------------------------------------------------------------

// `endpoint` llega URL-encodeado (getCustomerCount/getQBOCustomers ahora
// hacen encodeURIComponent(query) -- ver fix del bug de `%` crudo, mismo
// patrón que getQBOItems() en qboInvoiceService.js). `calls` guarda el
// endpoint crudo (encodeado) tal cual se le mandaría a QBO; el matching de
// SELECT COUNT(*)/STARTPOSITION decodea primero para no depender del
// encoding exacto de espacios/comas.
const buildFakeQboClient = ({ countResponse, pages }) => {
  const calls = [];
  return {
    calls,
    makeApiCall: async (endpoint) => {
      calls.push(endpoint);
      const decoded = decodeURIComponent(endpoint);

      if (decoded.includes('SELECT COUNT(*)')) {
        return countResponse;
      }

      const startPositionMatch = decoded.match(/STARTPOSITION (\d+)/);
      const startPosition = startPositionMatch ? parseInt(startPositionMatch[1], 10) : 1;
      const pageIndex = Math.floor((startPosition - 1) / 1000);
      const page = pages[pageIndex] || [];

      return { QueryResponse: { Customer: page } };
    }
  };
};

// `insertFailures` maps a `sbmqb_id` to the Error the fake `insert()` should
// throw instead of recording the row -- lets tests simulate a MySQL-level
// insert failure (e.g. ER_DUP_ENTRY from the unique index, or any other
// error) for one specific row while the rest of the batch inserts normally.
const buildFakeDatabase = (localCustomers, insertFailures = {}) => {
  const updates = [];
  const inserts = [];

  const db = (table) => {
    if (table !== 'sbmqb_customers') {
      throw new Error(`Unexpected table in fake database: ${table}`);
    }

    return {
      select: async () => localCustomers,
      where: (column, value) => ({
        update: async (values) => {
          updates.push({ column, value, values });
          return 1;
        }
      }),
      insert: async (values) => {
        const failure = insertFailures[values.sbmqb_id];
        if (failure) {
          throw failure;
        }
        inserts.push(values);
        return [1];
      }
    };
  };

  db.updates = updates;
  db.inserts = inserts;
  return db;
};

describe('qboCustomerService (factory + matching)', () => {
  describe('matchCustomer', () => {
    const { matchCustomer } = createQboCustomerService({
      qboClient: buildFakeQboClient({ countResponse: {}, pages: [] }),
      database: buildFakeDatabase([])
    });

    it('matches by qbo_id first when present, even if names differ', () => {
      const qboCustomer = { Id: '123', DisplayName: 'New Name', FullyQualifiedName: 'New Name' };
      const local = [
        { sbmqb_id: 'A', qbo_id: '123', name: 'Old Name', full_name: 'Old Name' },
        { sbmqb_id: 'B', qbo_id: null, name: 'New Name', full_name: 'New Name' }
      ];

      const result = matchCustomer(qboCustomer, local);

      expect(result.status).to.equal('matched');
      expect(result.matchedBy).to.equal('qbo_id');
      expect(result.local.sbmqb_id).to.equal('A');
    });

    it('falls back to FullyQualifiedName vs full_name when no qbo_id match', () => {
      const qboCustomer = { Id: '999', DisplayName: 'Some Display', FullyQualifiedName: 'Marina:Slip 42' };
      const local = [
        { sbmqb_id: 'A', qbo_id: null, name: 'Other', full_name: 'Marina:Slip 42' }
      ];

      const result = matchCustomer(qboCustomer, local);

      expect(result.status).to.equal('matched');
      expect(result.matchedBy).to.equal('full_name');
      expect(result.local.sbmqb_id).to.equal('A');
    });

    it('falls back to DisplayName vs name when no qbo_id or full_name match', () => {
      const qboCustomer = { Id: '999', DisplayName: 'John Doe', FullyQualifiedName: 'John Doe Yacht Corp' };
      const local = [
        { sbmqb_id: 'A', qbo_id: null, name: 'John Doe', full_name: 'Something Else' }
      ];

      const result = matchCustomer(qboCustomer, local);

      expect(result.status).to.equal('matched');
      expect(result.matchedBy).to.equal('name');
      expect(result.local.sbmqb_id).to.equal('A');
    });

    it('returns ambiguous when FullyQualifiedName matches more than one local customer', () => {
      const qboCustomer = { Id: '999', DisplayName: 'Dup', FullyQualifiedName: 'Dup Name' };
      const local = [
        { sbmqb_id: 'A', qbo_id: null, name: 'X', full_name: 'Dup Name' },
        { sbmqb_id: 'B', qbo_id: null, name: 'Y', full_name: 'Dup Name' }
      ];

      const result = matchCustomer(qboCustomer, local);

      expect(result.status).to.equal('ambiguous');
      expect(result.matchedBy).to.equal('full_name');
      expect(result.candidates.map((c) => c.sbmqb_id).sort()).to.deep.equal(['A', 'B']);
    });

    it('returns ambiguous when DisplayName matches more than one local customer and does not fall through', () => {
      const qboCustomer = { Id: '999', DisplayName: 'Dup Display', FullyQualifiedName: 'No Match Here' };
      const local = [
        { sbmqb_id: 'A', qbo_id: null, name: 'Dup Display', full_name: 'Other 1' },
        { sbmqb_id: 'B', qbo_id: null, name: 'Dup Display', full_name: 'Other 2' }
      ];

      const result = matchCustomer(qboCustomer, local);

      expect(result.status).to.equal('ambiguous');
      expect(result.matchedBy).to.equal('name');
    });

    it('returns unmatched when nothing matches by any strategy', () => {
      const qboCustomer = { Id: '999', DisplayName: 'Ghost', FullyQualifiedName: 'Ghost Corp' };
      const local = [
        { sbmqb_id: 'A', qbo_id: null, name: 'Someone Else', full_name: 'Someone Else Inc' }
      ];

      const result = matchCustomer(qboCustomer, local);

      expect(result.status).to.equal('unmatched');
    });

    it('does not fall through to name matching when qbo_id already matches ambiguously', () => {
      const qboCustomer = { Id: '123', DisplayName: 'Whatever', FullyQualifiedName: 'Whatever' };
      const local = [
        { sbmqb_id: 'A', qbo_id: '123', name: 'Not This', full_name: 'Not This' },
        { sbmqb_id: 'B', qbo_id: '123', name: 'Or This', full_name: 'Or This' }
      ];

      const result = matchCustomer(qboCustomer, local);

      expect(result.status).to.equal('ambiguous');
      expect(result.matchedBy).to.equal('qbo_id');
    });
  });

  describe('getQBOCustomers (pagination)', () => {
    it('paginates using STARTPOSITION/MAXRESULTS until a page returns fewer than 1000 results', async () => {
      const page1 = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i + 1), DisplayName: `C${i + 1}` }));
      const page2 = Array.from({ length: 234 }, (_, i) => ({ Id: String(1000 + i + 1), DisplayName: `C${1000 + i + 1}` }));

      const fakeQboClient = buildFakeQboClient({
        countResponse: { QueryResponse: { totalCount: 1234 } },
        pages: [page1, page2]
      });

      const { getQBOCustomers } = createQboCustomerService({
        qboClient: fakeQboClient,
        database: buildFakeDatabase([])
      });

      const customers = await getQBOCustomers({ includeInactive: true });

      expect(customers).to.have.lengthOf(1234);
      expect(fakeQboClient.calls).to.have.lengthOf(2);
      expect(decodeURIComponent(fakeQboClient.calls[0])).to.include('STARTPOSITION 1 MAXRESULTS 1000');
      expect(decodeURIComponent(fakeQboClient.calls[1])).to.include('STARTPOSITION 1001 MAXRESULTS 1000');
      expect(decodeURIComponent(fakeQboClient.calls[0])).to.include('Active IN (true, false)');
    });

    it('uses Active = true when includeInactive is false', async () => {
      const fakeQboClient = buildFakeQboClient({
        countResponse: { QueryResponse: { totalCount: 0 } },
        pages: [[]]
      });

      const { getQBOCustomers } = createQboCustomerService({
        qboClient: fakeQboClient,
        database: buildFakeDatabase([])
      });

      await getQBOCustomers({ includeInactive: false });

      expect(decodeURIComponent(fakeQboClient.calls[0])).to.include('Active = true');
    });

    it('stops after a single page when it returns fewer than MAXRESULTS results', async () => {
      const page1 = [{ Id: '1', DisplayName: 'Only One' }];

      const fakeQboClient = buildFakeQboClient({
        countResponse: { QueryResponse: { totalCount: 1 } },
        pages: [page1]
      });

      const { getQBOCustomers } = createQboCustomerService({
        qboClient: fakeQboClient,
        database: buildFakeDatabase([])
      });

      const customers = await getQBOCustomers({ includeInactive: true });

      expect(customers).to.have.lengthOf(1);
      expect(fakeQboClient.calls).to.have.lengthOf(1);
    });
  });

  describe('syncCustomers (dry-run by default, count verification, matching, writes)', () => {
    it('defaults to dryRun=true and never touches the database', async () => {
      const qboCustomers = [{ Id: '1', DisplayName: 'Foo', FullyQualifiedName: 'Foo' }];
      const fakeQboClient = buildFakeQboClient({
        countResponse: { QueryResponse: { totalCount: 1 } },
        pages: [qboCustomers]
      });
      const fakeDatabase = buildFakeDatabase([
        { sbmqb_id: 'A', qbo_id: null, name: 'Foo', full_name: 'Foo' }
      ]);

      const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

      const result = await syncCustomers();

      expect(result.totalQbo).to.equal(1);
      expect(result.matched).to.have.lengthOf(1);
      expect(result.wouldUpdate).to.equal(1);
      expect(result.unmatched).to.have.lengthOf(0);
      expect(result.ambiguous).to.have.lengthOf(0);
      expect(fakeDatabase.updates).to.have.lengthOf(0);
    });

    it('throws an explicit error when the paginated total does not match the COUNT query total', async () => {
      const fakeQboClient = buildFakeQboClient({
        countResponse: { QueryResponse: { totalCount: 7566 } },
        pages: [[{ Id: '1', DisplayName: 'Foo', FullyQualifiedName: 'Foo' }]]
      });
      const fakeDatabase = buildFakeDatabase([]);

      const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

      try {
        await syncCustomers();
        throw new Error('Expected syncCustomers to throw on count mismatch');
      } catch (error) {
        expect(error.message).to.match(/mismatch/i);
        expect(error.message).to.include('7566');
      }
    });

    it('throws when dryRun=false and QBO_SYNC_APPLY_ENABLED is not "true"', async () => {
      const previous = process.env.QBO_SYNC_APPLY_ENABLED;
      delete process.env.QBO_SYNC_APPLY_ENABLED;

      const fakeQboClient = buildFakeQboClient({
        countResponse: { QueryResponse: { totalCount: 0 } },
        pages: [[]]
      });
      const fakeDatabase = buildFakeDatabase([]);
      const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

      try {
        await syncCustomers({ dryRun: false });
        throw new Error('Expected syncCustomers to throw when apply mode is disabled');
      } catch (error) {
        expect(error.message).to.match(/QBO_SYNC_APPLY_ENABLED/);
      } finally {
        if (previous === undefined) {
          delete process.env.QBO_SYNC_APPLY_ENABLED;
        } else {
          process.env.QBO_SYNC_APPLY_ENABLED = previous;
        }
      }
    });

    it('applies only qbo_id updates for unambiguous matches when dryRun=false and apply is enabled', async () => {
      const previous = process.env.QBO_SYNC_APPLY_ENABLED;
      process.env.QBO_SYNC_APPLY_ENABLED = 'true';

      const qboCustomers = [
        { Id: '1', DisplayName: 'Foo', FullyQualifiedName: 'Foo' },
        { Id: '2', DisplayName: 'DupDisplay', FullyQualifiedName: 'NoMatch' },
        { Id: '3', DisplayName: 'Ghost', FullyQualifiedName: 'GhostCo' }
      ];
      const fakeQboClient = buildFakeQboClient({
        countResponse: { QueryResponse: { totalCount: 3 } },
        pages: [qboCustomers]
      });
      const fakeDatabase = buildFakeDatabase([
        { sbmqb_id: 'A', qbo_id: null, name: 'Foo', full_name: 'Foo' },
        { sbmqb_id: 'B', qbo_id: null, name: 'DupDisplay', full_name: 'X' },
        { sbmqb_id: 'C', qbo_id: null, name: 'DupDisplay', full_name: 'Y' }
      ]);

      const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

      try {
        const result = await syncCustomers({ dryRun: false });

        expect(result.matched).to.have.lengthOf(1);
        expect(result.ambiguous).to.have.lengthOf(1);
        expect(result.unmatched).to.have.lengthOf(1);
        expect(result.wouldUpdate).to.equal(1);

        expect(fakeDatabase.updates).to.have.lengthOf(1);
        expect(fakeDatabase.updates[0]).to.deep.equal({
          column: 'sbmqb_id',
          value: 'A',
          values: { qbo_id: '1' }
        });
      } finally {
        if (previous === undefined) {
          delete process.env.QBO_SYNC_APPLY_ENABLED;
        } else {
          process.env.QBO_SYNC_APPLY_ENABLED = previous;
        }
      }
    });

    it('does not write an update when the local record already has the correct qbo_id (matched via qbo_id, no-op)', async () => {
      const previous = process.env.QBO_SYNC_APPLY_ENABLED;
      process.env.QBO_SYNC_APPLY_ENABLED = 'true';

      const fakeQboClient = buildFakeQboClient({
        countResponse: { QueryResponse: { totalCount: 1 } },
        pages: [[{ Id: '1', DisplayName: 'Foo', FullyQualifiedName: 'Foo' }]]
      });
      const fakeDatabase = buildFakeDatabase([
        { sbmqb_id: 'A', qbo_id: '1', name: 'Foo', full_name: 'Foo' }
      ]);

      const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

      try {
        const result = await syncCustomers({ dryRun: false });

        expect(result.matched).to.have.lengthOf(1);
        expect(result.wouldUpdate).to.equal(0);
        expect(fakeDatabase.updates).to.have.lengthOf(0);
      } finally {
        if (previous === undefined) {
          delete process.env.QBO_SYNC_APPLY_ENABLED;
        } else {
          process.env.QBO_SYNC_APPLY_ENABLED = previous;
        }
      }
    });

    it('never inserts new customers into the database, only updates qbo_id', async () => {
      const fakeQboClient = buildFakeQboClient({
        countResponse: { QueryResponse: { totalCount: 1 } },
        pages: [[{ Id: '1', DisplayName: 'Ghost', FullyQualifiedName: 'GhostCo' }]]
      });
      const fakeDatabase = buildFakeDatabase([]);

      const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

      const result = await syncCustomers({ dryRun: true });

      expect(result.unmatched).to.have.lengthOf(1);
      expect(fakeDatabase.updates).to.have.lengthOf(0);
    });

    describe('creating new customers found only in QBO (unmatched bucket)', () => {
      const buildNewQboCustomer = (overrides = {}) => ({
        Id: '555',
        DisplayName: 'Brand New Boat LLC',
        FullyQualifiedName: 'Brand New Boat LLC',
        CompanyName: 'Brand New Boat LLC',
        Active: true,
        ...overrides
      });

      it('dry-run: reports wouldCreate for unmatched customers but inserts nothing', async () => {
        const qboCustomer = buildNewQboCustomer();
        const fakeQboClient = buildFakeQboClient({
          countResponse: { QueryResponse: { totalCount: 1 } },
          pages: [[qboCustomer]]
        });
        const fakeDatabase = buildFakeDatabase([]);

        const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

        const result = await syncCustomers({ dryRun: true });

        expect(result.unmatched).to.have.lengthOf(1);
        expect(result.unmatched[0]).to.include({
          qboId: '555',
          sbmqbId: 'QBO-555',
          willCreate: true
        });
        expect(result.wouldCreate).to.equal(1);
        expect(result.yaCreado).to.equal(0);
        expect(fakeDatabase.inserts).to.have.lengthOf(0);
        expect(fakeDatabase.updates).to.have.lengthOf(0);
      });

      it('apply: inserts a new local row with all expected default fields when QBO_SYNC_APPLY_ENABLED=true', async () => {
        const previous = process.env.QBO_SYNC_APPLY_ENABLED;
        process.env.QBO_SYNC_APPLY_ENABLED = 'true';

        const qboCustomer = buildNewQboCustomer();
        const fakeQboClient = buildFakeQboClient({
          countResponse: { QueryResponse: { totalCount: 1 } },
          pages: [[qboCustomer]]
        });
        const fakeDatabase = buildFakeDatabase([]);

        const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

        try {
          const result = await syncCustomers({ dryRun: false });

          expect(result.wouldCreate).to.equal(1);
          expect(result.yaCreado).to.equal(0);
          expect(fakeDatabase.inserts).to.have.lengthOf(1);
          expect(fakeDatabase.inserts[0]).to.deep.equal({
            sbmqb_id: 'QBO-555',
            name: 'Brand New Boat LLC',
            full_name: 'Brand New Boat LLC',
            company_name: 'Brand New Boat LLC',
            sbmqb_service: '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70004-Electricity T. @ 0.48/KW',
            class: 'MARINA',
            status: 'ACTIVE',
            qbo_id: '555'
          });
        } finally {
          if (previous === undefined) {
            delete process.env.QBO_SYNC_APPLY_ENABLED;
          } else {
            process.env.QBO_SYNC_APPLY_ENABLED = previous;
          }
        }
      });

      it('apply: sets status SUSPENDED and blank company_name for an inactive customer with no CompanyName', async () => {
        const previous = process.env.QBO_SYNC_APPLY_ENABLED;
        process.env.QBO_SYNC_APPLY_ENABLED = 'true';

        const qboCustomer = buildNewQboCustomer({
          Id: '777',
          CompanyName: undefined,
          Active: false
        });
        const fakeQboClient = buildFakeQboClient({
          countResponse: { QueryResponse: { totalCount: 1 } },
          pages: [[qboCustomer]]
        });
        const fakeDatabase = buildFakeDatabase([]);

        const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

        try {
          await syncCustomers({ dryRun: false });

          expect(fakeDatabase.inserts[0].status).to.equal('SUSPENDED');
          expect(fakeDatabase.inserts[0].company_name).to.equal('');
        } finally {
          if (previous === undefined) {
            delete process.env.QBO_SYNC_APPLY_ENABLED;
          } else {
            process.env.QBO_SYNC_APPLY_ENABLED = previous;
          }
        }
      });

      it('apply: throws and inserts nothing when QBO_SYNC_APPLY_ENABLED is not "true" (unmatched-only sync)', async () => {
        const previous = process.env.QBO_SYNC_APPLY_ENABLED;
        delete process.env.QBO_SYNC_APPLY_ENABLED;

        const qboCustomer = buildNewQboCustomer();
        const fakeQboClient = buildFakeQboClient({
          countResponse: { QueryResponse: { totalCount: 1 } },
          pages: [[qboCustomer]]
        });
        const fakeDatabase = buildFakeDatabase([]);

        const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

        try {
          await syncCustomers({ dryRun: false });
          throw new Error('Expected syncCustomers to throw when apply mode is disabled');
        } catch (error) {
          expect(error.message).to.match(/QBO_SYNC_APPLY_ENABLED/);
          expect(fakeDatabase.inserts).to.have.lengthOf(0);
        } finally {
          if (previous === undefined) {
            delete process.env.QBO_SYNC_APPLY_ENABLED;
          } else {
            process.env.QBO_SYNC_APPLY_ENABLED = previous;
          }
        }
      });

      it('treats a duplicate-key insert failure (ER_DUP_ENTRY) as already created and keeps processing the rest of the batch', async () => {
        const previous = process.env.QBO_SYNC_APPLY_ENABLED;
        process.env.QBO_SYNC_APPLY_ENABLED = 'true';

        // Two unmatched QBO customers: the first loses a race against
        // another overlapping sync run (the unique index on sbmqb_id rejects
        // it), the second has no such conflict and must still be inserted.
        const qboCustomers = [
          buildNewQboCustomer({ Id: '555', DisplayName: 'Raced Boat LLC', FullyQualifiedName: 'Raced Boat LLC' }),
          buildNewQboCustomer({ Id: '556', DisplayName: 'Clean Boat LLC', FullyQualifiedName: 'Clean Boat LLC' })
        ];
        const fakeQboClient = buildFakeQboClient({
          countResponse: { QueryResponse: { totalCount: 2 } },
          pages: [qboCustomers]
        });
        const dupError = new Error("Duplicate entry 'QBO-555' for key 'sbmqb_customers_sbmqb_id_unique'");
        dupError.code = 'ER_DUP_ENTRY';
        const fakeDatabase = buildFakeDatabase([], { 'QBO-555': dupError });

        const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

        try {
          const result = await syncCustomers({ dryRun: false });

          expect(result.unmatched).to.have.lengthOf(2);

          const racedEntry = result.unmatched.find((entry) => entry.qboId === '555');
          expect(racedEntry.willCreate).to.equal(false);
          expect(racedEntry.createError).to.equal(undefined);

          const cleanEntry = result.unmatched.find((entry) => entry.qboId === '556');
          expect(cleanEntry.willCreate).to.equal(true);

          expect(result.yaCreado).to.equal(1);
          expect(result.wouldCreate).to.equal(1);
          expect(fakeDatabase.inserts).to.have.lengthOf(1);
          expect(fakeDatabase.inserts[0].sbmqb_id).to.equal('QBO-556');
        } finally {
          if (previous === undefined) {
            delete process.env.QBO_SYNC_APPLY_ENABLED;
          } else {
            process.env.QBO_SYNC_APPLY_ENABLED = previous;
          }
        }
      });

      it('reports a non-duplicate insert failure on the unmatched entry via createError and keeps processing the rest of the batch', async () => {
        const previous = process.env.QBO_SYNC_APPLY_ENABLED;
        process.env.QBO_SYNC_APPLY_ENABLED = 'true';

        const qboCustomers = [
          buildNewQboCustomer({ Id: '555', DisplayName: 'Broken Boat LLC', FullyQualifiedName: 'Broken Boat LLC' }),
          buildNewQboCustomer({ Id: '556', DisplayName: 'Clean Boat LLC', FullyQualifiedName: 'Clean Boat LLC' })
        ];
        const fakeQboClient = buildFakeQboClient({
          countResponse: { QueryResponse: { totalCount: 2 } },
          pages: [qboCustomers]
        });
        const otherError = new Error("Data too long for column 'name' at row 1");
        otherError.code = 'ER_DATA_TOO_LONG';
        const fakeDatabase = buildFakeDatabase([], { 'QBO-555': otherError });

        const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

        try {
          const result = await syncCustomers({ dryRun: false });

          expect(result.unmatched).to.have.lengthOf(2);

          const brokenEntry = result.unmatched.find((entry) => entry.qboId === '555');
          expect(brokenEntry.createError).to.equal("Data too long for column 'name' at row 1");

          const cleanEntry = result.unmatched.find((entry) => entry.qboId === '556');
          expect(cleanEntry.createError).to.equal(undefined);

          // The failing row must not abort the batch -- the following row
          // still gets inserted.
          expect(fakeDatabase.inserts).to.have.lengthOf(1);
          expect(fakeDatabase.inserts[0].sbmqb_id).to.equal('QBO-556');
        } finally {
          if (previous === undefined) {
            delete process.env.QBO_SYNC_APPLY_ENABLED;
          } else {
            process.env.QBO_SYNC_APPLY_ENABLED = previous;
          }
        }
      });

      it('does not duplicate a customer already created by a previous sync (detected by synthetic sbmqb_id)', async () => {
        const previous = process.env.QBO_SYNC_APPLY_ENABLED;
        process.env.QBO_SYNC_APPLY_ENABLED = 'true';

        // Simulates the second run: the QBO customer still doesn't match by
        // qbo_id/full_name/name (e.g. its local row is stale/out of sync),
        // but a row with the synthetic sbmqb_id it would generate already
        // exists locally -- the dedup check must catch this by sbmqb_id.
        const qboCustomer = buildNewQboCustomer({ Id: '555', DisplayName: 'Renamed In QBO', FullyQualifiedName: 'Renamed In QBO' });
        const fakeQboClient = buildFakeQboClient({
          countResponse: { QueryResponse: { totalCount: 1 } },
          pages: [[qboCustomer]]
        });
        const fakeDatabase = buildFakeDatabase([
          { sbmqb_id: 'QBO-555', qbo_id: null, name: 'Brand New Boat LLC', full_name: 'Brand New Boat LLC' }
        ]);

        const { syncCustomers } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

        try {
          const result = await syncCustomers({ dryRun: false });

          expect(result.unmatched).to.have.lengthOf(1);
          expect(result.unmatched[0].willCreate).to.equal(false);
          expect(result.wouldCreate).to.equal(0);
          expect(result.yaCreado).to.equal(1);
          expect(fakeDatabase.inserts).to.have.lengthOf(0);
        } finally {
          if (previous === undefined) {
            delete process.env.QBO_SYNC_APPLY_ENABLED;
          } else {
            process.env.QBO_SYNC_APPLY_ENABLED = previous;
          }
        }
      });
    });
  });

  describe('findCustomerByName (read-only lookup, no live QBO call, no write)', () => {
    it('returns the single local match, including its qbo_id as-is', async () => {
      const fakeQboClient = buildFakeQboClient({ countResponse: {}, pages: [] });
      const fakeDatabase = buildFakeDatabase([
        { sbmqb_id: 'A', qbo_id: 'CUST-1', name: 'Cliente Demo', full_name: 'Cliente Demo Full' }
      ]);

      const { findCustomerByName } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

      const result = await findCustomerByName('Cliente Demo Full');

      expect(result.sbmqb_id).to.equal('A');
      expect(result.qbo_id).to.equal('CUST-1');
      expect(fakeQboClient.calls).to.have.lengthOf(0);
      expect(fakeDatabase.updates).to.have.lengthOf(0);
    });

    it('matches by "name" as a fallback when "full_name" does not match', async () => {
      const fakeDatabase = buildFakeDatabase([
        { sbmqb_id: 'A', qbo_id: 'CUST-1', name: 'Cliente Demo', full_name: 'Something Else' }
      ]);

      const { findCustomerByName } = createQboCustomerService({
        qboClient: buildFakeQboClient({ countResponse: {}, pages: [] }),
        database: fakeDatabase
      });

      const result = await findCustomerByName('Cliente Demo');

      expect(result.sbmqb_id).to.equal('A');
    });

    it('throws an explicit error when there are zero local matches (never returns null silently)', async () => {
      const fakeDatabase = buildFakeDatabase([
        { sbmqb_id: 'A', qbo_id: 'CUST-1', name: 'Someone Else', full_name: 'Someone Else Inc' }
      ]);

      const { findCustomerByName } = createQboCustomerService({
        qboClient: buildFakeQboClient({ countResponse: {}, pages: [] }),
        database: fakeDatabase
      });

      try {
        await findCustomerByName('Ghost Customer');
        throw new Error('Expected findCustomerByName to throw when there are zero matches');
      } catch (error) {
        expect(error.message).to.match(/No se encontró ningún cliente local/);
        expect(error.message).to.include('Ghost Customer');
      }
    });

    it('throws an explicit error when there is more than one local match (never returns an arbitrary row)', async () => {
      const fakeDatabase = buildFakeDatabase([
        { sbmqb_id: 'A', qbo_id: null, name: 'Dup Name', full_name: 'X' },
        { sbmqb_id: 'B', qbo_id: null, name: 'Dup Name', full_name: 'Y' }
      ]);

      const { findCustomerByName } = createQboCustomerService({
        qboClient: buildFakeQboClient({ countResponse: {}, pages: [] }),
        database: fakeDatabase
      });

      try {
        await findCustomerByName('Dup Name');
        throw new Error('Expected findCustomerByName to throw on ambiguous match');
      } catch (error) {
        expect(error.message).to.match(/ambiguo/i);
        expect(error.message).to.include('A');
        expect(error.message).to.include('B');
      }
    });

    it('never calls the QBO API and never writes to the database, regardless of QBO_SYNC_APPLY_ENABLED', async () => {
      const previous = process.env.QBO_SYNC_APPLY_ENABLED;
      process.env.QBO_SYNC_APPLY_ENABLED = 'true';

      const fakeQboClient = buildFakeQboClient({ countResponse: {}, pages: [] });
      const fakeDatabase = buildFakeDatabase([
        { sbmqb_id: 'A', qbo_id: null, name: 'Cliente Demo', full_name: 'Cliente Demo Full' }
      ]);

      const { findCustomerByName } = createQboCustomerService({ qboClient: fakeQboClient, database: fakeDatabase });

      try {
        const result = await findCustomerByName('Cliente Demo Full');

        expect(result.qbo_id).to.equal(null);
        expect(fakeQboClient.calls).to.have.lengthOf(0);
        expect(fakeDatabase.updates).to.have.lengthOf(0);
      } finally {
        if (previous === undefined) {
          delete process.env.QBO_SYNC_APPLY_ENABLED;
        } else {
          process.env.QBO_SYNC_APPLY_ENABLED = previous;
        }
      }
    });
  });
});
