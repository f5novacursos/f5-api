// Recuperação do F5 Leads: rotas de prospecção ativa hospedadas na API principal.
const express = require('express');
const db = require('../db');
const router = express.Router();
const { semAcentoSql, semAcentoJs, FUNCAO_CHAVE, LATERAIS, JA_ENVIADO, MOTIVO, NA_FILA } = require('./prospeccao-sql');

// Chave de telefone (DDD + 8 últimos dígitos) e índices para achar rápido "este número já existe / já recebeu mensagem?"
// A trava UNIQUE (nunca dois leads com o mesmo telefone) é criada à parte: se ainda houver repetidos no banco ela não
// entra, e é criada assim que os repetidos forem unidos (botão "Unir duplicados" na tela de Leads).
const INDICE_UNICO = `CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_empresas_chave_telefone
  ON leads_empresas (f5_chave_telefone(telefone))
  WHERE status <> 'duplicado' AND f5_chave_telefone(telefone) IS NOT NULL`;
db.query(`${FUNCAO_CHAVE}
  CREATE INDEX IF NOT EXISTS idx_leads_mensagens_chave ON leads_mensagens (f5_chave_telefone(numero)) WHERE status = 'enviado';
  CREATE INDEX IF NOT EXISTS idx_leads_empresas_chave ON leads_empresas (f5_chave_telefone(telefone));`)
  .then(() => db.query(INDICE_UNICO))
  .catch(e => console.error('[prospeccao] chave de telefone / trava de duplicados:', e.message));

// Um lead pode aparecer em várias buscas (ex.: achado em "Advogado" e depois em "Associação").
// leads_empresas.busca_id guarda só a 1ª; esta tabela liga o lead a TODAS as buscas que o encontraram.
db.query(`
  CREATE TABLE IF NOT EXISTS leads_empresa_buscas (
    empresa_id INTEGER NOT NULL,
    busca_id   INTEGER NOT NULL,
    PRIMARY KEY (empresa_id, busca_id)
  );
  CREATE INDEX IF NOT EXISTS idx_empresa_buscas_busca ON leads_empresa_buscas (busca_id);
  INSERT INTO leads_empresa_buscas (empresa_id, busca_id)
    SELECT id, busca_id FROM leads_empresas WHERE busca_id IS NOT NULL
  ON CONFLICT DO NOTHING;
`).catch(e => console.error('[prospeccao] leads_empresa_buscas:', e.message));

const ORDENS = {
  data_desc: 'e.criado_em DESC',
  data_asc:  'e.criado_em ASC',
  nome_asc:  'LOWER(e.nome) ASC',
  aval_desc: 'e.avaliacao DESC NULLS LAST, e.total_aval DESC NULLS LAST'
};

async function contaAtiva(id) {
  if (id) {
    const r = await db.query('SELECT * FROM leads_contas_apify WHERE id = $1 AND ativo = true', [id]);
    return r.rows[0] || null;
  }
  const r = await db.query('SELECT * FROM leads_contas_apify WHERE ativo = true ORDER BY ultima_uso ASC NULLS FIRST LIMIT 1');
  return r.rows[0] || null;
}

router.get('/stats', async (req, res) => {
  try {
    const [totais, porStatus, buscasRecentes, mensagens] = await Promise.all([
      db.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='novo') AS novos,
        COUNT(*) FILTER (WHERE status='mensagem_enviada') AS enviados,
        COUNT(*) FILTER (WHERE status='respondeu') AS respostas,
        COUNT(*) FILTER (WHERE status='cliente') AS clientes,
        COUNT(*) FILTER (WHERE status='sem_telefone') AS sem_telefone FROM leads_empresas WHERE status <> 'duplicado'`),
      db.query("SELECT status, COUNT(*) AS total FROM leads_empresas WHERE status <> 'duplicado' GROUP BY status ORDER BY total DESC"),
      db.query(`SELECT b.id,b.nicho,b.cidade,b.estado,b.status,b.total_retornado,b.total_novos,b.criado_em,b.actor_run_id,c.nome AS conta_nome
        FROM leads_buscas b LEFT JOIN leads_contas_apify c ON c.id=b.conta_id ORDER BY b.criado_em DESC LIMIT 5`),
      db.query("SELECT COUNT(*) AS total FROM leads_mensagens WHERE status='enviado'")
    ]);
    res.json({ totais: {...totais.rows[0], total_mensagens_enviadas: Number(mensagens.rows[0]?.total || 0)}, porStatus: porStatus.rows, buscasRecentes: buscasRecentes.rows });
  } catch (e) { console.error('[prospeccao stats]', e.message); res.status(500).json({error:e.message}); }
});

router.get('/buscas', async (req, res) => {
  try {
    const page=Math.max(1,Number(req.query.page)||1), limit=Math.min(50,Number(req.query.limit)||20), off=(page-1)*limit;
    const [rows,count] = await Promise.all([
      db.query(`SELECT b.*,c.nome AS conta_nome FROM leads_buscas b LEFT JOIN leads_contas_apify c ON c.id=b.conta_id ORDER BY b.criado_em DESC LIMIT $1 OFFSET $2`,[limit,off]),
      db.query('SELECT COUNT(*) FROM leads_buscas')
    ]);
    res.json({data:rows.rows,total:Number(count.rows[0].count),page,limit});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.get('/leads', async (req, res) => {
  try {
    const page=Math.max(1,Number(req.query.page)||1), limit=Math.min(100,Number(req.query.limit)||50), off=(page-1)*limit;
    const {status,busca_id,cidade,estado,q,nicho,site_filter,envio}=req.query, vals=[], cond=[];
    const add=(sql,value)=>{cond.push(sql.replace('?', `$${vals.length+1}`)); vals.push(value);};
    if(status)add('e.status=?',status); else cond.push("e.status <> 'duplicado'"); if(estado)add('e.estado=?',estado);
    // Busca e nicho olham TODAS as buscas que encontraram o lead, não só a primeira
    if(busca_id)add('EXISTS (SELECT 1 FROM leads_empresa_buscas eb WHERE eb.empresa_id=e.id AND eb.busca_id=?)',Number(busca_id));
    // Cidade e nicho comparam sem acento e sem diferença de maiúscula ("Joao Pessoa" = "João Pessoa")
    if(cidade)add(`${semAcentoSql('e.cidade')}=?`,semAcentoJs(cidade));
    if(nicho)add(`EXISTS (SELECT 1 FROM leads_empresa_buscas eb JOIN leads_buscas bb ON bb.id=eb.busca_id WHERE eb.empresa_id=e.id AND ${semAcentoSql('bb.nicho')}=?)`,semAcentoJs(nicho));
    if(site_filter==='com_site')cond.push("e.site IS NOT NULL AND e.site <> ''"); if(site_filter==='sem_site')cond.push("(e.site IS NULL OR e.site = '')");
    // Já recebeu mensagem? (este cadastro OU qualquer outro com o mesmo número)
    if(envio==='nunca')cond.push(`NOT ${JA_ENVIADO}`); if(envio==='ja')cond.push(JA_ENVIADO);
    if(q){
      const nome=semAcentoJs(q).replace(/[\\%_]/g,'\\$&'), digitos=q.replace(/\D/g,'');
      const partes=[`${semAcentoSql('e.nome')} LIKE $${vals.length+1}`]; vals.push(`%${nome}%`);
      // Telefone: compara só os dígitos, então "(83) 9887-4995", "83 98874995" e "98874995" acham o mesmo lead
      if(digitos.length>=3){ partes.push(`REGEXP_REPLACE(COALESCE(e.telefone,'')||COALESCE(e.whatsapp,''),'[^0-9]','','g') LIKE $${vals.length+1}`); vals.push(`%${digitos}%`); }
      cond.push(`(${partes.join(' OR ')})`);
    }
    const where=cond.length?'WHERE '+cond.join(' AND '):'';
    const from=`FROM leads_empresas e LEFT JOIN leads_buscas b ON b.id=e.busca_id LEFT JOIN leads_contas_apify c ON c.id=e.conta_id ${LATERAIS}`;
    const [rows,resumo]=await Promise.all([
      db.query(`SELECT e.*,b.nicho,c.nome AS conta_nome,x.ultimo_envio,x.qtd_envios,${JA_ENVIADO} AS ja_enviado,${NA_FILA} AS na_fila,(${MOTIVO}) AS bloqueio ${from} ${where} ORDER BY ${ORDENS[req.query.order]||ORDENS.data_desc}, e.id DESC LIMIT $${vals.length+1} OFFSET $${vals.length+2}`,[...vals,limit,off]),
      db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${JA_ENVIADO})::int AS ja_enviados,
          COUNT(*) FILTER (WHERE (${MOTIVO}) IS NULL)::int AS disponiveis ${from} ${where}`,vals)
    ]);
    const r=resumo.rows[0];
    res.json({data:rows.rows,total:r.total,resumo:{ja_enviados:r.ja_enviados,disponiveis:r.disponiveis},page,limit});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.patch('/leads/:id', async (req,res) => {
  try { const {status,observacoes,whatsapp,telefone}=req.body, fields={status,observacoes,whatsapp,telefone}, vals=[], sets=[];
    for(const [key,value] of Object.entries(fields)) if(value!==undefined){sets.push(`${key}=$${vals.length+1}`);vals.push(value);}
    if(!sets.length)return res.status(400).json({error:'Nada para atualizar'}); vals.push(req.params.id);
    const r=await db.query(`UPDATE leads_empresas SET ${sets.join(', ')}, atualizado_em=NOW() WHERE id=$${vals.length} RETURNING *`,vals);
    if(!r.rows[0])return res.status(404).json({error:'Lead não encontrado'}); res.json(r.rows[0]);
  } catch(e){
    if(e.code==='23505')return res.status(409).json({error:'Já existe outro lead com esse telefone'});
    res.status(500).json({error:e.message});
  }
});

// Listas dos filtros: uma entrada por nome "sem acento" ("Joao Pessoa" e "João Pessoa" viram uma só; fica a grafia mais usada)
router.get('/leads/cidades', async (req,res)=>{try{const k=semAcentoSql('cidade');const r=await db.query(`SELECT cidade FROM (SELECT DISTINCT ON (k) cidade, k FROM (SELECT cidade, ${k} AS k, COUNT(*) AS n FROM leads_empresas WHERE cidade IS NOT NULL AND cidade <> '' GROUP BY cidade) g ORDER BY k, n DESC) t ORDER BY k`);res.json(r.rows.map(x=>x.cidade))}catch(e){res.status(500).json({error:e.message})}});
router.get('/leads/nichos', async (req,res)=>{try{const k=semAcentoSql('nicho');const r=await db.query(`SELECT nicho FROM (SELECT DISTINCT ON (k) nicho, k FROM (SELECT nicho, ${k} AS k, COUNT(*) AS n FROM leads_buscas WHERE nicho IS NOT NULL AND nicho <> '' GROUP BY nicho) g ORDER BY k, n DESC) t ORDER BY k`);res.json(r.rows.map(x=>x.nicho))}catch(e){res.status(500).json({error:e.message})}});
// ── Duplicados que já estão no banco ───────────────────────────────────────────
// Grupo = leads com o mesmo DDD + 8 últimos dígitos. Fica UM (o que já recebeu mensagem; se nenhum, o mais antigo);
// os outros viram status 'duplicado': somem da lista e nunca recebem mensagem. NADA é apagado (dá para voltar o status).
async function gruposDuplicados() {
  const r = await db.query(`
    SELECT chave, id, nome, status FROM (
      SELECT f5_chave_telefone(e.telefone) AS chave, e.id, e.nome, e.status, e.criado_em,
             (e.status IN ('mensagem_enviada','respondeu','cliente')
              OR EXISTS (SELECT 1 FROM leads_mensagens m WHERE m.empresa_id = e.id AND m.status = 'enviado')) AS tem_envio
      FROM leads_empresas e
      WHERE e.status <> 'duplicado' AND f5_chave_telefone(e.telefone) IS NOT NULL
    ) t
    WHERE chave IN (SELECT f5_chave_telefone(telefone) FROM leads_empresas
                    WHERE status <> 'duplicado' AND f5_chave_telefone(telefone) IS NOT NULL
                    GROUP BY 1 HAVING COUNT(*) > 1)
    ORDER BY chave, tem_envio DESC, criado_em ASC, id ASC`);
  const mapa = new Map();
  for (const l of r.rows) { if (!mapa.has(l.chave)) mapa.set(l.chave, []); mapa.get(l.chave).push(l); }
  return [...mapa.values()].map(g => ({ manter: g[0], extras: g.slice(1) }));
}

// Só olha: quantos grupos e quantos cadastros repetidos existem (nada muda)
router.get('/leads/duplicados', async (req,res)=>{
  try {
    const g = await gruposDuplicados();
    res.json({ grupos: g.length, extras: g.reduce((s,x)=>s+x.extras.length,0),
      exemplos: g.slice(0,8).map(x => ({ manter: x.manter.nome, repetidos: x.extras.map(e => e.nome) })) });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Une: mantém um por grupo, marca os outros como 'duplicado' e liga o que ficou às buscas dos repetidos
router.post('/leads/duplicados', async (req,res)=>{
  try {
    const grupos = await gruposDuplicados();
    let marcados = 0;
    for (const g of grupos) {
      const ids = g.extras.map(x => x.id), keep = g.manter.id;
      await db.query('INSERT INTO leads_empresa_buscas (empresa_id,busca_id) SELECT $1,busca_id FROM leads_empresa_buscas WHERE empresa_id=ANY($2::int[]) ON CONFLICT DO NOTHING',[keep,ids]);
      await db.query(`UPDATE leads_empresas SET
          site=COALESCE(site,(SELECT site FROM leads_empresas WHERE id=ANY($2::int[]) AND site IS NOT NULL LIMIT 1)),
          email=COALESCE(email,(SELECT email FROM leads_empresas WHERE id=ANY($2::int[]) AND email IS NOT NULL LIMIT 1)),
          instagram=COALESCE(instagram,(SELECT instagram FROM leads_empresas WHERE id=ANY($2::int[]) AND instagram IS NOT NULL LIMIT 1)),
          atualizado_em=NOW() WHERE id=$1`,[keep,ids]);
      await db.query(`UPDATE leads_empresas SET status='duplicado', observacoes=COALESCE(observacoes||' | ','')||$2, atualizado_em=NOW() WHERE id=ANY($1::int[])`,[ids,`Duplicado do lead #${keep}`]);
      for (const id of ids) {
        await db.query(`INSERT INTO leads_historico (empresa_id,tipo,descricao) VALUES ($1,'duplicado',$2)`,[id,`Unido ao lead #${keep} (mesmo telefone)`]).catch(()=>{});
      }
      marcados += ids.length;
    }
    // Sem repetidos no banco, a trava UNIQUE pode entrar: dali em diante o banco recusa telefone repetido
    let trava = 'ok';
    try { await db.query(INDICE_UNICO); } catch(e) { trava = 'falhou: ' + e.message; }
    res.json({ ok:true, grupos: grupos.length, marcados, trava });
  } catch(e){ console.error('[prospeccao duplicados]',e.message); res.status(500).json({error:e.message}); }
});

// Detalhe de um lead (botão "Ver"). Fica depois de /leads/cidades para não capturar essa rota.
router.get('/leads/:id', async (req,res)=>{
  try {
    const id=Number(req.params.id); if(!Number.isInteger(id))return res.status(400).json({error:'ID inválido'});
    const r=await db.query('SELECT e.*,b.nicho FROM leads_empresas e LEFT JOIN leads_buscas b ON b.id=e.busca_id WHERE e.id=$1',[id]);
    if(!r.rows[0])return res.status(404).json({error:'Lead não encontrado'});
    res.json(r.rows[0]);
  } catch(e){res.status(500).json({error:e.message});}
});
// Linha do tempo do lead, mais recente primeiro
router.get('/leads/:id/historico', async (req,res)=>{
  try {
    const id=Number(req.params.id); if(!Number.isInteger(id))return res.status(400).json({error:'ID inválido'});
    const r=await db.query('SELECT id,tipo,descricao,dados,criado_em FROM leads_historico WHERE empresa_id=$1 ORDER BY criado_em DESC, id DESC LIMIT 100',[id]);
    res.json(r.rows);
  } catch(e){res.status(500).json({error:e.message});}
});
router.post('/leads/limpar-site', async (req,res)=>{try{const {ids}=req.body;if(!Array.isArray(ids)||!ids.length)return res.status(400).json({error:'Nenhum ID fornecido'});await db.query('UPDATE leads_empresas SET site=NULL,atualizado_em=NOW() WHERE id=ANY($1)',[ids]);res.json({ok:true,count:ids.length})}catch(e){res.status(500).json({error:e.message})}});

router.get('/contas', async (req,res)=>{try{const r=await db.query('SELECT id,nome,ativo,modo_auto,ultima_uso,criado_em FROM leads_contas_apify ORDER BY criado_em DESC');res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
router.post('/contas', async (req,res)=>{try{const {nome,api_token,ativo=true,modo_auto=true}=req.body;if(!nome||!api_token)return res.status(400).json({error:'nome e api_token são obrigatórios'});const r=await db.query('INSERT INTO leads_contas_apify (nome,api_token,ativo,modo_auto) VALUES ($1,$2,$3,$4) RETURNING id,nome,ativo,modo_auto,criado_em',[nome,api_token,ativo,modo_auto]);res.status(201).json(r.rows[0])}catch(e){res.status(500).json({error:e.message})}});
router.put('/contas/:id', async (req,res)=>{try{const {nome,api_token,ativo,modo_auto}=req.body,sets=[],vals=[];for(const [key,value] of Object.entries({nome,api_token,ativo,modo_auto}))if(value!==undefined){sets.push(`${key}=$${vals.length+1}`);vals.push(value)}if(!sets.length)return res.status(400).json({error:'Nada para atualizar'});vals.push(req.params.id);const r=await db.query(`UPDATE leads_contas_apify SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING id,nome,ativo,modo_auto,ultima_uso,criado_em`,vals);if(!r.rows[0])return res.status(404).json({error:'Conta não encontrada'});res.json(r.rows[0])}catch(e){res.status(500).json({error:e.message})}});
router.delete('/contas/:id', async (req,res)=>{try{await db.query('DELETE FROM leads_contas_apify WHERE id=$1',[req.params.id]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
router.get('/contas/:id/creditos', async (req,res)=>{
  try {const r=await db.query('SELECT api_token FROM leads_contas_apify WHERE id=$1',[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Conta não encontrada'});const token=r.rows[0].api_token;
    const [user,usage,runs]=await Promise.all([fetch(`https://api.apify.com/v2/users/me?token=${token}`),fetch(`https://api.apify.com/v2/users/me/usage/monthly?token=${token}`),fetch(`https://api.apify.com/v2/actor-runs?token=${token}&limit=100&desc=true`)]);
    if(!user.ok)return res.status(502).json({error:'Erro ao consultar Apify'});const u=await user.json(),v=usage.ok?await usage.json():{},x=runs.ok?await runs.json():{data:{items:[]}},plan=u.data?.plan||{},monthly=v.data||{};let usados=monthly.totalUsageCreditsUsdAfterVolumeDiscount??monthly.totalUsageCreditsUsdBeforeVolumeDiscount??0;if(usados===0){const inicio=monthly.usageCycle?.startAt?new Date(monthly.usageCycle.startAt):new Date(new Date().getFullYear(),new Date().getMonth(),1);usados=(x.data?.items||[]).filter(i=>new Date(i.startedAt)>=inicio).reduce((s,i)=>s+(i.usageTotalUsd||0),0)}res.json({username:u.data?.username,email:u.data?.email,plan_id:plan.id,plan_nome:plan.name||plan.id,creditos_total:plan.monthlyUsageCreditsUsd??5,creditos_usados:usados,renova_em:monthly.usageCycle?.endAt||null,compute_total:plan.monthlyActorComputeUnits,compute_usados:monthly.actorComputeUnits,runs_total:plan.monthlyActorRuns,runs_usados:monthly.actorRuns});
  }catch(e){console.error('[prospeccao creditos]',e.message);res.status(500).json({error:e.message})}
});

router.post('/apify/executar', async (req,res)=>{
  try { const {nicho,cidade,estado,quantidade=20,conta_id,ignorar,filtros={}}=req.body; if(!nicho||!cidade||!estado)return res.status(400).json({error:'nicho, cidade e estado são obrigatórios'}); if(ignorar)filtros.ignorar=ignorar;
    const conta=await contaAtiva(conta_id); if(!conta)return res.status(400).json({error:'Nenhuma conta Apify ativa disponível'});
    const busca=(await db.query(`INSERT INTO leads_buscas (nicho,cidade,estado,quantidade,filtros,conta_id,status) VALUES ($1,$2,$3,$4,$5,$6,'executando') RETURNING *`,[nicho,cidade,estado,quantidade,JSON.stringify(filtros),conta.id])).rows[0];
    const input={countryCode:'br',language:'pt-BR',locationQuery:`${cidade}, ${estado === 'PB' ? 'Paraíba' : estado}, Brazil`,maxCrawledPlacesPerSearch:Number(quantidade),searchStringsArray:[`${nicho} ${cidade} ${estado}`],skipClosedPlaces:false,...filtros};
    const apify=await fetch(`https://api.apify.com/v2/acts/lukaskrivka~google-maps-with-contact-details/runs?token=${conta.api_token}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    if(!apify.ok){const detail=await apify.text();await db.query("UPDATE leads_buscas SET status='erro',erro_msg=$1 WHERE id=$2",[detail,busca.id]);return res.status(502).json({error:'Erro ao iniciar Apify',detail});}
    const data=await apify.json(),runId=data.data?.id,datasetId=data.data?.defaultDatasetId;await db.query('UPDATE leads_buscas SET actor_run_id=$1,dataset_id=$2 WHERE id=$3',[runId,datasetId,busca.id]);await db.query('UPDATE leads_contas_apify SET ultima_uso=NOW() WHERE id=$1',[conta.id]);res.json({ok:true,busca_id:busca.id,run_id:runId,dataset_id:datasetId,conta:conta.nome});
  } catch(e){console.error('[prospeccao apify]',e.message);res.status(500).json({error:e.message});}
});

router.get('/apify/status/:runId', async (req,res)=>{
  try {const r=await db.query(`SELECT b.*,c.api_token FROM leads_buscas b JOIN leads_contas_apify c ON c.id=b.conta_id WHERE b.actor_run_id=$1`,[req.params.runId]);const busca=r.rows[0];if(!busca)return res.status(404).json({error:'Run não encontrado'});const response=await fetch(`https://api.apify.com/v2/actor-runs/${req.params.runId}?token=${busca.api_token}`);if(!response.ok)return res.status(502).json({error:'Erro ao consultar Apify'});const data=await response.json(),status=data.data?.status;if(status==='SUCCEEDED')await db.query("UPDATE leads_buscas SET status='importando' WHERE id=$1 AND status='executando'",[busca.id]);if(status==='FAILED'||status==='ABORTED')await db.query("UPDATE leads_buscas SET status='erro',erro_msg=$1,concluido_em=NOW() WHERE id=$2",[status,busca.id]);res.json({busca_id:busca.id,run_id:req.params.runId,apify_status:status,dataset_id:data.data?.defaultDatasetId,stats:data.data?.stats})}catch(e){res.status(500).json({error:e.message})}
});

// Importa o resultado do Apify SEM criar repetidos.
// Mesma empresa = mesmo place_id (identificador do Google) OU mesmo telefone (DDD + 8 últimos dígitos).
// Se já existe, não cria outra: só completa site/e-mail/Instagram que estavam vazios e liga o lead a esta busca.
// A trava UNIQUE do banco é a garantia final: se duas importações tentarem criar o mesmo telefone ao mesmo tempo, a segunda vira "atualizado".
router.post('/apify/importar/:runId', async (req,res)=>{
  try {
    const r=await db.query(`SELECT b.*,c.api_token FROM leads_buscas b JOIN leads_contas_apify c ON c.id=b.conta_id WHERE b.actor_run_id=$1`,[req.params.runId]);
    const busca=r.rows[0]; if(!busca)return res.status(404).json({error:'Run não encontrado'});
    const response=await fetch(`https://api.apify.com/v2/datasets/${busca.dataset_id}/items?token=${busca.api_token}&clean=true&format=json`);
    if(!response.ok)return res.status(502).json({error:'Erro ao buscar dataset Apify'});
    const items=await response.json();

    let ignorar=[];
    try{const f=typeof busca.filtros==='string'?JSON.parse(busca.filtros):busca.filtros||{};ignorar=String(f.ignorar||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)}catch{}

    // Procura o lead já cadastrado: primeiro pelo place_id, depois pelo telefone (DDD + 8 dígitos)
    const achar=async(placeId,telefone)=>{
      if(placeId){const p=await db.query('SELECT id FROM leads_empresas WHERE place_id=$1',[placeId]);if(p.rows[0])return p.rows[0].id}
      if(telefone){const t=await db.query("SELECT id FROM leads_empresas WHERE f5_chave_telefone(telefone)=f5_chave_telefone($1) AND status<>'duplicado' ORDER BY id LIMIT 1",[telefone]);if(t.rows[0])return t.rows[0].id}
      return null;
    };
    const reencontrado=async(id,site,email,instagram)=>{
      await db.query('UPDATE leads_empresas SET site=COALESCE(site,$1),email=COALESCE(email,$2),instagram=COALESCE(instagram,$3),atualizado_em=NOW() WHERE id=$4',[site,email,instagram,id]);
      await db.query('INSERT INTO leads_empresa_buscas (empresa_id,busca_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[id,busca.id]);
    };

    let novos=0,atualizados=0;
    for(const item of items){
      try{
        const placeId=item.placeId?String(item.placeId).slice(0,300):null;
        const nome=String(item.title||'Sem nome').slice(0,300);
        const categoria=item.categories?.[0]?String(item.categories[0]).slice(0,300):null;
        if(ignorar.some(x=>`${nome} ${categoria||''}`.toLowerCase().includes(x)))continue;
        const telefone=String(item.phone||'').replace(/\D/g,'').slice(-11)||null;
        const site=item.website?String(item.website).slice(0,500):null;
        const email=item.emails?.[0]?String(item.emails[0]).slice(0,200):null;
        const instagram=item.instagram?.[0]?String(item.instagram[0]).slice(0,200):null;

        const existente=await achar(placeId,telefone);
        if(existente){await reencontrado(existente,site,email,instagram);atualizados++;continue}

        try{
          const criado=await db.query(`INSERT INTO leads_empresas (place_id,nome,telefone,cidade,estado,categoria,avaliacao,total_aval,site,email,instagram,endereco,cep,latitude,longitude,status,busca_id,conta_id,dados_brutos) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
            [placeId,nome,telefone,busca.cidade,busca.estado,categoria,item.rating||null,item.reviewsCount||null,site,email,instagram,item.address||null,item.postalCode?.slice(0,10)||null,item.location?.lat||null,item.location?.lng||null,telefone?'novo':'sem_telefone',busca.id,busca.conta_id,JSON.stringify(item)]);
          await db.query('INSERT INTO leads_empresa_buscas (empresa_id,busca_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[criado.rows[0].id,busca.id]);
          novos++;
        }catch(e){
          // Outra importação criou esse mesmo lead no meio tempo (trava UNIQUE): trata como já existente
          if(e.code!=='23505')throw e;
          const id=await achar(placeId,telefone);
          if(!id)throw e;
          await reencontrado(id,site,email,instagram);atualizados++;
        }
      }catch(e){console.error('[prospeccao importar item]',e.message)}
    }
    await db.query("UPDATE leads_buscas SET status='concluido',total_retornado=$1,total_novos=$2,total_atualizados=$3,concluido_em=NOW() WHERE id=$4",[items.length,novos,atualizados,busca.id]);
    res.json({ok:true,busca_id:busca.id,total:items.length,novos,atualizados});
  }catch(e){console.error('[prospeccao importar]',e.message);res.status(500).json({error:e.message})}
});

router.use('/mensagens', require('./prospeccao-mensagens'));

router.get('/health', (req,res)=>res.json({ok:true,service:'f5-prospeccao'}));
module.exports=router;
