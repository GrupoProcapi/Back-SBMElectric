const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const database = require("./database");

const app = express();

app.use(bodyParser.raw({ type: 'text/xml',limit: '10mb' }));
const tempFSRead = path.join(__dirname, 'CustomerQuery.xml');

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
	

	        if (result.QBXML.QBXMLMsgsRs[0].CustomerQueryRs[0].$.statusMessage == 'Status OK') {
            result.QBXML.QBXMLMsgsRs[0].CustomerQueryRs[0].CustomerRet.forEach(element => {
              console.log(element)
              /**
               * {
                    ListID: [ '800013C8-1645199437' ],
                    TimeCreated: [ '2022-02-18T10:50:37-05:00' ],
                    TimeModified: [ '2022-09-27T14:30:24-05:00' ],
                    EditSequence: [ '1664307024' ],
                    Name: [ 'ZULLU' ],
                    FullName: [ 'ZULLU' ],
                    IsActive: [ 'true' ],
                    Sublevel: [ '0' ],
                    CompanyName: [ 'ZULLU, Capitole Finance Tofinso' ],
                    BillAddress: [ [Object] ],
                    BillAddressBlock: [ [Object] ],
                    Phone: [ '+33606850292' ],
                    Contact: [ '_' ],
                    AltContact: [ '_' ],
                    Balance: [ '0.00' ],
                    TotalBalance: [ '0.00' ],
                    SalesTaxCodeRef: [ [Object] ],
                    ItemSalesTaxRef: [ [Object] ],
                    JobStatus: [ 'None' ]
                  }

                  XML
                  '<CustomerRet>\n' +
    '<ListID>800013C8-1645199437</ListID>\n' +
    '<TimeCreated>2022-02-18T10:50:37-05:00</TimeCreated>\n' +
    '<TimeModified>2022-09-27T14:30:24-05:00</TimeModified>\n' +
    '<EditSequence>1664307024</EditSequence>\n' +
    '<Name>ZULLU</Name>\n' +
    '<FullName>ZULLU</FullName>\n' +
    '<IsActive>true</IsActive>\n' +
    '<Sublevel>0</Sublevel>\n' +
    '<CompanyName>ZULLU, Capitole Finance Tofinso</CompanyName>\n' +
    '<BillAddress>\n' +
    '<Addr1>ZULLU, Capitole Finance- Tofinso</Addr1>\n' +
    '<State>Capitole</State>\n' +
    '<Note>39 BD mondou 34510 florensac</Note>\n' +
    '</BillAddress>\n' +
    '<BillAddressBlock>\n' +
    '<Addr1>ZULLU, Capitole Finance- Tofinso</Addr1>\n' +
    '<Addr2>39 BD mondou 34510 florensac</Addr2>\n' +
    '</BillAddressBlock>\n' +
    '<Phone>+33606850292</Phone>\n' +
    '<Contact>_</Contact>\n' +
    '<AltContact>_</AltContact>\n' +
    '<Balance>0.00</Balance>\n' +
    '<TotalBalance>0.00</TotalBalance>\n' +
    '<SalesTaxCodeRef>\n' +
    '<ListID>80000003-1663700909</ListID>\n' +
    '<FullName>7%</FullName>\n' +
    '</SalesTaxCodeRef>\n' +
    '<ItemSalesTaxRef>\n' +
    '<ListID>80002244-1664293716</ListID>\n' +
    '<FullName>7%</FullName>\n' +
    '</ItemSalesTaxRef>\n' +
    '<JobStatus>None</JobStatus>\n' +
    '</CustomerRet>\n' +
               */
              
                  try {
                    //Verification
                    database.raw(`SELECT * FROM sbmqb_customers WHERE sbmqb_id = "${element.ListID[0]}" AND STATUS = "ACTIVE"`)
                    .then(([rows]) => rows[0])
                    .then((row) => {
                      if (!row) {

                        var companyName = ""
                        if (element.CompanyName)
                          companyName = element.CompanyName[0]

                        var status =  element.IsActive[0] ? "ACTIVE" : "SUSPENDED"
                        database.raw(`INSERT INTO sbmqb_customers (sbmqb_id, name, full_name, company_name, class, status) VALUES("${element.ListID[0]}", "${element.Name[0]}" , "${element.FullName[0]}", "${companyName}", "MARINA", "${status}")`)
                        .then(([line]) => line[0])
                        .then((line) => console.log({message : "sbmqb_customers Created. CustomerID:" + element.ListID[0]}))
                        .catch(console.log({message : "Error Insertando " + element.ListID[0]}));
                      } else {
                        console.log({message : "sbmqb_customers Exist. CustomerID:" + element.ListID[0]})
                      }
                    })
                    .catch(console.log({message : "Error seleccionando " + element.ListID[0]}));
                  } catch (err) {
                    console.log({ message: err.message });
                  }
            });
          }
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
