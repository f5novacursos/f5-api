// F5 Leads: envio/histórico/etiquetas de mensagens (portado do f5leads-api), montado em /api/prospeccao/mensagens
const express = require('express');
const router  = express.Router();
const db      = require('../db');

const EVO_URL      = process.env.EVOLUTION_URL      || 'https://evo.f5novacursos.com.br';
const EVO_APIKEY   = process.env.EVOLUTION_API_KEY || process.env.EVOLUTION_APIKEY || '';
const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE || 'zapf5cursos';

// Status que indicam que o lead já foi contatado (ou não deve ser) — nunca reenviar
const STATUS_CONTATADOS = ['mensagem_enviada', 'respondeu', 'cliente', 'nao_enviar', 'ignorado'];

// POST /api/mensagens/enviar
// Body: { empresa_ids?: [], teste_numero?: string, mensagem: string, instancia?: string, delay_ms?: number, media_base64?: string, media_mimetype?: string, media_name?: string, label_id?: string }
router.post('/enviar', async (req, res) => {
  try {
    const { 
      empresa_ids, teste_numero, mensagem, instancia = EVO_INSTANCE, delay_ms = 3000,
      media_base64, media_mimetype, media_name, label_id
    } = req.body;

    if (!empresa_ids?.length && !teste_numero) return res.status(400).json({ error: 'empresa_ids ou teste_numero é obrigatório' });
    if (!mensagem) return res.status(400).json({ error: 'mensagem é obrigatória' });

    const resultados = [];
    const isTest = !!teste_numero;
    const enviadosNoLote = new Set(); // últimos 8 dígitos já enviados neste disparo

    // Se for teste, cria um "mock" de empresa para aproveitar o loop
    const targets = isTest ? ['TESTE'] : empresa_ids;

    for (let i = 0; i < targets.length; i++) {
      const empresa_id = targets[i];
      let numero = '';

      if (isTest) {
        // Formata número de teste (garante 55)
        const numRaw = teste_numero.replace(/\D/g, '');
        numero = numRaw.startsWith('55') ? numRaw : `55${numRaw}`;
      } else {
        // Busca dados da empresa real
        const empRes = await db.query('SELECT * FROM leads_empresas WHERE id = $1', [empresa_id]);
        if (!empRes.rows[0]) {
          resultados.push({ empresa_id, ok: false, erro: 'Empresa não encontrada' });
          continue;
        }
        const empresa = empRes.rows[0];

        // Normaliza número (tenta whatsapp primeiro, depois telefone)
        const numRaw = (empresa.whatsapp || empresa.telefone || '').replace(/\D/g, '');
        if (!numRaw || numRaw.length < 8) {
          resultados.push({ empresa_id, ok: false, erro: 'Sem número válido' });
          await db.query(`UPDATE leads_empresas SET status = 'sem_whatsapp', atualizado_em = NOW() WHERE id = $1`, [empresa_id]);
          continue;
        }
        numero = numRaw.startsWith('55') ? numRaw : `55${numRaw}`;

        // Anti-reenvio: pula quem já foi contatado (status) ou cujo número já recebeu mensagem
        // (mesmo que seja outro cadastro da mesma empresa, achado em outra busca)
        const fim8 = numero.slice(-8);
        if (STATUS_CONTATADOS.includes(empresa.status)) {
          resultados.push({ empresa_id, ok: false, pulado: true, numero, erro: `Já contatado (${empresa.status})` });
          continue;
        }
        if (enviadosNoLote.has(fim8)) {
          resultados.push({ empresa_id, ok: false, pulado: true, numero, erro: 'Número repetido neste disparo' });
          continue;
        }
        const jaRecebeu = await db.query(
          `SELECT 1 FROM leads_mensagens
           WHERE status = 'enviado' AND RIGHT(REGEXP_REPLACE(COALESCE(numero, ''), '[^0-9]', '', 'g'), 8) = $1
           LIMIT 1`,
          [fim8]
        );
        if (jaRecebeu.rows[0]) {
          await db.query(`UPDATE leads_empresas SET status = 'mensagem_enviada', atualizado_em = NOW() WHERE id = $1`, [empresa_id]);
          resultados.push({ empresa_id, ok: false, pulado: true, numero, erro: 'Este número já recebeu mensagem antes' });
          continue;
        }
        enviadosNoLote.add(fim8);
      }

      let msg_id = null;

      // Só registra no banco se não for teste
      if (!isTest) {
        const msgRes = await db.query(
          `INSERT INTO leads_mensagens (empresa_id, conteudo, instancia, numero, status)
           VALUES ($1, $2, $3, $4, 'pendente') RETURNING id`,
          [empresa_id, media_base64 ? `[IMAGEM] ${mensagem}` : mensagem, instancia, numero]
        );
        msg_id = msgRes.rows[0].id;
      }

      // Delay entre envios (exceto o primeiro e exceto teste isolado)
      if (i > 0 && delay_ms > 0 && !isTest) {
        await new Promise(r => setTimeout(r, delay_ms));
      }

      // Chama Evolution API (Text ou Media)
      try {
        let evoUrl = `${EVO_URL}/message/sendText/${instancia}`;
        let evoBody = { number: numero, text: mensagem, delay: 1000 };

        if (media_base64) {
          evoUrl = `${EVO_URL}/message/sendMedia/${instancia}`;
          evoBody = {
            number: numero,
            mediatype: 'image',
            mimetype: media_mimetype || 'image/jpeg',
            caption:  mensagem,
            media: media_base64
          };
        }

        const evoRes = await fetch(evoUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': EVO_APIKEY
          },
          body: JSON.stringify(evoBody)
        });

        const evoData = await evoRes.json().catch(() => ({}));

        if (evoRes.ok) {
          if (!isTest) {
            await db.query(`UPDATE leads_mensagens SET status = 'enviado', resultado = $1 WHERE id = $2`, [JSON.stringify(evoData), msg_id]);
            await db.query(`UPDATE leads_empresas SET status = 'mensagem_enviada', atualizado_em = NOW() WHERE id = $1`, [empresa_id]);
            await db.query(
              `INSERT INTO leads_historico (empresa_id, tipo, descricao, dados) VALUES ($1, 'mensagem_enviada', $2, $3)`,
              [empresa_id, `Mensagem enviada via ${instancia}`, JSON.stringify({ instancia, numero, msg_id })]
            ).catch(e => console.error('[f5leads historico]', e.message));

            // Adiciona a etiqueta se foi enviada
            if (label_id) {
              fetch(`${EVO_URL}/label/handleLabel/${instancia}`, {
                method: 'POST',
                headers: { 'apikey': EVO_APIKEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  number: numero,
                  labelId: String(label_id),
                  action: "add"
                })
              }).catch(err => console.error('[f5leads] Erro ao adicionar etiqueta:', err));
            }
          }
          resultados.push({ empresa_id, ok: true, numero, msg_id });
        } else {
          const errMsg = evoData.message || evoData.error || JSON.stringify(evoData);
          if (!isTest) {
            await db.query(`UPDATE leads_mensagens SET status = 'erro', erro = $1 WHERE id = $2`, [errMsg, msg_id]);
            await db.query(
              `INSERT INTO leads_historico (empresa_id, tipo, descricao, dados) VALUES ($1, 'erro_envio', $2, $3)`,
              [empresa_id, `Erro ao enviar: ${errMsg}`, JSON.stringify({ numero, erro: errMsg })]
            ).catch(e => console.error('[f5leads historico]', e.message));
          }
          resultados.push({ empresa_id, ok: false, erro: errMsg });
        }
      } catch (evoErr) {
        if (!isTest) {
          await db.query(`UPDATE leads_mensagens SET status = 'erro', erro = $1 WHERE id = $2`, [evoErr.message, msg_id]);
        }
        resultados.push({ empresa_id, ok: false, erro: evoErr.message });
      }
    }

    const enviados = resultados.filter(r => r.ok).length;
    const pulados  = resultados.filter(r => r.pulado).length;
    const erros    = resultados.filter(r => !r.ok && !r.pulado).length;

    res.json({ ok: true, enviados, erros, pulados, resultados });
  } catch (e) {
    console.error('[mensagens enviar]', e.message);
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
