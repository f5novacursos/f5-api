// ════════════════════════════════════════════════════════════════
// MINERADOR DE PADRÕES AO VIVO — compartilhado Betano / Bet365
// 8 geometrias × 3 leituras → previsões: liga, hora alvo, slot alvo,
// probabilidade, amostra, edge. Parametrizado pela tabela.
// Uso: router.get('/padroes-live', require('../lib/padroes-live')(db, 'tabela'))
// ════════════════════════════════════════════════════════════════
module.exports = function (db, tabela) {
  let _liveCache = { key: '', ts: 0, data: null };
  return async (req, res, next) => {
    try {
      const { liga, horas = 168, min_conf = 70, min_amostra = 5 } = req.query;
      const cacheKey = `${liga || 'all'}|${horas}|${min_conf}|${min_amostra}`;
      if (_liveCache.key === cacheKey && Date.now() - _liveCache.ts < 60000) {
        return res.json(_liveCache.data);
      }
  
      const cutoffMs = Date.now() - Number(horas) * 3600000;
      const params = liga ? [cutoffMs, liga] : [cutoffMs];
      const ligaFilter = liga ? 'AND liga = $2' : '';
      const r = await db.query(`
        SELECT liga, hora, slot_min, ft_str, gols_total, is_btts, start_time,
               DATE(TO_TIMESTAMP(start_time/1000) AT TIME ZONE 'America/Sao_Paulo') as dia
        FROM ${tabela}
        WHERE start_time > $1 ${ligaFilter}
        ORDER BY liga, start_time ASC
      `, params);
      if (r.rows.length < 50) {
        return res.json({ ok: true, total: 0, previsoes: [], aviso: 'Dados insuficientes' });
      }
  
      const HORA_MS = 3600000;
      const agora = Date.now();
      const consecutivo = (a, b) => { const d = b - a; return d > HORA_MS * 0.5 && d < HORA_MS * 1.5; };
  
      // Mercados apostáveis (o que pode sair na célula alvo)
      const MARKETS = {
        '0-0':       g => g.gols_total === 0,
        'OVER 1.5':  g => g.gols_total >= 2,
        'UNDER 1.5': g => g.gols_total <= 1,
        'OVER 2.5':  g => g.gols_total >= 3,
        'UNDER 2.5': g => g.gols_total <= 2,
        'OVER 3.5':  g => g.gols_total >= 4,
        'AMBAS SIM': g => g.is_btts,
      };
      // Leituras da célula condição
      const CONDS = {
        placar: g => g.ft_str,
        gols:   g => `${g.gols_total} GOL`,
        ou:     g => (g.gols_total >= 3 ? 'OVER 2.5' : 'UNDER 2.5'),
      };
  
      // ── monta linhas (liga|dia|hora) e células por slot ──
      const linhaMap = {};
      for (const j of r.rows) {
        const k = `${j.liga}|${j.dia}|${j.hora}`;
        if (!linhaMap[k]) linhaMap[k] = { liga: j.liga, hora: j.hora, ts: Number(j.start_time), cells: {} };
        if (Number(j.start_time) < linhaMap[k].ts) linhaMap[k].ts = Number(j.start_time);
        linhaMap[k].cells[j.slot_min] = j;
      }
      const ligaLinhas = {};
      for (const v of Object.values(linhaMap)) {
        (ligaLinhas[v.liga] = ligaLinhas[v.liga] || []).push(v);
      }
      for (const l in ligaLinhas) ligaLinhas[l].sort((a, b) => a.ts - b.ts);
  
      const previsoes = [];
  
      for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
        const slotList = [...new Set(linhas.flatMap(l => Object.keys(l.cells).map(Number)))].sort((a, b) => a - b);
  
        // taxa base por mercado (frequência natural na liga)
        const baseN = {}; let baseT = 0;
        for (const l of linhas) for (const s in l.cells) {
          const g = l.cells[s]; baseT++;
          for (const [m, fn] of Object.entries(MARKETS)) if (fn(g)) baseN[m] = (baseN[m] || 0) + 1;
        }
        const base = m => baseT ? Math.round((baseN[m] || 0) / baseT * 100) : 0;

        // taxa base em ATÉ 2 e 3 TIROS (janelas de jogos consecutivos) —
        // sem isso o numero de 3 tiros engana: quase tudo "bate" em 3 jogos
        const baseN2 = {}, baseN3 = {}; let baseT2 = 0, baseT3 = 0;
        for (const l of linhas) {
          const seq = slotList.map(s => l.cells[s]).filter(Boolean);
          for (let i = 0; i + 1 < seq.length; i++) {
            baseT2++;
            for (const [m, fn] of Object.entries(MARKETS)) if (fn(seq[i]) || fn(seq[i + 1])) baseN2[m] = (baseN2[m] || 0) + 1;
          }
          for (let i = 0; i + 2 < seq.length; i++) {
            baseT3++;
            for (const [m, fn] of Object.entries(MARKETS)) if (fn(seq[i]) || fn(seq[i + 1]) || fn(seq[i + 2])) baseN3[m] = (baseN3[m] || 0) + 1;
          }
        }
        const base2 = m => baseT2 ? Math.round((baseN2[m] || 0) / baseT2 * 100) : 0;
        const base3 = m => baseT3 ? Math.round((baseN3[m] || 0) / baseT3 * 100) : 0;
  
        const cell = (li, si) => {
          if (li < 0 || li >= linhas.length || si < 0 || si >= slotList.length) return null;
          return linhas[li].cells[slotList[si]] || null;
        };
        const consecLinhas = (a, b) => a >= 0 && b < linhas.length && consecutivo(linhas[a].ts, linhas[b].ts);
  
        // ── GEOMETRIAS: células condição → célula alvo ──
        const GEOMS = {
          vertical:   { cond: (li, si) => [cell(li, si)],                                        alvo: (li, si) => ({ li: li + 1, si }),         check: li => true },
          torre2:     { cond: (li, si) => [cell(li - 1, si), cell(li, si)],                      alvo: (li, si) => ({ li: li + 1, si }),         check: li => consecLinhas(li - 1, li) },
          torre3:     { cond: (li, si) => [cell(li - 2, si), cell(li - 1, si), cell(li, si)],    alvo: (li, si) => ({ li: li + 1, si }),         check: li => consecLinhas(li - 2, li - 1) && consecLinhas(li - 1, li) },
          horizontal: { cond: (li, si) => [cell(li, si)],                                        alvo: (li, si) => ({ li, si: si + 1 }),         check: li => true },
          seq_horiz:  { cond: (li, si) => [cell(li, si - 1), cell(li, si)],                      alvo: (li, si) => ({ li, si: si + 1 }),         check: li => true },
          diag_dir:   { cond: (li, si) => [cell(li, si)],                                        alvo: (li, si) => ({ li: li + 1, si: si + 1 }), check: li => true },
          diag_esq:   { cond: (li, si) => [cell(li, si)],                                        alvo: (li, si) => ({ li: li + 1, si: si - 1 }), check: li => true },
          cruzamento: { cond: (li, si) => [cell(li, si - 1), cell(li, si + 1)],                  alvo: (li, si) => ({ li: li + 1, si }),         check: li => true },
        };
  
        // ── MINERAÇÃO: conta o que saiu no alvo após cada condição ──
        const acc = {}; // `${geom}|${dim}|${condKey}` → { total, out: {mercado: count} }
        for (let li = 0; li < linhas.length; li++) {
          for (let si = 0; si < slotList.length; si++) {
            for (const [gName, G] of Object.entries(GEOMS)) {
              if (!G.check(li)) continue;
              const condCells = G.cond(li, si);
              if (condCells.some(c => !c)) continue;
              const ap = G.alvo(li, si);
              if (ap.li !== li && !consecLinhas(li, ap.li)) continue; // hora alvo precisa ser a seguinte
              const t1 = cell(ap.li, ap.si);
              if (!t1) continue;
              const t2 = cell(ap.li, ap.si + 1);
              const t3 = cell(ap.li, ap.si + 2);
              for (const [dim, fn] of Object.entries(CONDS)) {
                const condKey = condCells.map(fn).join(',');
                // conta em dobro: específico do slot (fiel) + geral da liga (mais amostra)
                for (const key of [`${gName}|${dim}|${slotList[si]}|${condKey}`, `${gName}|${dim}|*|${condKey}`]) {
                  if (!acc[key]) acc[key] = { total: 0, out: {}, total2: 0, out2: {}, total3: 0, out3: {} };
                  acc[key].total++;
                  if (t2) acc[key].total2++;
                  if (t2 && t3) acc[key].total3++;
                  for (const [m, mfn] of Object.entries(MARKETS)) {
                    const h1 = mfn(t1);
                    if (h1) acc[key].out[m] = (acc[key].out[m] || 0) + 1;
                    if (t2 && (h1 || mfn(t2))) acc[key].out2[m] = (acc[key].out2[m] || 0) + 1;
                    if (t2 && t3 && (h1 || mfn(t2) || mfn(t3))) acc[key].out3[m] = (acc[key].out3[m] || 0) + 1;
                  }
                }
              }
            }
          }
        }
  
        // ── ESTADO ATUAL: condições satisfeitas com alvo ainda em aberto ──
        for (let li = Math.max(0, linhas.length - 2); li < linhas.length; li++) {
          for (let si = 0; si < slotList.length; si++) {
            for (const [gName, G] of Object.entries(GEOMS)) {
              if (!G.check(li)) continue;
              const condCells = G.cond(li, si);
              if (condCells.some(c => !c)) continue;
              const ap = G.alvo(li, si);
              if (ap.si < 0 || ap.si >= slotList.length) continue;
              if (cell(ap.li, ap.si)) continue; // alvo já saiu → não é previsão
  
              const lastCell = condCells[condCells.length - 1];
              const condTs = Number(lastCell.start_time);
              let alvoTs, alvoHora;
              if (ap.li === li) { // mesma hora, slot seguinte
                alvoTs = condTs + (slotList[ap.si] - lastCell.slot_min) * 60000;
                alvoHora = linhas[li].hora;
              } else {            // próxima hora
                alvoTs = condTs + HORA_MS + (slotList[ap.si] - lastCell.slot_min) * 60000;
                alvoHora = (linhas[li].hora + 1) % 24;
              }
              if (alvoTs < agora - 10 * 60000) continue; // já era pra ter saído → stale
              if (alvoTs > agora + 75 * 60000) continue; // longe demais
  
              for (const [dim, fn] of Object.entries(CONDS)) {
                const condKey = condCells.map(fn).join(',');
                // prefere estatística do PRÓPRIO slot; sem amostra, cai pra geral da liga
                let st = acc[`${gName}|${dim}|${slotList[si]}|${condKey}`];
                let slotEspecifico = true;
                if (!st || st.total3 < Number(min_amostra)) {
                  st = acc[`${gName}|${dim}|*|${condKey}`];
                  slotEspecifico = false;
                }
                if (!st || st.total3 < Number(min_amostra)) continue;
                // melhor mercado: probabilidade em ATÉ 3 TIROS com edge3 positivo
                let best = null;
                for (const m of Object.keys(MARKETS)) {
                  const c1 = st.total  ? Math.round((st.out[m]  || 0) / st.total  * 100) : 0;
                  const c2 = st.total2 ? Math.round((st.out2[m] || 0) / st.total2 * 100) : 0;
                  const c3 = st.total3 ? Math.round((st.out3[m] || 0) / st.total3 * 100) : 0;
                  if (c3 < Number(min_conf)) continue;
                  const e3 = c3 - base3(m);
                  if (e3 <= 0) continue;
                  if (!best || e3 > best.e3 || (e3 === best.e3 && c3 > best.c3)) best = { m, c1, c2, c3, e3 };
                }
                if (!best) continue;
                const tent = [slotList[ap.si], slotList[ap.si + 1], slotList[ap.si + 2]].filter(s => s !== undefined);
                previsoes.push({
                  liga: ligaKey,
                  geometria: gName,
                  dimensao: dim,
                  condicao: condCells.map(c => ({ hora: c.hora, slot_min: c.slot_min, ft: c.ft_str, leitura: fn(c) })),
                  alvo: { hora: alvoHora, slot_min: slotList[ap.si], ts: alvoTs },
                  tentativas: tent,
                  previsao: best.m,
                  prob: best.c1,
                  prob2: best.c2,
                  prob3: best.c3,
                  amostra: st.total,
                  amostra3: st.total3,
                  acertos: st.out[best.m] || 0,
                  acertos3: st.out3[best.m] || 0,
                  base_rate: base(best.m),
                  base2: base2(best.m),
                  base3: base3(best.m),
                  edge: best.c1 - base(best.m),
                  edge3: best.e3,
                  slot_especifico: slotEspecifico
                });
              }
            }
          }
        }
      }
  
      // UM CARD POR ALVO: mesma liga+hora+slot → prevalece o mercado de maior
      // probabilidade (desempate: maior edge, depois maior amostra)
      const byKey = {};
      const melhorQue = (a, b) => a.prob3 !== b.prob3 ? a.prob3 > b.prob3 : (a.edge3 !== b.edge3 ? a.edge3 > b.edge3 : a.amostra3 > b.amostra3);
      for (const p of previsoes) {
        const k = `${p.liga}|${p.alvo.hora}|${p.alvo.slot_min}`;
        if (!byKey[k] || melhorQue(p, byKey[k])) byKey[k] = p;
      }
      const final = Object.values(byKey)
        .sort((a, b) => (b.prob3 - a.prob3) || (b.edge3 - a.edge3) || (b.amostra3 - a.amostra3))
        .slice(0, 80);
  
      const payload = { ok: true, total: final.length, horas: Number(horas), gerado_em: new Date().toISOString(), previsoes: final };
      _liveCache = { key: cacheKey, ts: Date.now(), data: payload };
      res.json(payload);
    } catch (e) { next(e); }
  };
};
