const http = require("http");

const options = {
  timeout: 2000,
  host: "localhost",
  port: process.env.PORT || 8080,
  path: "/healthz", // must be the same as HEALTHCHECK in Dockerfile
  headers: {
    'api-key': 'a2a47f86-c361-4fed-98ec-6b36eeef0266'
  }
};

const request = http.request(options, res => {
  console.info("STATUS: " + res.statusCode);
  process.exitCode = res.statusCode === 200 ? 0 : 1;
  process.exit();
});

request.on("error", function(err) {
  console.error("ERROR", err);
  process.exit(1);
});

request.end();
