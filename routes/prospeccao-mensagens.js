// F5 Leads: envio/histórico/etiquetas de mensagens (portado do f5leads-api), montado em /api/prospeccao/mensagens
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { LATERAIS, MOTIVO } = require('./prospeccao-sql');

const EVO_URL      = process.env.EVOLUTION_URL      || 'https://evo.f5novacursos.com.br';
const EVO_APIKEY   = process.env.EVOLUTION_API_KEY || process.env.EVOLUTION_APIKEY || '';
const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE || 'zapf5cursos';

// Status que indicam que o lead já foi contatado (ou não deve ser) — nunca reenviar
const STATUS_CONTATADOS = ['mensagem_enviada', 'respondeu', 'cliente', 'nao_enviar', 'ignorado'];

// ── Tabelas da fila de disparo ─────────────────────────────────────────────
// O disparo roda NO SERVIDOR: a tela só cria o disparo e acompanha o progresso.
// Fechar a aba, cair a internet ou reiniciar a API não perde o andamento.
db.query(`
  CREATE TABLE IF NOT EXISTS leads_disparos (
    id               SERIAL PRIMARY KEY,
    status           VARCHAR(20) NOT NULL DEFAULT 'em_andamento', -- em_andamento | concluido | cancelado
    mensagem         TEXT NOT NULL,
    instancia        VARCHAR(100) NOT NULL,
    delay_ms         INTEGER NOT NULL DEFAULT 30000,
    label_id         VARCHAR(100),
    media_base64     TEXT,
    media_mimetype   VARCHAR(100),
    total            INTEGER NOT NULL DEFAULT 0,
    enviados         INTEGER NOT NULL DEFAULT 0,
    pulados          INTEGER NOT NULL DEFAULT 0,
    erros            INTEGER NOT NULL DEFAULT 0,
    proximo_envio_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    concluido_em     TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS leads_disparo_itens (
    id            SERIAL PRIMARY KEY,
    disparo_id    INTEGER NOT NULL REFERENCES leads_disparos(id) ON DELETE CASCADE,
    empresa_id    INTEGER NOT NULL,
    ordem         INTEGER NOT NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'pendente', -- pendente | enviando | enviado | pulado | erro | cancelado
    numero        VARCHAR(30),
    erro          TEXT,
    processado_em TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_disparo_itens_fila ON leads_disparo_itens (disparo_id, status, ordem);
  CREATE INDEX IF NOT EXISTS idx_disparo_itens_empresa ON leads_disparo_itens (empresa_id);
`).then(() => {
  // Item que estava "enviando" quando a API caiu: NÃO reenvia (pode ter chegado) — marca para conferência
  return db.query(`UPDATE leads_disparo_itens SET status = 'erro', erro = 'Interrompido durante o envio (API reiniciou) — conferir no WhatsApp', processado_em = NOW() WHERE status = 'enviando'`);
}).catch(e => console.error('[f5leads disparos] criar tabelas:', e.message));

// Envia uma mensagem pela Evolution (texto ou imagem com legenda)
async function chamarEvolution({ numero, mensagem, instancia, media_base64, media_mimetype }) {
  let evoUrl = `${EVO_URL}/message/sendText/${instancia}`;
  let evoBody = { number: numero, text: mensagem, delay: 1000 };
  if (media_base64) {
    evoUrl = `${EVO_URL}/message/sendMedia/${instancia}`;
    evoBody = { number: numero, mediatype: 'image', mimetype: media_mimetype || 'image/jpeg', caption: mensagem, media: media_base64 };
  }
  const evoRes = await fetch(evoUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVO_APIKEY },
    body: JSON.stringify(evoBody)
  });
  const evoData = await evoRes.json().catch(() => ({}));
  if (!evoRes.ok) throw new Error(evoData.message || evoData.error || JSON.stringify(evoData));
  return evoData;
}

// Troca {{empresa}} pelo nome do lead (a tela promete isso no campo da mensagem)
function aplicarVariaveis(texto, nomeEmpresa) {
  return String(texto).replace(/\{\{\s*empresa\s*\}\}/gi, nomeEmpresa);
}

// Processa UM lead do disparo: valida, aplica o anti-reenvio e envia.
// Retorna { status: 'enviado' | 'pulado' | 'erro', numero, erro }.
async function processarEmpresa(empresa_id, cfg) {
  const { instancia, media_base64, media_mimetype, label_id } = cfg;

  const empRes = await db.query('SELECT * FROM leads_empresas WHERE id = $1', [empresa_id]);
  const empresa = empRes.rows[0];
  if (!empresa) return { status: 'erro', erro: 'Empresa não encontrada' };
  const mensagem = aplicarVariaveis(cfg.mensagem, empresa.nome || '');

  // Normaliza número (tenta whatsapp primeiro, depois telefone)
  const numRaw = (empresa.whatsapp || empresa.telefone || '').replace(/\D/g, '');
  if (!numRaw || numRaw.length < 8) {
    await db.query(`UPDATE leads_empresas SET status = 'sem_whatsapp', atualizado_em = NOW() WHERE id = $1`, [empresa_id]);
    return { status: 'erro', erro: 'Sem número válido' };
  }
  const numero = numRaw.startsWith('55') ? numRaw : `55${numRaw}`;

  // Anti-reenvio: pula quem já foi contatado (status) ou cujo número já recebeu mensagem
  // (mesmo que seja outro cadastro da mesma empresa, achado em outra busca, ou repetido neste disparo)
  if (empresa.status === 'duplicado') {
    return { status: 'pulado', numero, erro: 'Cadastro duplicado (unido a outro lead)' };
  }
  if (STATUS_CONTATADOS.includes(empresa.status)) {
    return { status: 'pulado', numero, erro: `Já contatado (${empresa.status})` };
  }
  // "Mesmo número" = mesmo DDD + 8 últimos dígitos (83 9887-4995 e 85 9887-4995 são empresas diferentes)
  const jaRecebeu = await db.query(
    `SELECT 1 FROM leads_mensagens
     WHERE status = 'enviado' AND f5_chave_telefone($1) IS NOT NULL AND f5_chave_telefone(numero) = f5_chave_telefone($1)
     LIMIT 1`,
    [numero]
  );
  if (jaRecebeu.rows[0]) {
    await db.query(`UPDATE leads_empresas SET status = 'mensagem_enviada', atualizado_em = NOW() WHERE id = $1`, [empresa_id]);
    return { status: 'pulado', numero, erro: 'Este número já recebeu mensagem antes' };
  }

  const msgRes = await db.query(
    `INSERT INTO leads_mensagens (empresa_id, conteudo, instancia, numero, status)
     VALUES ($1, $2, $3, $4, 'pendente') RETURNING id`,
    [empresa_id, media_base64 ? `[IMAGEM] ${mensagem}` : mensagem, instancia, numero]
  );
  const msg_id = msgRes.rows[0].id;

  try {
    const evoData = await chamarEvolution({ numero, mensagem, instancia, media_base64, media_mimetype });
    await db.query(`UPDATE leads_mensagens SET status = 'enviado', resultado = $1 WHERE id = $2`, [JSON.stringify(evoData), msg_id]);
    await db.query(`UPDATE leads_empresas SET status = 'mensagem_enviada', atualizado_em = NOW() WHERE id = $1`, [empresa_id]);
    await db.query(
      `INSERT INTO leads_historico (empresa_id, tipo, descricao, dados) VALUES ($1, 'mensagem_enviada', $2, $3)`,
      [empresa_id, `Mensagem enviada via ${instancia}`, JSON.stringify({ instancia, numero, msg_id })]
    ).catch(e => console.error('[f5leads historico]', e.message));

    // Adiciona a etiqueta se foi escolhida
    if (label_id) {
      fetch(`${EVO_URL}/label/handleLabel/${instancia}`, {
        method: 'POST',
        headers: { 'apikey': EVO_APIKEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: numero, labelId: String(label_id), action: 'add' })
      }).catch(err => console.error('[f5leads] Erro ao adicionar etiqueta:', err));
    }
    return { status: 'enviado', numero };
  } catch (e) {
    await db.query(`UPDATE leads_mensagens SET status = 'erro', erro = $1 WHERE id = $2`, [e.message, msg_id]);
    await db.query(
      `INSERT INTO leads_historico (empresa_id, tipo, descricao, dados) VALUES ($1, 'erro_envio', $2, $3)`,
      [empresa_id, `Erro ao enviar: ${e.message}`, JSON.stringify({ numero, erro: e.message })]
    ).catch(err => console.error('[f5leads historico]', err.message));
    return { status: 'erro', numero, erro: e.message };
  }
}

// ── Worker da fila ─────────────────────────────────────────────────────────
// A cada 2s pega o próximo lead pendente do disparo mais antigo cujo intervalo já passou.
// Um lead por vez; pulados não esperam o intervalo, envios reais esperam delay_ms.
let workerOcupado = false;
async function tickDisparos() {
  if (workerOcupado) return;
  workerOcupado = true;
  try {
    const d = (await db.query(
      `SELECT * FROM leads_disparos WHERE status = 'em_andamento' AND proximo_envio_em <= NOW() ORDER BY id LIMIT 1`
    )).rows[0];
    if (!d) return;

    const item = (await db.query(
      `UPDATE leads_disparo_itens SET status = 'enviando'
       WHERE id = (SELECT id FROM leads_disparo_itens WHERE disparo_id = $1 AND status = 'pendente' ORDER BY ordem LIMIT 1)
       RETURNING *`,
      [d.id]
    )).rows[0];

    if (!item) {
      // Acabou a fila: conclui e libera a imagem guardada
      await db.query(`UPDATE leads_disparos SET status = 'concluido', concluido_em = NOW(), media_base64 = NULL WHERE id = $1 AND status = 'em_andamento'`, [d.id]);
      return;
    }

    const r = await processarEmpresa(item.empresa_id, d);
    await db.query(
      `UPDATE leads_disparo_itens SET status = $1, numero = $2, erro = $3, processado_em = NOW() WHERE id = $4`,
      [r.status, r.numero || null, r.erro || null, item.id]
    );
    const coluna = r.status === 'enviado' ? 'enviados' : r.status === 'pulado' ? 'pulados' : 'erros';
    // Só espera o intervalo se realmente tentou mandar algo pelo WhatsApp
    const esperar = r.status === 'pulado' ? 0 : d.delay_ms;
    await db.query(
      `UPDATE leads_disparos SET ${coluna} = ${coluna} + 1, proximo_envio_em = NOW() + ($1 || ' milliseconds')::interval WHERE id = $2`,
      [String(esperar), d.id]
    );
  } catch (e) {
    console.error('[f5leads disparos] worker:', e.message);
  } finally {
    workerOcupado = false;
  }
}
setInterval(tickDisparos, 2000).unref();

// POST /api/prospeccao/mensagens/verificar  { empresa_ids: [] }
// Confere NA HORA, com os dados atuais do banco, quem pode receber e quem seria pulado (e por quê).
// Pega o que a tela ainda não sabe: envio feito em outro dia/aba, outro cadastro com o mesmo número, lead já na fila.
router.post('/verificar', async (req, res) => {
  try {
    const ids = [...new Set((req.body.empresa_ids || []).map(Number).filter(Boolean))];
    if (!ids.length) return res.json({ total: 0, enviar: 0, ids_enviar: [], pulados: [], por_motivo: {} });
    const r = await db.query(
      `SELECT e.id, e.nome, k.chave, x.ultimo_envio, (${MOTIVO}) AS motivo
       FROM leads_empresas e ${LATERAIS}
       WHERE e.id = ANY($1::int[])
       ORDER BY array_position($1::int[], e.id)`, [ids]);
    const vistos = new Set(), ids_enviar = [], pulados = [], por_motivo = {};
    for (const l of r.rows) {
      let motivo = l.motivo;
      // dois cadastros com o mesmo número na mesma seleção: só o primeiro recebe
      if (!motivo && l.chave && vistos.has(l.chave)) motivo = 'repetido_na_selecao';
      if (!motivo) { if (l.chave) vistos.add(l.chave); ids_enviar.push(l.id); continue; }
      por_motivo[motivo] = (por_motivo[motivo] || 0) + 1;
      pulados.push({ id: l.id, nome: l.nome, motivo, ultimo_envio: l.ultimo_envio });
    }
    res.json({ total: ids.length, enviar: ids_enviar.length, ids_enviar, pulados: pulados.slice(0, 100), por_motivo });
  } catch (e) {
    console.error('[mensagens verificar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/prospeccao/mensagens/enviar
// Body: { empresa_ids?: [], teste_numero?: string, mensagem: string, instancia?: string, delay_ms?: number, media_base64?: string, media_mimetype?: string, label_id?: string }
// - teste_numero: envia na hora (não mexe em leads nem histórico)
// - empresa_ids:  cria um disparo na fila e responde na hora com { disparo_id }
router.post('/enviar', async (req, res) => {
  try {
    const {
      empresa_ids, teste_numero, mensagem, instancia = EVO_INSTANCE, delay_ms = 30000,
      media_base64, media_mimetype, label_id
    } = req.body;

    if (!empresa_ids?.length && !teste_numero) return res.status(400).json({ error: 'empresa_ids ou teste_numero é obrigatório' });
    if (!mensagem) return res.status(400).json({ error: 'mensagem é obrigatória' });

    if (teste_numero) {
      const numRaw = String(teste_numero).replace(/\D/g, '');
      const numero = numRaw.startsWith('55') ? numRaw : `55${numRaw}`;
      try {
        await chamarEvolution({ numero, mensagem: aplicarVariaveis(mensagem, 'Empresa Exemplo'), instancia, media_base64, media_mimetype });
        return res.json({ ok: true, enviados: 1, erros: 0, pulados: 0, resultados: [{ empresa_id: 'TESTE', ok: true, numero }] });
      } catch (e) {
        return res.json({ ok: true, enviados: 0, erros: 1, pulados: 0, resultados: [{ empresa_id: 'TESTE', ok: false, erro: e.message }] });
      }
    }

    // Remove IDs repetidos mantendo a ordem
    const ids = [...new Set(empresa_ids.map(Number).filter(Boolean))];
    const d = (await db.query(
      `INSERT INTO leads_disparos (mensagem, instancia, delay_ms, label_id, media_base64, media_mimetype, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [mensagem, instancia, Math.max(0, Number(delay_ms) || 0), label_id || null, media_base64 || null, media_mimetype || null, ids.length]
    )).rows[0];
    await db.query(
      `INSERT INTO leads_disparo_itens (disparo_id, empresa_id, ordem)
       SELECT $1, x.id, x.ord FROM UNNEST($2::int[]) WITH ORDINALITY AS x(id, ord)`,
      [d.id, ids]
    );
    tickDisparos(); // começa já, sem esperar o próximo tick
    res.json({ ok: true, disparo_id: d.id, total: ids.length });
  } catch (e) {
    console.error('[mensagens enviar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/prospeccao/mensagens/disparos?ativos=1 — lista disparos recentes (ou só os em andamento)
router.get('/disparos', async (req, res) => {
  try {
    const where = req.query.ativos ? `WHERE status = 'em_andamento'` : '';
    const r = await db.query(
      `SELECT id, status, mensagem, instancia, delay_ms, total, enviados, pulados, erros, proximo_envio_em, criado_em, concluido_em
       FROM leads_disparos ${where} ORDER BY id DESC LIMIT 20`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/prospeccao/mensagens/disparos/:id — progresso + itens processados
router.get('/disparos/:id', async (req, res) => {
  try {
    const d = (await db.query(
      `SELECT id, status, mensagem, instancia, delay_ms, total, enviados, pulados, erros, proximo_envio_em, criado_em, concluido_em
       FROM leads_disparos WHERE id = $1`, [req.params.id]
    )).rows[0];
    if (!d) return res.status(404).json({ error: 'Disparo não encontrado' });
    const itens = await db.query(
      `SELECT i.empresa_id, i.status, i.numero, i.erro, i.processado_em, e.nome AS empresa_nome
       FROM leads_disparo_itens i LEFT JOIN leads_empresas e ON e.id = i.empresa_id
       WHERE i.disparo_id = $1 AND i.status NOT IN ('pendente', 'cancelado')
       ORDER BY i.processado_em DESC NULLS FIRST LIMIT 200`, [d.id]
    );
    res.json({ ...d, itens: itens.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/prospeccao/mensagens/disparos/:id/cancelar — para o disparo (o que já foi enviado fica)
router.post('/disparos/:id/cancelar', async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE leads_disparos SET status = 'cancelado', concluido_em = NOW(), media_base64 = NULL
       WHERE id = $1 AND status = 'em_andamento' RETURNING id`, [req.params.id]
    );
    if (!r.rows[0]) return res.status(400).json({ error: 'Disparo não está em andamento' });
    await db.query(`UPDATE leads_disparo_itens SET status = 'cancelado' WHERE disparo_id = $1 AND status = 'pendente'`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// GET /api/mensagens/etiquetas — Busca etiquetas na Evolution API
// Query param opcional: ?instancia=nomeDaInstancia (usa EVO_INSTANCE como padrão)
router.get('/etiquetas', async (req, res) => {
  try {
    const instancia = req.query.instancia || EVO_INSTANCE;
    const evoRes = await fetch(`${EVO_URL}/label/findLabels/${instancia}`, {
      headers: { 'apikey': EVO_APIKEY }
    });
    if (!evoRes.ok) {
      console.error(`[etiquetas] Evolution API retornou ${evoRes.status} para instância ${instancia}`);
      return res.status(evoRes.status).json({ error: `Erro ao buscar etiquetas (HTTP ${evoRes.status})` });
    }
    const raw = await evoRes.json();

    // Normaliza: a Evolution pode retornar array direto, { labels: [] } ou { data: [] }
    let labels = [];
    if (Array.isArray(raw)) {
      labels = raw;
    } else if (Array.isArray(raw?.labels)) {
      labels = raw.labels;
    } else if (Array.isArray(raw?.data)) {
      labels = raw.data;
    }

    // Garante que cada label tenha pelo menos id e name
    labels = labels.filter(l => l && (l.id !== undefined || l.labelId !== undefined)).map(l => ({
      id:   l.id   ?? l.labelId ?? l.label_id,
      name: l.name ?? l.label   ?? l.title ?? `Etiqueta ${l.id}`
    }));

    res.json(labels);
  } catch (e) {
    console.error('[etiquetas] Erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mensagens — histórico de envios
router.get('/', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || 1));
    const limit = Math.min(100, parseInt(req.query.limit || 50));
    const off   = (page - 1) * limit;

    const [rows, cnt] = await Promise.all([
      db.query(`
        SELECT m.*, e.nome AS empresa_nome, e.cidade
        FROM leads_mensagens m
        LEFT JOIN leads_empresas e ON e.id = m.empresa_id
        ORDER BY m.enviado_em DESC
        LIMIT $1 OFFSET $2
      `, [limit, off]),
      db.query('SELECT COUNT(*) FROM leads_mensagens')
    ]);

    res.json({ data: rows.rows, total: parseInt(cnt.rows[0].count), page, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
