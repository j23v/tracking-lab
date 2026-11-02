// A licenca: um codigo que so o Tracking Lab gera (assinado com a mesma chave
// das regras do dia), com o e-mail do comprador e o pedido. O Hub confere
// sozinho, sem consultar ninguem. Uma licenca vale para quantos perfis (pixels)
// a pessoa quiser ligar (decisao do dono, 02/11: sem licenca a mais por perfil).
// O campo `n` (perfis) segue no formato, sem uso, para nao mudar o codigo.
//
// Sem licenca valida: o Hub mostra so a tela de ativacao, a IA nao age e nada
// vai ao Meta (as vendas que chegarem ficam guardadas e saem depois de ativar,
// dentro dos 7 dias do Meta).
//
// Formato: TL1-<dados em base64url>.<assinatura em base64url>. A assinatura e
// sobre "tracking-lab-licenca:<dados>": assim uma assinatura de regras nunca
// serve como licenca, e vice-versa.

import { CHAVE_PUBLICA } from './regras.js';

const PREFIXO = 'tracking-lab-licenca:';
const deB64url = (s) => {
  const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const deB64 = (s) => Uint8Array.from(atob(String(s || '').trim()), (c) => c.charCodeAt(0));
const limparEmail = (e) => String(e || '').trim().toLowerCase();

/** O codigo -> { ok, email, pedido, perfis, emitida } ou { ok: false, motivo }. Nunca lanca. */
export async function lerLicenca(codigo, chavePublicaB64 = CHAVE_PUBLICA) {
  const m = String(codigo || '').trim().match(/^TL1-([A-Za-z0-9_-]{10,2000})\.([A-Za-z0-9_-]{40,200})$/);
  if (!m) return { ok: false, motivo: 'formato' };
  try {
    const chave = await crypto.subtle.importKey('raw', deB64(chavePublicaB64), { name: 'Ed25519' }, false, ['verify']);
    const confere = await crypto.subtle.verify({ name: 'Ed25519' }, chave, deB64url(m[2]), new TextEncoder().encode(PREFIXO + m[1]));
    if (!confere) return { ok: false, motivo: 'assinatura' };
    const d = JSON.parse(new TextDecoder().decode(deB64url(m[1])));
    const perfis = Number(d.n);
    if (d.v !== 1 || !/^[^@\s]+@[^@\s]+$/.test(d.e || '') || !Number.isInteger(perfis) || perfis < 1 || perfis > 50) {
      return { ok: false, motivo: 'dados' };
    }
    return { ok: true, email: limparEmail(d.e), pedido: String(d.p || '').slice(0, 80), perfis, emitida: String(d.d || '') };
  } catch {
    return { ok: false, motivo: 'formato' };
  }
}

const chaveDe = (env) => env.TL_CHAVE_TESTE || CHAVE_PUBLICA;

/** A licenca em vigor nesta instalacao, ou null. Confere a assinatura a cada leitura. */
export async function licencaAtiva(env) {
  try {
    const r = await env.DB.prepare("SELECT valor FROM config WHERE chave = 'licenca'").first();
    if (!r) return null;
    const l = await lerLicenca(JSON.parse(r.valor).codigo, chaveDe(env));
    return l.ok ? l : null;
  } catch {
    return null;
  }
}

/** Ativa (ou troca) a licenca: o e-mail digitado tem que ser o da licenca. */
export async function ativarLicenca(env, email, codigo) {
  const l = await lerLicenca(codigo, chaveDe(env));
  if (!l.ok) {
    return { ok: false, status: 400, erro: l.motivo === 'assinatura' ? 'Essa licença não foi emitida pelo Tracking Lab.' : 'Licença inválida: copie de novo, inteira, do e-mail da compra.' };
  }
  if (limparEmail(email) !== l.email) return { ok: false, status: 400, erro: 'O e-mail não é o desta licença. Use o e-mail da compra.' };
  await env.DB.prepare(
    `INSERT INTO config (chave, valor, quando) VALUES ('licenca', ?1, ?2)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, quando = excluded.quando`,
  ).bind(JSON.stringify({ codigo: String(codigo).trim(), ativada: Date.now() }), Date.now()).run();
  return { ok: true, status: 200, email: l.email };
}
