const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 4747;

app.use(bodyParser.raw({ type: 'text/xml' }));
const tempFSRead = path.join(__dirname, 'AccountQuery.xml');

const AccountQuery = fs.readFileSync(tempFSRead, 'utf8');

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
        const ticket = 'SBM-QBWC-MEASURER-CONSUME-0001';
        callback(null, { authenticateResult: { 'string': [ticket, ''] } });
      },
      sendRequestXML: (args, callback) => {
        console.log("Argumentos que envia el QBWC")
        console.log(args)
        console.log('sendRequestXML called');
        const requestXML = AccountQuery;
        callback(null, { sendRequestXMLResult: requestXML });
      },
      receiveResponseXML: (args, callback) => {
        console.log("Argumentos que envia el QBWC en la respuesta")
        console.log(args)
        console.log('receiveResponseXML called');
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