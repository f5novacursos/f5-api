const router = require('express').Router();
const db = require('../db');

// ── BET365 Virtual Sports — tabela separada ──────────────────────────────────
// TODO próximo chat: preencher leagueIds e slots reais da Bet365
// Eduardo vai trazer: nome das ligas, leagueIds, minutos dos slots

const B365_LEAGUE_MAP = {
  // 'leagueId': 'slug_liga'  — preencher no próximo chat
  // Ex: '12345': 'premier_league_b365'
};

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS virturia_resultados_b365 (
      id            SERIAL PRIMARY KEY,
      event_id      VARCHAR(60) NOT NULL UNIQUE,
      liga          VARCHAR(30) NOT NULL,
      hora          INTEGER NOT NULL,
      slot          INTEGER NOT NULL,
      slot_min      INTEGER NOT NULL,
      team_a        VARCHAR(60),
      team_b        VARCHAR(60),
      ft_a          INTEGER NOT NULL,
      ft_b          INTEGER NOT NULL,
      ht_a          INTEGER,
      ht_b          INTEGER,
      ft_str        VARCHAR(10),
      ht_str        VARCHAR(10),
      gols_total    INTEGER,
      is_btts       BOOLEAN,
      casa_ganha    BOOLEAN,
      visit_ganha   BOOLEAN,
      empate        BOOLEAN,
      ht_atipico    BOOLEAN,
      start_time    BIGINT,
      coletado_em   TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_vr_b365_liga ON virturia_resultados_b365(liga)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_vr_b365_hora ON virturia_resultados_b365(hora, slot_min)`);
}
initTable().catch(e => console.error('[virturia-b365] init error:', e.message));

// POST /api/virturia-b365/salvar
router.post('/salvar', async (req, res, next) => {
  try {
    const { resultados } = req.body;
    if (!Array.isArray(resultados) || resultados.length === 0) return res.json({ ok: true, salvos: 0 });

    const SLOTS = {
      express_cup:   [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59],
      copa_mundo:    [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
      euro_cup:      [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59],
      sul_americana: [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
      premier_league:[0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
    };

    let salvos = 0;
    for (const r of resultados) {
      if (!r.startTime) continue;
      const ftA = Number(r.scoreA)||0, ftB = Number(r.scoreB)||0;
      const htA = r.htA!=null?Number(r.htA):null, htB = r.htB!=null?Number(r.htB):null;
      const d = new Date(r.startTime);
      const dBRT = new Date(d.getTime() + 1*3600000); // BST = UTC+1
      const hora = dBRT.getUTCHours(), minuto = dBRT.getUTCMinutes();
      const ligaSlots = SLOTS[r.liga] || SLOTS['liga1_b365'];
      let slotIdx=0, minDiff=99;
      for (let i=0;i<ligaSlots.length;i++) {
        const diff=Math.abs(ligaSlots[i]-minuto);
        if(diff<minDiff){minDiff=diff;slotIdx=i;}
      }
      const slotMin = ligaSlots[slotIdx];
      const dataBRT = dBRT.toISOString().slice(0, 10);
      // event_id único por liga+dia+hora+slot (Bet365 também reutiliza IDs a cada ciclo)
      const eventId = `${r.liga}_${dataBRT}_${hora}_${slotMin}`;
      try {
        await db.query(`
          INSERT INTO virturia_resultados_b365
            (event_id,liga,hora,slot,slot_min,team_a,team_b,ft_a,ft_b,ht_a,ht_b,ft_str,ht_str,gols_total,is_btts,casa_ganha,visit_ganha,empate,ht_atipico,start_time)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (event_id) DO UPDATE SET
            ft_a=EXCLUDED.ft_a, ft_b=EXCLUDED.ft_b, ht_a=EXCLUDED.ht_a, ht_b=EXCLUDED.ht_b,
            ft_str=EXCLUDED.ft_str, ht_str=EXCLUDED.ht_str, gols_total=EXCLUDED.gols_total,
            is_btts=EXCLUDED.is_btts, casa_ganha=EXCLUDED.casa_ganha, visit_ganha=EXCLUDED.visit_ganha,
            empate=EXCLUDED.empate, start_time=EXCLUDED.start_time
        `, [eventId,r.liga,hora,slotIdx,slotMin,r.teamA,r.teamB,ftA,ftB,htA,htB,
            `${ftA}-${ftB}`,htA!=null?`${htA}-${htB}`:null,ftA+ftB,ftA>0&&ftB>0,ftA>ftB,ftB>ftA,ftA===ftB,
            htA!=null?(htA+htB>=3):false, r.startTime]);
        salvos++;
      } catch(e) { if(salvos===0) console.error('[b365 insert] liga='+r.liga+' eventId='+eventId+' err='+e.message); }
    }
    res.json({ ok: true, salvos, recebidos: resultados.length });
  } catch(e) { next(e); }
});

// GET /api/virturia-b365/resultados
router.get('/resultados', async (req, res, next) => {
  try {
    const { liga, horas = 6 } = req.query;
    const cutoffMs = Date.now() - Number(horas) * 3600000;
    const params = [cutoffMs];
    let ligaFilter = '';
    if (liga) { ligaFilter = 'AND liga = $2'; params.push(liga); }
    const r = await db.query(`
      SELECT event_id AS id, liga,
        team_a AS "teamA", team_b AS "teamB",
        ft_a::text AS "scoreA", ft_b::text AS "scoreB",
        ht_a::text AS "htA", ht_b::text AS "htB",
        start_time AS "startTime", start_time AS "endedAt", true AS "isEnded"
      FROM virturia_resultados_b365
      WHERE start_time > $1 ${ligaFilter}
      ORDER BY start_time DESC LIMIT 2000
    `, params);
    const tot = await db.query('SELECT COUNT(*) as t FROM virturia_resultados_b365 WHERE start_time > $1', [cutoffMs]);
    res.json({ ok: true, total: r.rows.length, hist: Number(tot.rows[0].t), results: r.rows });
  } catch(e) { next(e); }
});

// GET /api/virturia-b365/stats
router.get('/stats', async (req, res, next) => {
  try {
    const r = await db.query(`
      SELECT liga, COUNT(*) as total, MIN(coletado_em) as primeiro, MAX(coletado_em) as ultimo
      FROM virturia_resultados_b365 GROUP BY liga ORDER BY liga
    `);
    const total = await db.query('SELECT COUNT(*) as total FROM virturia_resultados_b365');
    res.json({ ok: true, total: Number(total.rows[0].total), por_liga: r.rows });
  } catch(e) { next(e); }
});


// GET /api/virturia-b365/padroes-auto
router.get('/padroes-auto', async (req, res, next) => {
  try {
    const { liga, horas = 168, min_ocorrencias = 3, min_confianca = 60 } = req.query;
    const cutoffMs = Date.now() - Number(horas) * 3600000;
    const ligaParam = liga ? [cutoffMs, liga] : [cutoffMs];
    const ligaFilter = liga ? `AND liga = $2` : '';

    const r = await db.query(`
      SELECT liga, hora, slot_min, ft_str, gols_total, is_btts,
             casa_ganha, visit_ganha, empate, start_time,
             DATE(TO_TIMESTAMP(start_time/1000) AT TIME ZONE 'America/Sao_Paulo') as dia
      FROM virturia_resultados_b365
      WHERE start_time > $1 ${ligaFilter}
      ORDER BY liga, start_time ASC
    `, ligaParam);

    if (r.rows.length < 10) return res.json({ ok: true, total: 0, padroes: [] });

    // Agrupa por liga+dia+hora
    const linhaMap = {};
    for (const j of r.rows) {
      const k = `${j.liga}|${j.dia}|${j.hora}`;
      if (!linhaMap[k]) linhaMap[k] = { liga: j.liga, ts: Number(j.start_time), slots: [] };
      if (Number(j.start_time) < linhaMap[k].ts) linhaMap[k].ts = Number(j.start_time);
      linhaMap[k].slots.push(j);
    }

    // Por liga, ordena linhas por tempo
    const ligaLinhas = {};
    for (const v of Object.values(linhaMap)) {
      if (!ligaLinhas[v.liga]) ligaLinhas[v.liga] = [];
      v.slots.sort((a, b) => a.slot_min - b.slot_min);
      ligaLinhas[v.liga].push(v);
    }
    for (const l in ligaLinhas) ligaLinhas[l].sort((a, b) => a.ts - b.ts);

    const padroes = [];
    const minOcorr = Number(min_ocorrencias);
    const minConf = Number(min_confianca);

    // Retorna só O resultado principal — sem contradições
    function tagPrincipal(j) {
      if (j.gols_total === 0) return '0-0';
      if (j.gols_total >= 4) return 'OVER 3.5';
      if (j.gols_total >= 3) return 'OVER 2.5';
      if (j.gols_total >= 2) return 'OVER 1.5';
      return 'UNDER 1.5';
    }

    // PADRÃO VERTICAL: mesmo slot em horas seguidas
    for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
      const todosSlots = [...new Set(linhas.flatMap(l => l.slots.map(s => s.slot_min)))];
      for (const slotMin of todosSlots) {
        const seq = linhas.map(l => l.slots.find(s => s.slot_min === slotMin)).filter(Boolean);
        if (seq.length < minOcorr + 1) continue;
        const acc = {};
        for (let i = 0; i < seq.length - 1; i++) {
          const cond = seq[i].ft_str;
          const prox = seq[i + 1];
          if (!acc[cond]) acc[cond] = { total: 0, res: {} };
          acc[cond].total++;
          const tag = tagPrincipal(prox);
          acc[cond].res[tag] = (acc[cond].res[tag] || 0) + 1;
        }
        for (const [cond, v] of Object.entries(acc)) {
          if (v.total < minOcorr) continue;
          // Pega APENAS o resultado mais frequente
          const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
          if (!melhor) continue;
          const [res, cnt] = melhor;
          const conf = Math.round(cnt / v.total * 100);
          if (conf < minConf) continue;
          padroes.push({ id: `v_${ligaKey}_${slotMin}_${cond}_${res}`.replace(/\W/g,'_'), tipo: 'vertical', liga: ligaKey, slot_min: slotMin, condicao: [cond], resultado: res, ocorrencias: v.total, acertos: cnt, confianca: conf, descricao: `Slot ${slotMin}': saiu ${cond} → próxima hora: ${res}` });
        }
      }
    }

    // PADRÃO HORIZONTAL: slots seguidos na mesma hora
    for (const [ligaKey, linhas] of Object.entries(ligaLinhas)) {
      const acc = {};
      for (const linha of linhas) {
        const slots = linha.slots;
        for (let i = 0; i < slots.length - 1; i++) {
          const cond = slots[i].ft_str;
          const prox = slots[i + 1];
          if (!acc[cond]) acc[cond] = { total: 0, res: {} };
          acc[cond].total++;
          const tag = tagPrincipal(prox);
          acc[cond].res[tag] = (acc[cond].res[tag] || 0) + 1;
        }
      }
      for (const [cond, v] of Object.entries(acc)) {
        if (v.total < minOcorr) continue;
        // Pega APENAS o resultado mais frequente
        const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
        if (!melhor) continue;
        const [res, cnt] = melhor;
        const conf = Math.round(cnt / v.total * 100);
        if (conf < minConf) continue;
        padroes.push({ id: `h_${ligaKey}_${cond}_${res}`.replace(/\W/g,'_'), tipo: 'horizontal', liga: ligaKey, slot_min: null, condicao: [cond], resultado: res, ocorrencias: v.total, acertos: cnt, confianca: conf, descricao: `Mesma hora: depois de ${cond} → próximo slot: ${res}` });
      }
    }

    const vistos = new Set();
    const final = padroes
      .filter(p => { if (vistos.has(p.id)) return false; vistos.add(p.id); return true; })
      .sort((a, b) => b.confianca - a.confianca || b.ocorrencias - a.ocorrencias)
      .slice(0, 100);

    res.json({ ok: true, total: final.length, horas: Number(horas), padroes: final });
  } catch(e) { next(e); }
});

// POST /api/virturia-b365/limpar
router.post('/limpar', async (req, res, next) => {
  try {
    const { chave } = req.body;
    if (chave !== 'virturia2026secret') return res.status(403).json({ error: 'Chave inválida' });
    await db.query('DELETE FROM virturia_resultados_b365');
    res.json({ ok: true, msg: 'Tabela limpa com sucesso' });
  } catch(e) { next(e); }
});

// GET /api/virturia-b365/padroes-live — minerador 8 geometrias (mesmo motor da Betano)
router.get('/padroes-live', require('../lib/padroes-live')(db, 'virturia_resultados_b365'));

// 🔮 GET /api/virturia-b365/previsao — jogos futuros × histórico do confronto
// (motor compartilhado com a Betano — ver lib/previsao.js)
router.get('/previsao', require('../lib/previsao')(db, 'virturia_resultados_b365', {
  provider: 'bet365',
  ligas: [
    { sub: 'express_cup',              liga: 'express_cup' },
    { sub: 'copa_do_mundo',            liga: 'copa_mundo' },
    { sub: 'euro_cup',                 liga: 'euro_cup' },
    { sub: 'super_liga_sul-americana', liga: 'sul_americana' },
    { sub: 'premiership',              liga: 'premier_league' },
  ],
  slots: {
    express_cup:    Array.from({ length: 60 }, (_, i) => i),
    copa_mundo:     [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
    euro_cup:       [2,5,8,11,14,17,20,23,26,29,32,35,38,41,44,47,50,53,56,59],
    sul_americana:  [1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58],
    premier_league: [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
  },
  slotsFallback: [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57],
  toRealUtcMs: -3600000,   // EasyCo grava BST (UTC+1) rotulado como UTC
  clockFromRealMs: 3600000 // relógio da Bet365 = UK
}));

// ════════════════════════════════════════════════════════════════
// 🧠 GET /api/virturia-b365/previsao-proxima-hora
// Motor dinâmico — analisa TODO o histórico disponível,
// encontra QUALQUER padrão que se repete (não só torre),
// prioriza atípicos (0-0, 5+ gols, espelhos) como gatilhos.
// Retorna previsões para a próxima hora baseadas no contexto atual.
// ════════════════════════════════════════════════════════════════
router.get('/previsao-proxima-hora', async (req, res, next) => {
  try {
    const { min_confianca = 60, min_ocorrencias = 3 } = req.query;
    const minConf  = parseInt(min_confianca) || 60;
    const minOcorr = parseInt(min_ocorrencias) || 3;

    // Hora BST atual
    const agoraBST   = new Date(Date.now() + 3600000);
    const horaBST    = agoraBST.getUTCHours();
    const proxHoraBST = (horaBST + 1) % 24;

    // ── 1. Busca TODO o histórico disponível ──
    const rHist = await db.query(`
      SELECT liga, hora, slot_min, ft_str, ft_a, ft_b, gols_total,
             is_btts, empate, start_time,
             DATE(TO_TIMESTAMP(start_time/1000)) as dia
      FROM virturia_resultados_b365
      ORDER BY liga, start_time ASC
    `);

    if (rHist.rows.length < 20) {
      return res.json({ ok: true, total: 0, hora_bst: proxHoraBST, previsoes: [] });
    }

    // ── 2. Classifica cada resultado ──
    function classificar(r) {
      const g = r.gols_total;
      const a = r.ft_a, b = r.ft_b;
      const tags = [];
      if (g === 0)  tags.push('0-0');
      if (g >= 2)   tags.push('OVER 1.5'); else tags.push('UNDER 1.5');
      if (g >= 3)   tags.push('OVER 2.5'); else tags.push('UNDER 2.5');
      if (g >= 4)   tags.push('OVER 3.5');
      if (g >= 5)   tags.push('OVER 4.5');  // atípico
      if (r.is_btts) tags.push('AMBAS SIM');
      // Tag principal única (mais específica)
      let principal;
      if (g === 0)       principal = '0-0';
      else if (g >= 5)   principal = 'OVER 4.5';
      else if (g >= 4)   principal = 'OVER 3.5';
      else if (g >= 3)   principal = 'OVER 2.5';
      else if (g >= 2)   principal = 'OVER 1.5';
      else               principal = 'UNDER 1.5';

      // Atípico = 0-0, 5+ gols, ou placar espelho (2-2, 3-3, 1-1 com gols)
      const atipico = g === 0 || g >= 5 || (a === b && g >= 2);
      return { principal, tags, atipico, ft: r.ft_str };
    }

    // ── 3. Organiza por liga → lista de linhas (hora × slots) ──
    const linhaMap = {};
    for (const j of rHist.rows) {
      const k = `${j.liga}|${j.dia}|${j.hora}`;
      if (!linhaMap[k]) linhaMap[k] = { liga: j.liga, hora: j.hora, ts: Number(j.start_time), slots: [] };
      linhaMap[k].slots.push({ ...j, ...classificar(j) });
    }
    const ligaLinhas = {};
    for (const v of Object.values(linhaMap)) {
      if (!ligaLinhas[v.liga]) ligaLinhas[v.liga] = [];
      v.slots.sort((a, b) => a.slot_min - b.slot_min);
      ligaLinhas[v.liga].push(v);
    }
    for (const l in ligaLinhas) ligaLinhas[l].sort((a, b) => a.ts - b.ts);

    // ── 4. Motor de padrões — encontra QUALQUER combinação ──
    // Para cada liga × slot: analisa todas as janelas de N linhas consecutivas
    // e vê o que aparece depois. Sem restrição de tipo de padrão.
    const padraoMap = {}; // chave: liga|slot_min → array de candidatos

    for (const [liga, linhas] of Object.entries(ligaLinhas)) {
      const todosSlots = [...new Set(linhas.flatMap(l => l.slots.map(s => s.slot_min)))];

      for (const slotMin of todosSlots) {
        // Sequência temporal desse slot nessa liga
        const seq = linhas
          .map(l => l.slots.find(s => s.slot_min === slotMin))
          .filter(Boolean);
        if (seq.length < minOcorr + 1) continue;

        // Analisa janelas de tamanho 1, 2 e 3 como condição → próximo
        for (let janela = 1; janela <= 3; janela++) {
          const acc = {}; // condKey → { total, res:{tag:count}, atipico_cond }
          for (let i = 0; i <= seq.length - janela - 1; i++) {
            const conds = seq.slice(i, i + janela);
            const prox  = seq[i + janela];
            // Chave da condição = sequência de tags principais
            const condKey = conds.map(c => c.principal).join(' → ');
            const temAtipico = conds.some(c => c.atipico);
            if (!acc[condKey]) acc[condKey] = { total: 0, res: {}, atipico: temAtipico, janela };
            acc[condKey].total++;
            acc[condKey].res[prox.principal] = (acc[condKey].res[prox.principal] || 0) + 1;
            if (temAtipico) acc[condKey].atipico = true;
          }

          for (const [condKey, v] of Object.entries(acc)) {
            if (v.total < minOcorr) continue;
            const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
            if (!melhor) continue;
            const [res, cnt] = melhor;
            const conf = Math.round(cnt / v.total * 100);
            if (conf < minConf) continue;

            const chave = `${liga}|${slotMin}`;
            if (!padraoMap[chave]) padraoMap[chave] = [];
            padraoMap[chave].push({
              liga, slot_min: slotMin,
              condicao: condKey,
              resultado: res,
              confianca: conf,
              ocorrencias: v.total,
              acertos: cnt,
              atipico: v.atipico,
              janela: v.janela,
            });
          }
        }
      }
    }

    // ── 5. Para cada slot, pega o MELHOR padrão ──
    // Prioridade: atípico > confiança > janela maior
    const previsoes = [];
    for (const [chave, candidatos] of Object.entries(padraoMap)) {
      candidatos.sort((a, b) => {
        if (a.atipico !== b.atipico) return b.atipico - a.atipico;
        if (b.confianca !== a.confianca) return b.confianca - a.confianca;
        return b.janela - a.janela;
      });
      const melhor = candidatos[0];
      previsoes.push({
        ...melhor,
        hora_alvo_bst: proxHoraBST,
        // Contexto: últimas N ocorrências da condição nesse slot
        historico_recente: (() => {
          const [liga2, slot2] = chave.split('|');
          const seqSlot = (ligaLinhas[liga2]||[])
            .map(l => (l.slots||[]).find(s => s.slot_min === parseInt(slot2)))
            .filter(Boolean).slice(-5);
          return seqSlot.map(s => ({ ft: s.ft, gols: s.gols_total, atipico: s.atipico }));
        })(),
      });
    }

    // Ordena: atípicos primeiro, depois por confiança
    previsoes.sort((a, b) => {
      if (a.atipico !== b.atipico) return b.atipico - a.atipico;
      return b.confianca - a.confianca;
    });

    res.json({
      ok: true,
      hora_bst: proxHoraBST,
      hora_bst_atual: horaBST,
      total: previsoes.length,
      total_atipicos: previsoes.filter(p => p.atipico).length,
      previsoes,
    });
  } catch(e) { next(e); }
});

// GET /api/virturia-b365/historico-acertos
router.get('/historico-acertos', async (req, res, next) => {
  try {
    const { horas_atras = 4, min_confianca = 60 } = req.query;
    const minConf  = parseInt(min_confianca) || 60;
    const minOcorr = 3;
    const horasAtras = parseInt(horas_atras) || 4;

    // Função classificar (igual ao motor de previsão)
    function classificar(r) {
      const g = r.gols_total; const a = r.ft_a, b = r.ft_b;
      let principal;
      if (g === 0)       principal = '0-0';
      else if (g >= 5)   principal = 'OVER 4.5';
      else if (g >= 4)   principal = 'OVER 3.5';
      else if (g >= 3)   principal = 'OVER 2.5';
      else if (g >= 2)   principal = 'OVER 1.5';
      else               principal = 'UNDER 1.5';
      const atipico = g === 0 || g >= 5 || (a === b && g >= 2);
      return { principal, atipico };
    }

    // Função que roda o motor de previsão para uma hora-alvo específica
    // usando apenas dados ANTERIORES a essa hora (sem olhar o futuro)
    async function gerarPrevisoesPara(horaAlvoBST, corteMs) {
      // Busca só dados anteriores ao corte
      const rHist = await db.query(`
        SELECT liga, hora, slot_min, ft_str, ft_a, ft_b, gols_total,
               is_btts, empate, start_time,
               DATE(TO_TIMESTAMP(start_time/1000)) as dia
        FROM virturia_resultados_b365
        WHERE start_time < $1
        ORDER BY liga, start_time ASC
      `, [corteMs]);

      if (rHist.rows.length < 20) return [];

      const linhaMap = {};
      for (const j of rHist.rows) {
        const k = `${j.liga}|${j.dia}|${j.hora}`;
        if (!linhaMap[k]) linhaMap[k] = { liga: j.liga, hora: j.hora, ts: Number(j.start_time), slots: [] };
        linhaMap[k].slots.push({ ...j, ...classificar(j) });
      }
      const ligaLinhas = {};
      for (const v of Object.values(linhaMap)) {
        if (!ligaLinhas[v.liga]) ligaLinhas[v.liga] = [];
        v.slots.sort((a, b) => a.slot_min - b.slot_min);
        ligaLinhas[v.liga].push(v);
      }
      for (const l in ligaLinhas) ligaLinhas[l].sort((a, b) => a.ts - b.ts);

      const padraoMap = {};
      for (const [liga, linhas] of Object.entries(ligaLinhas)) {
        const todosSlots = [...new Set(linhas.flatMap(l => l.slots.map(s => s.slot_min)))];
        for (const slotMin of todosSlots) {
          const seq = linhas.map(l => l.slots.find(s => s.slot_min === slotMin)).filter(Boolean);
          if (seq.length < minOcorr + 1) continue;
          for (let janela = 1; janela <= 3; janela++) {
            const acc = {};
            for (let i = 0; i <= seq.length - janela - 1; i++) {
              const conds = seq.slice(i, i + janela);
              const prox  = seq[i + janela];
              const condKey = conds.map(c => c.principal).join(' -> ');
              const temAtipico = conds.some(c => c.atipico);
              if (!acc[condKey]) acc[condKey] = { total: 0, res: {}, atipico: temAtipico, janela };
              acc[condKey].total++;
              acc[condKey].res[prox.principal] = (acc[condKey].res[prox.principal] || 0) + 1;
            }
            for (const [condKey, v] of Object.entries(acc)) {
              if (v.total < minOcorr) continue;
              const melhor = Object.entries(v.res).sort((a,b) => b[1]-a[1])[0];
              if (!melhor) continue;
              const [resul, cnt] = melhor;
              const conf = Math.round(cnt / v.total * 100);
              if (conf < minConf) continue;
              const chave = `${liga}|${slotMin}`;
              if (!padraoMap[chave]) padraoMap[chave] = [];
              padraoMap[chave].push({ liga, slot_min: slotMin, resultado: resul, confianca: conf, ocorrencias: v.total, atipico: v.atipico, janela: v.janela });
            }
          }
        }
      }

      const previsoes = [];
      for (const [, candidatos] of Object.entries(padraoMap)) {
        candidatos.sort((a, b) => (a.atipico !== b.atipico ? b.atipico - a.atipico : b.confianca !== a.confianca ? b.confianca - a.confianca : b.janela - a.janela));
        previsoes.push(candidatos[0]);
      }
      return previsoes;
    }

    // Função que verifica se resultado bate com previsão
    function bateu(previsto, gols, is_btts) {
      if (previsto === '0-0')      return gols === 0;
      if (previsto === 'OVER 1.5') return gols >= 2;
      if (previsto === 'UNDER 1.5') return gols <= 1;
      if (previsto === 'OVER 2.5') return gols >= 3;
      if (previsto === 'UNDER 2.5') return gols <= 2;
      if (previsto === 'OVER 3.5') return gols >= 4;
      if (previsto === 'OVER 4.5') return gols >= 5;
      if (previsto === 'AMBAS SIM') return is_btts;
      return false;
    }

    const agoraBST = new Date(Date.now() + 3600000);
    const horaBSTAtual = agoraBST.getUTCHours();
    const horas = [];

    for (let i = horasAtras; i >= 1; i--) {
      const inicioBST = new Date(Date.now() + 3600000 - i * 3600000);
      inicioBST.setUTCMinutes(0, 0, 0);
      const fimBST    = new Date(inicioBST.getTime() + 3600000);
      const horaBST   = inicioBST.getUTCHours();
      const dataBST   = inicioBST.toISOString().slice(0, 10);
      const inicioMs  = inicioBST.getTime() - 3600000; // UTC real
      const fimMs     = fimBST.getTime() - 3600000;

      // Gera previsões usando só dados anteriores ao início dessa hora
      const previsoes = await gerarPrevisoesPara(horaBST, inicioMs);
      const prevMap   = {}; // liga|slot_min → previsao
      for (const p of previsoes) prevMap[`${p.liga}|${p.slot_min}`] = p;

      // Busca resultados reais que saíram nessa hora
      const rReal = await db.query(`
        SELECT liga, slot_min, ft_str, ft_a, ft_b, gols_total, is_btts, start_time
        FROM virturia_resultados_b365
        WHERE start_time >= $1 AND start_time < $2
        ORDER BY liga, slot_min ASC
      `, [inicioMs, fimMs]);

      const entradas = [];
      for (const r of rReal.rows) {
        const chave = `${r.liga}|${r.slot_min}`;
        const prev  = prevMap[chave];
        if (!prev) continue; // sem previsão para esse slot, ignora
        const acertou = bateu(prev.resultado, r.gols_total, r.is_btts);
        entradas.push({
          liga: r.liga,
          slot_min: r.slot_min,
          previsto: prev.resultado,
          confianca: prev.confianca,
          ocorrencias: prev.ocorrencias,
          ft_real: r.ft_str,
          gols_real: r.gols_total,
          status: acertou ? 'green' : 'red',
        });
      }

      const greens = entradas.filter(e => e.status === 'green').length;
      const reds   = entradas.filter(e => e.status === 'red').length;
      const total  = greens + reds;
      horas.push({
        hora_bst: horaBST, data_bst: dataBST,
        resumo: { greens, reds, total, pct: total > 0 ? Math.round(greens / total * 100) : null },
        entradas,
      });
    }

    res.json({ ok: true, horas });
  } catch(e) { next(e); }
});

module.exports = router;
