// Gera URL assinada (presigned GET) para um objeto privado no Cloudflare R2.
// Implementa AWS Signature V4 por query-string usando só o `crypto` nativo
// (sem aws-sdk) — importante porque o deploy do f5-api é via `docker cp` e não
// reinstala node_modules.
const crypto = require('crypto');

const hmac = (key, str) => crypto.createHmac('sha256', key).update(str, 'utf8').digest();
const sha256hex = (str) => crypto.createHash('sha256').update(str, 'utf8').digest('hex');

// Codificação de URI no estilo S3 (RFC 3986) — encodeURIComponent + os extras.
function s3uri(str, encodeSlash = true) {
  let out = encodeURIComponent(str).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (!encodeSlash) out = out.replace(/%2F/g, '/');
  return out;
}

function r2Configurado() {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
            process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
}

// Núcleo da assinatura SigV4 por query-string (presigned URL). Serve p/ GET e PUT.
// Assinamos só o header `host` (SignedHeaders=host) → o navegador pode mandar
// Content-Type sem quebrar a assinatura.
function _presign(method, objectKey, expiresSeconds) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('R2 não configurado (defina R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).');
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const region = 'auto';
  const service = 's3';

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const canonicalUri = '/' + s3uri(bucket, false) + '/' + s3uri(objectKey, false);

  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params).sort()
    .map(k => `${s3uri(k)}=${s3uri(params[k])}`).join('&');

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery,
    `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope, sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// presignGet('curso1/aula123.mp4', 600) -> URL válida por 600s
function presignGet(objectKey, expiresSeconds = 600) {
  return _presign('GET', objectKey, expiresSeconds);
}

// presignPut('curso1/aula123.mp4', 3600) -> URL p/ upload direto (HTTP PUT) válida por N segundos.
// O navegador faz `fetch(url, { method:'PUT', body: arquivo })`. Exige CORS no bucket R2.
function presignPut(objectKey, expiresSeconds = 3600) {
  return _presign('PUT', objectKey, expiresSeconds);
}

module.exports = { presignGet, presignPut, r2Configurado };
