/**
 * Archivo de conexion a la base de datos para las migraciones
 * para seleccionar el tipo de objeto debes mapearlo con el compose.yaml en la seccion de NODE_ENV
 * de momento dice development
 */

    const fs = require("fs");

    const readFileSync = filename => fs.readFileSync(filename).toString("utf8");
    const { database } = require('./src/config');

  module.exports = {
  
    local: {
      client: 'sqlite3',
      connection: { 
        filename: './dev.sqlite3'
      }
    },
  
    development: {
      client: 'mysql2',
      connection: database,
      pool: {
        min: 2,
        max: 10
      },
      migrations: {
        tableName: 'knex_migrations'
      }
    },
  
    production: {
      client: 'postgresql',
      connection: {
        database: 'my_db',
        user:     'username',
        password: 'password'
      },
      pool: {
        min: 2,
        max: 10
      },
      migrations: {
        tableName: 'knex_migrations'
      }
    }
  
  };