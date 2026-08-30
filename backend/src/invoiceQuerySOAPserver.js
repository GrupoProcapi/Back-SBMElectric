const express = require('express');
const bodyParser = require('body-parser');
const xml2js = require('xml2js');
const database = require("./database");

const app = express();

app.use(bodyParser.raw({ type: 'text/xml', limit: '10mb' }));

// Fecha de arranque del rango histórico a reconstruir (se perdió la data en
// producción, este endpoint relee las facturas ya emitidas en QuickBooks
// Desktop para recuperar las lecturas que quedaron guardadas en el Desc de
// cada línea).
const FROM_TXN_DATE = '2024-06-01';

// Usamos un nombre de variable de entorno propio (distinto de
// process.env.iteratorID que ya usa SOAPserver.js para CustomerQueryRq) para
// no pisar la paginación de la app existente si corren al mismo tiempo.
function getTodayISODate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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
        const ticket = 'SBM-QBWC-INVOICE-READ-0001';
        callback(null, { authenticateResult: { 'string': [ticket, ''] } });
      },
      sendRequestXML: (args, callback) => {
        console.log("Argumentos que envia el QBWC")
        console.log(args)
        console.log("process.env.invoiceQueryIteratorID")
        console.log(process.env.invoiceQueryIteratorID)
        console.log('sendRequestXML called');
        if (process.env.invoiceQueryIteratorID != "" && process.env.invoiceQueryIteratorID) {
          var iteratorID = `iteratorID="${process.env.invoiceQueryIteratorID}"`
          var iterator = 'iterator="Continue"'
        } else {
          var iteratorID = ''
          var iterator = 'iterator="Start"'
        }

        const toTxnDate = getTodayISODate();

        const requestXML = `<?xml version="1.0" encoding="utf-8"?>
        <?qbxml version="7.0"?>
        <QBXML>
          <QBXMLMsgsRq onError="continueOnError">
            <InvoiceQueryRq requestID="1" ${iterator} ${iteratorID}>
              <MaxReturned>100</MaxReturned>
              <TxnDateRangeFilter>
                <FromTxnDate>${FROM_TXN_DATE}</FromTxnDate>
                <ToTxnDate>${toTxnDate}</ToTxnDate>
              </TxnDateRangeFilter>
              <IncludeLineItems>true</IncludeLineItems>
              <IncludeRetElement>TxnID</IncludeRetElement>
              <IncludeRetElement>RefNumber</IncludeRetElement>
              <IncludeRetElement>TxnDate</IncludeRetElement>
              <IncludeRetElement>CustomerRef</IncludeRetElement>
              <IncludeRetElement>Memo</IncludeRetElement>
              <IncludeRetElement>TxnLineID</IncludeRetElement>
              <IncludeRetElement>Desc</IncludeRetElement>
              <IncludeRetElement>Amount</IncludeRetElement>
              <IncludeRetElement>ItemRef</IncludeRetElement>
            </InvoiceQueryRq>
          </QBXMLMsgsRq>
        </QBXML>`;
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
            callback(null, { receiveResponseXMLResult: 100 });
            return;
          }

          // Result contiene el objeto JavaScript convertido desde el XML
          console.log('Datos XML convertidos a objeto JavaScript:', result);

          try {
            const invoiceQueryRs = result.QBXML.QBXMLMsgsRs[0].InvoiceQueryRs[0];
            const statusMessage = invoiceQueryRs.$.statusMessage;
            console.log('InvoiceQueryRs statusMessage: ' + statusMessage);

            const invoiceRetList = invoiceQueryRs.InvoiceRet || [];
            /**
             * Una InvoiceRet típica (con IncludeLineItems=true) trae, entre otros:
             * {
             *   TxnID: [...],
             *   RefNumber: [ '208355' ],
             *   TxnDate: [ '2024-07-15' ],
             *   CustomerRef: [ { ListID: [...], FullName: [...] } ],
             *   Memo: [ '...' ],
             *   InvoiceLineRet: [
             *     {
             *       TxnLineID: [ '...' ],
             *       Desc: [ 'DOCK    A1\nINITIAL 100\nFINAL   200\nUSED    100 KWTS\n...' ],
             *       Amount: [ '48.00' ]
             *     }
             *   ]
             * }
             */
            const upsertPromises = [];

            invoiceRetList.forEach((invoiceRet) => {
              const refNumber = invoiceRet.RefNumber ? invoiceRet.RefNumber[0] : null;
              const txnDate = invoiceRet.TxnDate ? invoiceRet.TxnDate[0] : null;
              const memo = invoiceRet.Memo ? invoiceRet.Memo[0] : null;
              const customerRef = invoiceRet.CustomerRef && invoiceRet.CustomerRef[0]
                ? (invoiceRet.CustomerRef[0].FullName
                    ? invoiceRet.CustomerRef[0].FullName[0]
                    : (invoiceRet.CustomerRef[0].ListID ? invoiceRet.CustomerRef[0].ListID[0] : null))
                : null;

              const lineRetList = invoiceRet.InvoiceLineRet || [];

              lineRetList.forEach((lineRet) => {
                const txnLineId = lineRet.TxnLineID ? lineRet.TxnLineID[0] : null;
                if (!txnLineId) {
                  // Sin TxnLineID no podemos garantizar idempotencia, se descarta.
                  console.log({ message: 'Línea de factura sin TxnLineID, se omite. RefNumber:' + refNumber });
                  return;
                }
                const lineDesc = lineRet.Desc ? lineRet.Desc[0] : null;
                const lineAmount = lineRet.Amount ? lineRet.Amount[0] : null;
                const itemRef = lineRet.ItemRef && lineRet.ItemRef[0]
                  ? (lineRet.ItemRef[0].FullName
                      ? lineRet.ItemRef[0].FullName[0]
                      : (lineRet.ItemRef[0].ListID ? lineRet.ItemRef[0].ListID[0] : null))
                  : null;

                const upsertPromise = database.raw(
                  `INSERT INTO sbmqb_invoices_read
                    (sbmqb_ref_number, sbmqb_txn_line_id, sbmqb_customer_ref, txn_date, memo, line_desc, line_amount, item_ref)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON DUPLICATE KEY UPDATE
                    sbmqb_ref_number = VALUES(sbmqb_ref_number),
                    sbmqb_customer_ref = VALUES(sbmqb_customer_ref),
                    txn_date = VALUES(txn_date),
                    memo = VALUES(memo),
                    line_desc = VALUES(line_desc),
                    line_amount = VALUES(line_amount),
                    item_ref = VALUES(item_ref),
                    synced_at = CURRENT_TIMESTAMP`,
                  [refNumber, txnLineId, customerRef, txnDate, memo, lineDesc, lineAmount, itemRef]
                )
                .then(() => console.log({ message: 'sbmqb_invoices_read upserted. TxnLineID:' + txnLineId }))
                .catch((error) => console.log({ message: 'Error insertando TxnLineID ' + txnLineId, error: error.message }));

                upsertPromises.push(upsertPromise);
              });
            });

            Promise.all(upsertPromises).then(() => {
              console.log("Resultado de iteratorRemainingCount")
              console.log(invoiceQueryRs.$.iteratorRemainingCount)
              if (!invoiceQueryRs.$.iteratorRemainingCount || invoiceQueryRs.$.iteratorRemainingCount == '0') {
                process.env.invoiceQueryIteratorID = ""
                callback(null, { receiveResponseXMLResult: 100 });
              } else {
                process.env.invoiceQueryIteratorID = invoiceQueryRs.$.iteratorID
                callback(null, { receiveResponseXMLResult: 1 });
              }
            });
          } catch (error) {
            // Sin InvoiceQueryRs (ej. onError continueOnError sin resultados) o
            // sin más facturas que leer: terminamos la corrida sin romper QBWC.
            console.log({ message: 'receiveResponseXML sin InvoiceQueryRs procesable', error: error.message });
            process.env.invoiceQueryIteratorID = ""
            callback(null, { receiveResponseXMLResult: 100 });
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

module.exports = { invoiceQuerySOAP: app, invoiceQueryService: service };
