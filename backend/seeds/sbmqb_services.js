exports.seed = function(knex) {
    // Deletes ALL existing entries
    return knex('sbmqb_services').del()
      .then(function () {
        // Inserts seed entries
        return knex('sbmqb_services').insert([
          {sbmqb_id:"800022E5-1674049814", service: '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70004-Electricity T. @ 0.48/KW', description: '70004-Electricity T. @ 0.48/KW', price: 0.48},
          {sbmqb_id:"80000477-1559623735", service: '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70003-Metered elect. @ 0.21/KW', description: '70003-Metered elect. @ 0.21/KW', price: 0.21},
          {sbmqb_id:"80000476-1559623735", service: '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70002-Metered elect. @ 0.415/KW', description: '70002-Metered elect. @ 0.415/KW', price: 0.415},
          {sbmqb_id:"80000475-1559623734", service: '4113 &#183; INGRESOS ELECTRIDIDAD:70000:70001-Metered elect. @ 0.415/KW', description: '70001-Metered elect. @ 0.415/KW', price: 0.415},
        ]);
      });
  };