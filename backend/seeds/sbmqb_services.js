exports.seed = function(knex) {
    // Deletes ALL existing entries
    return knex('sbmqb_services').del()
      .then(function () {
        // Inserts seed entries
        return knex('sbmqb_services').insert([
          {sbmqb_id:70001, service_type: 'Metered electricity', description: '0.415/kW', price: 0.415},
          {sbmqb_id:70002, service_type: 'Metered electricity', description: '0.415/kW -D', price: 0.415},
          {sbmqb_id:70003, service_type: 'Metered electricity', description: '0.21/kW', price: 0.21},
          {sbmqb_id:70004, service_type: 'Metered electricity', description: '0.48/kW', price: 0.48},
        ]);
      });
  };