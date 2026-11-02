// As regras do dia: um arquivo PUBLICO nosso (regras/regras.json na origem),
// assinado, so com DADOS e nunca com codigo:
//   - a versao da API do Meta;
//   - ajustes nos caminhos dos campos dos checkouts prontos (nunca na autenticacao);
//   - avisos curtos para o Painel.
//
// O Worker do cliente le 1x por dia (src/alertas.js, conferencia diaria) e
// confere a nossa assinatura. Assinatura errada, arquivo quebrado ou regra
// invalida: fica com o que ja tinha. O cliente pode desligar e voltar ao que
// veio no codigo (etapa Atualizacoes).

import { ajustarPerfil } from './checkouts/perfil.js';
import { PERFIS } from './checkouts/perfis.js';
import { GRAPH_VERSAO_PADRAO } from './meta.js';

// A chave PUBLICA da assinatura (a privada fica so com o Tracking Lab).
export const CHAVE_PUBLICA = 'sRp6dYm0exBrkaIntxSn7yKRZxLfGYpnDvGOKWjgYL0=';

const bytes = (b64) => Uint8Array.from(atob(String(b64 || '').trim()), (c) => c.charCodeAt(0));
/** O Git pode trocar "\n" por "\r\n": a assinatura vale para o texto com "\n". */
const normalizar = (t) => String(t).replace(/\r\n/g, '\n');

/** A assinatura Ed25519 confere? Nunca lanca. */
export async function conferirAssinatura(texto, assinaturaB64, chavePublicaB64 = CHAVE_PUBLICA) {
  try {
    const chave = await crypto.subtle.importKey('raw', bytes(chavePublicaB64), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, chave, bytes(assinaturaB64), new TextEncoder().encode(normalizar(texto)));
  } catch {
    return false;
  }
}

/** Confere o formato. Devolve { ok, regras } ou { ok: false, erro }. */
export function validarRegras(d) {
  const erro = (e) => ({ ok: false, erro: e });
  if (!d || typeof d !== 'object' || d.formato !== 1) return erro('formato desconhecido');
  const versao = String(d.versao || '');
  if (!/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/.test(versao)) return erro('versao: AAAA-MM-DD.n');
  const r = { formato: 1, versao, perfis: {}, avisos: [] };
  if (d.meta_graph_versao !== undefined) {
    const m = String(d.meta_graph_versao).match(/^v(\d{2})\.0$/);
    if (!m || Number(m[1]) < 20 || Number(m[1]) > 40) return erro('meta_graph_versao: vNN.0');
    r.meta_graph_versao = `v${m[1]}.0`;
  }
  for (const [id, ajuste] of Object.entries(d.perfis || {})) {
    if (!PERFIS[id]) return erro(`perfis.${id}: checkout desconhecido`);
    try { ajustarPerfil(PERFIS[id], ajuste); } catch (e) { return erro(`perfis.${id}: ${e.message}`); }
    r.perfis[id] = ajuste;
  }
  const avisos = Array.isArray(d.avisos) ? d.avisos : [];
  if (avisos.length > 5) return erro('avisos: no máximo 5');
  for (const a of avisos) {
    const texto = String(a?.texto || '').trim();
    if (!texto || texto.length > 300) return erro('avisos: texto de 1 a 300 caracteres');
    if (a.ate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(a.ate))) return erro('avisos.ate: AAAA-MM-DD');
    r.avisos.push({ texto, ...(a.ate ? { ate: String(a.ate) } : {}) });
  }
  return { ok: true, regras: r };
}

/** Busca, confere a assinatura e valida. Nunca lanca. */
export async function buscarRegras(env, repo, buscar = fetch) {
  const base = String(env.TL_ORIGEM_RAW || 'https://raw.githubusercontent.com').replace(/\/$/, '');
  const url = `${base}/${repo}/main/regras/regras.json`;
  try {
    const [r, s] = await Promise.all([url, `${url}.sig`].map((u) => buscar(u, { signal: AbortSignal.timeout(8000) })));
    if (!r.ok || !s.ok) return { ok: false, motivo: 'sem_arquivo' };
    const [texto, sig] = await Promise.all([r.text(), s.text()]);
    // A chave de teste so existe na suite; no cliente vale a do codigo.
    if (!(await conferirAssinatura(texto, sig, env.TL_REGRAS_CHAVE || CHAVE_PUBLICA))) return { ok: false, motivo: 'assinatura' };
    let dados;
    try { dados = JSON.parse(normalizar(texto)); } catch { return { ok: false, motivo: 'json' }; }
    const v = validarRegras(dados);
    return v.ok ? { ok: true, regras: v.regras } : { ok: false, motivo: `invalida: ${v.erro}` };
  } catch (erro) {
    return { ok: false, motivo: `rede: ${String(erro.message || erro).slice(0, 80)}` };
  }
}

async function marca(env, chave) {
  const r = await env.DB.prepare('SELECT valor FROM config WHERE chave = ?').bind(chave).first();
  if (!r) return null;
  try { return JSON.parse(r.valor); } catch { return null; }
}
async function gravar(env, chave, valor) {
  await env.DB.prepare(
    `INSERT INTO config (chave, valor, quando) VALUES (?1, ?2, ?3)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, quando = excluded.quando`,
  ).bind(chave, JSON.stringify(valor), Date.now()).run();
}

/** A leitura de 1x por dia: guarda as regras boas; com problema, fica com as anteriores. */
export async function atualizarRegras(env, repo, buscar = fetch) {
  const r = await buscarRegras(env, repo, buscar);
  if (r.ok) await gravar(env, 'regras', r.regras);
  await gravar(env, 'regras_leitura', { quando: Date.now(), ok: r.ok, motivo: r.ok ? '' : r.motivo });
  return r;
}

/** As regras em vigor, ou null (nunca lidas, ou o cliente desligou). */
export async function lerRegras(env) {
  try {
    if ((await marca(env, 'regras_ligadas')) === false) return null;
    return await marca(env, 'regras');
  } catch {
    return null;
  }
}

/** O cliente liga ou desliga as regras do dia (desligadas: vale o que veio no codigo). */
export async function ligarRegras(env, ligadas) {
  await gravar(env, 'regras_ligadas', Boolean(ligadas));
  return { ok: true, status: 200, ligadas: Boolean(ligadas) };
}

/** O que o Hub mostra na etapa Atualizacoes e no Painel. */
export async function estadoDasRegras(env, agora = Date.now()) {
  const ligadas = (await marca(env, 'regras_ligadas')) !== false;
  const regras = await marca(env, 'regras');
  const leitura = await marca(env, 'regras_leitura');
  const hoje = new Date(agora).toISOString().slice(0, 10);
  return {
    ligadas, versao: regras?.versao || null, leitura,
    meta: versaoMeta({}, ligadas ? regras : null),
    checkouts_ajustados: ligadas && regras ? Object.keys(regras.perfis || {}) : [],
    avisos: ligadas && regras ? (regras.avisos || []).filter((a) => !a.ate || a.ate >= hoje) : [],
  };
}

/** A versao da API do Meta: a do ambiente (so testes) > a das regras > a do codigo. */
export function versaoMeta(env, regras) {
  return String(env?.META_GRAPH_VERSAO || regras?.meta_graph_versao || GRAPH_VERSAO_PADRAO);
}

/** Um perfil pronto com o ajuste das regras (se houver e for valido). */
export function perfilComRegras(id, regras) {
  const base = PERFIS[id];
  const ajuste = regras?.perfis?.[id];
  if (!base || !ajuste) return base || null;
  try { return ajustarPerfil(base, ajuste); } catch { return base; }
}
