// lib/lixeira.js — Lixeira central do sistema F5
// -----------------------------------------------------------------------------
// Em vez de apagar um registro de vez, tiramos uma "fotografia" (JSON) da linha
// inteira e guardamos na tabela `lixeira`. Dá pra RESTAURAR (recoloca a linha no
// lugar) ou EXCLUIR DEFINITIVO. O que passa de RETENCAO_DIAS é limpo sozinho.
//
// Como usar numa rota DELETE (exemplo turma):
//   const lixeira = require('../lib/lixeira');
//   await lixeira.guardar({ entidade:'turma', ref_id:id, rotulo:`Turma ${cod}`,
//                           dados:{ _turma:row, _alunos:[...] }, por:req });
//   await db.query('DELETE FROM turmas WHERE id=$1', [id]);
// -----------------------------------------------------------------------------
const db = require('../db');

const RETENCAO_DIAS = 30;

// Registro de entidades: rótulo amigável + como restaurar cada uma.
// `tabela` é usado pelo restaurador genérico (re-insere a linha tal e qual).
// Entidades com lógica especial (turma, curso) trazem seu próprio `restaurar`.
const ENTIDADES = {
  turma:        { nome: 'Turma' },        // restauração própria (turma + alunos + frequência)
  aluno:        { nome: 'Aluno',        tabela: 'alunos' },     // restauração própria (+vaga)
  reserva:      { nome: 'Reserva',      tabela: 'reservas' },
  interessado:  { nome: 'Lead',         tabela: 'interessados' },
  curso:        { nome: 'Curso',        tabela: 'cursos', soft: true },  // soft delete: ativo=true
  financeiro:   { nome: 'Lançamento financeiro', tabela: 'financeiro' },
  financeiro_recorrente: { nome: 'Despesa recorrente', tabela: 'financeiro_recorrente', soft: true },
  aula:         { nome: 'Aula (banco de aulas)', tabela: 'aulas' },
  freq_aula:    { nome: 'Aula da frequência',    tabela: 'freq_aulas' }, // restauração própria (+presenças)
  cliente_web:  { nome: 'Cliente web',  tabela: 'clientes_web' },
  ead_curso:    { nome: 'Curso EAD',    tabela: 'ead_cursos' },
  ead_modulo:   { nome: 'Módulo EAD',   tabela: 'ead_modulos' },
  ead_aula:     { nome: 'Aula EAD',     tabela: 'ead_aulas' },
};

let _pronta = false;
async function ensureTable() {
  if (_pronta) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS lixeira (
      id           SERIAL PRIMARY KEY,
      entidade     VARCHAR(40)  NOT NULL,
      ref_id       INTEGER,
      rotulo       TEXT,
      dados        JSONB        NOT NULL,
      excluido_por VARCHAR(160),
      excluido_em  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      expira_em    TIMESTAMPTZ  NOT NULL DEFAULT (now() + interval '${RETENCAO_DIAS} days')
    )
  `);
  _pronta = true;
}

// extrai o e-mail de quem apagou a partir do req (header opcional do front)
function quem(por) {
  if (!por) return null;
  if (typeof por === 'string') return por.slice(0, 160);
  // por = req
  const h = por.headers || {};
  return (h['x-user-email'] || h['x-usuario'] || '').toString().slice(0, 160) || null;
}

// Guarda uma fotografia na lixeira. Retorna a linha criada.
async function guardar({ entidade, ref_id, rotulo, dados, por }) {
  await ensureTable();
  if (!ENTIDADES[entidade]) throw new Error(`Entidade desconhecida na lixeira: ${entidade}`);
  const { rows } = await db.query(
    `INSERT INTO lixeira (entidade, ref_id, rotulo, dados, excluido_por, expira_em)
     VALUES ($1,$2,$3,$4,$5, now() + interval '${RETENCAO_DIAS} days') RETURNING *`,
    [entidade, ref_id ?? null, rotulo ?? null, JSON.stringify(dados ?? {}), quem(por)]
  );
  return rows[0];
}

// Lista a lixeira (já apaga de vez o que expirou).
async function listar() {
  await ensureTable();
  await purgarExpirados();
  const { rows } = await db.query('SELECT * FROM lixeira ORDER BY excluido_em DESC');
  return rows.map(r => ({
    ...r,
    entidade_nome: (ENTIDADES[r.entidade] || {}).nome || r.entidade,
    dias_restantes: Math.max(0, Math.ceil((new Date(r.expira_em) - Date.now()) / 86400000)),
  }));
}

// Re-insere uma linha (JSON) numa tabela, preservando o id original.
async function reinserir(client, tabela, row) {
  const cols = Object.keys(row);
  if (!cols.length) return;
  const vals = cols.map(c => row[c]);
  const ph   = cols.map((_, i) => '$' + (i + 1));
  await client.query(
    `INSERT INTO ${tabela} (${cols.map(c => `"${c}"`).join(',')}) VALUES (${ph.join(',')}) ` +
    `ON CONFLICT (id) DO NOTHING`,
    vals
  );
  // realinha a sequência do id pra não colidir com inserts futuros
  await client.query(
    `SELECT setval(pg_get_serial_sequence($1,'id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM ${tabela}), 1))`,
    [tabela]
  ).catch(() => {}); // se a tabela não usa serial em id, ignora
}

// Restaura um item da lixeira de volta ao sistema. Roda numa transação.
async function restaurar(id) {
  await ensureTable();
  const { rows } = await db.query('SELECT * FROM lixeira WHERE id=$1', [id]);
  if (!rows.length) { const e = new Error('Item não encontrado na lixeira'); e.status = 404; throw e; }
  const item = rows[0];
  const dados = item.dados || {};

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const cfg = ENTIDADES[item.entidade] || {};

    if (item.entidade === 'turma') {
      // restaura a turma INTEIRA, na ordem que as chaves estrangeiras exigem:
      // turma → alunos → aulas de frequência → presenças
      if (dados._turma) await reinserir(client, 'turmas', dados._turma);
      for (const al of (dados._alunos     || [])) await reinserir(client, 'alunos',        al);
      for (const fa of (dados._freq_aulas || [])) await reinserir(client, 'freq_aulas',    fa);
      for (const fp of (dados._freq_presencas || [])) await reinserir(client, 'freq_presencas', fp);

    } else if (item.entidade === 'freq_aula') {
      // restaura a aula da frequência e as presenças que estavam nela
      if (dados._aula) await reinserir(client, 'freq_aulas', dados._aula);
      for (const fp of (dados._presencas || [])) await reinserir(client, 'freq_presencas', fp);

    } else if (item.entidade === 'ead_curso') {
      // curso EAD completo: curso → módulos → aulas
      if (dados._curso) await reinserir(client, 'ead_cursos', dados._curso);
      for (const m of (dados._modulos || [])) await reinserir(client, 'ead_modulos', m);
      for (const a of (dados._aulas   || [])) await reinserir(client, 'ead_aulas',   a);

    } else if (item.entidade === 'ead_modulo') {
      // módulo EAD + suas aulas
      if (dados._modulo) await reinserir(client, 'ead_modulos', dados._modulo);
      for (const a of (dados._aulas || [])) await reinserir(client, 'ead_aulas', a);

    } else if (cfg.soft) {
      // soft delete (curso, despesa recorrente): só religa a flag ativo
      if (dados.id != null) {
        await client.query(`UPDATE ${cfg.tabela} SET ativo=true WHERE id=$1`, [dados.id]);
      }

    } else if (item.entidade === 'aluno') {
      // re-insere o aluno e devolve a vaga na turma (a exclusão tinha liberado)
      await reinserir(client, 'alunos', dados);
      if (dados.turma_id) {
        await client.query(
          'UPDATE turmas SET vagas_ocupadas = vagas_ocupadas + 1 WHERE id=$1',
          [dados.turma_id]
        );
      }

    } else {
      if (!cfg.tabela) throw new Error(`Não sei restaurar a entidade: ${item.entidade}`);
      await reinserir(client, cfg.tabela, dados);
    }

    await client.query('DELETE FROM lixeira WHERE id=$1', [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { ok: true, entidade: item.entidade, ref_id: item.ref_id };
}

// Apaga DE VEZ um item da lixeira.
async function purgar(id) {
  await ensureTable();
  await db.query('DELETE FROM lixeira WHERE id=$1', [id]);
  return { ok: true };
}

// Esvazia a lixeira inteira.
async function esvaziar() {
  await ensureTable();
  await db.query('DELETE FROM lixeira');
  return { ok: true };
}

// Limpeza automática: apaga o que passou da validade.
async function purgarExpirados() {
  await ensureTable();
  const { rowCount } = await db.query('DELETE FROM lixeira WHERE expira_em < now()');
  if (rowCount) console.log(`[lixeira] limpeza automática: ${rowCount} item(ns) expirado(s) removido(s)`);
  return rowCount;
}

module.exports = {
  RETENCAO_DIAS, ENTIDADES,
  ensureTable, guardar, listar, restaurar, purgar, esvaziar, purgarExpirados,
};
