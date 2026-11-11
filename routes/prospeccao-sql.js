// F5 Leads: trechos de SQL compartilhados — UMA definição de "já recebeu mensagem" / "bloqueado para envio" / "mesmo telefone".
// Usado pela lista de leads (marcação na tela), pela verificação antes do disparo e pela importação.

// Status que contam como "já foi contatado"
const ENVIADOS = ['mensagem_enviada', 'respondeu', 'cliente'];
const lista = (a) => a.map(s => `'${s}'`).join(',');

// Compara texto sem acento e sem diferença de maiúscula (não depende da extensão unaccent do Postgres)
const COM = 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç';
const SEM = 'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc';
const semAcentoSql = (col) => `LOWER(TRANSLATE(${col},'${COM}','${SEM}'))`;
const semAcentoJs = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ── Chave de telefone ─────────────────────────────────────────────────────────
// "Mesmo telefone" = mesmo DDD + mesmos 8 últimos dígitos. O DDD entra na chave de propósito:
// 83 9887-4995 e 85 9887-4995 são empresas diferentes (outro estado). O 9º dígito dos celulares não conta,
// então 83 8887-4995 e 83 98887-4995 são o mesmo número. Retorna NULL se não der para saber o DDD.
const FUNCAO_CHAVE = `
CREATE OR REPLACE FUNCTION f5_chave_telefone(txt text) RETURNS text AS $$
  SELECT CASE WHEN LENGTH(n) IN (10, 11) THEN LEFT(n, 2) || RIGHT(n, 8) END
  FROM (
    SELECT CASE WHEN LENGTH(d) >= 12 AND LEFT(d, 2) = '55' THEN SUBSTRING(d FROM 3) ELSE d END AS n
    FROM (SELECT REGEXP_REPLACE(COALESCE(txt, ''), '[^0-9]', '', 'g') AS d) a
  ) b
$$ LANGUAGE sql IMMUTABLE;`;

// Número do lead = whatsapp, senão telefone (igual ao que o disparo usa). k.chave = chave desse número.
// x = último envio confirmado para este lead OU para qualquer cadastro com o mesmo número (mesmo DDD).
const LATERAIS = `
  CROSS JOIN LATERAL (
    SELECT f5_chave_telefone(COALESCE(NULLIF(e.whatsapp,''), e.telefone)) AS chave
  ) k
  LEFT JOIN LATERAL (
    SELECT MAX(m.enviado_em) AS ultimo_envio, COUNT(*)::int AS qtd_envios
    FROM leads_mensagens m
    WHERE m.status = 'enviado'
      AND (m.empresa_id = e.id
           OR (k.chave IS NOT NULL AND f5_chave_telefone(m.numero) = k.chave))
  ) x ON true`;

// Lead que já está na fila de um disparo em andamento
const NA_FILA = `EXISTS (
  SELECT 1 FROM leads_disparo_itens i JOIN leads_disparos d ON d.id = i.disparo_id
  WHERE i.empresa_id = e.id AND i.status IN ('pendente','enviando') AND d.status = 'em_andamento')`;

const JA_ENVIADO = `(x.ultimo_envio IS NOT NULL OR e.status IN (${lista(ENVIADOS)}))`;

// Por que o lead NÃO pode receber agora (NULL = pode receber)
const MOTIVO = `CASE
  WHEN ${JA_ENVIADO} THEN 'enviado'
  WHEN e.status = 'duplicado' THEN 'duplicado'
  WHEN e.status = 'nao_enviar' THEN 'nao_enviar'
  WHEN e.status = 'ignorado' THEN 'ignorado'
  WHEN ${NA_FILA} THEN 'na_fila'
  WHEN e.status IN ('sem_telefone','sem_whatsapp') OR k.chave IS NULL THEN 'sem_numero'
END`;

module.exports = { ENVIADOS, lista, semAcentoSql, semAcentoJs, FUNCAO_CHAVE, LATERAIS, NA_FILA, JA_ENVIADO, MOTIVO };
