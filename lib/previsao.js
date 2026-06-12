// ════════════════════════════════════════════════════════════════
// 🔮 PREVISÕES — compartilhado Betano / Bet365
// Jogos FUTUROS (status 'pendente' no snapshot EasyCo) cruzados com
// o histórico do confronto exato na tabela da casa. Para cada jogo
// que vai acontecer: o mercado que mais saiu nesse confronto.
// cfg: { provider, ligas:[{sub,liga}], slots:{liga:[..]}, slotsFallback,
//        toRealUtcMs (parsedDate→UTC real), clockFromRealMs (UTC real→relógio da casa) }
// ════════════════════════════════════════════════════════════════
const EA_BASE = 'https://api.easycoanalytics.com.br';
const EA_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
};

module.exports = function (db, tabela, cfg) {
  let _cache = { key: '', ts: 0, data: null };

  return async (req, res, next) => {
    try {
      const { liga, horas = 2, min_amostra = 5 } = req.query;
      const cacheKey = `${liga || 'all'}|${horas}|${min_amostra}`;
      if (_cache.key === cacheKey && Date.now() - _cache.ts < 30000) {
        return res.json(_cache.data);
      }

      // 1) jogos pendentes (futuros) direto do snapshot
      const alvoLigas = cfg.ligas.filter(l => !liga || l.liga === liga);
      const pendentes = [];
      for (const item of alvoLigas) {
        try {
          const r = await fetch(`${EA_BASE}/snapshot?provider=${cfg.provider}&sub=${encodeURIComponent(item.sub)}&_t=${Date.now()}`,
            { headers: EA_HEADERS, signal: AbortSignal.timeout(12000) });
          if (!r.ok) continue;
          const data = await r.json();
          if (!Array.isArray(data)) continue;
          for (const jogo of data) {
            if (jogo.status === 'finalizado') continue;
            if (!jogo.date || !jogo.teamA || !jogo.teamB) continue;
            const realUtcMs = new Date(jogo.date).getTime() + cfg.toRealUtcMs;
            if (!realUtcMs || isNaN(realUtcMs)) continue;
            if (realUtcMs < Date.now() - 5 * 60000) continue;
            if (realUtcMs > Date.now() + Number(horas) * 3600000) continue;
            pendentes.push({ liga: item.liga, jogo, realUtcMs });
          }
        } catch (e) { /* liga indisponível agora — segue as outras */ }
        await new Promise(r2 => setTimeout(r2, 250));
      }

      // 2) para cada jogo futuro: histórico do confronto exato no banco
      const previsoes = [];
      for (const pend of pendentes) {
        const { liga: lg, jogo, realUtcMs } = pend;
        const clock = new Date(realUtcMs + cfg.clockFromRealMs);
        const minuto = clock.getUTCMinutes();
        const slots = cfg.slots[lg] || cfg.slotsFallback || [];
        let slotMin = slots.length ? slots[0] : minuto, md = 99;
        for (const s of slots) { const d2 = Math.abs(s - minuto); if (d2 < md) { md = d2; slotMin = s; } }

        const h = await db.query(`
          SELECT ft_str, gols_total, is_btts, COUNT(*)::int AS vezes
          FROM ${tabela}
          WHERE liga = $1 AND team_a = $2 AND team_b = $3
          GROUP BY ft_str, gols_total, is_btts
          ORDER BY vezes DESC
        `, [lg, jogo.teamA, jogo.teamB]);
        const total = h.rows.reduce((a, r2) => a + r2.vezes, 0);
        if (total < Number(min_amostra)) continue;

        // distribuição por MERCADO (apostável) — confiança real
        const mk = { '0-0': 0, 'OVER 1.5': 0, 'UNDER 1.5': 0, 'OVER 2.5': 0, 'UNDER 2.5': 0, 'OVER 3.5': 0, 'AMBAS SIM': 0 };
        for (const r2 of h.rows) {
          const g = r2.gols_total;
          if (g === 0) mk['0-0'] += r2.vezes;
          if (g >= 2) mk['OVER 1.5'] += r2.vezes; else mk['UNDER 1.5'] += r2.vezes;
          if (g >= 3) mk['OVER 2.5'] += r2.vezes; else mk['UNDER 2.5'] += r2.vezes;
          if (g >= 4) mk['OVER 3.5'] += r2.vezes;
          if (r2.is_btts) mk['AMBAS SIM'] += r2.vezes;
        }
        let melhor = null;
        for (const [m, v] of Object.entries(mk)) {
          const pct = Math.round(v / total * 100);
          if (!melhor || pct > melhor.pct) melhor = { m, v, pct };
        }
        if (!melhor) continue;

        previsoes.push({
          liga: lg,
          event_id: `${jogo.teamA} x ${jogo.teamB}`,
          team_a: jogo.teamA,
          team_b: jogo.teamB,
          slot: slotMin,
          start_time: realUtcMs,
          resultado_mais_frequente: melhor.m,
          confianca: melhor.pct,
          total,
          vezes: melhor.v,
          odds: jogo.odds || null,
          historico: h.rows.slice(0, 4).map(r2 => ({ ft: r2.ft_str, vezes: r2.vezes, pct: Math.round(r2.vezes / total * 100) }))
        });
      }

      previsoes.sort((a, b) => a.start_time - b.start_time || b.confianca - a.confianca);
      const payload = { ok: true, total: previsoes.length, jogos_futuros: pendentes.length, previsoes };
      _cache = { key: cacheKey, ts: Date.now(), data: payload };
      res.json(payload);
    } catch (e) { next(e); }
  };
};
