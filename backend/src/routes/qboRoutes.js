const express = require('express');
const router = express.Router();
const qboClient = require('../services/qboClient');
const qboCustomerService = require('../services/qboCustomerService');
const qboInvoiceService = require('../services/qboInvoiceService');

router.get('/auth', (req, res) => {
  try {
    const authUri = qboClient.getAuthUri();
    res.redirect(authUri);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/callback', async (req, res) => {
  try {
    const result = await qboClient.handleCallback(req.url);
    res.json({ 
      message: 'Autenticación exitosa con QuickBooks Online',
      realmId: result.realmId,
      expiresIn: result.expiresIn
    });
  } catch (error) {
    console.error('Error en callback OAuth:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const { realmId } = await qboClient.getAuthenticatedClient();
    res.json({ connected: true, realmId });
  } catch (error) {
    res.json({ connected: false, error: error.message });
  }
});

router.post('/customers/sync', async (req, res) => {
  try {
    const result = await qboCustomerService.syncCustomers();
    res.json({ 
      message: 'Clientes sincronizados exitosamente',
      ...result
    });
  } catch (error) {
    console.error('Error sincronizando clientes:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/customers', async (req, res) => {
  try {
    const customers = await qboCustomerService.getQBOCustomers();
    res.json({ message: customers });
  } catch (error) {
    console.error('Error obteniendo clientes QBO:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/invoices/process', async (req, res) => {
  try {
    const results = await qboInvoiceService.processPendingInvoices();
    res.json({ 
      message: 'Facturas procesadas',
      results
    });
  } catch (error) {
    console.error('Error procesando facturas:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/invoices/create', async (req, res) => {
  try {
    const invoice = await qboInvoiceService.createInvoice(req.body);
    res.json({ 
      message: 'Factura creada exitosamente',
      invoice
    });
  } catch (error) {
    console.error('Error creando factura:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/items', async (req, res) => {
  try {
    const items = await qboInvoiceService.getQBOItems();
    res.json({ message: items });
  } catch (error) {
    console.error('Error obteniendo items QBO:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/invoices', async (req, res) => {
  try {
    const invoices = await qboInvoiceService.getQBOInvoices();
    res.json({ message: invoices });
  } catch (error) {
    console.error('Error obteniendo facturas QBO:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
