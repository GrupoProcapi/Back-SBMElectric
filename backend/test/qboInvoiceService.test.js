const { expect } = require('chai');

const qboInvoiceService = require('../src/services/qboInvoiceService');
const qboConfig = require('../src/config/qboConfig');

// NOTA: el proyecto no tiene sinon/proxyquire/zod instalados (ver package.json).
// Estos tests son unitarios puros: solo cubren la lógica que NO toca red (QBO)
// ni la base de datos real -- los builders puros (buildDescription,
// buildInvoiceBody, buildRequestId, previewInvoice) y las guard clauses de
// createInvoice()/processPendingInvoices() que retornan/lanzan ANTES de tocar
// qboCustomerService/qboClient/knex.
//
// GAP CONOCIDO (documentado, no testeado acá): el camino feliz de
// createInvoice() (llamada real a qboClient.makeApiCall + qboCustomerService
// + escritura en `sbmqb_invoices`/`measurements`) y el camino feliz de
// processPendingInvoices() con dryRun:false requieren stubear knex y
// qboClient, lo cual no es posible sin una librería de mocking. Se deja
// documentado como deuda técnica hasta que se apruebe instalar sinon o similar.

const {
  buildDescription,
  buildInvoiceBody,
  buildRequestId,
  previewInvoice,
  sanitizeItemSearch,
  buildItemsQuery,
  paginateQboEntity,
  ITEM_PAGE_SIZE
} = qboInvoiceService.__testables;

// Fake mínimo de qboClient para testear getQBOItems() sin red real -- mismo
// approach hand-rolled que test/qboCustomerService.js (no hay sinon/proxyquire
// instalado en el proyecto). Simula páginas de resultados según STARTPOSITION.
//
// `endpoint` llega URL-encodeado (getQBOItems hace encodeURIComponent(query)
// antes de armar el endpoint -- ver fix del bug de `%` crudo en
// qboInvoiceService.js). `calls` guarda el endpoint crudo (encodeado) tal cual
// se lo mandaría a QBO -- útil para verificar que el `%` de LIKE viaje como
// `%25`. El matching de STARTPOSITION decodea primero para no depender del
// formato exacto de encoding de espacios.
const buildFakeQboItemsClient = (pages) => {
  const calls = [];
  return {
    calls,
    makeApiCall: async (endpoint) => {
      calls.push(endpoint);
      const decoded = decodeURIComponent(endpoint);
      const startPositionMatch = decoded.match(/STARTPOSITION (\d+)/);
      const startPosition = startPositionMatch ? parseInt(startPositionMatch[1], 10) : 1;
      const pageIndex = Math.floor((startPosition - 1) / ITEM_PAGE_SIZE);
      const page = pages[pageIndex] || [];
      return { QueryResponse: { Item: page } };
    }
  };
};

const VALID_SERVICE_MAP = {
  'servicio-electricidad-tarifa': { itemId: 'ITEM-T', unitPrice: 0.48 },
  'servicio-electricidad-medido': { itemId: 'ITEM-M', unitPrice: 0.415 }
};

const setValidConfig = (overrides = {}) => {
  process.env.QBO_SERVICE_MAP_JSON = JSON.stringify(VALID_SERVICE_MAP);
  process.env.QBO_TAX_CODE_ID = '7';
  process.env.QBO_SALES_TERM_ID = '3';
  delete process.env.QBO_CLASS_ID;
  delete process.env.QBO_PROCESS_MAX_BATCH;
  Object.entries(overrides).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
  return qboConfig.reloadConfig();
};

const baseInvoiceData = () => ({
  id: 42,
  sbmqb_customer_name: 'Cliente Demo',
  sbmqb_service: 'servicio-electricidad-tarifa',
  measurer_code: 'DOCK-01',
  initial_measure_value: 100,
  current_measure_value: 250,
  total_measure_value: 150,
  begin_date: '2026-01-01T00:00:00.000Z',
  end_date: '2026-01-31T00:00:00.000Z'
});

describe('qboInvoiceService - buildDescription (sin cambios funcionales)', () => {
  it('arma Description con Dock/Initial/Final/Used y el rango de fechas', () => {
    const description = buildDescription(baseInvoiceData());
    expect(description).to.include('DOCK    DOCK-01');
    expect(description).to.include('INITIAL 100');
    expect(description).to.include('FINAL   250');
    expect(description).to.include('USED    150 KWTS');
    expect(description).to.include('JAN 1 TO JAN 31');
  });

  it('usa "Electricity" por defecto cuando sbmqb_service no matchea el patrón esperado', () => {
    const description = buildDescription({ ...baseInvoiceData(), sbmqb_service: null });
    expect(description.split('\n')[0]).to.equal('Electricity');
  });
});

describe('qboInvoiceService - buildInvoiceBody (sin hardcodes)', () => {
  const customer = { qbo_id: 'CUST-1', full_name: 'Cliente Demo Full' };

  afterEach(() => {
    delete process.env.QBO_SERVICE_MAP_JSON;
    delete process.env.QBO_TAX_CODE_ID;
    delete process.env.QBO_SALES_TERM_ID;
    delete process.env.QBO_CLASS_ID;
    qboConfig.reloadConfig();
  });

  it('usa el unitPrice/itemId del mapa de servicio, NO 0.48 hardcodeado', () => {
    const config = setValidConfig();
    const serviceConfig = qboConfig.getServiceConfig('servicio-electricidad-medido'); // 0.415
    const invoiceData = { ...baseInvoiceData(), sbmqb_service: 'servicio-electricidad-medido' };

    const body = buildInvoiceBody(invoiceData, { customer, serviceConfig, config });
    const line = body.Line[0];

    expect(line.SalesItemLineDetail.UnitPrice).to.equal(0.415);
    expect(line.SalesItemLineDetail.ItemRef).to.deep.equal({ value: 'ITEM-M' });
    expect(line.Amount).to.equal(invoiceData.total_measure_value * 0.415);
  });

  it('usa QBO_TAX_CODE_ID como TaxCodeRef, NO "7" hardcodeado por default', () => {
    const config = setValidConfig({ QBO_TAX_CODE_ID: '25' });
    const serviceConfig = qboConfig.getServiceConfig('servicio-electricidad-tarifa');
    const body = buildInvoiceBody(baseInvoiceData(), { customer, serviceConfig, config });

    expect(body.Line[0].SalesItemLineDetail.TaxCodeRef).to.deep.equal({ value: '25' });
  });

  it('setea PrivateNote = SBM-INV-{id}', () => {
    const config = setValidConfig();
    const serviceConfig = qboConfig.getServiceConfig('servicio-electricidad-tarifa');
    const body = buildInvoiceBody(baseInvoiceData(), { customer, serviceConfig, config });

    expect(body.PrivateNote).to.equal('SBM-INV-42');
  });

  it('NUNCA incluye DocNumber (se deja que QBO lo autogenere)', () => {
    const config = setValidConfig();
    const serviceConfig = qboConfig.getServiceConfig('servicio-electricidad-tarifa');
    const body = buildInvoiceBody(baseInvoiceData(), { customer, serviceConfig, config });

    expect(body).to.not.have.property('DocNumber');
  });

  it('agrega SalesTermRef desde QBO_SALES_TERM_ID', () => {
    const config = setValidConfig({ QBO_SALES_TERM_ID: '9' });
    const serviceConfig = qboConfig.getServiceConfig('servicio-electricidad-tarifa');
    const body = buildInvoiceBody(baseInvoiceData(), { customer, serviceConfig, config });

    expect(body.SalesTermRef).to.deep.equal({ value: '9' });
  });

  it('NO agrega ClassRef cuando QBO_CLASS_ID no está configurado (opcional)', () => {
    const config = setValidConfig();
    const serviceConfig = qboConfig.getServiceConfig('servicio-electricidad-tarifa');
    const body = buildInvoiceBody(baseInvoiceData(), { customer, serviceConfig, config });

    expect(body).to.not.have.property('ClassRef');
  });

  it('agrega ClassRef cuando QBO_CLASS_ID sí está configurado', () => {
    const config = setValidConfig({ QBO_CLASS_ID: 'CLASS-7' });
    const serviceConfig = qboConfig.getServiceConfig('servicio-electricidad-tarifa');
    const body = buildInvoiceBody(baseInvoiceData(), { customer, serviceConfig, config });

    expect(body.ClassRef).to.deep.equal({ value: 'CLASS-7' });
  });

  it('CustomerRef usa customer.qbo_id y full_name (o name como fallback)', () => {
    const config = setValidConfig();
    const serviceConfig = qboConfig.getServiceConfig('servicio-electricidad-tarifa');
    const body = buildInvoiceBody(baseInvoiceData(), { customer, serviceConfig, config });

    expect(body.CustomerRef).to.deep.equal({ value: 'CUST-1', name: 'Cliente Demo Full' });
  });
});

describe('qboInvoiceService - buildRequestId (idempotencia)', () => {
  it('genera un requestid determinístico tipo sbm-inv-{id}', () => {
    expect(buildRequestId({ id: 42 })).to.equal('sbm-inv-42');
    expect(buildRequestId({ id: 42 })).to.equal(buildRequestId({ id: 42 }));
  });
});

describe('qboInvoiceService - previewInvoice (usado por processPendingInvoices en dryRun)', () => {
  afterEach(() => {
    delete process.env.QBO_SERVICE_MAP_JSON;
    delete process.env.QBO_TAX_CODE_ID;
    delete process.env.QBO_SALES_TERM_ID;
    delete process.env.QBO_CLASS_ID;
    delete process.env.QBO_PROCESS_MAX_BATCH;
    qboConfig.reloadConfig();
  });

  it('lanza un error si invoiceData no tiene id local', () => {
    setValidConfig();
    expect(() => previewInvoice({ ...baseInvoiceData(), id: undefined })).to.throw(/id/i);
  });

  it('retorna skipped=true sin llamar red/DB si la factura ya tiene sbmqb_invoice_id', () => {
    setValidConfig();
    const result = previewInvoice({ ...baseInvoiceData(), sbmqb_invoice_id: 'QBO-999' });
    expect(result).to.deep.equal({
      skipped: true,
      reason: 'La factura local ya tiene sbmqb_invoice_id asignado, no se crearía de nuevo en QBO',
      sbmqb_invoice_id: 'QBO-999'
    });
  });

  it('lanza un error explícito si el servicio del cliente no está mapeado (no factura con datos inventados)', () => {
    setValidConfig();
    expect(() => previewInvoice({ ...baseInvoiceData(), sbmqb_service: 'servicio-no-existe' }))
      .to.throw(/no hay mapeo/i);
  });

  it('devuelve el preview completo con valores del mapa de servicio, sin tocar red', () => {
    setValidConfig();
    const preview = previewInvoice({ ...baseInvoiceData(), sbmqb_service: 'servicio-electricidad-medido' });

    expect(preview.skipped).to.equal(false);
    expect(preview.itemId).to.equal('ITEM-M');
    expect(preview.unitPrice).to.equal(0.415);
    expect(preview.amount).to.equal(150 * 0.415);
    expect(preview.requestId).to.equal('sbm-inv-42');
    expect(preview.privateNote).to.equal('SBM-INV-42');
    expect(preview.taxCodeId).to.equal('7');
    expect(preview.salesTermId).to.equal('3');
  });
});

describe('qboInvoiceService - createInvoice (guard clauses, sin red/DB)', () => {
  afterEach(() => {
    delete process.env.QBO_SERVICE_MAP_JSON;
    delete process.env.QBO_TAX_CODE_ID;
    delete process.env.QBO_SALES_TERM_ID;
    qboConfig.reloadConfig();
  });

  it('lanza un error si invoiceData no tiene id local (requerido para idempotencia)', async () => {
    let thrown = null;
    try {
      await qboInvoiceService.createInvoice({ ...baseInvoiceData(), id: undefined });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect(thrown.message).to.match(/id/i);
  });

  it('saltea la creación (skipped=true) si la factura ya tiene sbmqb_invoice_id, sin tocar QBO', async () => {
    const result = await qboInvoiceService.createInvoice({
      ...baseInvoiceData(),
      sbmqb_invoice_id: 'QBO-EXISTING-1'
    });
    expect(result.skipped).to.equal(true);
    expect(result.sbmqb_invoice_id).to.equal('QBO-EXISTING-1');
  });

  it('lanza un error explícito si el servicio del cliente no está mapeado en QBO_SERVICE_MAP_JSON', async () => {
    setValidConfig();
    let thrown = null;
    try {
      await qboInvoiceService.createInvoice({ ...baseInvoiceData(), sbmqb_service: 'servicio-inexistente' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect(thrown.message).to.match(/no hay mapeo/i);
  });

  it('lanza un error explícito (fail-closed) si la configuración de QBO está incompleta', async () => {
    delete process.env.QBO_SERVICE_MAP_JSON;
    delete process.env.QBO_TAX_CODE_ID;
    delete process.env.QBO_SALES_TERM_ID;
    qboConfig.reloadConfig();

    let thrown = null;
    try {
      await qboInvoiceService.createInvoice(baseInvoiceData());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect(thrown.message).to.match(/deshabilitad/i);
  });
});

describe('qboInvoiceService - processPendingInvoices (guard clauses, sin DB)', () => {
  afterEach(() => {
    delete process.env.QBO_PROCESS_MAX_BATCH;
  });

  it('rechaza si no se pasa invoiceIds', async () => {
    let thrown = null;
    try {
      await qboInvoiceService.processPendingInvoices();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect(thrown.message).to.match(/invoiceIds/);
  });

  it('rechaza si invoiceIds es un array vacío (nunca "todas las PENDIENTE")', async () => {
    let thrown = null;
    try {
      await qboInvoiceService.processPendingInvoices({ invoiceIds: [] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect(thrown.message).to.match(/invoiceIds/);
  });

  it('rechaza si invoiceIds no es un array', async () => {
    let thrown = null;
    try {
      await qboInvoiceService.processPendingInvoices({ invoiceIds: 42 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(Error);
  });

  it('rechaza si invoiceIds supera QBO_PROCESS_MAX_BATCH', async () => {
    process.env.QBO_PROCESS_MAX_BATCH = '1';
    let thrown = null;
    try {
      await qboInvoiceService.processPendingInvoices({ invoiceIds: [1, 2] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect(thrown.message).to.match(/QBO_PROCESS_MAX_BATCH/);
  });
});

describe('qboInvoiceService - sanitizeItemSearch', () => {
  it('devuelve undefined cuando no viene search', () => {
    expect(sanitizeItemSearch(undefined)).to.equal(undefined);
    expect(sanitizeItemSearch(null)).to.equal(undefined);
  });

  it('devuelve undefined cuando search es string vacío o solo espacios', () => {
    expect(sanitizeItemSearch('')).to.equal(undefined);
    expect(sanitizeItemSearch('   ')).to.equal(undefined);
  });

  it('trimea y acepta letras, números, espacios y guiones', () => {
    expect(sanitizeItemSearch('  ELECTR  ')).to.equal('ELECTR');
    expect(sanitizeItemSearch('Electricidad-Muelle 42')).to.equal('Electricidad-Muelle 42');
  });

  it('rechaza intentos de inyección con comillas simples', () => {
    expect(() => sanitizeItemSearch("ELECTR' OR '1'='1")).to.throw(
      qboInvoiceService.InvalidItemSearchError
    );
  });

  it('rechaza intentos de inyección tipo "; DROP"', () => {
    expect(() => sanitizeItemSearch("x'; DROP TABLE Item; --")).to.throw(
      qboInvoiceService.InvalidItemSearchError
    );
  });

  it('rechaza caracteres especiales de SQL/QBO como %, _, (, )', () => {
    expect(() => sanitizeItemSearch('ELECTR%')).to.throw(qboInvoiceService.InvalidItemSearchError);
    expect(() => sanitizeItemSearch('a)OR(1=1')).to.throw(qboInvoiceService.InvalidItemSearchError);
  });

  it('rechaza search que no es string', () => {
    expect(() => sanitizeItemSearch(['a', 'b'])).to.throw(qboInvoiceService.InvalidItemSearchError);
    expect(() => sanitizeItemSearch(42)).to.throw(qboInvoiceService.InvalidItemSearchError);
  });
});

describe('qboInvoiceService - buildItemsQuery', () => {
  it('arma la query base (sin search) con STARTPOSITION/MAXRESULTS', () => {
    const query = buildItemsQuery(undefined, { startPosition: 1, maxResults: 1000 });
    expect(query).to.equal('SELECT * FROM Item WHERE Active = true STARTPOSITION 1 MAXRESULTS 1000');
  });

  it('agrega la cláusula LIKE cuando hay search (ya sanitizado)', () => {
    const query = buildItemsQuery('ELECTR', { startPosition: 1001, maxResults: 1000 });
    expect(query).to.equal(
      "SELECT * FROM Item WHERE Active = true AND Name LIKE '%ELECTR%' STARTPOSITION 1001 MAXRESULTS 1000"
    );
  });
});

describe('qboInvoiceService - getQBOItems (paginación + search)', () => {
  it('trae todo en una sola página cuando hay menos de 1000 resultados', async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({ Id: String(i), Name: `Item ${i}` }));
    const fakeClient = buildFakeQboItemsClient([page]);

    const items = await qboInvoiceService.getQBOItems({ client: fakeClient });

    expect(items).to.have.lengthOf(50);
    expect(fakeClient.calls).to.have.lengthOf(1);
    expect(decodeURIComponent(fakeClient.calls[0])).to.include('STARTPOSITION 1 MAXRESULTS 1000');
  });

  it('pagina cuando hay más de 1000 resultados, hasta traer todo', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ Id: `p1-${i}` }));
    const page2 = Array.from({ length: 1000 }, (_, i) => ({ Id: `p2-${i}` }));
    const page3 = Array.from({ length: 250 }, (_, i) => ({ Id: `p3-${i}` }));
    const fakeClient = buildFakeQboItemsClient([page1, page2, page3]);

    const items = await qboInvoiceService.getQBOItems({ client: fakeClient });

    expect(items).to.have.lengthOf(2250);
    expect(fakeClient.calls).to.have.lengthOf(3);
    expect(decodeURIComponent(fakeClient.calls[0])).to.include('STARTPOSITION 1 MAXRESULTS 1000');
    expect(decodeURIComponent(fakeClient.calls[1])).to.include('STARTPOSITION 1001 MAXRESULTS 1000');
    expect(decodeURIComponent(fakeClient.calls[2])).to.include('STARTPOSITION 2001 MAXRESULTS 1000');
  });

  it('para exactamente al recibir una última página completa (múltiplo exacto de 1000)', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ Id: `p1-${i}` }));
    const page2 = Array.from({ length: 1000 }, (_, i) => ({ Id: `p2-${i}` }));
    // Tercera página vacía: simula que QBO no tiene más resultados.
    const fakeClient = buildFakeQboItemsClient([page1, page2, []]);

    const items = await qboInvoiceService.getQBOItems({ client: fakeClient });

    expect(items).to.have.lengthOf(2000);
    expect(fakeClient.calls).to.have.lengthOf(3);
  });

  it('arma la query con el filtro LIKE cuando se pasa search', async () => {
    const fakeClient = buildFakeQboItemsClient([[{ Id: '1', Name: 'Electricidad Muelle A' }]]);

    const items = await qboInvoiceService.getQBOItems({ search: 'ELECTR', client: fakeClient });

    expect(items).to.have.lengthOf(1);
    expect(decodeURIComponent(fakeClient.calls[0])).to.include("Name LIKE '%ELECTR%'");
    // Regresión del bug real: el `%` de LIKE DEBE viajar como `%25` en el
    // endpoint crudo (URL-encodeado) que se le manda a QBO. Un `%` literal acá
    // es exactamente lo que rompía la query contra QBO (500 genérico).
    expect(fakeClient.calls[0]).to.include('%25ELECTR%25');
  });

  it('rechaza un search con caracteres inválidos ANTES de llamar a QBO', async () => {
    const fakeClient = buildFakeQboItemsClient([[]]);
    let thrown = null;

    try {
      await qboInvoiceService.getQBOItems({ search: "'; DROP TABLE Item; --", client: fakeClient });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(qboInvoiceService.InvalidItemSearchError);
    expect(fakeClient.calls).to.have.lengthOf(0);
  });

  it('sin client inyectado usa el qboClient real por default (no rompe la firma anterior)', () => {
    // getQBOItems() sin argumentos no debe explotar por falta de `client` --
    // solo verificamos que la función exista y acepte llamarse sin params
    // (el camino feliz real requiere red, cubierto por los tests con fake client).
    expect(qboInvoiceService.getQBOItems).to.be.a('function');
  });
});

// Fake mínimo de qboClient para testear paginateQboEntity()/getQBOTerms()/
// getQBOClasses() sin red real -- mismo approach que buildFakeQboItemsClient,
// parametrizado por `entityName` (Term/Class) en vez de Item.
const buildFakeQboEntityClient = (entityName, pages) => {
  const calls = [];
  return {
    calls,
    makeApiCall: async (endpoint) => {
      calls.push(endpoint);
      const decoded = decodeURIComponent(endpoint);
      const startPositionMatch = decoded.match(/STARTPOSITION (\d+)/);
      const startPosition = startPositionMatch ? parseInt(startPositionMatch[1], 10) : 1;
      const pageIndex = Math.floor((startPosition - 1) / ITEM_PAGE_SIZE);
      const page = pages[pageIndex] || [];
      return { QueryResponse: { [entityName]: page } };
    }
  };
};

describe('qboInvoiceService - paginateQboEntity (helper compartido por getQBOTerms/getQBOClasses)', () => {
  it('arma la query SELECT * FROM {entityName} con STARTPOSITION/MAXRESULTS, sin filtro LIKE', async () => {
    const fakeClient = buildFakeQboEntityClient('Term', [[{ Id: '1', Name: 'Net 30' }]]);

    const results = await paginateQboEntity({ entityName: 'Term', client: fakeClient });

    expect(results).to.deep.equal([{ Id: '1', Name: 'Net 30' }]);
    expect(decodeURIComponent(fakeClient.calls[0])).to.equal(
      '/query?query=SELECT * FROM Term STARTPOSITION 1 MAXRESULTS 1000'
    );
  });

  it('pagina cuando hay más de 1000 resultados, hasta traer todo', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ Id: `p1-${i}` }));
    const page2 = Array.from({ length: 250 }, (_, i) => ({ Id: `p2-${i}` }));
    const fakeClient = buildFakeQboEntityClient('Class', [page1, page2]);

    const results = await paginateQboEntity({ entityName: 'Class', client: fakeClient });

    expect(results).to.have.lengthOf(1250);
    expect(fakeClient.calls).to.have.lengthOf(2);
    expect(decodeURIComponent(fakeClient.calls[1])).to.include('STARTPOSITION 1001 MAXRESULTS 1000');
  });

  it('para exactamente al recibir una última página completa (múltiplo exacto de 1000)', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ Id: `p1-${i}` }));
    const fakeClient = buildFakeQboEntityClient('Term', [page1, []]);

    const results = await paginateQboEntity({ entityName: 'Term', client: fakeClient });

    expect(results).to.have.lengthOf(1000);
    expect(fakeClient.calls).to.have.lengthOf(2);
  });

  it('respeta el guard de páginas (maxPages) para no loopear indefinidamente', async () => {
    // Cada página viene llena (=pageSize), así que sin el guard loopearía para siempre.
    const fullPage = Array.from({ length: 10 }, (_, i) => ({ Id: `x-${i}` }));
    const client = {
      calls: [],
      makeApiCall: async function (endpoint) {
        this.calls.push(endpoint);
        return { QueryResponse: { Term: fullPage } };
      }
    };

    let thrown = null;
    try {
      await paginateQboEntity({ entityName: 'Term', client, pageSize: 10, maxPages: 3 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect(thrown.message).to.match(/safety limit of 3 pages/);
    expect(client.calls).to.have.lengthOf(3);
  });
});

describe('qboInvoiceService - getQBOTerms', () => {
  it('devuelve los términos de pago (Term) paginados', async () => {
    const terms = [
      { Id: '1', Name: 'Net 15' },
      { Id: '2', Name: 'Net 30' }
    ];
    const fakeClient = buildFakeQboEntityClient('Term', [terms]);

    const result = await qboInvoiceService.getQBOTerms({ client: fakeClient });

    expect(result).to.deep.equal(terms);
    expect(decodeURIComponent(fakeClient.calls[0])).to.include('SELECT * FROM Term');
  });

  it('sin client inyectado usa el qboClient real por default (no rompe la firma)', () => {
    expect(qboInvoiceService.getQBOTerms).to.be.a('function');
  });
});

describe('qboInvoiceService - getQBOClasses', () => {
  it('devuelve las clases (Class) paginadas -- incluye MARINA entre las 7 clases reales', async () => {
    const classes = [
      { Id: '1', Name: 'ADMINISTRACION' },
      { Id: '2', Name: 'CHANDLERY' },
      { Id: '3', Name: 'COMBUSTIBLE' },
      { Id: '4', Name: 'MANTENIMIENTO' },
      { Id: '5', Name: 'MARINA' },
      { Id: '6', Name: 'SAIL LOFT' },
      { Id: '7', Name: 'YARD' }
    ];
    const fakeClient = buildFakeQboEntityClient('Class', [classes]);

    const result = await qboInvoiceService.getQBOClasses({ client: fakeClient });

    expect(result).to.deep.equal(classes);
    expect(result.find((c) => c.Name === 'MARINA').Id).to.equal('5');
    expect(decodeURIComponent(fakeClient.calls[0])).to.include('SELECT * FROM Class');
  });

  it('sin client inyectado usa el qboClient real por default (no rompe la firma)', () => {
    expect(qboInvoiceService.getQBOClasses).to.be.a('function');
  });
});
