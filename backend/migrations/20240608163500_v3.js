exports.up = function(knex) {
    return knex.schema
    .table('measurers', function (table) {
      table.string('muelle', 100);
    })
};

exports.down = function(knex) {
    return knex.schema
    //.dropTable('sbmqb_invoices')
};