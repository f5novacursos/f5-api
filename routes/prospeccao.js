// Recuperação do F5 Leads: rotas de prospecção ativa hospedadas na API principal.
const express = require('express');
const db = require('../db');
const router = express.Router();

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
        COUNT(*) FILTER (WHERE status='sem_telefone') AS sem_telefone FROM leads_empresas`),
      db.query('SELECT status, COUNT(*) AS total FROM leads_empresas GROUP BY status ORDER BY total DESC'),
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
    const {status,busca_id,cidade,estado,q,nicho,site_filter}=req.query, vals=[], cond=[];
    const add=(sql,value)=>{cond.push(sql.replace('?', `$${vals.length+1}`)); vals.push(value);};
    if(status)add('e.status=?',status); if(busca_id)add('e.busca_id=?',Number(busca_id)); if(cidade)add('LOWER(e.cidade) LIKE ?',`%${cidade.toLowerCase()}%`); if(estado)add('e.estado=?',estado);
    if(nicho)add('LOWER(b.nicho)=?',nicho.toLowerCase()); if(site_filter==='com_site')cond.push("e.site IS NOT NULL AND e.site <> ''"); if(site_filter==='sem_site')cond.push("(e.site IS NULL OR e.site = '')");
    if(q){ const p1=`$${vals.length+1}`,p2=`$${vals.length+2}`; cond.push(`(LOWER(e.nome) LIKE ${p1} OR e.telefone LIKE ${p2})`); vals.push(`%${q.toLowerCase()}%`,`%${q}%`); }
    const where=cond.length?'WHERE '+cond.join(' AND '):'';
    const [rows,count]=await Promise.all([
      db.query(`SELECT e.*,b.nicho,c.nome AS conta_nome FROM leads_empresas e LEFT JOIN leads_buscas b ON b.id=e.busca_id LEFT JOIN leads_contas_apify c ON c.id=e.conta_id ${where} ORDER BY e.criado_em DESC LIMIT $${vals.length+1} OFFSET $${vals.length+2}`,[...vals,limit,off]),
      db.query(`SELECT COUNT(*) FROM leads_empresas e LEFT JOIN leads_buscas b ON b.id=e.busca_id ${where}`,vals)
    ]);
    res.json({data:rows.rows,total:Number(count.rows[0].count),page,limit});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.patch('/leads/:id', async (req,res) => {
  try { const {status,observacoes,whatsapp,telefone}=req.body, fields={status,observacoes,whatsapp,telefone}, vals=[], sets=[];
    for(const [key,value] of Object.entries(fields)) if(value!==undefined){sets.push(`${key}=$${vals.length+1}`);vals.push(value);}
    if(!sets.length)return res.status(400).json({error:'Nada para atualizar'}); vals.push(req.params.id);
    const r=await db.query(`UPDATE leads_empresas SET ${sets.join(', ')}, atualizado_em=NOW() WHERE id=$${vals.length} RETURNING *`,vals);
    if(!r.rows[0])return res.status(404).json({error:'Lead não encontrado'}); res.json(r.rows[0]);
  } catch(e){res.status(500).json({error:e.message});}
});

router.get('/contas', async (req,res)=>{try{const r=await db.query('SELECT id,nome,ativo,modo_auto,ultima_uso,criado_em FROM leads_contas_apify ORDER BY criado_em DESC');res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
router.post('/contas', async (req,res)=>{try{const {nome,api_token,ativo=true,modo_auto=true}=req.body;if(!nome||!api_token)return res.status(400).json({error:'nome e api_token são obrigatórios'});const r=await db.query('INSERT INTO leads_contas_apify (nome,api_token,ativo,modo_auto) VALUES ($1,$2,$3,$4) RETURNING id,nome,ativo,modo_auto,criado_em',[nome,api_token,ativo,modo_auto]);res.status(201).json(r.rows[0])}catch(e){res.status(500).json({error:e.message})}});

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

router.get('/health', (req,res)=>res.json({ok:true,service:'f5-prospeccao'}));
module.exports=router;
