// routes/certificados.js
// Rotas de certificados — F5 Nova Cursos
// GET  /api/certificado?cpf=XXX       → busca alunos formados pelo CPF
// POST /api/certificado/emitir        → gera cert_hash para um aluno
// GET  /api/certificado/validar?codigo=XXX → valida um código de certificado
// POST /api/certificado/avulso        → emite certificado avulso (sem turma cadastrada)

const express = require("express");
const router = express.Router();
const pool = require("../db");

// Auto-migration: garante colunas cert_hash e cert_emitido na tabela alunos
async function migrateCertColumns() {
  try {
    await pool.query(`
      ALTER TABLE alunos
        ADD COLUMN IF NOT EXISTS cert_hash     VARCHAR(30)  UNIQUE,
        ADD COLUMN IF NOT EXISTS cert_emitido  TIMESTAMP
    `);
    console.log("[certificados] colunas cert_hash/cert_emitido OK");
  } catch (e) {
    console.error("[certificados] migrate erro:", e.message);
  }
}
migrateCertColumns();

// ─── GET /api/certificado?cpf=XXX ─────────────────────────────────────────
// Retorna o(s) certificado(s) do aluno pelo CPF (status = formado e cert_hash não nulo)
router.get("/", async (req, res) => {
  const cpf = (req.query.cpf || "").replace(/\D/g, "");
  if (cpf.length < 11) return res.status(400).json({ erro: "CPF inválido" });

  const cpfFormatado = cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");

  try {
    const result = await pool.query(`
      SELECT a.id, a.nome, a.cpf, a.curso, a.cert_hash, a.cert_emitido, a.pagamento,
             t.data_fim, t.nome AS turma_nome, t.carga AS turma_carga
      FROM alunos a
      LEFT JOIN turmas t ON t.id = a.turma_id
      WHERE (REPLACE(REPLACE(REPLACE(a.cpf, '.', ''), '-', ''), ' ', '') = $1
             OR a.cpf = $2)
        AND a.status = 'formado'
        AND a.cert_hash IS NOT NULL
      ORDER BY a.cert_emitido DESC
    `, [cpf, cpfFormatado]);

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: "CPF não encontrado ou sem certificados emitidos" });
    }

    const aluno = result.rows[0];

    const fmtData = (d) => {
      if (!d) return "";
      const dt = new Date(d);
      return `${String(dt.getDate()).padStart(2,"0")}/${String(dt.getMonth()+1).padStart(2,"0")}/${dt.getFullYear()}`;
    };

    const cursos = result.rows.map(r => {
      const nomeCurso = r.curso || r.turma_nome || "Informática Profissional + IA";
      const cargaInfo = r.turma_carga ? (String(r.turma_carga).endsWith("h") ? r.turma_carga : r.turma_carga + "h") : obterCarga(nomeCurso);
      return {
        id:        r.cert_hash,
        nome:      nomeCurso,
        carga:     cargaInfo,
        conclusao: fmtData(r.data_fim || r.pagamento || r.cert_emitido)
      };
    });

    res.json({ nome: aluno.nome, cpf: aluno.cpf, cursos });
  } catch (e) {
    console.error("[certificado GET]", e.message);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// ─── GET /api/certificado/validar?codigo=XXX ──────────────────────────────
router.get("/validar", async (req, res) => {
  const codigo = (req.query.codigo || "").toUpperCase().trim();
  if (!codigo) return res.status(400).json({ erro: "Código obrigatório" });

  try {
    const result = await pool.query(`
      SELECT a.nome, a.curso, a.cert_hash, a.cert_emitido, a.pagamento,
             t.data_fim, t.nome AS turma_nome, t.carga AS turma_carga
      FROM alunos a
      LEFT JOIN turmas t ON t.id = a.turma_id
      WHERE a.cert_hash = $1
    `, [codigo]);

    if (result.rows.length === 0) {
      return res.status(404).json({ valido: false });
    }

    const r = result.rows[0];
    const fmtData = (d) => {
      if (!d) return "";
      const dt = new Date(d);
      return `${String(dt.getDate()).padStart(2,"0")}/${String(dt.getMonth()+1).padStart(2,"0")}/${dt.getFullYear()}`;
    };

    const nomeCurso = r.curso || r.turma_nome || "Informática Profissional + IA";
    const cargaInfo = r.turma_carga ? (String(r.turma_carga).endsWith("h") ? r.turma_carga : r.turma_carga + "h") : obterCarga(nomeCurso);

    res.json({
      valido:    true,
      aluno:     r.nome,
      curso:     nomeCurso,
      carga:     cargaInfo,
      conclusao: fmtData(r.data_fim || r.pagamento || r.cert_emitido),
      codigo:    r.cert_hash
    });
  } catch (e) {
    console.error("[certificado/validar]", e.message);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// ─── POST /api/certificado/emitir ─────────────────────────────────────────
router.post("/emitir", async (req, res) => {
  const { aluno_id } = req.body;
  if (!aluno_id) return res.status(400).json({ erro: "aluno_id obrigatório" });

  try {
    const check = await pool.query(
      "SELECT id, nome, curso, status, cert_hash, cert_emitido FROM alunos WHERE id = $1",
      [aluno_id]
    );
    if (check.rows.length === 0) return res.status(404).json({ erro: "Aluno não encontrado" });

    const aluno = check.rows[0];

    if (aluno.cert_hash) {
      return res.json({ cert_hash: aluno.cert_hash, cert_emitido: aluno.cert_emitido, ja_existia: true });
    }

    if (aluno.status !== "formado") {
      return res.status(422).json({ erro: "Aluno não está com status formado" });
    }

    const ano = new Date().getFullYear();
    const seqRes = await pool.query(
      "SELECT COUNT(*) AS total FROM alunos WHERE cert_hash LIKE $1",
      [`F5-INFO-${ano}-%`]
    );
    const seq = String(parseInt(seqRes.rows[0].total) + 1).padStart(3, "0");
    const cert_hash = `F5-INFO-${ano}-${seq}`;

    const now = new Date();
    await pool.query(
      "UPDATE alunos SET cert_hash = $1, cert_emitido = $2 WHERE id = $3",
      [cert_hash, now, aluno_id]
    );

    res.json({ cert_hash, cert_emitido: now });
  } catch (e) {
    console.error("[certificado/emitir]", e.message);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// ─── POST /api/certificado/avulso ─────────────────────────────────────────
// Emite certificado avulso para aluno sem turma cadastrada no sistema.
// Body: { nome, cpf (opcional), curso, conclusao (YYYY-MM-DD), carga (opcional) }
router.post("/avulso", async (req, res) => {
  const { nome, cpf, curso, conclusao, carga } = req.body;
  if (!nome || !curso || !conclusao) {
    return res.status(400).json({ erro: "nome, curso e conclusao são obrigatórios" });
  }

  try {
    // Garante que a "Turma Histórico" existe (turma especial para avulsos)
    let turmaRes = await pool.query("SELECT id FROM turmas WHERE codigo = 'HISTORICO'");
    if (turmaRes.rows.length === 0) {
      turmaRes = await pool.query(`
        INSERT INTO turmas (codigo, nome, turma, status, vagas_total, vagas_ocupadas)
        VALUES ('HISTORICO', 'Histórico', 'Turma Histórico', 'encerrada', 9999, 0)
        RETURNING id
      `);
    }
    const turma_id = turmaRes.rows[0].id;

    // Se CPF fornecido, verifica se já tem certificado avulso para esse CPF+curso
    if (cpf) {
      const cpfLimpo = cpf.replace(/\D/g, "");
      const cpfFmt = cpfLimpo.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
      const existing = await pool.query(`
        SELECT id, cert_hash, cert_emitido FROM alunos
        WHERE (REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), ' ', '') = $1 OR cpf = $2)
          AND curso = $3 AND status = 'formado' AND cert_hash IS NOT NULL
      `, [cpfLimpo, cpfFmt, curso]);
      if (existing.rows.length > 0) {
        return res.json({ ...existing.rows[0], ja_existia: true, avulso: true });
      }
    }

    // Gera sequência única para avulsos no ano corrente
    const ano = new Date().getFullYear();
    const seqRes = await pool.query(
      "SELECT COUNT(*) AS total FROM alunos WHERE cert_hash LIKE $1",
      [`F5-AVUL-${ano}-%`]
    );
    const seq = String(parseInt(seqRes.rows[0].total) + 1).padStart(3, "0");
    const cert_hash = `F5-AVUL-${ano}-${seq}`;
    const now = new Date();

    // Insere aluno avulso
    const insert = await pool.query(`
      INSERT INTO alunos (nome, cpf, curso, turma_id, status, pagamento, cert_hash, cert_emitido)
      VALUES ($1, $2, $3, $4, 'formado', $5, $6, $7)
      RETURNING id
    `, [
      nome,
      cpf || null,
      curso,
      turma_id,
      conclusao,
      cert_hash,
      now
    ]);

    const cargaInfo = carga
      ? (String(carga).endsWith("h") ? carga : carga + "h")
      : obterCarga(curso);

    const fmtData = (d) => {
      if (!d) return "";
      const dt = new Date(d);
      return `${String(dt.getDate()).padStart(2,"0")}/${String(dt.getMonth()+1).padStart(2,"0")}/${dt.getFullYear()}`;
    };

    res.json({
      aluno_id:   insert.rows[0].id,
      cert_hash,
      cert_emitido: now,
      nome,
      curso,
      carga:      cargaInfo,
      conclusao:  fmtData(conclusao),
      avulso:     true
    });
  } catch (e) {
    console.error("[certificado/avulso]", e.message);
    res.status(500).json({ erro: "Erro interno: " + e.message });
  }
});

// Utilitário: retorna carga horária com base no nome do curso
function obterCarga(nomeCurso) {
  const mapa = {
    "informática": "60h",
    "excel": "40h",
    "design": "50h",
    "power bi": "45h",
    "powerbi": "45h"
  };
  const lower = nomeCurso.toLowerCase();
  for (const [chave, carga] of Object.entries(mapa)) {
    if (lower.includes(chave)) return carga;
  }
  return "60h";
}

module.exports = router;
