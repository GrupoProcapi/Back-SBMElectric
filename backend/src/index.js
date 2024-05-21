const app = require("./server");
const { appSOAP, service }  = require("./SOAPserver");
const { invoiceSOAP, invoiceService }  = require("./invoiceSOAPserver");
const { port, portSOAP} = require("./config");
const soap = require('soap');
const fs = require('fs');
const path = require('path');

const server = app.listen(port, function() {
  console.log("Webserver is ready");
});

const wsdlPath = path.join(__dirname, 'qbwebconnector.wsdl');

const xml = fs.readFileSync(wsdlPath, 'utf8');

const serverSOAP = appSOAP.listen(portSOAP, () => {
  console.log(`SOAP server listening on port ${portSOAP}`);
});

soap.listen(appSOAP, '/qbwc', service, xml);
soap.listen(invoiceSOAP, '/invoice', invoiceService, xml);

//
// need this in docker container to properly exit since node doesn't handle SIGINT/SIGTERM
// this also won't work on using npm start since:
// https://github.com/npm/npm/issues/4603
// https://github.com/npm/npm/pull/10868
// https://github.com/RisingStack/kubernetes-graceful-shutdown-example/blob/master/src/index.js
// if you want to use npm then start with `docker run --init` to help, but I still don't think it's
// a graceful shutdown of node process
//

// quit on ctrl-c when running docker in terminal
process.on("SIGINT", function onSigint() {
  console.info(
    "Got SIGINT (aka ctrl-c in docker). Graceful shutdown ",
    new Date().toISOString()
  );
  shutdown();
});

// quit properly on docker stop
process.on("SIGTERM", function onSigterm() {
  console.info(
    "Got SIGTERM (docker container stop). Graceful shutdown ",
    new Date().toISOString()
  );
  shutdown();
});

// shut down server
function shutdown() {
  server.close(function onServerClosed(err) {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    process.exit(0);
  });
}
//
// need above in docker container to properly exit
//
