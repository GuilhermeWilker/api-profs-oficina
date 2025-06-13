require('dotenv').config()
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Necessário para Render
});

app.use(cors());
app.use(bodyParser.json());

// Criação das tabelas
const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oficinas (
      id SERIAL PRIMARY KEY,
      nome TEXT,
      local TEXT,
      limite_turno1 INTEGER,
      limite_turno2 INTEGER
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inscricoes (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id),
      oficina_id INTEGER REFERENCES oficinas(id),
      turno TEXT CHECK (turno IN ('turno1', 'turno2')),
      UNIQUE(usuario_id, oficina_id)
    );
  `);
};

initDB();

// Rota para popular oficinas
app.post('/seed', async (req, res) => {
  const oficinas = req.body;
  const client = await pool.connect();
  try {
    for (const o of oficinas) {
      await client.query(
        `INSERT INTO oficinas (nome, local, limite_turno1, limite_turno2)
         VALUES ($1, $2, $3, $4)`,
        [o.nome, o.local, o.limite_turno1, o.limite_turno2]
      );
    }
    res.send('Oficinas inseridas com sucesso');
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/editar-inscricao', async (req, res) => {
  const { email, nova_oficina_id, novo_turno } = req.body;

  if (!['turno1', 'turno2'].includes(novo_turno)) {
    return res.status(400).json({ error: 'Turno inválido' });
  }

  const client = await pool.connect();
  try {
    const usuario = await client.query("SELECT * FROM usuarios WHERE email = $1", [email]);
    if (usuario.rowCount === 0) return res.status(404).json({ error: 'Usuário não encontrado' });

    const user = usuario.rows[0];

    const inscricao = await client.query("SELECT * FROM inscricoes WHERE usuario_id = $1", [user.id]);
    if (inscricao.rowCount === 0) return res.status(404).json({ error: 'Inscrição não encontrada' });

    const i = inscricao.rows[0];
    const campoAntigo = i.turno === 'turno1' ? 'limite_turno1' : 'limite_turno2';
    const campoNovo = novo_turno === 'turno1' ? 'limite_turno1' : 'limite_turno2';

    await client.query(`UPDATE oficinas SET ${campoAntigo} = ${campoAntigo} + 1 WHERE id = $1`, [i.oficina_id]);
    await client.query("DELETE FROM inscricoes WHERE id = $1", [i.id]);

    const novaOficina = await client.query(`SELECT ${campoNovo} FROM oficinas WHERE id = $1`, [nova_oficina_id]);
    if (novaOficina.rowCount === 0) return res.status(404).json({ error: 'Nova oficina não encontrada' });

    if (novaOficina.rows[0][campoNovo] <= 0) {
      return res.status(400).json({ error: 'Limite de vagas atingido na nova oficina' });
    }

    await client.query("INSERT INTO inscricoes (usuario_id, oficina_id, turno) VALUES ($1, $2, $3)",
      [user.id, nova_oficina_id, novo_turno]);

    await client.query(`UPDATE oficinas SET ${campoNovo} = ${campoNovo} - 1 WHERE id = $1`, [nova_oficina_id]);

    res.json({ sucesso: true, mensagem: "Inscrição atualizada com sucesso" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/inscrever', async (req, res) => {
  const { email, nome, oficina_id, turno } = req.body;

  if (!['turno1', 'turno2'].includes(turno)) {
    return res.status(400).json({ error: 'Turno inválido' });
  }

  const client = await pool.connect();
  try {
    let user = await client.query("SELECT * FROM usuarios WHERE email = $1", [email]);
    let userId;

    if (user.rowCount > 0) {
      userId = user.rows[0].id;
    } else {
      const inserted = await client.query(
        "INSERT INTO usuarios (nome, email) VALUES ($1, $2) RETURNING id",
        [nome, email]
      );
      userId = inserted.rows[0].id;
    }

    const exists = await client.query("SELECT * FROM inscricoes WHERE usuario_id = $1 AND oficina_id = $2", [userId, oficina_id]);
    if (exists.rowCount > 0) return res.status(400).json({ error: 'Usuário já inscrito nessa oficina' });

    const campo = turno === 'turno1' ? 'limite_turno1' : 'limite_turno2';
    const oficina = await client.query(`SELECT ${campo} FROM oficinas WHERE id = $1`, [oficina_id]);

    if (oficina.rowCount === 0) return res.status(404).json({ error: 'Oficina não encontrada' });
    if (oficina.rows[0][campo] <= 0) return res.status(400).json({ error: 'Limite de vagas atingido' });

    await client.query("INSERT INTO inscricoes (usuario_id, oficina_id, turno) VALUES ($1, $2, $3)",
      [userId, oficina_id, turno]);

    await client.query(`UPDATE oficinas SET ${campo} = ${campo} - 1 WHERE id = $1`, [oficina_id]);

    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/inscricoes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
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
      JOIN oficinas o ON o.id = i.oficina_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/oficinas', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM oficinas");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/fresh', async (req, res) => {
  try {
    await pool.query("DELETE FROM inscricoes");
    await pool.query("DELETE FROM usuarios");
    await pool.query("DELETE FROM oficinas");
    res.json({ sucesso: true, mensagem: "Tabelas limpas com sucesso" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
