// Protege rotas administrativas validando o MESMO token do Google que o
// login do admin já usa (admin/auth.js). Nada de segredo novo pra guardar
// ou vazar — o backend confere direto com o Google se o token é válido,
// se é pra este app (GOOGLE_CLIENT_ID) e se o e-mail está na allowlist.
const https = require('https');

const GOOGLE_CLIENT_ID = '163041222391-rmnha7n1jcni0nu19bflgvpq6f6ufm0j.apps.googleusercontent.com';
const ALLOWED_EMAILS = ['f5novacursos@gmail.com', 'heltonfdm@gmail.com'];

function verificarComGoogle(idToken) {
  return new Promise((resolve) => {
    https.get(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      (r) => {
        let data = '';
        r.on('data', (chunk) => (data += chunk));
        r.on('end', () => {
          try {
            const info = JSON.parse(data);
            const valido = r.statusCode === 200 && info.aud === GOOGLE_CLIENT_ID && ALLOWED_EMAILS.includes(info.email);
            resolve(valido);
          } catch (e) {
            resolve(false);
          }
        });
      }
    ).on('error', () => resolve(false));
  });
}

module.exports = async function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Não autorizado' });

  const ok = await verificarComGoogle(token);
  if (!ok) return res.status(401).json({ error: 'Não autorizado' });
  next();
};
