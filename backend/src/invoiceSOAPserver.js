const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const database = require("./database");

const app = express();

app.use(bodyParser.raw({ type: 'text/xml',limit: '10mb' }));
const tempFSRead = path.join(__dirname, 'InvoiceAdd.xml');

const InvoiceAdd = fs.readFileSync(tempFSRead, 'utf8');

const service = {
  QBWebConnectorSvc: {
    QBWebConnectorSvcSoap: {
      // Implementación de los métodos necesarios
      serverVersion: (args, callback) => {
        console.log('serverVersion called');
        callback(null, { serverVersionResult: '1.0' });
      },
      clientVersion: (args, callback) => {
        console.log('clientVersion called');
        callback(null, { clientVersionResult: { 'statusCode': '', 'message': '' } });
      },
      authenticate: (args, callback) => {
        console.log('authenticate called');
        const ticket = 'SBM-QBWC-MEASURER-CONSUME-INVOICE-0001';
        callback(null, { authenticateResult: { 'string': [ticket, ''] } });
      },
      sendRequestXML: (args, callback) => {
        console.log("Argumentos que envia el QBWC")
        console.log(args)
        console.log('sendRequestXML called');
        const requestXML = InvoiceAdd;
        console.log('XML que enviamos')
        console.log(requestXML)
        callback(null, { sendRequestXMLResult: requestXML });
      },
      receiveResponseXML: (args, callback) => {
        console.log("Argumentos que envia el QBWC en la respuesta")
        console.log(args)
        console.log('receiveResponseXML called');

        xml2js.parseString(args.response, (err, result) => {
          if (err) {
            console.error('Error al parsear el XML:', err);
            res.status(500).send('Error interno del servidor');
            return;
          }
      
          // Result contiene el objeto JavaScript convertido desde el XML
          console.log('Datos XML convertidos a objeto JavaScript:', result);
	        //console.log(result.QBXML.QBXMLMsgsRs[0].AccountQueryRs)
	
        });

        const response = 100; // Percent done
        callback(null, { receiveResponseXMLResult: response });
      },
      connectionError: (args, callback) => {
        console.log('connectionError called');
        const errorMessage = 'connection error';
        callback(null, { connectionErrorResult: errorMessage });
      },
      getLastError: (args, callback) => {
        console.log('getLastError called');
        const lastError = 'No error';
        callback(null, { getLastErrorResult: lastError });
      },
      closeConnection: (args, callback) => {
        console.log('closeConnection called');
        const closeConnectionMessage = 'Connection closed';
        callback(null, { closeConnectionResult: closeConnectionMessage });
      }
    }
  }
};


app.post('/wsdl', (req, res) => {
  res.send(xml);
});

module.exports = {appSOAP:app, service:service};
