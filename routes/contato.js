const router  = require('express').Router();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

// POST /api/contato
router.post('/', async (req, res) => {
  try {
    const { nome, email, assunto, mensagem } = req.body;
    if (!nome || !email || !mensagem) {
      return res.status(400).json({ error: 'nome, email e mensagem são obrigatórios' });
    }

    await transporter.sendMail({
      from:    `"${nome} via F5 Nova Cursos" <${process.env.MAIL_USER}>`,
      to:      process.env.MAIL_TO || process.env.MAIL_USER,
      replyTo: email,
      subject: `✉️ ${assunto || 'Novo contato'} — F5 Nova Cursos`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f0f4fb;padding:32px;border-radius:12px">
          <div style="background:#0a1628;padding:24px 28px;border-radius:10px 10px 0 0;text-align:center">
            <h1 style="color:#f5b800;font-size:22px;margin:0;letter-spacing:2px">F5 NOVA CURSOS</h1>
            <p style="color:rgba(255,255,255,.5);font-size:13px;margin:6px 0 0">Novo contato pelo site</p>
          </div>
          <div style="background:#fff;padding:28px;border-radius:0 0 10px 10px;border:1px solid #e0e7f0">
            <table style="width:100%;border-collapse:collapse">
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid #f0f4fb;font-size:13px;color:#8fa3c8;font-weight:700;width:100px">NOME</td>
                <td style="padding:10px 0;border-bottom:1px solid #f0f4fb;font-size:15px;color:#0a1628;font-weight:600">${nome}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid #f0f4fb;font-size:13px;color:#8fa3c8;font-weight:700">E-MAIL</td>
                <td style="padding:10px 0;border-bottom:1px solid #f0f4fb;font-size:15px;color:#2155b8">${email}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid #f0f4fb;font-size:13px;color:#8fa3c8;font-weight:700">ASSUNTO</td>
                <td style="padding:10px 0;border-bottom:1px solid #f0f4fb;font-size:15px;color:#0a1628">${assunto || '—'}</td>
              </tr>
              <tr>
                <td style="padding:12px 0 0;font-size:13px;color:#8fa3c8;font-weight:700;vertical-align:top">MENSAGEM</td>
                <td style="padding:12px 0 0;font-size:15px;color:#0a1628;line-height:1.6">${mensagem.replace(/\n/g, '<br>')}</td>
              </tr>
            </table>
            <div style="margin-top:24px;padding:14px;background:#f0f4fb;border-radius:8px;text-align:center">
              <a href="mailto:${email}" style="color:#2155b8;font-weight:700;text-decoration:none;font-size:14px">↩ Responder para ${email}</a>
            </div>
          </div>
          <p style="text-align:center;font-size:11px;color:#8fa3c8;margin-top:16px">F5 Nova Cursos — João Pessoa, PB</p>
        </div>
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[Contato] Erro ao enviar e-mail:', err.message);
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
});

module.exports = router;
