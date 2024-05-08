exports.up = function(knex) {
    return knex.schema
    .createTable('users', function (table) {
      table.increments('id');
      table.string('username', 75).notNullable();
      table.string('password', 512).notNullable();
      table.enu('role', ['OPERADOR', 'FACTURADOR', 'ADMINISTRADOR']);
    })
    .createTable('measurers', function (table) {
      table.increments('id');
      table.string('pedestal', 100).notNullable();
      table.string('pedestal_id', 100).notNullable();
      table.string('measurer_code', 255).notNullable();
    })
    .createTable('measurements', function (table) {
      table.increments('id');
      table.integer('user_id', 100).notNullable();
      table.integer('measurer_id', 100).notNullable();
      table.string('customer_sbm', 500).notNullable();
      table.decimal('last_measure_value').notNullable();
      table.timestamp('last_measure_date', { precision: 6 });
      table.decimal('current_measure_value').notNullable();
      table.timestamp('current_measure_date', { precision: 6 }).defaultTo(knex.fn.now(6));
      table.enu('status', ['PENDIENTE', 'PROCESANDO', 'FACTURADO']);
      //table.foreign('user_id').references('users.id').deferrable('deferred');
      //table.foreign('measurer_id').references('measurers.id').deferrable('deferred');
    });
};

exports.down = function(knex) {
    return knex.schema
    .dropTable('users')
    .dropTable('measurements')
    .dropTable('measurers');
};