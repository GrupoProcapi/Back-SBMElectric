exports.up = function(knex) {
    return knex.schema
    .createTable('sbmqb_invoices_read', function (table) {
      table.increments('id');
      table.string('sbmqb_ref_number', 50).notNullable();
      // TxnLineID is the value QuickBooks returns as a globally unique identifier
      // for a single invoice line — used as the idempotency key so re-running the
      // sync (InvoiceQueryRq) never duplicates rows, and invoices with multiple
      // lines are stored one row per line instead of collapsing into one.
      table.string('sbmqb_txn_line_id', 100).notNullable();
      table.string('sbmqb_customer_ref', 255);
      table.date('txn_date');
      table.text('memo');
      table.text('line_desc');
      table.decimal('line_amount', 12, 2);
      table.timestamp('synced_at', { precision: 6 }).defaultTo(knex.fn.now(6));

      table.unique('sbmqb_txn_line_id');
      table.index('sbmqb_ref_number');
    });
};

exports.down = function(knex) {
    return knex.schema
    .dropTable('sbmqb_invoices_read');
};
