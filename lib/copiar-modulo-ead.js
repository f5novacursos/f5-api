// Cópia independente dos registros; referências de vídeo/PDF são reutilizadas.
module.exports = async function copiarModuloEad(db, origemId, destinoId, novoTitulo) {
  const erro = (status, mensagem) => Object.assign(new Error(mensagem), { status });
  if (!Number.isSafeInteger(origemId) || origemId <= 0 || !Number.isSafeInteger(destinoId) || destinoId <= 0)
    throw erro(400, 'Módulo e curso de destino inválidos.');
  if (novoTitulo != null && (typeof novoTitulo !== 'string' || !novoTitulo.trim() || novoTitulo.trim().length > 200))
    throw erro(400, 'Informe um título de até 200 caracteres.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: origens } = await client.query('SELECT * FROM ead_modulos WHERE id=$1 FOR SHARE', [origemId]);
    if (!origens.length) throw erro(404, 'Módulo de origem não encontrado.');
    const origem = origens[0];
    if (Number(origem.curso_id) === destinoId) throw erro(400, 'Escolha outro curso de destino.');
    // Serializa cópias no destino para impedir duplicação por cliques simultâneos.
    const { rows: destinos } = await client.query('SELECT * FROM ead_cursos WHERE id=$1 AND ativo=true FOR UPDATE', [destinoId]);
    if (!destinos.length) throw erro(404, 'Curso de destino não encontrado.');
    const { rows: cursosOrigem } = await client.query('SELECT * FROM ead_cursos WHERE id=$1', [origem.curso_id]);
    const integrado = c => c && (c.tipo_conteudo === 'digitacao' || ['curso-digitacao-f5','curso-digitacao-f5-kids'].includes(c.slug));
    if (integrado(destinos[0]) || integrado(cursosOrigem[0])) throw erro(400, 'Cursos de digitação possuem estrutura própria e não aceitam esta cópia.');
    const titulo = novoTitulo == null ? origem.titulo : novoTitulo.trim();
    const { rows: existentes } = await client.query('SELECT id FROM ead_modulos WHERE curso_id=$1 AND lower(trim(titulo))=lower(trim($2))', [destinoId, titulo]);
    if (existentes.length) throw erro(409, 'Já existe um módulo com esse nome no destino. Confira o curso antes de copiar novamente ou escolha outro nome.');
    const { rows: modulos } = await client.query(
      `INSERT INTO ead_modulos (curso_id,titulo,descricao,ordem)
       SELECT $1,$2,$3,COALESCE(MAX(ordem),0)+1 FROM ead_modulos WHERE curso_id=$1 RETURNING id`,
      [destinoId,titulo,origem.descricao || '']);
    const moduloId = modulos[0].id;
    const aulas = await client.query(
      `INSERT INTO ead_aulas (modulo_id,titulo,descricao,url,duracao,material,material_url,gratis,ordem)
       SELECT $1,titulo,descricao,url,duracao,material,material_url,gratis,
              (row_number() OVER (ORDER BY ordem ASC, id ASC))::integer
       FROM ead_aulas WHERE modulo_id=$2 ORDER BY ordem ASC,id ASC`, [moduloId,origemId]);
    await client.query('COMMIT');
    return { modulo_id: moduloId, curso_id: destinoId, titulo, total_aulas: aulas.rowCount };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
};
