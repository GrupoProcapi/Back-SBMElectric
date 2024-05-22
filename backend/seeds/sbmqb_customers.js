exports.seed = function(knex) {
    // Deletes ALL existing entries
    return knex('sbmqb_customers').del()
      .then(function () {
        // Inserts seed entries
        return knex('sbmqb_customers').insert([
          {
            sbmqb_id: "80001286-1639401114",
            name: "2 FAST 4 YOU, Vienna Cat LTD.",
            full_name: "2 FAST 4 YOU, Vienna Cat LTD.",
            company_name: "2 FAST 4 YOU, Vienna Cat LTD.",
            class: "MARINA",
            status: "ACTIVE"
          },
          {
            sbmqb_id: "80001286-16394",
            name: "Test BK - 1",
            full_name: "Test BK - 1",
            company_name: "Test BK - 1",
            class: "MARINA",
            status: "ACTIVE"
          }
        ]);
      });
  };