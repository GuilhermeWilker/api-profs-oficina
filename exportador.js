const db = require('./db');
const XLSX = require('xlsx');

module.exports = function exportarParaExcel() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM usuarios`, [], (err, rows) => {
      if (err) return reject(err);

      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Usuarios');

      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      resolve(buffer);
    });
  });
};
