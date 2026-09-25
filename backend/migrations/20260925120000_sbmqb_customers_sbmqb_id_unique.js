// Adds a UNIQUE index on sbmqb_customers.sbmqb_id.
//
// Why: syncCustomers() (qboCustomerService.js) now auto-creates local rows
// for QBO-only customers, guarding duplicates only with an in-memory Set
// computed once at the start of the run. Two overlapping non-dry-run syncs
// could each insert a row with the same synthetic sbmqb_id (`QBO-<id>`)
// before either commits, and nothing at the DB layer would stop it. This
// index makes that scenario fail loudly (ER_DUP_ENTRY) instead of silently
// creating duplicate customer rows.
//
// sbmqb_id stays nullable -- MySQL/MariaDB (InnoDB) allows any number of
// NULLs in a UNIQUE index; NULL is never compared equal to another NULL for
// uniqueness purposes. Verified locally against an ephemeral MariaDB 13.0.2
// instance restored from the 2026-09-24 production snapshot (7,566 rows,
// zero NULLs, zero duplicate non-null sbmqb_id values) before writing this
// migration.
exports.up = (knex) => knex.schema.alterTable('sbmqb_customers', (table) => {
  table.unique('sbmqb_id', 'sbmqb_customers_sbmqb_id_unique');
});

exports.down = (knex) => knex.schema.alterTable('sbmqb_customers', (table) => {
  table.dropUnique('sbmqb_id', 'sbmqb_customers_sbmqb_id_unique');
});
