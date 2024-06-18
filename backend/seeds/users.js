exports.seed = function(knex) {
    // Deletes ALL existing entries
    return knex('users').del()
      .then(function () {
        // Inserts seed entries
        return knex('users').insert([
          {username:'diaz', password: btoa('testPassword.'), role: 'FACTURADOR'},
          {username:'bravo', password: btoa('testPassword'), role: 'OPERADOR'},
          {username:'alpha', password: btoa('testPassword'), role: 'ADMINISTRADOR'},
          {username:'testUser', password: btoa('testPassword'), role: 'ADMINISTRADOR'},
        ]);
      });
  };