exports.seed = function(knex) {
    // Deletes ALL existing entries
    return knex('users').del()
      .then(function () {
        // Inserts seed entries
        return knex('users').insert([
          {username:'diaz', password: btoa('PA123.'), rol: 'FACTURADOR'},
          {username:'bravo', password: btoa('1.'), rol: 'OPERADOR'},
          {username:'alpha', password: btoa('sbm'), rol: 'ADMINISTRADOR'},
        ]);
      });
  };