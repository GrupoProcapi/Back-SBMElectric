const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const database = require("./database");

const app = express();

app.use(bodyParser.raw({ type: 'text/xml',limit: '10mb' }));

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
        const ticket = "PROCESANDO-REGISTROS-MEDIDAS";
        callback(null, { authenticateResult: { 'string': [ticket, ''] } });
      },
      sendRequestXML: (args, callback) => {
        console.log("Argumentos que envia el QBWC")
        console.log(args)
        console.log('sendRequestXML called');
        console.log('XML que enviamos')
        
        //Sacar una medida pendiente a facturar
        try {
          database.raw(`SELECT * FROM measurements WHERE status = "PENDIENTE" LIMIT 1`)
          .then(([rows, columns]) => rows[0])
          .then((rows) => {
            //No hay solicitudes pendientes
            if (!rows) {
              callback(null, { sendRequestXMLResult: "" });
              return
            }
            //Mapear variables
            const today = new Date();
            const year = today.getFullYear();
            const month = String(today.getMonth() + 1).padStart(2, '0');
            const day = String(today.getDate()).padStart(2, '0');
            var date=`${year}-${month}-${day}`;
            var fullName =  rows.sbmqb_customer_name 
            var description = rows.description
            var qty = rows.current_measure_value - rows.last_measure_value
            var rate = rows.sbmqb_service
            const requestXML = `<?xml version="1.0" encoding="utf-8"?>
            <?qbxml version="7.0"?>
            <QBXML>
              <QBXMLMsgsRq onError="stopOnError">
                <InvoiceAddRq requestID = "${rows.id}">
                  <InvoiceAdd defMacro = "TxnID:NewInvoice">
                    <CustomerRef>
                      <FullName>${fullName}</FullName>
                    </CustomerRef>
                    <TemplateRef>
                      <ListID>8000001A-1559700385</ListID>
                      <FullName>SHELTER BAY INVOICE2019</FullName>
                    </TemplateRef>
                    <TxnDate>${date}</TxnDate>
                    <InvoiceLineAdd>
                      <ItemRef>
                        <FullName>${rate}</FullName>
                      </ItemRef>
                      <Desc>${description}</Desc>
                      <Quantity >${qty}</Quantity>
                    </InvoiceLineAdd>
                  </InvoiceAdd>
                </InvoiceAddRq>
              </QBXMLMsgsRq>
            </QBXML>`;
            console.log(requestXML)       
            callback(null, { sendRequestXMLResult: requestXML });
          })

        } catch (err) {
          console.log({ message: err.message });
        }
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
	        // Verificando si existen medidas pendientes por procesar usando result
          
          try {
            if (result.QBXML.QBXMLMsgsRs[0].InvoiceAddRs[0].$.statusMessage == 'Status OK') {
              //Update registro
              database.raw(`UPDATE measurements SET status = "FACTURADO" WHERE id = ${result.QBXML.QBXMLMsgsRs[0].InvoiceAddRs[0].$.requestID}`)
              .then(([rows]) => rows[0])
              .then((row) => {
                //Actualizado decide si continuar o no
                database.raw('SELECT * FROM measurements WHERE status = "PENDIENTE" LIMIT 1')
                .then(([rows]) => rows[0])
                .then((row) => row ?  1 : 0)
                .then((response) => {
                  callback(null, { receiveResponseXMLResult: response })
                })
              })
            } 
          } catch (err) {
            res.status(500).json({ message: err.message });
          }
        });
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

module.exports = {invoiceSOAP:app, invoiceService:service};
