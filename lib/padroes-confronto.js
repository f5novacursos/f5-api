// ══════════════════════════════════════════════════════════════════════
// lib/padroes-confronto.js  — Motor por Confronto (teamA × teamB × slot)
// Uso: router.get('/padroes-confronto', require('../lib/padroes-confronto')(db, 'tabela', LIGAS_CFG))
// ══════════════════════════════════════════════════════════════════════

const EA_BASE = 'https://api.easycoanalytics.com.br';

// Cache simples em memória (90 segundos por chave)
const _cache = new Map();
function cacheGet(k) { const e = _cache.get(k); return e && Date.now() < e.exp ? e.v : null; }
function cacheSet(k, v, ttl = 90000) { _cache.set(k, { v, exp: Date.now() + ttl }); }

module.exports = function(db, tabela, ligasCfg) {
  // ligasCfg = [{ sub: 'express_cup', liga: 'express_cup', provider: 'bet365' }, ...]

  return async function(req, res) {
    try {
      const horas       = Math.min(parseInt(req.query.horas)       || 720,  8760);
      const min_conf    = Math.min(parseInt(req.query.min_conf)     || 70,   100);
      const min_amostra = Math.max(parseInt(req.query.min_amostra)  || 8,    3);
      const ligaFiltro  = req.query.liga || null;

      const cacheKey = `confronto_${tabela}_${horas}_${min_conf}_${min_amostra}_${ligaFiltro}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      // ── 1. Busca estatísticas históricas de confronto no banco ──────────
      const ligaWhere = ligaFiltro ? `AND liga = $2` : '';
      const params    = [min_amostra];
      if (ligaFiltro) params.push(ligaFiltro);

      const sql = `
        SELECT
          liga, team_a, team_b, slot_min,
          COUNT(*)::int                                                                            AS total,
          ROUND(AVG(gols_total)::numeric, 2)                                                       AS media_gols,
          -- OVER/UNDER 2.5
          SUM(CASE WHEN gols_total > 2  THEN 1 ELSE 0 END)::int                                   AS over25_n,
          ROUND(100.0 * SUM(CASE WHEN gols_total > 2  THEN 1 ELSE 0 END) / COUNT(*), 1)           AS over25_pct,
          ROUND(100.0 * SUM(CASE WHEN gols_total <= 2 THEN 1 ELSE 0 END) / COUNT(*), 1)           AS under25_pct,
          -- OVER/UNDER 1.5
          ROUND(100.0 * SUM(CASE WHEN gols_total > 1  THEN 1 ELSE 0 END) / COUNT(*), 1)           AS over15_pct,
          ROUND(100.0 * SUM(CASE WHEN gols_total <= 1 THEN 1 ELSE 0 END) / COUNT(*), 1)           AS under15_pct,
          -- OVER 3.5 e OVER 4.5 (5+ gols)
          ROUND(100.0 * SUM(CASE WHEN gols_total > 3  THEN 1 ELSE 0 END) / COUNT(*), 1)           AS over35_pct,
          ROUND(100.0 * SUM(CASE WHEN gols_total > 4  THEN 1 ELSE 0 END) / COUNT(*), 1)           AS over45_pct,
          -- 0-0
          ROUND(100.0 * SUM(CASE WHEN gols_total = 0  THEN 1 ELSE 0 END) / COUNT(*), 1)           AS zero_pct,
          -- Ambas marcam
          ROUND(100.0 * SUM(CASE WHEN is_btts = true  THEN 1 ELSE 0 END) / COUNT(*), 1)           AS btts_pct
        FROM ${tabela}
        WHERE team_a IS NOT NULL
          AND team_b IS NOT NULL
          AND gols_total IS NOT NULL
          AND coletado_em > NOW() - INTERVAL '${horas} hours'
          ${ligaWhere}
        GROUP BY liga, team_a, team_b, slot_min
        HAVING COUNT(*) >= $1
        ORDER BY liga, team_a, team_b, slot_min
      `;

      const { rows: stats } = await db.query(sql, params);

      // ── 2. Monta índice rápido: "liga|teamA|teamB|slot" → stats ─────────
      const idx = new Map();
      for (const r of stats) {
        idx.set(`${r.liga}|${r.team_a}|${r.team_b}|${r.slot_min}`, r);
      }

      // ── 3. Busca jogos pendentes na EasyCo (próximos ~90 min) ───────────
      const ligas = ligaFiltro
        ? ligasCfg.filter(l => l.liga === ligaFiltro)
        : ligasCfg;

      const pendentes = [];
      const agora     = Date.now();
      const janela    = 90 * 60 * 1000; // 90 minutos

      await Promise.all(ligas.map(async ({ sub, liga, provider = 'bet365' }) => {
        try {
          const url = `${EA_BASE}/snapshot?provider=${provider}&sub=${sub}&_t=${Date.now()}`;
          const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
          if (!resp.ok) return;
          const data = await resp.json();
          const jogos = Array.isArray(data) ? data : (data.jogos || data.results || []);
          for (const j of jogos) {
            if (j.status !== 'pendente' && j.status !== 'upcoming') continue;
            const ts = j.startTime || j.start_time;
            if (!ts || ts < agora || ts > agora + janela) continue;
            const teamA = j.teamA || j.team_a;
            const teamB = j.teamB || j.team_b;
            const slotMin = j.slotMin ?? j.slot_min ?? null;
            if (!teamA || !teamB) continue;
            pendentes.push({ liga, teamA, teamB, slotMin, ts });
          }
        } catch (_) { /* ignora liga offline */ }
      }));

      // ── 4. Para cada jogo pendente: acha todos os mercados fortes ────────
      const previsoes = [];

      for (const jogo of pendentes) {
        const key = `${jogo.liga}|${jogo.teamA}|${jogo.teamB}|${jogo.slotMin}`;
        const s   = idx.get(key);
        if (!s) continue;

        const minutos = Math.round((jogo.ts - agora) / 60000);

        // Monta lista de todos os mercados com sua confiança
        const mercados = [
          { mercado: 'OVER 2.5',  pct: parseFloat(s.over25_pct),  prioridade: 1 },
          { mercado: 'UNDER 2.5', pct: parseFloat(s.under25_pct), prioridade: 1 },
          { mercado: 'OVER 1.5',  pct: parseFloat(s.over15_pct),  prioridade: 2 },
          { mercado: 'UNDER 1.5', pct: parseFloat(s.under15_pct), prioridade: 3 },
          { mercado: 'OVER 3.5',  pct: parseFloat(s.over35_pct),  prioridade: 2 },
          { mercado: 'OVER 4.5',  pct: parseFloat(s.over45_pct),  prioridade: 3, bonus: true },
          { mercado: '0-0',       pct: parseFloat(s.zero_pct),    prioridade: 3, bonus: true },
          { mercado: 'AMBAS SIM', pct: parseFloat(s.btts_pct),    prioridade: 2 },
        ];

        // Filtra os que passam do min_conf e não são contraditórios entre si
        const fortes = mercados
          .filter(m => m.pct >= min_conf)
          .sort((a, b) => b.pct - a.pct);

        // Remove contradições (ex: OVER 2.5 e UNDER 2.5 no mesmo jogo)
        const mercadosLimpos = [];
        const excluidos = new Set();
        for (const m of fortes) {
          if (excluidos.has(m.mercado)) continue;
          mercadosLimpos.push(m);
          // Marca contraditórios
          if (m.mercado === 'OVER 2.5')  { excluidos.add('UNDER 2.5'); excluidos.add('UNDER 1.5'); excluidos.add('0-0'); }
          if (m.mercado === 'UNDER 2.5') { excluidos.add('OVER 2.5');  excluidos.add('OVER 3.5');  excluidos.add('OVER 4.5'); excluidos.add('AMBAS SIM'); }
          if (m.mercado === 'OVER 1.5')  { excluidos.add('UNDER 1.5'); excluidos.add('0-0'); }
          if (m.mercado === 'UNDER 1.5') { excluidos.add('OVER 1.5');  excluidos.add('OVER 2.5');  excluidos.add('OVER 3.5'); excluidos.add('OVER 4.5'); excluidos.add('AMBAS SIM'); }
          if (m.mercado === '0-0')        { excluidos.add('OVER 1.5');  excluidos.add('OVER 2.5');  excluidos.add('AMBAS SIM'); }
        }

        if (!mercadosLimpos.length) continue;

        // Mercado principal (maior confiança)
        const principal = mercadosLimpos[0];
        // Bônus (extras como 5+ gols, 0-0, AMBAS quando tem força)
        const extras = mercadosLimpos.slice(1).filter(m => m.bonus || m.pct >= min_conf + 5);

        previsoes.push({
          liga:        jogo.liga,
          team_a:      jogo.teamA,
          team_b:      jogo.teamB,
          slot_min:    jogo.slotMin,
          ts:          jogo.ts,
          minutos_ate: minutos,
          total:       s.total,
          media_gols:  parseFloat(s.media_gols),
          // Principal
          mercado:     principal.mercado,
          confianca:   principal.pct,
          // Todos os fortes (para exibir no card)
          mercados:    mercadosLimpos,
          // Extras de bônus
          extras,
        });
      }

      // Ordena: mais próximo primeiro, dentro do mesmo slot: maior confiança
      previsoes.sort((a, b) => a.ts - b.ts || b.confianca - a.confianca);

      const resultado = {
        ok: true,
        total: previsoes.length,
        jogos_analisados: stats.length,
        pendentes_encontrados: pendentes.length,
        previsoes,
      };

      cacheSet(cacheKey, resultado, 90000);
      res.json(resultado);

    } catch (e) {
      console.error('[padroes-confronto]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  };
};
