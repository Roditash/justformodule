const { initializeDb } = require('./db');

initializeDb()
  .then(() => {
    console.log('Base de datos de Neon inicializada.');
  })
  .catch((error) => {
    console.error('No se pudo inicializar la base de datos:', error.message);
    process.exitCode = 1;
  });
