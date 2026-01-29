const qboClient = require('./qboClient');
const database = require('../database');

const getQBOCustomers = async () => {
  const response = await qboClient.makeApiCall('/query?query=SELECT * FROM Customer WHERE Active = true');
  return response.QueryResponse?.Customer || [];
};

const syncCustomers = async () => {
  const customers = await getQBOCustomers();
  
  let created = 0;
  let updated = 0;
  let skipped = 0;
  
  for (const customer of customers) {
    try {
      const existing = await database('sbmqb_customers')
        .where('qbo_id', customer.Id)
        .orWhere('full_name', customer.DisplayName)
        .orWhere('name', customer.DisplayName)
        .first();
      
      if (!existing) {
        await database('sbmqb_customers').insert({
          qbo_id: customer.Id,
          name: customer.DisplayName,
          full_name: customer.FullyQualifiedName || customer.DisplayName,
          company_name: customer.CompanyName || '',
          sbmqb_service: '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70004-Electricity T. @ 0.48/KW',
          class: 'MARINA',
          status: customer.Active ? 'ACTIVE' : 'SUSPENDED'
        });
        created++;
      } else if (!existing.qbo_id) {
        await database('sbmqb_customers')
          .where('id', existing.id)
          .update({ 
            qbo_id: customer.Id,
            status: customer.Active ? 'ACTIVE' : 'SUSPENDED'
          });
        updated++;
      } else {
        skipped++;
      }
    } catch (error) {
      console.error(`Error procesando cliente ${customer.DisplayName}:`, error.message);
      skipped++;
    }
  }
  
  return { 
    total: customers.length,
    created,
    updated,
    skipped
  };
};

const findCustomerByName = async (customerName) => {
  const localCustomer = await database('sbmqb_customers')
    .where('full_name', customerName)
    .orWhere('name', customerName)
    .first();
  
  if (localCustomer && localCustomer.qbo_id) {
    return localCustomer;
  }
  
  const response = await qboClient.makeApiCall(
    `/query?query=SELECT * FROM Customer WHERE DisplayName = '${customerName.replace(/'/g, "\\'")}'`
  );
  
  const qboCustomer = response.QueryResponse?.Customer?.[0];
  
  if (qboCustomer && localCustomer) {
    await database('sbmqb_customers')
      .where('id', localCustomer.id)
      .update({ qbo_id: qboCustomer.Id });
    return { ...localCustomer, qbo_id: qboCustomer.Id };
  }
  
  return localCustomer || null;
};

module.exports = {
  getQBOCustomers,
  syncCustomers,
  findCustomerByName
};
