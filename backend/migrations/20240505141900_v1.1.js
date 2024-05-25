exports.up = function(knex) {
    return knex.schema
    .createTable('sbmqb_customers', function (table) {
      table.string('sbmqb_id');
      table.string('name', 300).notNullable();
      table.string('full_name', 300).notNullable();
      table.string('company_name', 300).notNullable();
      table.string('sbmqb_service');
      table.enu('class', ['MARINA', 'EDIFICIO']);
      table.enu('status', ['ACTIVE', 'SUSPENDED', 'TERMINATED']);
    })
    /*.createTable('sbmqb_services', function (table) {
      table.string('sbmqb_id');
      table.string('service', 200).notNullable();
      table.string('description', 400).notNullable();
      table.decimal('price').notNullable();
    })
    .createTable('sbmqb_customer_services', function (table) {
      table.increments('id');
      table.string('sbmqb_customer_id').notNullable();
      table.string('sbmqb_service_id').notNullable();
      table.integer('measurer_id').notNullable();
      table.timestamp('begin_date', { precision: 6 }).defaultTo(knex.fn.now(6));;
      table.timestamp('end_date', { precision: 6 })
      table.enu('status', ['ACTIVE', 'SUSPENDED', 'TERMINATED']);
      //table.foreign('sbmqb_customer_id').references('sbmqb_customers.sbmqb_id').deferrable('deferred');
      //table.foreign('sbmqb_service_id').references('sbmqb_services.sbmqb_id').deferrable('deferred');
    });*/
};

exports.down = function(knex) {
    return knex.schema
    .dropTable('sbmqb_customers')
    //.dropTable('sbmqb_services')
    //.dropTable('sbmqb_customer_services');
};