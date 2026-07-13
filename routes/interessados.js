const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const lixeira = require('../lib/lixeira');

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interessados (
      id           SERIAL PRIMARY KEY,
      nome         VARCHAR(100) NOT NULL,
      whatsapp     VARCHAR(20),
      curso        VARCHAR(100),
      turno        VARCHAR(20),
      motivo       VARCHAR(100),
      obs          TEXT,
      reserva_id   INTEGER,
      criado_em    TIMESTAMP DEFAULT NOW()
    )
  `);
}
migrate();
/* Adiciona tem_notebook se não existir */
pool.query("ALTER TABLE interessados ADD COLUMN IF NOT EXISTS tem_notebook BOOLEAN DEFAULT false").catch(()=>{});

router.get('/', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM interessados ORDER BY criado_em DESC');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.get('/match', async (req, res) => {
  try {
    const { curso, turno } = req.query;
    if (!curso && !turno) return res.json([]);
    let query = 'SELECT * FROM interessados WHERE 1=1';
    const params = [];
    if (curso) { params.push('%' + curso.toLowerCase() + '%'); query += ' AND LOWER(curso) LIKE $' + params.length; }
    if (turno) { params.push(turno.toLowerCase()); query += ' AND LOWER(turno) = $' + params.length; }
    const r = await pool.query(query + ' ORDER BY criado_em DESC', params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { nome, whatsapp, curso, turno, motivo, obs, reserva_id, tem_notebook } = req.body;
    if (!nome) return res.status(400).json({ erro: 'nome obrigatorio' });
    const r = await pool.query(
      'INSERT INTO interessados (nome, whatsapp, curso, turno, motivo, obs, reserva_id, tem_notebook) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [nome, whatsapp||null, curso||null, turno||null, motivo||null, obs||null, reserva_id||null, Boolean(tem_notebook||false)]
    );
    if (reserva_id) await pool.query('DELETE FROM reservas WHERE id = $1', [reserva_id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// DELETE /api/interessados/:id — manda o lead pra Lixeira.
// ?silencioso=1 pula a lixeira (usado pelo "mover entre abas" do painel, que
// recria o lead noutra aba e apaga o antigo — não é uma exclusão de verdade).
router.delete('/:id', async (req, res) => {
  try {
    const silencioso = req.query.silencioso === '1' || req.query.silencioso === 'true';
    if (!silencioso) {
      const { rows } = await pool.query('SELECT * FROM interessados WHERE id = $1', [req.params.id]);
      if (rows.length) {
        const l = rows[0];
        await lixeira.guardar({
          entidade: 'interessado', ref_id: l.id, por: req,
          rotulo: `Lead ${l.nome || ''} — ${l.curso || ''}`.trim(),
          dados: l,
        });
      }
    }
    await pool.query('DELETE FROM interessados WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
