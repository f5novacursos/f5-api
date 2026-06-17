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

// Estatística de mercados da célula ACIMA (Under/Over 2.5 e Ambas Sim)
function novoStat() { return { n:0, under:0, over:0, ambas:0 }; }
function acumulaStat(s, a, b) {
  s.n++;
  const g = a + b;
  if (g <= 2) s.under++;
  if (g >= 3) s.over++;
  if (a > 0 && b > 0) s.ambas++;
}
function melhorMercado(s) {
  return [
    { m:'UNDER 2.5', p: Math.round(s.under*100/s.n) },
    { m:'OVER 2.5',  p: Math.round(s.over*100/s.n) },
    { m:'AMBAS SIM', p: Math.round(s.ambas*100/s.n) },
  ].sort((a, b) => b.p - a.p)[0];
}

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
// clockOffsetMs: relógio do provedor (Betano -3h = -10800000, Bet365 +1h = +3600000)
module.exports = function (db, tabela, clockOffsetMs = 0) {
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

  // ── GET /melhores-entradas ──────────────────────────────────────
  // A "aba Especial": pega o que saiu por último em cada slot e prevê
  // a célula ACIMA. Retorna só o TOP N por liga (mastigado).
  router.get('/melhores-entradas', auth, async (req, res) => {
    try {
      const horas      = parseInt(req.query.horas) || 720;
      const topN       = parseInt(req.query.top) || 3;
      const minAmostra = parseInt(req.query.min_amostra) || 8;
      const minConf    = parseInt(req.query.min_conf) || 60;
      const cutoff     = Date.now() - horas * 3600000;

      const { rows } = await db.query(`
        SELECT liga, slot_min, ft_a, ft_b, ft_str, start_time
        FROM ${tabela}
        WHERE start_time > $1
        ORDER BY liga, slot_min, start_time ASC
      `, [cutoff]);

      // Organiza por liga → slot → lista cronológica
      const porLiga = {};
      for (const r of rows) {
        const lg = r.liga, slot = parseInt(r.slot_min);
        (porLiga[lg] = porLiga[lg] || {});
        (porLiga[lg][slot] = porLiga[lg][slot] || []).push({
          ts: Number(r.start_time), ft: r.ft_str,
          a: parseInt(r.ft_a), b: parseInt(r.ft_b)
        });
      }

      const out = {};
      for (const lg in porLiga) {
        const slots = porLiga[lg];
        // Dois gatilhos por slot, ambos prevendo a célula ACIMA (próxima hora):
        //  stat1: slot|ft         (último resultado)        → mercados de cima
        //  stat2: slot||ft1>ft2   (2 últimos consecutivos)  → mercados de cima
        const stat1 = {}, stat2 = {};
        for (const slot in slots) {
          const arr = slots[slot];
          for (let i = 0; i < arr.length - 1; i++) {
            const gap = arr[i+1].ts - arr[i].ts;
            if (gap < MIN_GAP || gap > MAX_GAP) continue;
            // gatilho de 1: arr[i] → arr[i+1]
            const k1 = slot + '|' + arr[i].ft;
            (stat1[k1] = stat1[k1] || novoStat());
            acumulaStat(stat1[k1], arr[i+1].a, arr[i+1].b);
            // gatilho de 2: (arr[i-1], arr[i]) → arr[i+1], exige os dois gaps ~60min (horas consecutivas)
            if (i >= 1) {
              const gapPrev = arr[i].ts - arr[i-1].ts;
              if (gapPrev >= MIN_GAP && gapPrev <= MAX_GAP) {
                const k2 = slot + '||' + arr[i-1].ft + '>' + arr[i].ft;
                (stat2[k2] = stat2[k2] || novoStat());
                acumulaStat(stat2[k2], arr[i+1].a, arr[i+1].b);
              }
            }
          }
        }

        // gatilho atual de cada slot = seus últimos resultados; pega o melhor entre seq-2 e seq-1
        const cands = [];
        for (const slot in slots) {
          const arr = slots[slot];
          const ult = arr[arr.length - 1];
          const horaAlvo = (new Date(ult.ts + clockOffsetMs).getUTCHours() + 1) % 24;

          const opcoes = [];
          // seq-1 (sempre disponível)
          const s1 = stat1[slot + '|' + ult.ft];
          if (s1 && s1.n >= minAmostra) {
            const b = melhorMercado(s1);
            opcoes.push({ tipo:'seq1', gatilho: ult.ft, mercado: b.m, pct: b.p, amostra: s1.n });
          }
          // seq-2 (só se os 2 últimos forem horas consecutivas e tiver amostra)
          if (arr.length >= 2) {
            const pen = arr[arr.length - 2];
            if (ult.ts - pen.ts >= MIN_GAP && ult.ts - pen.ts <= MAX_GAP) {
              const s2 = stat2[slot + '||' + pen.ft + '>' + ult.ft];
              if (s2 && s2.n >= minAmostra) {
                const b = melhorMercado(s2);
                opcoes.push({ tipo:'seq2', gatilho: pen.ft + '>' + ult.ft, mercado: b.m, pct: b.p, amostra: s2.n });
              }
            }
          }
          if (!opcoes.length) continue;
          // ganha a maior confiança; empate → maior amostra
          opcoes.sort((a, b) => b.pct - a.pct || b.amostra - a.amostra);
          const win = opcoes[0];
          if (win.pct < minConf) continue;
          cands.push({ slot:+slot, gatilho: win.gatilho, tipo: win.tipo, mercado: win.mercado, pct: win.pct, amostra: win.amostra, hora_alvo: horaAlvo });
        }

        // top N por confiança, exibido em ordem de slot
        cands.sort((a,b) => b.pct - a.pct || b.amostra - a.amostra);
        out[lg] = cands.slice(0, topN).sort((a,b) => a.slot - b.slot);
      }

      // hora alvo dominante (a mais frequente entre todas as entradas) p/ o banner
      const contHora = {};
      for (const lg in out) for (const e of out[lg]) contHora[e.hora_alvo] = (contHora[e.hora_alvo]||0) + 1;
      let horaAlvoDom = null, maxC = 0;
      for (const h in contHora) if (contHora[h] > maxC) { maxC = contHora[h]; horaAlvoDom = +h; }

      res.json({ ok: true, hora_alvo: horaAlvoDom, ligas: out });
    } catch (e) {
      console.error('[melhores-entradas]', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
