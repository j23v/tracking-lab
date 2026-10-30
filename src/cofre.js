// O cofre dos segredos do cliente (chave do Meta, token do webhook).
//
// Cifra com AES-GCM; a chave sai da SENHA_HUB (segredo do Worker, pedido pelo
// botao) por HKDF, com um sal novo a cada gravacao. Formato guardado no D1:
//   v1.<sal>.<iv>.<cifrado>        (base64url)
//
// ⚠️ O que isto protege, e o que nao: protege uma copia do D1 que vaze sozinha
// (exportacao, backup). NAO protege de quem tem a conta Cloudflare do cliente --
// essa pessoa ja pode publicar codigo que le os segredos. HKDF, e nao PBKDF2,
// porque o plano gratis da Cloudflare da ~10 ms de CPU por pedido.
//
// Trocar a senha do Hub exige `recifrar` (o Hub faz isso no mesmo passo).

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deB64(texto) {
  const s = atob(texto.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function chaveDe(senha, sal) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(senha)), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: sal, info: enc.encode('tracking-lab/cofre/v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function cifrar(texto, senha) {
  if (!senha) throw new Error('sem SENHA_HUB');
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const chave = await chaveDe(senha, sal);
  const cifrado = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, chave, enc.encode(String(texto)));
  return `v1.${b64(sal)}.${b64(iv)}.${b64(cifrado)}`;
}

/** Lanca se a senha estiver errada ou o texto adulterado (o GCM confere). */
export async function decifrar(guardado, senha) {
  const [v, sal, iv, cifrado] = String(guardado || '').split('.');
  if (v !== 'v1' || !sal || !iv || !cifrado) throw new Error('formato desconhecido');
  const chave = await chaveDe(senha, deB64(sal));
  const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(iv) }, chave, deB64(cifrado));
  return dec.decode(claro);
}

/** Troca de senha: decifra com a velha e cifra com a nova. */
export async function recifrar(guardado, senhaVelha, senhaNova) {
  return cifrar(await decifrar(guardado, senhaVelha), senhaNova);
}

/** O que o Hub mostra no lugar do segredo: "EAAG…x9Q". */
export function dica(texto) {
  const s = String(texto || '').trim();
  if (s.length < 10) return '…';
  return `${s.slice(0, 4)}…${s.slice(-3)}`;
}
