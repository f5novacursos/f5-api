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
      const { liga, horas = 2, min_amostra = 15, min_confianca = 75 } = req.query;
      const cacheKey = `${liga || 'all'}|${horas}|${min_amostra}`;

      // Piso por liga+mercado — portado da aba Especial (25/06/2026).
      const PISO_LIGA_MERCADO = {
        'premier_league|OVER 2.5':  999,
        'copa_america|OVER 2.5':    999,
        'euro_cup|OVER 2.5':        999,
        'copa_mundo|OVER 2.5':       75,
        'copa_estrelas|OVER 2.5':    70,
        'sul_americana|OVER 2.5':    70,
        'brasileirao|AMBAS SIM':    999,
        'premier_league|AMBAS SIM': 999,
        'sul_americana|AMBAS SIM':  999,
      };
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

      // 2) RECOMENDAÇÃO POR BASE DA LIGA (não por confronto).
      //    Análise 26/06/2026: o confronto team A × team B NÃO prevê (correlação treino×teste
      //    r=0,106; o mesmo time teve ~22 placares diferentes em ~175 jogos; o under do time
      //    não persiste). Virtual é RNG e os nomes dos times são rótulos trocados a cada jogo
      //    (fitas reaproveitadas). Então a recomendação vem da BASE DA LIGA + Martingale, só
      //    OVER 1.5 (base alta ~68%) / UNDER 2.5 (~58%) — mesma filosofia da aba Especial.
      //    A aba mantém o valor de LISTAR os jogos reais futuros (nome + horário).
      const MERCADOS = ['OVER 1.5', 'UNDER 2.5'];
      const baseCache = {};
      async function baseDaLiga(lg) {
        if (baseCache[lg]) return baseCache[lg];
        const b = await db.query(`
          SELECT ft_str, gols_total, COUNT(*)::int AS vezes
          FROM ${tabela} WHERE liga = $1
          GROUP BY ft_str, gols_total
        `, [lg]);
        let total = 0, over15 = 0, under25 = 0; const placares = {};
        for (const r2 of b.rows) {
          total += r2.vezes;
          if (r2.gols_total >= 2) over15 += r2.vezes;
          if (r2.gols_total <= 2) under25 += r2.vezes;
          placares[r2.ft_str] = (placares[r2.ft_str] || 0) + r2.vezes;
        }
        const topPlacares = Object.entries(placares).sort((a, b2) => b2[1] - a[1]).slice(0, 4)
          .map(([ft, v]) => ({ ft, vezes: v, pct: total ? Math.round(v / total * 100) : 0 }));
        return (baseCache[lg] = { total, over15, under25, topPlacares });
      }

      const previsoes = [];
      for (const pend of pendentes) {
        const { liga: lg, jogo, realUtcMs } = pend;
        const clock = new Date(realUtcMs + cfg.clockFromRealMs);
        const minuto = clock.getUTCMinutes();
        const slots = cfg.slots[lg] || cfg.slotsFallback || [];
        let slotMin = slots.length ? slots[0] : minuto, md = 99;
        for (const s of slots) { const d2 = Math.abs(s - minuto); if (d2 < md) { md = d2; slotMin = s; } }

        const bl = await baseDaLiga(lg);
        if (bl.total < Number(min_amostra)) continue;

        let melhor = null;
        for (const m of MERCADOS) {
          const vezes = m === 'OVER 1.5' ? bl.over15 : bl.under25;
          const pct = bl.total ? Math.round(vezes / bl.total * 100) : 0;     // base de 1 tiro na liga
          const pisoLM = PISO_LIGA_MERCADO[`${lg}|${m}`] || 0;
          if (pct < pisoLM) continue;
          const m3 = Math.round((1 - Math.pow(1 - pct / 100, 3)) * 100);      // acerto esperado em 3 tiros
          if (!melhor || pct > melhor.pct) melhor = { m, pct, m3, vezes };
        }
        if (!melhor) continue;
        if (melhor.m3 < Number(min_confianca)) continue; // filtra pela projeção Martingale (3 tiros)

        previsoes.push({
          liga: lg,
          event_id: `${jogo.teamA} x ${jogo.teamB}`,
          team_a: jogo.teamA,
          team_b: jogo.teamB,
          slot: slotMin,
          start_time: realUtcMs,
          resultado_mais_frequente: melhor.m,
          confianca: melhor.m3,        // projeção Martingale 3 tiros = acerto real esperado
          base_liga: melhor.pct,       // base de 1 tiro da liga (referência)
          edge: 0,
          total: bl.total,
          vezes: melhor.vezes,
          odds: jogo.odds || null,
          historico: bl.topPlacares    // placares mais comuns da LIGA (não do confronto)
        });
      }

      previsoes.sort((a, b) => a.start_time - b.start_time || b.confianca - a.confianca);
      const payload = { ok: true, total: previsoes.length, jogos_futuros: pendentes.length, previsoes };
      _cache = { key: cacheKey, ts: Date.now(), data: payload };
      res.json(payload);
    } catch (e) { next(e); }
  };
};
