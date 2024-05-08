exports.seed = function(knex) {
    // Deletes ALL existing entries
    return knex('measurers').del()
      .then(function () {
        // Inserts seed entries
        return knex('measurers').insert([
          {pedestal:'Pedestal East No.1', pedestal_id: '2024', measurer_code: '12345678901'},
          {pedestal:'Pedestal West No.1', pedestal_id: '2025', measurer_code: '12345678902'},
          {pedestal:'Pedestal South No.1', pedestal_id: '2026', measurer_code: '12345678903'},
        ]);
      });
  };