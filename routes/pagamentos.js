const router = require('express').Router();
const db     = require('../db');

const HANDLE   = process.env.INFINITEPAY_HANDLE || 'f5novacursos';
const IP_URL   = 'https://api.checkout.infinitepay.io/links';
const BASE_URL = process.env.BASE_URL || 'https://api.f5novacursos.com.br';

/* ─────────────────────────────────────────────────────────────────
   POST /api/pagamentos/link
   Gera link de pagamento InfinitePay para um aluno já cadastrado.
   Body: { aluno_id }
   Retorna: { checkout_url, order_nsu }
───────────────────────────────────────────────────────────────── */
router.post('/link', async (req, res, next) => {
  try {
    const { aluno_id } = req.body;
    if (!aluno_id) return res.status(400).json({ error: 'aluno_id obrigatório' });

    const { rows } = await db.query('SELECT * FROM alunos WHERE id=$1', [aluno_id]);
    if (!rows.length) return res.status(404).json({ error: 'Aluno não encontrado' });
    const aluno = rows[0];

    const order_nsu      = `student-${aluno.id}-${Date.now()}`;
    const valor_reais    = parseFloat(aluno.valor || aluno.valor_curso || 600);
    const preco_centavos = Math.round(valor_reais * 100);

    const payload = {
      handle:   HANDLE,
      order_nsu,
      items: [{
        quantity:    1,
        price:       preco_centavos,
        description: aluno.curso || 'Curso F5 Nova Cursos',
      }],
      redirect_url: `https://f5novacursos.com.br/reserva.html?pago=1`,
      webhook_url:  `${BASE_URL}/webhook/infinitepay`,
      customer: {
        name: aluno.nome,
        ...(aluno.email    && { email:        aluno.email }),
        ...(aluno.whatsapp && { phone_number: '+55' + aluno.whatsapp.replace(/\D/g, '') }),
      },
    };

    const ipRes = await fetch(IP_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!ipRes.ok) {
      const err = await ipRes.text();
      return res.status(502).json({ error: 'InfinitePay erro', detail: err });
    }

    const data         = await ipRes.json();
    const checkout_url = data.url || data.checkout_url || data.link;
    if (!checkout_url) return res.status(502).json({ error: 'URL não retornada', data });

    // Salvar order_nsu no aluno para rastrear
    await db.query('UPDATE alunos SET order_nsu=$1 WHERE id=$2', [order_nsu, aluno.id]);

    res.json({ checkout_url, order_nsu });
  } catch (err) { next(err); }
});

/* ─────────────────────────────────────────────────────────────────
   POST /api/pagamentos/matricula
   Matrícula online: cria aluno (aguardando_pagamento) + link InfinitePay.
   Body: { nome, whatsapp, curso, valor }
   Retorna: { checkout_url, aluno_id }
───────────────────────────────────────────────────────────────── */
router.post('/matricula', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { nome, whatsapp, curso, valor } = req.body;
    if (!nome || !whatsapp || !curso) {
      return res.status(400).json({ error: 'nome, whatsapp e curso são obrigatórios' });
    }

    const preco = parseFloat(valor) || 600;

    // 1. Criar aluno com status aguardando_pagamento
    const { rows } = await client.query(
      `INSERT INTO alunos (nome, whatsapp, curso, status, status_pagamento, valor)
       VALUES ($1,$2,$3,'aguardando_pagamento','pendente',$4) RETURNING *`,
      [nome, whatsapp, curso, preco]
    );
    const aluno = rows[0];

    // 2. Gerar link InfinitePay
    const order_nsu      = `student-${aluno.id}-${Date.now()}`;
    const preco_centavos = Math.round(preco * 100);

    const payload = {
      handle: HANDLE,
      order_nsu,
      items: [{ quantity: 1, price: preco_centavos, description: curso }],
      redirect_url: `https://f5novacursos.com.br/reserva.html?pago=1`,
      webhook_url:  `${BASE_URL}/webhook/infinitepay`,
      customer: {
        name:         