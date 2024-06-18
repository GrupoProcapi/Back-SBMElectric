exports.up = function(knex) {
    return knex.schema
    .alterTable('measurements', function(table) {
      table.integer('last_measure_value').alter();
      table.integer('current_measure_value').alter();
    });
};

exports.down = function(knex) {
    return knex.schema
    //.dropTable('sbmqb_invoices')
};