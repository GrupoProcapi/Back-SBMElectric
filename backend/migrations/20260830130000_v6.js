exports.up = function(knex) {
    return knex.schema
    .alterTable('sbmqb_invoices_read', function (table) {
      // ItemRef (nombre del ítem contable de QuickBooks, ej. "1-ELECTRICITY")
      // devuelto por InvoiceLineRet — necesario para determinar sbmqb_service
      // al migrar estos registros a sbmqb_invoices. Nullable porque las
      // 98,282 filas ya sincronizadas quedan en NULL hasta re-sincronizar.
      table.string('item_ref', 255).nullable();
    });
};

exports.down = function(knex) {
    return knex.schema
    .alterTable('sbmqb_invoices_read', function (table) {
      table.dropColumn('item_ref');
    });
};
