const router = require('express').Router();
const db = require('../db');
const lixeira = require('../lib/lixeira');
const r2 = require('../lib/r2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Rate limit: máx 10 tentativas de login por IP a cada 15 minutos
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos e tente novamente.' }
});

// Rate limit: máx 5 cadastros por IP a cada hora (evita spam de contas)
const cadastroLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitos cadastros realizados. Tente novamente em 1 hora.' }
});

const JWT_SECRET = process.env.EAD_JWT_SECRET || 'ead2026secret';
const JWT_EXPIRY = '7d';

// Normaliza texto: remove acento e baixa caixa (p/ casar nomes de turma/curso)
function _norm(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Dado o nome da turma/curso presencial, retorna os TÍTULOS de cursos EAD elegíveis.
// Robusto a acento ("Informática") e sem o falso 'ia' (que pegava Excel/Design).
function cursosEadElegiveis(...nomes) {
  const t = _norm(nomes.filter(Boolean).join(' '));
  const titulos = [];
  if (t.includes('informatica')) titulos.push('Informática Profissional + IA EAD');
  if (t.includes('excel'))       titulos.push('Excel Profissional + IA EAD');
  return titulos;
}

// Garantir que a pasta privada de vídeos exista
const videosDir = path.join(__dirname, '../private/videos');
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}

// ── AUTO-MIGRATION E SEEDING ──────────────────────────────────────────
async function initEadDatabase() {
  // 1. Cursos EAD
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_cursos (
      id SERIAL PRIMARY KEY,
      titulo VARCHAR(200) NOT NULL,
      descricao TEXT,
      categoria VARCHAR(100) DEFAULT 'Informática',
      carga_horaria INTEGER NOT NULL DEFAULT 20,
      preco NUMERIC(10,2) NOT NULL DEFAULT 0.00,
      icone VARCHAR(20) DEFAULT '💻',
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);

  // 2. Módulos EAD
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_modulos (
      id SERIAL PRIMARY KEY,
      curso_id INTEGER REFERENCES ead_cursos(id) ON DELETE CASCADE,
      titulo VARCHAR(200) NOT NULL,
      ordem INTEGER DEFAULT 0,
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);

  // 3. Aulas EAD
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_aulas (
      id SERIAL PRIMARY KEY,
      modulo_id INTEGER REFERENCES ead_modulos(id) ON DELETE CASCADE,
      titulo VARCHAR(200) NOT NULL,
      url VARCHAR(500),
      duracao INTEGER NOT NULL DEFAULT 10,
      material TEXT,
      gratis BOOLEAN DEFAULT false,
      ordem INTEGER DEFAULT 0,
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);

  // 4. Usuários EAD (Alunos Públicos / Vendas Web)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_usuarios (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(200) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      senha_hash VARCHAR(255) NOT NULL,
      cpf VARCHAR(14) UNIQUE NOT NULL,
      telefone VARCHAR(20),
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);

  // 5. Matrículas EAD
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_matriculas (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES ead_usuarios(id) ON DELETE SET NULL,
      aluno_id INTEGER REFERENCES alunos(id) ON DELETE SET NULL,
      curso_id INTEGER REFERENCES ead_cursos(id) ON DELETE CASCADE,
      data_matricula TIMESTAMP DEFAULT NOW(),
      status VARCHAR(20) DEFAULT 'ativa',
      order_nsu VARCHAR(60),
      transaction_nsu VARCHAR(100),
      receipt_url VARCHAR(500),
      UNIQUE (usuario_id, curso_id),
      UNIQUE (aluno_id, curso_id)
    )
  `);

  // 6. Progresso do Aluno EAD
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_progresso (
      id SERIAL PRIMARY KEY,
      matricula_id INTEGER REFERENCES ead_matriculas(id) ON DELETE CASCADE,
      aula_id INTEGER REFERENCES ead_aulas(id) ON DELETE CASCADE,
      concluida BOOLEAN DEFAULT true,
      data_conclusao TIMESTAMP DEFAULT NOW(),
      UNIQUE (matricula_id, aula_id)
    )
  `);

  // 7. Certificados EAD
  await db.query(`
    CREATE TABLE IF NOT EXISTS ead_certificados (
      id SERIAL PRIMARY KEY,
      matricula_id INTEGER REFERENCES ead_matriculas(id) ON DELETE CASCADE UNIQUE,
      codigo VARCHAR(50) UNIQUE NOT NULL,
      data_emissao TIMESTAMP DEFAULT NOW()
    )
  `);

  // Colunas adicionadas depois (idempotente)
  await db.query(`ALTER TABLE ead_cursos ADD COLUMN IF NOT EXISTS imagem VARCHAR(500)`);
  // imagem pode guardar URL OU a própria imagem (data URI base64) — precisa caber
  await db.query(`ALTER TABLE ead_cursos ALTER COLUMN imagem TYPE TEXT`);
  // EAD melhorias 2026-06-22: descrição da aula/módulo + material como ARQUIVO (chave R2 ou URL)
  await db.query(`ALTER TABLE ead_aulas ADD COLUMN IF NOT EXISTS descricao TEXT`);
  await db.query(`ALTER TABLE ead_aulas ADD COLUMN IF NOT EXISTS material_url TEXT`);
  await db.query(`ALTER TABLE ead_modulos ADD COLUMN IF NOT EXISTS descricao TEXT`);
  await db.query(`ALTER TABLE ead_usuarios ADD COLUMN IF NOT EXISTS deletado_em TIMESTAMP`);

  // Popular cursos iniciais se vazia
  const { rows } = await db.query('SELECT COUNT(*) FROM ead_cursos');
  if (parseInt(rows[0].count) === 0) {
    await db.query(`
      INSERT INTO ead_cursos (titulo, descricao, categoria, carga_horaria, preco, icone) VALUES 
      ('Informática Profissional + IA EAD', 'Domine o computador, o sistema operacional e as principais ferramentas de Inteligência Artificial para alavancar seu currículo.', 'Informática', 60, 149.90, '💻'),
      ('Excel Profissional + IA EAD', 'Aprenda planilhas, fórmulas complexas, gráficos avançados e relatórios integrados com IA.', 'Excel / Office', 40, 90.00, '📊')
    `);
    console.log('[EAD] Cursos iniciais semeados no banco.');
  }
}
initEadDatabase().catch(err => console.error('[EAD] Erro na migração EAD:', err.message));


// ── MIDDLEWARE DE AUTENTICAÇÃO ────────────────────────────────────────
function eadAuthMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token ausente' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

// Middleware de Admin
function eadAdminMiddleware(req, res, next) {
  eadAuthMiddleware(req, res, () => {
    if (req.user && req.user.role === 'admin') {
      next();
    } else {
      res.status(403).json({ error: 'Acesso restrito ao administrador' });
    }
  });
}


// ── ROTAS DE AUTENTICAÇÃO ─────────────────────────────────────────────

// POST /api/ead/auth/login
router.post('/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const { cpf, email, senha, nasc } = req.body;

    // Login Admin Especial (Compatibilidade)
    if (cpf === '000.000.000-00' && nasc === '2000-01-01') {
      const token = jwt.sign(
        { id: 0, nome: 'Administrador EAD', role: 'admin' },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
      );
      return res.json({ ok: true, token, usuario: { nome: 'Administrador EAD', role: 'admin' } });
    }

    // Fluxo Aluno Acadêmico (Presencial) via apenas CPF
    if (cpf && !senha && !email) {
      const cpfLimpo = cpf.replace(/\D/g, '');
      if (cpfLimpo.length < 11) return res.status(400).json({ error: 'CPF inválido.' });

      // Busca na tabela alunos da escola
      const { rows: alunos } = await db.query(
        `SELECT a.*, t.nome AS turma_curso_nome 
         FROM alunos a 
         LEFT JOIN turmas t ON a.turma_id = t.id 
         WHERE REPLACE(REPLACE(a.cpf, '.', ''), '-', '') = $1 AND a.status IN ('ativo', 'formado')`,
        [cpfLimpo]
      );

      if (!alunos.length) {
        return res.status(401).json({ error: 'Aluno não encontrado no sistema acadêmico ou inativo.' });
      }

      const aluno = alunos[0];
      
      // Mapear cursos ead elegíveis com base na turma (ou curso) do presencial
      const cursosElegiveis = cursosEadElegiveis(aluno.turma_curso_nome, aluno.curso);

      if (cursosElegiveis.length === 0) {
        return res.status(403).json({ error: 'Seu curso presencial não possui um equivalente no EAD liberado.' });
      }

      // Buscar os IDs correspondentes na tabela ead_cursos
      const { rows: eadCursos } = await db.query(
        'SELECT id, titulo FROM ead_cursos WHERE titulo = ANY($1)',
        [cursosElegiveis]
      );

      // Inserir matrículas ativas para o aluno presencial
      const cursosLiberadosIds = [];
      for (const eadCurso of eadCursos) {
        cursosLiberadosIds.push(eadCurso.id);
        await db.query(
          `INSERT INTO ead_matriculas (aluno_id, curso_id, status) 
           VALUES ($1, $2, 'ativa') 
           ON CONFLICT (aluno_id, curso_id) DO NOTHING`,
          [aluno.id, eadCurso.id]
        );
      }

      // Gerar Token JWT
      const token = jwt.sign(
        { id: aluno.id, nome: aluno.nome, cpf: aluno.cpf, tipo: 'presencial', role: 'student', cursos: cursosLiberadosIds },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
      );

      return res.json({ 
        ok: true, 
        token, 
        usuario: { 
          id: aluno.id, 
          nome: aluno.nome, 
          cpf: aluno.cpf, 
          tipo: 'presencial', 
          role: 'student',
          cursos: cursosLiberadosIds
        } 
      });
    }

    // Fluxo Aluno Público (Web / Venda) via E-mail ou CPF + Senha
    const idRaw = (email || cpf || '').trim();
    if (!idRaw || !senha) {
      return res.status(400).json({ error: 'Preencha CPF/E-mail e Senha.' });
    }
    const idEmail = idRaw.toLowerCase();        // casa por e-mail (mesmo com dígitos)
    const idDigits = idRaw.replace(/\D/g, '');  // casa por CPF (só os números)

    const { rows: users } = await db.query(
      `SELECT * FROM ead_usuarios
       WHERE LOWER(email) = $1 OR ($2 <> '' AND REPLACE(REPLACE(cpf, '.', ''), '-', '') = $2)`,
      [idEmail, idDigits]
    );

    if (!users.length) {
      return res.status(401).json({ error: 'Usuário não encontrado ou senha inválida.' });
    }

    const user = users[0];
    const ok = bcrypt.compareSync(senha, user.senha_hash);
    if (!ok) return res.status(401).json({ error: 'Usuário não encontrado ou senha inválida.' });

    // Buscar as matrículas ativas do usuário web
    const { rows: mats } = await db.query(
      "SELECT curso_id FROM ead_matriculas WHERE usuario_id = $1 AND status = 'ativa'",
      [user.id]
    );
    const cursosIds = mats.map(m => m.curso_id);

    const token = jwt.sign(
      { id: user.id, nome: user.nome, cpf: user.cpf, tipo: 'web', role: 'student', cursos: cursosIds },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.json({
      ok: true,
      token,
      usuario: {
        id: user.id,
        nome: user.nome,
        cpf: user.cpf,
        email: user.email,
        tipo: 'web',
        role: 'student',
        cursos: cursosIds
      }
    });

  } catch(e) { next(e); }
});

// POST /api/ead/auth/cadastro
router.post('/auth/cadastro', cadastroLimiter, async (req, res, next) => {
  try {
    const { nome, email, senha, cpf, telefone } = req.body;
    if (!nome || !email || !senha || !cpf) {
      return res.status(400).json({ error: 'Nome, E-mail, Senha e CPF são obrigatórios.' });
    }

    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length < 11) return res.status(400).json({ error: 'CPF inválido.' });

    const hash = bcrypt.hashSync(senha, 10);

    const { rows } = await db.query(
      `INSERT INTO ead_usuarios (nome, email, senha_hash, cpf, telefone) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, nome, email, cpf, telefone`,
      [nome, email.toLowerCase().trim(), hash, cpfLimpo, telefone || null]
    );

    res.status(201).json({ ok: true, usuario: rows[0] });
  } catch(e) {
    if (e.message.includes('unique') || e.code === '23505') {
      return res.status(400).json({ error: 'E-mail ou CPF já cadastrado no sistema EAD.' });
    }
    next(e);
  }
});


// ── ROTAS DE CURSOS & AULAS ───────────────────────────────────────────

// GET /api/ead/cursos
router.get('/cursos', async (req, res, next) => {
  try {
    // Listar cursos EAD ativos
    const { rows: cursos } = await db.query('SELECT * FROM ead_cursos WHERE ativo = true ORDER BY id');
    
    // Obter árvore de módulos e aulas
    for (const curso of cursos) {
      const { rows: modulos } = await db.query(
        'SELECT * FROM ead_modulos WHERE curso_id = $1 ORDER BY ordem ASC, id ASC',
        [curso.id]
      );

      for (const modulo of modulos) {
        // NÃO expõe a.url (chave do vídeo é segredo) — só o booleano tem_video p/ o admin.
        // material_url é a chave/URL do PDF/arquivo (não é segredo de acesso); tem_material idem.
        const { rows: aulas } = await db.query(
          `SELECT id, modulo_id, titulo, descricao, duracao, material, material_url, gratis, ordem,
                  (url IS NOT NULL AND url <> '') AS tem_video
           FROM ead_aulas WHERE modulo_id = $1 ORDER BY ordem ASC, id ASC`,
          [modulo.id]
        );
        aulas.forEach(a => { a.tem_material = !!(a.material_url && String(a.material_url).trim()); });
        modulo.aulas = aulas;
      }

      curso.modulos = modulos;
    }

    res.json(cursos);
  } catch(e) { next(e); }
});

// POST /api/ead/cursos (Admin)
router.post('/cursos', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { titulo, descricao, categoria, carga_horaria, preco, icone, imagem } = req.body;
    if (!titulo) return res.status(400).json({ error: 'Título do curso é obrigatório.' });

    const { rows } = await db.query(
      `INSERT INTO ead_cursos (titulo, descricao, categoria, carga_horaria, preco, icone, imagem)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [titulo, descricao || '', categoria || 'Informática', parseInt(carga_horaria) || 20, parseFloat(preco) || 0.00, icone || '💻', imagem || null]
    );
    res.status(201).json(rows[0]);
  } catch(e) { next(e); }
});

// PUT /api/ead/cursos/:id (Admin)
router.put('/cursos/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { titulo, descricao, categoria, carga_horaria, preco, icone, imagem } = req.body;
    const { rows } = await db.query(
      `UPDATE ead_cursos SET
         titulo = COALESCE($1, titulo),
         descricao = COALESCE($2, descricao),
         categoria = COALESCE($3, categoria),
         carga_horaria = COALESCE($4, carga_horaria),
         preco = COALESCE($5, preco),
         icone = COALESCE($6, icone),
         imagem = COALESCE($7, imagem)
       WHERE id = $8 RETURNING *`,
      [titulo, descricao, categoria, carga_horaria, preco, icone, imagem, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Curso não encontrado.' });
    res.json(rows[0]);
  } catch(e) { next(e); }
});

// DELETE /api/ead/cursos/:id (Admin) — manda o curso EAD (módulos+aulas) pra Lixeira
router.delete('/cursos/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: c } = await db.query('SELECT * FROM ead_cursos WHERE id=$1', [id]);
    if (!c.length) return res.status(404).json({ error: 'Curso não encontrado.' });
    const curso = c[0];
    const { rows: modulos } = await db.query('SELECT * FROM ead_modulos WHERE curso_id=$1', [id]);
    const { rows: aulas } = modulos.length
      ? await db.query('SELECT * FROM ead_aulas WHERE modulo_id = ANY($1)', [modulos.map(m => m.id)])
      : { rows: [] };
    await lixeira.guardar({
      entidade: 'ead_curso', ref_id: id, por: req,
      rotulo: `Curso EAD ${curso.titulo || ''}`.trim(),
      dados: { _curso: curso, _modulos: modulos, _aulas: aulas },
    });
    await db.query('DELETE FROM ead_cursos WHERE id = $1', [id]);
    res.json({ ok: true, msg: `Curso ${curso.titulo} removido com sucesso.` });
  } catch(e) { next(e); }
});

// POST /api/ead/modulos (Admin)
router.post('/modulos', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { curso_id, titulo, ordem } = req.body;
    if (!curso_id || !titulo) return res.status(400).json({ error: 'curso_id e titulo são obrigatórios.' });

    const { rows } = await db.query(
      'INSERT INTO ead_modulos (curso_id, titulo, ordem) VALUES ($1, $2, $3) RETURNING *',
      [curso_id, titulo, parseInt(ordem) || 0]
    );
    res.status(201).json(rows[0]);
  } catch(e) { next(e); }
});

// PUT /api/ead/modulos/:id (Admin) — renomeia / edita um módulo.
router.put('/modulos/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { titulo, descricao, ordem } = req.body;
    const { rows } = await db.query(
      `UPDATE ead_modulos SET
         titulo = COALESCE($1, titulo),
         descricao = COALESCE($2, descricao),
         ordem = COALESCE($3, ordem)
       WHERE id = $4 RETURNING *`,
      [titulo, descricao, (ordem != null ? parseInt(ordem) : null), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Módulo não encontrado.' });
    res.json(rows[0]);
  } catch(e) { next(e); }
});

// DELETE /api/ead/modulos/:id (Admin) — manda o módulo (e suas aulas) pra Lixeira
router.delete('/modulos/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: m } = await db.query('SELECT * FROM ead_modulos WHERE id=$1', [id]);
    if (m.length) {
      const modulo = m[0];
      const { rows: aulas } = await db.query('SELECT * FROM ead_aulas WHERE modulo_id=$1', [id]);
      await lixeira.guardar({
        entidade: 'ead_modulo', ref_id: id, por: req,
        rotulo: `Módulo EAD ${modulo.titulo || ''}`.trim(),
        dados: { _modulo: modulo, _aulas: aulas },
      });
    }
    await db.query('DELETE FROM ead_modulos WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// POST /api/ead/aulas (Admin)
router.post('/aulas', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { modulo_id, titulo, url, descricao, duracao, material, material_url, gratis, ordem } = req.body;
    if (!modulo_id || !titulo) return res.status(400).json({ error: 'modulo_id e titulo são obrigatórios.' });

    const { rows } = await db.query(
      `INSERT INTO ead_aulas (modulo_id, titulo, url, descricao, duracao, material, material_url, gratis, ordem)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [modulo_id, titulo, url || '', descricao || '', parseInt(duracao) || 10, material || '', material_url || '', Boolean(gratis), parseInt(ordem) || 0]
    );
    res.status(201).json(rows[0]);
  } catch(e) { next(e); }
});

// PUT /api/ead/aulas/:id (Admin) — edita uma aula existente.
// Campos ausentes (undefined) são preservados; string vazia LIMPA o campo
// (ex.: apagar a URL do vídeo). url/material_url usam COALESCE só quando undefined.
router.put('/aulas/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const has = k => Object.prototype.hasOwnProperty.call(b, k);
    const { rows } = await db.query(
      `UPDATE ead_aulas SET
         titulo       = COALESCE($1, titulo),
         url          = CASE WHEN $2::boolean THEN $3 ELSE url END,
         descricao    = COALESCE($4, descricao),
         duracao      = COALESCE($5, duracao),
         material     = COALESCE($6, material),
         material_url = CASE WHEN $7::boolean THEN $8 ELSE material_url END,
         gratis       = COALESCE($9, gratis),
         ordem        = COALESCE($10, ordem)
       WHERE id = $11 RETURNING *`,
      [
        has('titulo') ? b.titulo : null,
        has('url'), has('url') ? (b.url || '') : null,
        has('descricao') ? b.descricao : null,
        has('duracao') ? (parseInt(b.duracao) || 10) : null,
        has('material') ? b.material : null,
        has('material_url'), has('material_url') ? (b.material_url || '') : null,
        has('gratis') ? Boolean(b.gratis) : null,
        has('ordem') ? (parseInt(b.ordem) || 0) : null,
        id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Aula não encontrada.' });
    res.json(rows[0]);
  } catch(e) { next(e); }
});

// DELETE /api/ead/aulas/:id (Admin) — manda a aula EAD pra Lixeira
router.delete('/aulas/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { rows } = await db.query('SELECT * FROM ead_aulas WHERE id=$1', [id]);
    if (rows.length) {
      const a = rows[0];
      await lixeira.guardar({
        entidade: 'ead_aula', ref_id: id, por: req,
        rotulo: `Aula EAD ${a.titulo || ''}`.trim(),
        dados: a,
      });
    }
    await db.query('DELETE FROM ead_aulas WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch(e) { next(e); }
});


// ── STREAMING SEGURO DE VÍDEOS (VPS) ──────────────────────────────────
router.get('/video/:aulaId', eadAuthMiddleware, async (req, res, next) => {
  try {
    const { aulaId } = req.params;

    // Buscar detalhes da aula e o curso_id correspondente
    const { rows: aulas } = await db.query(
      `SELECT a.*, m.curso_id 
       FROM ead_aulas a 
       JOIN ead_modulos m ON a.modulo_id = m.id 
       WHERE a.id = $1`,
      [aulaId]
    );

    if (!aulas.length) return res.status(404).json({ error: 'Aula não encontrada.' });
    const aula = aulas[0];

    // Se for aula grátis (degustação), permite sem matrícula ativa
    if (!aula.gratis) {
      let matriculado = false;
      
      if (req.user.role === 'admin') {
        matriculado = true;
      } else if (req.user.tipo === 'presencial') {
        const { rows } = await db.query(
          "SELECT id FROM ead_matriculas WHERE aluno_id = $1 AND curso_id = $2 AND status = 'ativa'",
          [req.user.id, aula.curso_id]
        );
        if (rows.length) matriculado = true;
      } else if (req.user.tipo === 'web') {
        const { rows } = await db.query(
          "SELECT id FROM ead_matriculas WHERE usuario_id = $1 AND curso_id = $2 AND status = 'ativa'",
          [req.user.id, aula.curso_id]
        );
        if (rows.length) matriculado = true;
      }

      if (!matriculado) {
        return res.status(403).json({ error: 'Você não possui matrícula ativa neste curso para assistir a este vídeo.' });
      }
    }

    if (!aula.url) {
      return res.status(400).json({ error: 'Esta aula não possui arquivo de vídeo cadastrado.' });
    }

    // Servir stream do arquivo local .mp4 na VPS
    const videoPath = path.join(videosDir, aula.url);
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: 'Arquivo de vídeo não encontrado no servidor.' });
    }

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(videoPath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(200, head);
      fs.createReadStream(videoPath).pipe(res);
    }

  } catch(e) { next(e); }
});


// ── VÍDEO VIA CLOUDFLARE R2 (URL ASSINADA) ────────────────────────────
// GET /api/ead/video-url/:aulaId → { url } presigned (expira em minutos).
// aula.url guarda a CHAVE do objeto no R2 (ex: "curso1/aula123.mp4").
// A URL assinada vai direto no <video src> (resolve o <video> não mandar header).
router.get('/video-url/:aulaId', eadAuthMiddleware, async (req, res, next) => {
  try {
    const { aulaId } = req.params;
    const { rows: aulas } = await db.query(
      `SELECT a.*, m.curso_id
       FROM ead_aulas a JOIN ead_modulos m ON a.modulo_id = m.id
       WHERE a.id = $1`,
      [aulaId]
    );
    if (!aulas.length) return res.status(404).json({ error: 'Aula não encontrada.' });
    const aula = aulas[0];

    // Mesma checagem de acesso do /video
    if (!aula.gratis) {
      let matriculado = false;
      if (req.user.role === 'admin') {
        matriculado = true;
      } else if (req.user.tipo === 'presencial') {
        const { rows } = await db.query(
          "SELECT id FROM ead_matriculas WHERE aluno_id = $1 AND curso_id = $2 AND status = 'ativa'",
          [req.user.id, aula.curso_id]);
        matriculado = rows.length > 0;
      } else if (req.user.tipo === 'web') {
        const { rows } = await db.query(
          "SELECT id FROM ead_matriculas WHERE usuario_id = $1 AND curso_id = $2 AND status = 'ativa'",
          [req.user.id, aula.curso_id]);
        matriculado = rows.length > 0;
      }
      if (!matriculado) {
        return res.status(403).json({ error: 'Você não possui matrícula ativa neste curso.' });
      }
    }

    if (!aula.url) return res.status(400).json({ error: 'Aula sem vídeo cadastrado.' });

    const raw = String(aula.url).trim();

    // YouTube → devolve a url original (o front monta o embed).
    if (raw.includes('youtube.com') || raw.includes('youtu.be')) {
      return res.json({ tipo: 'youtube', url: raw });
    }
    // URL http completa (vídeo direto ou outro embed) → devolve como está.
    if (/^https?:\/\//i.test(raw)) {
      return res.json({ tipo: 'http', url: raw });
    }
    // Caso contrário: é chave de objeto no R2 → URL assinada de curta duração.
    if (!r2.r2Configurado()) {
      return res.status(503).json({ error: 'Armazenamento de vídeo (R2) ainda não configurado.' });
    }
    const url = r2.presignGet(raw, 600); // 10 min
    res.json({ tipo: 'r2', url });
  } catch(e) { next(e); }
});

// GET /api/ead/material-url/:aulaId — devolve URL p/ abrir o ARQUIVO de material
// (PDF etc). Mesma checagem de matrícula do vídeo. http/https → como está; chave → presigned GET.
router.get('/material-url/:aulaId', eadAuthMiddleware, async (req, res, next) => {
  try {
    const { aulaId } = req.params;
    const { rows: aulas } = await db.query(
      `SELECT a.*, m.curso_id FROM ead_aulas a JOIN ead_modulos m ON a.modulo_id = m.id WHERE a.id = $1`,
      [aulaId]
    );
    if (!aulas.length) return res.status(404).json({ error: 'Aula não encontrada.' });
    const aula = aulas[0];

    if (!aula.gratis) {
      let matriculado = false;
      if (req.user.role === 'admin') {
        matriculado = true;
      } else if (req.user.tipo === 'presencial') {
        const { rows } = await db.query(
          "SELECT id FROM ead_matriculas WHERE aluno_id = $1 AND curso_id = $2 AND status = 'ativa'",
          [req.user.id, aula.curso_id]);
        matriculado = rows.length > 0;
      } else if (req.user.tipo === 'web') {
        const { rows } = await db.query(
          "SELECT id FROM ead_matriculas WHERE usuario_id = $1 AND curso_id = $2 AND status = 'ativa'",
          [req.user.id, aula.curso_id]);
        matriculado = rows.length > 0;
      }
      if (!matriculado) return res.status(403).json({ error: 'Você não possui matrícula ativa neste curso.' });
    }

    const raw = String(aula.material_url || '').trim();
    if (!raw) return res.status(404).json({ error: 'Aula sem material de arquivo.' });
    if (/^https?:\/\//i.test(raw)) return res.json({ tipo: 'http', url: raw });
    if (!r2.r2Configurado()) return res.status(503).json({ error: 'Armazenamento (R2) não configurado.' });
    res.json({ tipo: 'r2', url: r2.presignGet(raw, 600) });
  } catch(e) { next(e); }
});

// POST /api/ead/upload-url (Admin) — gera URL assinada de UPLOAD (PUT) pro R2.
// Body: { filename, tipo } (tipo: 'video' | 'material'). Retorna { key, url, expira }.
// O admin faz fetch(url,{method:'PUT',body:arquivo}) e depois salva `key` no campo
// da aula (url do vídeo, ou material_url). Exige CORS configurado no bucket.
router.post('/upload-url', eadAdminMiddleware, async (req, res, next) => {
  try {
    if (!r2.r2Configurado()) {
      return res.status(503).json({ error: 'Armazenamento de vídeo (R2) ainda não configurado.' });
    }
    const { filename, tipo } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename é obrigatório.' });

    // Sanitiza o nome: tira acento, troca tudo que não for [a-z0-9.-] por '-'
    const base = String(filename)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '') || 'arquivo';
    const pasta = (tipo === 'material') ? 'materiais' : 'videos';
    const rand = Math.random().toString(36).slice(2, 8);
    const key = `${pasta}/${Date.now()}-${rand}-${base}`;

    const url = r2.presignPut(key, 3600); // 1h p/ concluir o upload
    res.json({ ok: true, key, url, expira: 3600 });
  } catch(e) { next(e); }
});


// ── PROGRESSO E CERTIFICADOS DO ALUNO ─────────────────────────────────

// GET /api/ead/progresso
router.get('/progresso', eadAuthMiddleware, async (req, res, next) => {
  try {
    let matriculasQuery = '';
    const params = [];
    if (req.user.tipo === 'presencial') {
      matriculasQuery = "SELECT id, curso_id FROM ead_matriculas WHERE aluno_id = $1 AND status = 'ativa'";
      params.push(req.user.id);
    } else {
      matriculasQuery = "SELECT id, curso_id FROM ead_matriculas WHERE usuario_id = $1 AND status = 'ativa'";
      params.push(req.user.id);
    }

    const { rows: mats } = await db.query(matriculasQuery, params);
    const progresso = {};

    for (const mat of mats) {
      const { rows: progs } = await db.query(
        'SELECT aula_id FROM ead_progresso WHERE matricula_id = $1',
        [mat.id]
      );
      progresso[mat.curso_id] = {};
      progs.forEach(p => {
        progresso[mat.curso_id][p.aula_id] = true;
      });
    }

    res.json(progresso);
  } catch(e) { next(e); }
});

// POST /api/ead/progresso
router.post('/progresso', eadAuthMiddleware, async (req, res, next) => {
  try {
    const { aula_id, concluida } = req.body;
    if (!aula_id) return res.status(400).json({ error: 'aula_id obrigatório' });

    // Obter o curso_id da aula
    const { rows: aulas } = await db.query(
      'SELECT a.*, m.curso_id FROM ead_aulas a JOIN ead_modulos m ON a.modulo_id = m.id WHERE a.id = $1',
      [aula_id]
    );
    if (!aulas.length) return res.status(404).json({ error: 'Aula não encontrada' });
    const cursoId = aulas[0].curso_id;

    // Buscar a matrícula ativa do aluno para este curso
    let matQuery = '';
    const params = [cursoId, req.user.id];
    if (req.user.tipo === 'presencial') {
      matQuery = "SELECT id FROM ead_matriculas WHERE curso_id = $1 AND aluno_id = $2 AND status = 'ativa'";
    } else {
      matQuery = "SELECT id FROM ead_matriculas WHERE curso_id = $1 AND usuario_id = $2 AND status = 'ativa'";
    }

    const { rows: mats } = await db.query(matQuery, params);
    if (!mats.length) {
      return res.status(403).json({ error: 'Aluno não possui matrícula ativa para este curso.' });
    }
    const matriculaId = mats[0].id;

    if (concluida) {
      await db.query(
        'INSERT INTO ead_progresso (matricula_id, aula_id) VALUES ($1, $2) ON CONFLICT (matricula_id, aula_id) DO NOTHING',
        [matriculaId, aula_id]
      );
    } else {
      await db.query(
        'DELETE FROM ead_progresso WHERE matricula_id = $1 AND aula_id = $2',
        [matriculaId, aula_id]
      );
    }

    // Checar se completou 100% para gerar certificado
    const { rows: totalAulasRows } = await db.query(
      'SELECT COUNT(a.id) FROM ead_aulas a JOIN ead_modulos m ON a.modulo_id = m.id WHERE m.curso_id = $1',
      [cursoId]
    );
    const { rows: aulasConcluidasRows } = await db.query(
      'SELECT COUNT(*) FROM ead_progresso WHERE matricula_id = $1',
      [matriculaId]
    );

    const total = parseInt(totalAulasRows[0].count) || 0;
    const concluidas = parseInt(aulasConcluidasRows[0].count) || 0;

    let certCriado = null;

    if (total > 0 && concluidas === total) {
      // Gerar Certificado EAD
      const { rows: certsExistentes } = await db.query(
        'SELECT * FROM ead_certificados WHERE matricula_id = $1',
        [matriculaId]
      );
      if (!certsExistentes.length) {
        // Encontrar contagem de certificados para o código sequencial
        const { rows: contagem } = await db.query('SELECT COUNT(*) FROM ead_certificados');
        const sequencia = String(parseInt(contagem[0].count) + 1).padStart(4, '0');
        const codigo = `F5-EAD-${new Date().getFullYear()}-${sequencia}`;
        
        const { rows: novoCert } = await db.query(
          'INSERT INTO ead_certificados (matricula_id, codigo) VALUES ($1, $2) RETURNING *',
          [matriculaId, codigo]
        );
        certCriado = novoCert[0];
      }
    }

    res.json({ ok: true, concluida, certificado: certCriado });

  } catch(e) { next(e); }
});

// GET /api/ead/certificados
router.get('/certificados', eadAuthMiddleware, async (req, res, next) => {
  try {
    let matsQuery = '';
    const params = [];
    if (req.user.tipo === 'presencial') {
      matsQuery = "SELECT id, curso_id FROM ead_matriculas WHERE aluno_id = $1 AND status = 'ativa'";
      params.push(req.user.id);
    } else {
      matsQuery = "SELECT id, curso_id FROM ead_matriculas WHERE usuario_id = $1 AND status = 'ativa'";
      params.push(req.user.id);
    }

    const { rows: mats } = await db.query(matsQuery, params);
    if (!mats.length) return res.json([]);

    const matsIds = mats.map(m => m.id);
    const { rows: certs } = await db.query(
      `SELECT c.*, cur.titulo AS curso_titulo, cur.carga_horaria 
       FROM ead_certificados c
       JOIN ead_matriculas m ON c.matricula_id = m.id
       JOIN ead_cursos cur ON m.curso_id = cur.id
       WHERE c.matricula_id = ANY($1)`,
      [matsIds]
    );

    res.json(certs.map(c => ({
      id: c.id,
      codigo: c.codigo,
      nomeAluno: req.user.nome,
      nomeCurso: c.curso_titulo,
      carga: c.carga_horaria,
      emissao: c.data_emissao
    })));

  } catch(e) { next(e); }
});

// GET /api/ead/certificados/validar/:codigo
router.get('/certificados/validar/:codigo', async (req, res, next) => {
  try {
    const { codigo } = req.params;
    const { rows } = await db.query(
      `SELECT c.*, cur.titulo AS curso_titulo, cur.carga_horaria,
              u.nome AS usuario_nome, a.nome AS aluno_nome
       FROM ead_certificados c
       JOIN ead_matriculas m ON c.matricula_id = m.id
       JOIN ead_cursos cur ON m.curso_id = cur.id
       LEFT JOIN ead_usuarios u ON m.usuario_id = u.id
       LEFT JOIN alunos a ON m.aluno_id = a.id
       WHERE UPPER(c.codigo) = $1`,
      [codigo.toUpperCase().trim()]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Certificado não encontrado.' });
    }

    const cert = rows[0];
    res.json({
      ok: true,
      codigo: cert.codigo,
      nomeAluno: cert.usuario_nome || cert.aluno_nome || '—',
      nomeCurso: cert.curso_titulo,
      carga: cert.carga_horaria,
      emissao: cert.data_emissao
    });
  } catch(e) { next(e); }
});


// ── INTEGRAÇÃO VENDAS E CHECKOUT INFINITEPAY ──────────────────────────

// POST /api/ead/checkout
router.post('/checkout', eadAuthMiddleware, async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { curso_id } = req.body;
    if (!curso_id) return res.status(400).json({ error: 'curso_id é obrigatório.' });

    // Só permite checkout para alunos web (públicos)
    if (req.user.tipo !== 'web') {
      return res.status(400).json({ error: 'Apenas alunos de vendas web necessitam pagar pelo portal.' });
    }

    const { rows: cursos } = await client.query('SELECT * FROM ead_cursos WHERE id = $1', [curso_id]);
    if (!cursos.length) return res.status(404).json({ error: 'Curso não encontrado.' });
    const curso = cursos[0];

    if (parseFloat(curso.preco) <= 0) {
      // Liberar gratuitamente
      const { rows: mat } = await client.query(
        `INSERT INTO ead_matriculas (usuario_id, curso_id, status)
         VALUES ($1, $2, 'ativa')
         ON CONFLICT (usuario_id, curso_id) DO UPDATE SET status = 'ativa'
         RETURNING *`,
        [req.user.id, curso.id]
      );
      await client.query('COMMIT');
      return res.json({ ok: true, status: 'ativa', msg: 'Curso gratuito liberado.' });
    }

    // Criar/Obter matrícula pendente
    const { rows: mats } = await client.query(
      `INSERT INTO ead_matriculas (usuario_id, curso_id, status)
       VALUES ($1, $2, 'pendente')
       ON CONFLICT (usuario_id, curso_id) DO UPDATE SET status = ead_matriculas.status
       RETURNING *`,
      [req.user.id, curso.id]
    );
    const matricula = mats[0];

    const order_nsu = `ead-mat-${matricula.id}-${Date.now()}`;
    const preco_centavos = Math.round(parseFloat(curso.preco) * 100);

    const HANDLE = process.env.INFINITEPAY_HANDLE || 'f5novacursos';
    const IP_URL = 'https://api.checkout.infinitepay.io/links';
    const BASE_URL = process.env.BASE_URL || 'https://api.f5novacursos.com.br';

    const payload = {
      handle: HANDLE,
      order_nsu,
      items: [{ quantity: 1, price: preco_centavos, description: curso.titulo }],
      redirect_url: `https://f5novacursos.com.br/ead.html?pago=1`,
      webhook_url: `${BASE_URL}/webhook/infinitepay`,
      customer: {
        name: req.user.nome,
        email: req.user.email
      }
    };

    const ipRes = await fetch(IP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!ipRes.ok) {
      const errText = await ipRes.text();
      await client.query('ROLLBACK');
      return res.status(502).json({ error: 'Erro no checkout InfinitePay', detail: errText });
    }

    const data = await ipRes.json();
    const checkout_url = data.url || data.checkout_url || data.link;

    await client.query(
      'UPDATE ead_matriculas SET order_nsu = $1, receipt_url = $2 WHERE id = $3',
      [order_nsu, checkout_url, matricula.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, status: 'pendente', checkout_url, order_nsu });

  } catch(e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// POST /api/ead/checkout-publico  (SEM login prévio)
// O comprador preenche os dados NA HORA da compra; criamos/achamos a conta e
// geramos o pagamento. Após pagar (webhook), ele acessa logando com e-mail+senha.
router.post('/checkout-publico', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { curso_id, nome, email, cpf, telefone, senha } = req.body;
    if (!curso_id || !nome || !email || !cpf || !senha) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Preencha nome, e-mail, CPF e senha.' });
    }
    const cpfLimpo = String(cpf).replace(/\D/g, '');
    if (cpfLimpo.length < 11) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'CPF inválido.' });
    }
    const emailLower = String(email).toLowerCase().trim();

    const { rows: cursos } = await client.query('SELECT * FROM ead_cursos WHERE id = $1', [curso_id]);
    if (!cursos.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Curso não encontrado.' }); }
    const curso = cursos[0];

    // Achar conta existente (por e-mail ou CPF) ou criar uma nova
    const { rows: existentes } = await client.query(
      `SELECT * FROM ead_usuarios
       WHERE LOWER(email) = $1 OR REPLACE(REPLACE(cpf,'.',''),'-','') = $2`,
      [emailLower, cpfLimpo]
    );
    let usuario, contaExistente = false;
    if (existentes.length) {
      usuario = existentes[0];
      contaExistente = true; // mantém a senha antiga
    } else {
      const hash = bcrypt.hashSync(senha, 10);
      const { rows: novo } = await client.query(
        `INSERT INTO ead_usuarios (nome, email, senha_hash, cpf, telefone)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [nome, emailLower, hash, cpfLimpo, telefone || null]
      );
      usuario = novo[0];
    }

    // Curso grátis: libera direto
    if (parseFloat(curso.preco) <= 0) {
      await client.query(
        `INSERT INTO ead_matriculas (usuario_id, curso_id, status)
         VALUES ($1, $2, 'ativa')
         ON CONFLICT (usuario_id, curso_id) DO UPDATE SET status = 'ativa'`,
        [usuario.id, curso.id]
      );
      await client.query('COMMIT');
      return res.json({ ok: true, status: 'ativa', conta_existente: contaExistente, email: usuario.email });
    }

    // Matrícula pendente + link InfinitePay
    const { rows: mats } = await client.query(
      `INSERT INTO ead_matriculas (usuario_id, curso_id, status)
       VALUES ($1, $2, 'pendente')
       ON CONFLICT (usuario_id, curso_id) DO UPDATE SET status = ead_matriculas.status
       RETURNING *`,
      [usuario.id, curso.id]
    );
    const matricula = mats[0];
    const order_nsu = `ead-mat-${matricula.id}-${Date.now()}`;
    const preco_centavos = Math.round(parseFloat(curso.preco) * 100);

    const HANDLE = process.env.INFINITEPAY_HANDLE || 'f5novacursos';
    const IP_URL = 'https://api.checkout.infinitepay.io/links';
    const BASE_URL = process.env.BASE_URL || 'https://api.f5novacursos.com.br';

    const payload = {
      handle: HANDLE,
      order_nsu,
      items: [{ quantity: 1, price: preco_centavos, description: curso.titulo }],
      redirect_url: `https://f5novacursos.com.br/ead.html?pago=1`,
      webhook_url: `${BASE_URL}/webhook/infinitepay`,
      customer: { name: usuario.nome, email: usuario.email },
    };

    const ipRes = await fetch(IP_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!ipRes.ok) {
      const errText = await ipRes.text();
      await client.query('ROLLBACK');
      return res.status(502).json({ error: 'Erro no checkout InfinitePay', detail: errText });
    }
    const data = await ipRes.json();
    const checkout_url = data.url || data.checkout_url || data.link;

    await client.query(
      'UPDATE ead_matriculas SET order_nsu = $1, receipt_url = $2 WHERE id = $3',
      [order_nsu, checkout_url, matricula.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true, status: 'pendente', checkout_url, order_nsu, conta_existente: contaExistente, email: usuario.email });

  } catch(e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// Listar alunos do EAD (Admin)
// Mostra: usuários web (com matrícula) E presenciais ELEGÍVEIS pela turma
// (mesmo que ainda não tenham logado no portal — acesso é automático por CPF).
router.get('/alunos', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { search } = req.query;

    // mapa titulo -> id dos cursos EAD
    const { rows: eadCursos } = await db.query('SELECT id, titulo FROM ead_cursos');
    const tituloToId = {};
    eadCursos.forEach(c => { tituloToId[c.titulo] = c.id; });

    const lista = [];

    // 1) Usuários web (vendas online) + suas matrículas ativas
    const { rows: webs } = await db.query(
      'SELECT id, nome, email, cpf, telefone, criado_em FROM ead_usuarios WHERE deletado_em IS NULL ORDER BY nome'
    );
    for (const u of webs) {
      const { rows: mats } = await db.query(
        "SELECT curso_id FROM ead_matriculas WHERE usuario_id = $1 AND status = 'ativa'",
        [u.id]
      );
      lista.push({
        id: u.id, nome: u.nome, email: u.email, cpf: u.cpf,
        telefone: u.telefone, criado_em: u.criado_em, tipo: 'web',
        cursos: mats.map(m => m.curso_id),
      });
    }

    // 2) Presenciais ativos/formados, elegíveis pela turma (independe de já ter logado)
    const { rows: pres } = await db.query(`
      SELECT a.id, a.nome, a.email, a.cpf, a.whatsapp AS telefone, a.pagamento AS criado_em,
             a.curso, t.nome AS turma_nome
      FROM alunos a
      LEFT JOIN turmas t ON a.turma_id = t.id
      WHERE a.status IN ('ativo', 'formado')
      ORDER BY a.nome
    `);
    for (const a of pres) {
      const titulos = cursosEadElegiveis(a.turma_nome, a.curso);
      if (!titulos.length) continue; // turma sem equivalente EAD (ex: Design) — pula
      const cursosIds = titulos.map(t => tituloToId[t]).filter(Boolean);
      lista.push({
        id: a.id, nome: a.nome, email: a.email, cpf: a.cpf,
        telefone: a.telefone, criado_em: a.criado_em, tipo: 'presencial',
        turma: a.turma_nome || null,
        cursos: cursosIds,
      });
    }

    // Filtro de busca (nome / cpf / email)
    let result = lista;
    if (search) {
      const s = String(search).toLowerCase();
      const sNum = s.replace(/\D/g, '');
      result = lista.filter(x =>
        (x.nome || '').toLowerCase().includes(s) ||
        (x.email || '').toLowerCase().includes(s) ||
        (sNum && (x.cpf || '').replace(/\D/g, '').includes(sNum))
      );
    }

    res.json(result);
  } catch(e) { next(e); }
});

// POST /api/ead/alunos/avulso — cria aluno web + libera cursos (admin, sem pagamento)
router.post('/alunos/avulso', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { nome, email, cpf, senha, telefone, curso_ids } = req.body;
    if (!nome || !email || !cpf || !senha) {
      return res.status(400).json({ error: 'nome, email, cpf e senha são obrigatórios' });
    }
    const cursos = Array.isArray(curso_ids) ? curso_ids.map(Number).filter(Boolean) : [];
    const hash = await bcrypt.hash(String(senha), 10);
    const cpfLimpo = String(cpf).replace(/\D/g, '');
    const cpfFmt = cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    const { rows: eu } = await db.query(
      `INSERT INTO ead_usuarios (nome, email, cpf, senha_hash, telefone)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [nome.trim(), email.trim().toLowerCase(), cpfFmt, hash, telefone || null]
    );
    const usuarioId = eu[0].id;
    for (const cursoId of cursos) {
      await db.query(
        `INSERT INTO ead_matriculas (usuario_id, curso_id, status)
         VALUES ($1,$2,'ativa') ON CONFLICT (usuario_id, curso_id) DO NOTHING`,
        [usuarioId, cursoId]
      );
    }
    res.status(201).json({ ok: true, usuario_id: usuarioId });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'E-mail ou CPF já cadastrado' });
    next(e);
  }
});

// DELETE /api/ead/alunos/web/:id — soft-delete usuário web (admin)
router.delete('/alunos/web/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    await db.query(`UPDATE ead_usuarios SET deletado_em = NOW() WHERE id = $1`, [id]);
    await db.query(`UPDATE ead_matriculas SET status = 'inativa' WHERE usuario_id = $1`, [id]);
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// GET /api/ead/alunos/web/:id/matriculas — matrículas ativas de um usuário web (admin)
router.get('/alunos/web/:id/matriculas', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT m.id AS matricula_id, c.id AS curso_id, c.titulo, c.icone
         FROM ead_matriculas m
         JOIN ead_cursos c ON c.id = m.curso_id
        WHERE m.usuario_id = $1 AND m.status = 'ativa'
        ORDER BY c.titulo`,
      [req.params.id]
    );
    res.json(rows);
  } catch(e) { next(e); }
});

// GET /api/ead/alunos/presencial/:id/matriculas — matrículas EAD de um aluno presencial (admin)
router.get('/alunos/presencial/:id/matriculas', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT m.id AS matricula_id, c.id AS curso_id, c.titulo, c.icone
         FROM ead_matriculas m
         JOIN ead_cursos c ON c.id = m.curso_id
        WHERE m.aluno_id = $1 AND m.status = 'ativa'
        ORDER BY c.titulo`,
      [req.params.id]
    );
    res.json(rows);
  } catch(e) { next(e); }
});

// POST /api/ead/matriculas — libera um curso para um aluno (admin)
router.post('/matriculas', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { tipo, id, curso_id } = req.body; // tipo='web'|'presencial'
    if (!tipo || !id || !curso_id) return res.status(400).json({ error: 'tipo, id e curso_id obrigatórios' });
    const campo = tipo === 'presencial' ? 'aluno_id' : 'usuario_id';
    const conflict = tipo === 'presencial' ? '(aluno_id, curso_id)' : '(usuario_id, curso_id)';
    await db.query(
      `INSERT INTO ead_matriculas (${campo}, curso_id, status)
       VALUES ($1,$2,'ativa')
       ON CONFLICT ${conflict} DO UPDATE SET status='ativa', data_matricula=NOW()`,
      [id, curso_id]
    );
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// DELETE /api/ead/matriculas/:matriculaId — revoga acesso a um curso (admin)
router.delete('/matriculas/:matriculaId', eadAdminMiddleware, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE ead_matriculas SET status='inativa' WHERE id=$1`,
      [req.params.matriculaId]
    );
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// GET /api/ead/certificados/admin/todos — lista TODOS os certificados emitidos (Admin)
router.get('/certificados/admin/todos', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.codigo, c.data_emissao, cur.titulo AS curso_titulo, cur.carga_horaria,
              COALESCE(u.nome, a.nome) AS aluno_nome
       FROM ead_certificados c
       JOIN ead_matriculas m ON c.matricula_id = m.id
       JOIN ead_cursos cur ON m.curso_id = cur.id
       LEFT JOIN ead_usuarios u ON m.usuario_id = u.id
       LEFT JOIN alunos a ON m.aluno_id = a.id
       ORDER BY c.data_emissao DESC`
    );
    res.json(rows.map(r => ({
      nomeAluno: r.aluno_nome || '—',
      nomeCurso: r.curso_titulo,
      codigo: r.codigo,
      emissao: r.data_emissao,
      carga: r.carga_horaria
    })));
  } catch(e) { next(e); }
});

module.exports = router;
module.exports.eadAuthMiddleware = eadAuthMiddleware;
