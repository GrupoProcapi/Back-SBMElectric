const qboClient = require('./qboClient');
const qboCustomerService = require('./qboCustomerService');
const database = require('../database');

const getQBOItems = async () => {
  const response = await qboClient.makeApiCall('/query?query=SELECT * FROM Item WHERE Active = true');
  return response.QueryResponse?.Item || [];
};

const findElectricityItem = async () => {
  const response = await qboClient.makeApiCall(
    "/query?query=SELECT * FROM Item WHERE Name LIKE '%Electricity%' OR Name LIKE '%Electric%'"
  );
  const items = response.QueryResponse?.Item || [];
  return items[0] || null;
};

const createInvoice = async (invoiceData) => {
  const customer = await qboCustomerService.findCustomerByName(invoiceData.sbmqb_customer_name);
  
  if (!customer || !customer.qbo_id) {
    throw new Error(`Cliente no encontrado en QBO: ${invoiceData.sbmqb_customer_name}. Ejecuta primero /api/qbo/customers/sync`);
  }
  
  let electricityItem = await findElectricityItem();
  
  const servicioExtraido = invoiceData.sbmqb_service ? 
    invoiceData.sbmqb_service.match(/(\d+-)(.*)/)?.[2] || 'Electricity' : 
    'Electricity';
  
  const beginDate = new Date(invoiceData.begin_date);
  const endDate = new Date(invoiceData.end_date);
  const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  
  const description = `${servicioExtraido}
DOCK    ${invoiceData.measurer_code}
INITIAL ${invoiceData.initial_measure_value}
FINAL   ${invoiceData.current_measure_value}
USED    ${invoiceData.total_measure_value} KWTS
${monthNames[beginDate.getUTCMonth()]} ${beginDate.getUTCDate()} TO ${monthNames[endDate.getUTCMonth()]} ${endDate.getUTCDate()}`;

  const unitPrice = 0.48;
  const amount = invoiceData.total_measure_value * unitPrice;
  
  const invoiceBody = {
    Line: [{
      DetailType: 'SalesItemLineDetail',
      Amount: amount,
      Description: description,
      SalesItemLineDetail: {
        ItemRef: {
          value: electricityItem?.Id || '1',
          name: electricityItem?.Name || 'Services'
        },
        Qty: invoiceData.total_measure_value,
        UnitPrice: unitPrice
      }
    }],
    CustomerRef: {
      value: customer.qbo_id,
      name: customer.full_name || customer.name
    }
  };
  
  const response = await qboClient.makeApiCall('/invoice', 'POST', invoiceBody);
  
  if (response.Invoice) {
    if (invoiceData.id) {
      await database('sbmqb_invoices')
        .where('id', invoiceData.id)
        .update({
          status: 'FACTURADO',
          sbmqb_invoice_id: response.Invoice.DocNumber || response.Invoice.Id
        });
      
      await database('measurements')
        .where('sbmqb_invoices_id', invoiceData.id)
        .update({ status: 'FACTURADO' });
    }
    
    return response.Invoice;
  }
  
  throw new Error('Error creando factura en QBO: ' + JSON.stringify(response));
};

const getQBOInvoices = async (maxResults = 100) => {
  const response = await qboClient.makeApiCall(
    `/query?query=SELECT * FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS ${maxResults}`
  );
  return response.QueryResponse?.Invoice || [];
};

const processPendingInvoices = async () => {
  const pendingInvoices = await database('sbmqb_invoices')
    .where('status', 'PENDIENTE');
  
  if (pendingInvoices.length === 0) {
    return { message: 'No hay facturas pendientes', processed: 0, results: [] };
  }
  
  const results = [];
  
  for (const invoice of pendingInvoices) {
    try {
      const createdInvoice = await createInvoice(invoice);
      results.push({ 
        id: invoice.id, 
        success: true, 
        qboId: createdInvoice.Id,
        docNumber: createdInvoice.DocNumber
      });
    } catch (error) {
      console.error(`Error procesando factura ${invoice.id}:`, error.message);
      results.push({ 
        id: invoice.id, 
        success: false, 
        error: error.message 
      });
    }
  }
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  return { 
    processed: pendingInvoices.length,
    successful,
    failed,
    results
  };
};

module.exports = {
  getQBOItems,
  getQBOInvoices,
  createInvoice,
  processPendingInvoices
};
