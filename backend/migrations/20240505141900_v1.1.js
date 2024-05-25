exports.up = function(knex) {
    return 0
};

exports.down = function(knex) {
    return knex.schema
    //.dropTable('sbmqb_customers')
    //.dropTable('sbmqb_services')
    //.dropTable('sbmqb_customer_services');
};