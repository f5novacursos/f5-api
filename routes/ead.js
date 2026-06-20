const router = require('express').Router();
const db = require('../db');
const lixeira = require('../lib/lixeira');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const JWT_SECRET = process.env.EAD_JWT_SECRET || 'ead2026secret';
const JWT_EXPIRY = '7d';

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
router.post('/auth/login', async (req, res, next) => {
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
      
      // Mapear cursos ead elegíveis com base na turma do presencial
      const cursosElegiveis = [];
      const cursoPresencial = (aluno.turma_curso_nome || '').toLowerCase();
      
      if (cursoPresencial.includes('informatica') || cursoPresencial.includes('ia') || cursoPresencial.includes('inteligência')) {
        cursosElegiveis.push('Informática Profissional + IA EAD');
      }
      if (cursoPresencial.includes('excel')) {
        cursosElegiveis.push('Excel Profissional + IA EAD');
      }

      // Se não houver curso elegível explícito, mas estiver ativo no acadêmico, 
      // podemos dar acesso conforme o que ele tiver na coluna 'curso' do aluno
      if (cursosElegiveis.length === 0 && aluno.curso) {
        const cAluno = aluno.curso.toLowerCase();
        if (cAluno.includes('informatica') || cAluno.includes('ia')) {
          cursosElegiveis.push('Informática Profissional + IA EAD');
        }
        if (cAluno.includes('excel')) {
          cursosElegiveis.push('Excel Profissional + IA EAD');
        }
      }

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
    const identificador = (email || cpf || '').toLowerCase().trim();
    if (!identificador || !senha) {
      return res.status(400).json({ error: 'Preencha CPF/E-mail e Senha.' });
    }

    const { rows: users } = await db.query(
      `SELECT * FROM ead_usuarios 
       WHERE LOWER(email) = $1 OR REPLACE(REPLACE(cpf, '.', ''), '-', '') = $1`,
      [identificador.replace(/\D/g, '') || identificador]
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
router.post('/auth/cadastro', async (req, res, next) => {
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
        const { rows: aulas } = await db.query(
          'SELECT id, modulo_id, titulo, duracao, material, gratis, ordem FROM ead_aulas WHERE modulo_id = $1 ORDER BY ordem ASC, id ASC',
          [modulo.id]
        );
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
    const { titulo, descricao, categoria, carga_horaria, preco, icone } = req.body;
    if (!titulo) return res.status(400).json({ error: 'Título do curso é obrigatório.' });

    const { rows } = await db.query(
      `INSERT INTO ead_cursos (titulo, descricao, categoria, carga_horaria, preco, icone) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [titulo, descricao || '', categoria || 'Informática', parseInt(carga_horaria) || 20, parseFloat(preco) || 0.00, icone || '💻']
    );
    res.status(201).json(rows[0]);
  } catch(e) { next(e); }
});

// PUT /api/ead/cursos/:id (Admin)
router.put('/cursos/:id', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { titulo, descricao, categoria, carga_horaria, preco, icone } = req.body;
    const { rows } = await db.query(
      `UPDATE ead_cursos SET 
         titulo = COALESCE($1, titulo), 
         descricao = COALESCE($2, descricao), 
         categoria = COALESCE($3, categoria), 
         carga_horaria = COALESCE($4, carga_horaria), 
         preco = COALESCE($5, preco), 
         icone = COALESCE($6, icone) 
       WHERE id = $7 RETURNING *`,
      [titulo, descricao, categoria, carga_horaria, preco, icone, req.params.id]
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
    const { modulo_id, titulo, url, duracao, material, gratis, ordem } = req.body;
    if (!modulo_id || !titulo) return res.status(400).json({ error: 'modulo_id e titulo são obrigatórios.' });

    const { rows } = await db.query(
      `INSERT INTO ead_aulas (modulo_id, titulo, url, duracao, material, gratis, ordem) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [modulo_id, titulo, url || '', parseInt(duracao) || 10, material || '', Boolean(gratis), parseInt(ordem) || 0]
    );
    res.status(201).json(rows[0]);
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

// Listar alunos do EAD (Admin)
router.get('/alunos', eadAdminMiddleware, async (req, res, next) => {
  try {
    const { search } = req.query;
    let query = `
      SELECT u.id, u.nome, u.email, u.cpf, u.telefone, u.criado_em, 'web' AS tipo
      FROM ead_usuarios u
      UNION ALL
      SELECT a.id, a.nome, a.email, a.cpf, a.whatsapp AS telefone, a.pagamento AS criado_em, 'presencial' AS tipo
      FROM alunos a
      JOIN ead_matriculas m ON a.id = m.aluno_id
      GROUP BY a.id
    `;
    const params = [];
    
    if (search) {
      params.push('%' + search + '%');
      query = `
        SELECT * FROM (${query}) AS total
        WHERE nome ILIKE $1 OR cpf ILIKE $1 OR email ILIKE $1
      `;
    }
    
    const { rows } = await db.query(query, params);
    
    // Obter as matrículas de cada um
    for (const aluno of rows) {
      let queryMats = '';
      if (aluno.tipo === 'web') {
        queryMats = "SELECT curso_id FROM ead_matriculas WHERE usuario_id = $1 AND status = 'ativa'";
      } else {
        queryMats = "SELECT curso_id FROM ead_matriculas WHERE aluno_id = $1 AND status = 'ativa'";
      }
      const { rows: mats } = await db.query(queryMats, [aluno.id]);
      aluno.cursos = mats.map(m => m.curso_id);
    }
    
    res.json(rows);
  } catch(e) { next(e); }
});

module.exports = router;
module.exports.eadAuthMiddleware = eadAuthMiddleware;
