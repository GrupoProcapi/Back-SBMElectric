exports.up = function(knex) {
    return knex.schema
    .table('measurements', function (table) {
      table.string('sbmqb_customer_name', 500).nullable().alter();
      table.string('description', 300).notNullable().alter();
      table.decimal('total_measure_value');
      table.integer('sbmqb_invoices_id');
    })
    .createTable('sbmqb_invoices', function (table) {
      table.increments('id');
      table.string('sbmqb_customer_name', 500);
      table.string('sbmqb_service').notNullable();
      table.string('measurer_code', 255).notNullable();
      table.decimal('initial_measure_value').notNullable();
      table.decimal('current_measure_value').notNullable();
      table.decimal('total_measure_value').notNullable();
      table.timestamp('begin_date', { precision: 6 });
      table.timestamp('end_date', { precision: 6 })
      table.enu('status', ['PENDIENTE', 'PROCESANDO', 'FACTURADO']);
      table.string('sbmqb_invoice_id');
    });;
};

exports.down = function(knex) {
    return knex.schema
    //.dropTable('sbmqb_invoices')
};