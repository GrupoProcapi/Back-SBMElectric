/**
 * Migration: QuickBooks Online Integration
 * - Creates qbo_tokens table for OAuth tokens storage
 * - Adds qbo_id column to sbmqb_customers for mapping QBO customers
 */
exports.up = function(knex) {
    return knex.schema
        .createTable('qbo_tokens', function(table) {
            table.increments('id');
            table.string('realm_id', 100).notNullable();
            table.text('access_token').notNullable();
            table.text('refresh_token').notNullable();
            table.timestamp('token_expiry');
            table.timestamp('refresh_token_expiry');
            table.timestamp('created_at').defaultTo(knex.fn.now());
            table.timestamp('updated_at').defaultTo(knex.fn.now());
        })
        .table('sbmqb_customers', function(table) {
            table.string('qbo_id', 100);
        });
};

exports.down = function(knex) {
    return knex.schema
        .dropTableIfExists('qbo_tokens')
        .table('sbmqb_customers', function(table) {
            table.dropColumn('qbo_id');
        });
};
