const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const db = new sqlite3.Database('dados.sqlite');
const PORT = 4000;

app.use(cors());
app.use(bodyParser.json());

// Criação das tabelas

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS oficinas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    local TEXT,
    limite_turno1 INTEGER,
    limite_turno2 INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS inscricoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER,
    oficina_id INTEGER,
    turno TEXT CHECK(turno IN ('turno1', 'turno2')),
    UNIQUE(usuario_id, oficina_id),
    FOREIGN KEY(usuario_id) REFERENCES usuarios(id),
    FOREIGN KEY(oficina_id) REFERENCES oficinas(id)
  )`);
});

// Rota para popular oficinas (executar uma vez)
app.post('/seed', (req, res) => {
  const oficinas = req.body;
  db.serialize(() => {
    const stmt = db.prepare(`INSERT INTO oficinas (nome, local, limite_turno1, limite_turno2) VALUES (?, ?, ?, ?)`);
    oficinas.forEach(o => {
      stmt.run(o.nome, o.local, o.limite_turno1, o.limite_turno2);
    });
    stmt.finalize();
  });
  res.send('Oficinas inseridas com sucesso');
});

app.post('/editar-inscricao', (req, res) => {
  const { email, nova_oficina_id, novo_turno } = req.body;

  if (!['turno1', 'turno2'].includes(novo_turno)) {
    return res.status(400).json({ error: 'Turno inválido' });
  }

  db.get("SELECT * FROM usuarios WHERE email = ?", [email], (err, usuario) => {
    if (err || !usuario) return res.status(404).json({ error: 'Usuário não encontrado' });

    db.get("SELECT * FROM inscricoes WHERE usuario_id = ?", [usuario.id], (err, inscricao) => {
      if (err || !inscricao) return res.status(404).json({ error: 'Inscrição atual não encontrada' });

      const campoAntigo = inscricao.turno === 'turno1' ? 'limite_turno1' : 'limite_turno2';
      const campoNovo = novo_turno === 'turno1' ? 'limite_turno1' : 'limite_turno2';

      db.serialize(() => {
        // 1. Restaurar vaga na oficina antiga
        db.run(`UPDATE oficinas SET ${campoAntigo} = ${campoAntigo} + 1 WHERE id = ?`, [inscricao.oficina_id]);

        // 2. Remover inscrição anterior
        db.run("DELETE FROM inscricoes WHERE id = ?", [inscricao.id]);

        // 3. Verificar se há vaga na nova oficina
        db.get(`SELECT ${campoNovo} as limite FROM oficinas WHERE id = ?`, [nova_oficina_id], (err, novaOficina) => {
          if (err || !novaOficina) return res.status(404).json({ error: 'Nova oficina não encontrada' });

          if (novaOficina.limite <= 0) {
            return res.status(400).json({ error: 'Limite de vagas atingido na nova oficina' });
          }

          // 4. Criar nova inscrição
          db.run("INSERT INTO inscricoes (usuario_id, oficina_id, turno) VALUES (?, ?, ?)",
            [usuario.id, nova_oficina_id, novo_turno], function (err) {
              if (err) return res.status(500).json({ error: err.message });

              // 5. Decrementar vaga da nova oficina
              db.run(`UPDATE oficinas SET ${campoNovo} = ${campoNovo} - 1 WHERE id = ?`, [nova_oficina_id]);

              res.json({ sucesso: true, mensagem: "Inscrição atualizada com sucesso" });
            });
        });
      });
    });
  });
});

// Inscrição com decremento de vagas
app.post('/inscrever', (req, res) => {
  const { email, nome, oficina_id, turno } = req.body;

  if (!['turno1', 'turno2'].includes(turno)) {
    return res.status(400).json({ error: 'Turno inválido' });
  }

  db.get("SELECT * FROM usuarios WHERE email = ?", [email], (err, usuario) => {
    if (err) return res.status(500).json({ error: err.message });

    const continuar = (usuarioId) => {
      db.get("SELECT * FROM inscricoes WHERE usuario_id = ? AND oficina_id = ?", [usuarioId, oficina_id], (err, inscricao) => {
        if (err) return res.status(500).json({ error: err.message });
        if (inscricao) return res.status(400).json({ error: 'Usuário já inscrito nessa oficina' });

        const campoLimite = turno === 'turno1' ? 'limite_turno1' : 'limite_turno2';

        db.get(`SELECT ${campoLimite} as limite FROM oficinas WHERE id = ?`, [oficina_id], (err, oficina) => {
          if (err) return res.status(500).json({ error: err.message });
          if (!oficina) return res.status(404).json({ error: 'Oficina não encontrada' });

          if (oficina.limite <= 0) {
            return res.status(400).json({ error: 'Limite de vagas atingido nesse turno' });
          }

          // Inserir a inscrição
          db.run("INSERT INTO inscricoes (usuario_id, oficina_id, turno) VALUES (?, ?, ?)", [usuarioId, oficina_id, turno], function (err) {
            if (err) return res.status(500).json({ error: err.message });

            // Decrementar o limite do turno
            db.run(`UPDATE oficinas SET ${campoLimite} = ${campoLimite} - 1 WHERE id = ?`, [oficina_id], function (err) {
              if (err) return res.status(500).json({ error: 'Erro ao atualizar limite da oficina' });
              res.json({ sucesso: true });
            });
          });
        });
      });
    };

    if (usuario) {
      continuar(usuario.id);
    } else {
      db.run("INSERT INTO usuarios (nome, email) VALUES (?, ?)", [nome, email], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        continuar(this.lastID);
      });
    }
  });
});

// Listar inscrições com horários legíveis
app.get('/inscricoes', (req, res) => {
  db.all(`SELECT
            u.nome,
            u.email,
            o.nome as oficina,
            o.local,
            CASE
              WHEN i.turno = 'turno1' THEN '9h30 às 11h30'
              WHEN i.turno = 'turno2' THEN '11h30 às 13h30'
              ELSE i.turno
            END as horario
          FROM inscricoes i
          JOIN usuarios u ON u.id = i.usuario_id
          JOIN oficinas o ON o.id = i.oficina_id`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Rota para listar todas as oficinas
app.get('/oficinas', (req, res) => {
  db.all(`SELECT
            id,
            nome,
            local,
            limite_turno1,
            limite_turno2
          FROM oficinas`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/fresh', (req, res) => {
  db.serialize(() => {
    db.run("DELETE FROM inscricoes");
    db.run("DELETE FROM usuarios");
    db.run("DELETE FROM oficinas", (err) => {
      if (err) return res.status(500).json({ error: 'Erro ao apagar oficinas' });
      res.json({ sucesso: true, mensagem: "Todas as tabelas foram limpas com sucesso" });
    });
  });
});

app.use(express.json());
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
