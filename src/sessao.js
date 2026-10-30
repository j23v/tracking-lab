// Login do Hub: a senha e o segredo SENHA_HUB (pedido pelo botao). A sessao e
// um cookie assinado com HMAC da propria senha -- trocar a senha derruba todas
// as sessoes, sem tabela nenhuma.

const enc = new TextEncoder();
export const MIN_SENHA = 12;
const HORAS_SESSAO = 12;
export const COOKIE = 'tl_sessao';

/** "ok" | "falta" | "curta" -- o Hub explica cada um. */
export function estadoDaSenha(senha) {
  const s = String(senha || '');
  if (!s) return 'falta';
  return s.length < MIN_SENHA ? 'curta' : 'ok';
}

async function hmac(chave, texto) {
  const k = await crypto.subtle.importKey('raw', enc.encode(String(chave)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(texto)));
}

function iguais(a, b) {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a[i] ^ b[i];
  return dif === 0;
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Confere a senha digitada sem vazar pelo tempo: compara os HMAC (mesmo
 * tamanho sempre), e nao os textos.
 */
export async function senhaConfere(digitada, senha) {
  if (estadoDaSenha(senha) !== 'ok') return false;
  const [a, b] = await Promise.all([hmac('tl/entrar', String(digitada || '')), hmac('tl/entrar', String(senha))]);
  return iguais(a, b);
}

export async function novaSessao(senha, agora = Date.now()) {
  const expira = agora + HORAS_SESSAO * 3600 * 1000;
  return `${expira}.${hex(await hmac(senha, `sessao:${expira}`))}`;
}

export async function sessaoValida(valor, senha, agora = Date.now()) {
  const [expira, assinatura] = String(valor || '').split('.');
  if (!/^\d+$/.test(expira || '') || !/^[0-9a-f]{64}$/.test(assinatura || '')) return false;
  if (Number(expira) < agora || estadoDaSenha(senha) !== 'ok') return false;
  const esperada = hex(await hmac(senha, `sessao:${expira}`));
  return iguais(enc.encode(esperada), enc.encode(assinatura));
}

export function lerCookie(request, nome = COOKIE) {
  const achado = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${nome}=([^;]+)`));
  return achado ? achado[1] : '';
}

export function cookieDaSessao(valor, segura) {
  return `${COOKIE}=${valor}; Path=/lab; HttpOnly; SameSite=Lax; Max-Age=${HORAS_SESSAO * 3600}${segura ? '; Secure' : ''}`;
}
