// ══════════════════════════════════════════════════════════════════
// routes/virturia-contexto.js — Engine de Adjacência da Matrix
// "Quando saiu X numa célula, o que saiu ACIMA dela (próxima hora,
//  mesmo slot) historicamente?"  — minera os 20k+ jogos.
//
// A célula "acima" é encontrada pelo TEMPO REAL entre jogos (~60min),
// então funciona igual para Betano e Bet365 (sem bug de timezone).
// ══════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.VIRTURIA_JWT_SECRET || process.env.VIRTURIA_CHAVE || 'virturia2026secret';

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Token ausente' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: 'Token inválido' }); }
}

const MIN_GAP = 50 * 60 * 1000;   // 50 min
const MAX_GAP = 70 * 60 * 1000;   // 70 min

// Deriva os mercados de um resultado
function mercadosDe(ftA, ftB) {
  const a = parseInt(ftA), b = parseInt(ftB), g = a + b;
  const m = [];
  m.push(g >= 3 ? 'OVER 2.5' : 'UNDER 2.5');
  m.push(g >= 2 ? 'OVER 1.5' : 'UNDER 1.5');
  m.push(a > 0 && b > 0 ? 'AMBAS SIM' : 'AMBAS NÃO');
  if (g === 0) m.push('0-0');
  if (g >= 4) m.push('OVER 3.5');
  return m;
}

// Factory: cria o router para uma tabela (Betano ou Bet365)
module.exports = function (db, tabela) {
  const router = require('express').Router();

  // ── GET /matriz-acima ───────────────────────────────────────────
  // Params: liga, horas (default 720=30d), modo (ft|htft), min_amostra, min_conf
  router.get('/matriz-acima', auth, async (req, res) => {
    try {
      const liga      = req.query.liga || null;
      const horas     = parseInt(req.query.horas) || 720;
      const modo      = req.query.modo === 'htft' ? 'htft' : 'ft';
      const minAmostra= parseInt(req.query.min_amostra) || 6;
      const minConf   = parseInt(req.query.min_conf) || 50;
      const cutoff    = Date.now() - horas * 3600000;

      const { rows } = await db.query(`
        SELECT liga, slot_min, ht_str, ft_str, ft_a, ft_b, start_time
        FROM ${tabela}
        WHERE start_time > $1 ${liga ? 'AND liga = $2' : ''}
        ORDER BY liga, slot_min, start_time ASC
      `, liga ? [cutoff, liga] : [cutoff]);

      // Agrupa por liga|slot e linka cada célula com a de cima (~60min depois)
      // signature do gatilho → contagem de mercados/placares que saíram acima
      const stats = {}; // chave: liga|signature

      let prev = null;
      for (const r of rows) {
        const cur = {
          liga: r.liga, slot: parseInt(r.slot_min),
          ts: Number(r.start_time),
          ft: r.ft_str, ht: r.ht_str,
          a: r.ft_a, b: r.ft_b
        };
        if (prev && prev.liga === cur.liga && prev.slot === cur.slot) {
          const gap = cur.ts - prev.ts;
          if (gap >= MIN_GAP && gap <= MAX_GAP) {
            // prev = gatilho ; cur = célula ACIMA (próxima hora, mesmo slot)
            const sig = modo === 'htft'
              ? `${prev.ht || '?'}→${prev.ft}`
              : prev.ft;
            const chave = `${prev.liga}|${sig}`;
            if (!stats[chave]) {
              stats[chave] = {
                liga: prev.liga, signature: sig, total: 0,
                mercados: {}, placares: {}
              };
            }
            const s = stats[chave];
            s.total++;
            // conta mercados que saíram acima
            for (const mk of mercadosDe(cur.a, cur.b)) {
              s.mercados[mk] = (s.mercados[mk] || 0) + 1;
            }
            // conta placar exato acima
            s.placares[cur.ft] = (s.placares[cur.ft] || 0) + 1;
          }
        }
        prev = cur;
      }

      // Monta resposta: para cada gatilho, o melhor mercado acima
      const out = [];
      for (const chave in stats) {
        const s = stats[chave];
        if (s.total < minAmostra) continue;

        // melhor mercado
        let bestMk = null, bestMkN = 0;
        for (const mk in s.mercados) {
          if (s.mercados[mk] > bestMkN) { bestMkN = s.mercados[mk]; bestMk = mk; }
        }
        const mkPct = Math.round(bestMkN * 100 / s.total);
        if (mkPct < minConf) continue;

        // melhor placar exato
        let bestPl = null, bestPlN = 0;
        for (const pl in s.placares) {
          if (s.placares[pl] > bestPlN) { bestPlN = s.placares[pl]; bestPl = pl; }
        }

        out.push({
          liga: s.liga,
          gatilho: s.signature,
          amostra: s.total,
          mercado_acima: bestMk,
          mercado_pct: mkPct,
          mercado_vezes: bestMkN,
          placar_acima: bestPl,
          placar_pct: Math.round(bestPlN * 100 / s.total),
          placar_vezes: bestPlN,
        });
      }

      // Ordena pelos que mais saem (amostra), depois confiança
      out.sort((a, b) => b.amostra - a.amostra || b.mercado_pct - a.mercado_pct);

      res.json({ ok: true, modo, total: out.length, padroes: out.slice(0, 120) });
    } catch (e) {
      console.error('[matriz-acima]', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
