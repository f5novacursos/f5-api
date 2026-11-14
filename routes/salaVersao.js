// F5 Sala — entrega das atualizações do programa do professor.
// As versões ficam em data/sala/<versao>/ (app.asar, app.asar.sig, versao.json) e data/sala/latest.json aponta a mais nova.
// Quem confere a ASSINATURA é o computador do professor (atualizador do Windows), então este servidor só entrega arquivos:
// mesmo que alguém trocasse um arquivo aqui, ele seria recusado lá por não ter a assinatura da F5.
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const PASTA = process.env.SALA_DATA || path.join(__dirname, '..', 'data', 'sala'); // SALA_DATA só para testes
const ARQUIVOS = new Set(['app.asar', 'app.asar.sig', 'versao.json']);

// GET /api/sala/versao  → { versao, sha256, tamanho, dependencias, publicadoEm, novidades: [...] }
router.get('/versao', (req, res) => {
  try {
    const latest = JSON.parse(fs.readFileSync(path.join(PASTA, 'latest.json'), 'utf8'));
    res.setHeader('Cache-Control', 'no-store');
    res.json(latest);
  } catch {
    res.status(404).json({ error: 'Nenhuma versão publicada ainda.' });
  }
});

// GET /api/sala/pacote/0.9.23/app.asar
router.get('/pacote/:versao/:arquivo', (req, res) => {
  const { versao, arquivo } = req.params;
  if (!/^\d+\.\d+\.\d+$/.test(versao) || !ARQUIVOS.has(arquivo)) return res.status(404).json({ error: 'Arquivo não encontrado.' });
  const caminho = path.join(PASTA, versao, arquivo);
  if (!caminho.startsWith(PASTA + path.sep) || !fs.existsSync(caminho)) return res.status(404).json({ error: 'Arquivo não encontrado.' });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(caminho);
});

module.exports = router;
