exports.up = function(knex) {
    return knex.schema
    .table('measurements', function (table) {
      table.string('sbmqb_customer_name', 500).nullable().alter();
      table.string('description', 300).notNullable().alter();
      table.decimal('total_measure_value');
      table.integer('sbmqb_invoices_id');
    })
    .table('measurers', function (table) {
      table.string('muelle', 100);
    })
};

exports.down = function(knex) {
    return knex.schema
    //.dropTable('sbmqb_invoices')
};