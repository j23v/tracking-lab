// A configuracao do cliente (preenchida no Hub, guardada no D1, fora do codigo:
// atualizar nunca apaga) e os segredos (chave do Meta, token do webhook), estes
// cifrados pelo cofre.

import { validarPerfil } from './checkouts/perfil.js';
import { PERFIS } from './checkouts/perfis.js';
import { cifrar, decifrar, dica } from './cofre.js';

export const PADRAO = {
  pixels: [],          // ids dos pixels (conjuntos de dados) que recebem a Compra
  dominio: '',         // https://pagina-de-vendas -- vira o event_source_url sem visita
  checkouts: [],       // os que o cliente usa (o Hub mostra so esses); webhooks de todos ficam abertos
  perfil_outro: null,  // o perfil montado pelo cliente para um checkout sem perfil pronto
  produtos: [],        // nomes aceitos; vazio = todos os produtos do webhook
  pais: 'br',
  moeda: 'BRL',
  codigo_teste: '',    // TEST... do Gerenciador: preenchido = tudo vai como TESTE
  repositorio: '',     // usuario/repo da copia no GitHub (para o link da rotina de atualizacao)
  confirmacoes: {},    // o que so o cliente pode afirmar: { dup_checkout: true, privacidade: true, ... }
};

// As confirmacoes que o Hub pede (o resto e conferido sozinho).
export const CONFIRMACOES = ['dup_checkout', 'dup_ferramentas', 'privacidade', 'reembolso', 'rotina'];

export const IDS_DE_CHECKOUT = [...Object.keys(PERFIS), 'outro'];

/** meta_token, ou o token do webhook de um checkout: `<id>_token`. */
export function segredoValido(nome) {
  return nome === 'meta_token' || IDS_DE_CHECKOUT.some((id) => nome === `${id}_token`);
}

/** Valida e limpa; devolve { ok, config } ou { ok: false, erro }. */
export function validarConfig(parcial) {
  const c = {};
  const erro = (e) => ({ ok: false, erro: e });
  if ('pixels' in parcial) {
    const lista = (Array.isArray(parcial.pixels) ? parcial.pixels : [parcial.pixels])
      .map((p) => String(p ?? '').trim()).filter(Boolean);
    if (lista.some((p) => !/^\d{6,20}$/.test(p))) return erro('pixel: só números (o ID do conjunto de dados)');
    c.pixels = [...new Set(lista)];
  }
  if ('dominio' in parcial) {
    const d = String(parcial.dominio || '').trim();
    if (d) {
      let u;
      try { u = new URL(/^https?:\/\//.test(d) ? d : `https://${d}`); } catch { return erro('domínio inválido'); }
      // A pagina INTEIRA (sem ?query e #): a venda pode estar em /oferta, e a
      // conferencia da pagina tem que olhar ali, nao na raiz do site.
      c.dominio = `${u.protocol}//${u.host}${u.pathname}`;
    } else c.dominio = '';
  }
  // `checkout` (um so) e o nome antigo, da 0.1.0.
  if ('checkouts' in parcial || 'checkout' in parcial) {
    const l = [...new Set((Array.isArray(parcial.checkouts) ? parcial.checkouts : [parcial.checkouts ?? parcial.checkout])
      .map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean))];
    const ruim = l.find((x) => !IDS_DE_CHECKOUT.includes(x));
    if (ruim) return erro(`checkout desconhecido: "${ruim}" (use ${IDS_DE_CHECKOUT.join(', ')})`);
    c.checkouts = l;
  }
  if ('perfil_outro' in parcial) {
    if (parcial.perfil_outro === null) c.perfil_outro = null;
    else {
      try { c.perfil_outro = validarPerfil(parcial.perfil_outro); } catch (e) { return erro(`perfil: ${e.message}`); }
    }
  }
  if ('produtos' in parcial) {
    c.produtos = (Array.isArray(parcial.produtos) ? parcial.produtos : [parcial.produtos])
      .map((p) => String(p ?? '').trim()).filter(Boolean).slice(0, 50);
  }
  if ('pais' in parcial) {
    const p = String(parcial.pais || '').trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(p)) return erro('país: duas letras (ex.: br)');
    c.pais = p;
  }
  if ('moeda' in parcial) {
    const m = String(parcial.moeda || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(m)) return erro('moeda: três letras (ex.: BRL)');
    c.moeda = m;
  }
  if ('repositorio' in parcial) {
    const r = String(parcial.repositorio || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$|\/$/g, '');
    if (r && !/^[\w.-]{1,39}\/[\w.-]{1,100}$/.test(r)) return erro('repositório: usuario/nome (ex.: ana-loja/tracking-lab)');
    c.repositorio = r;
  }
  if ('confirmacoes' in parcial) {
    const o = parcial.confirmacoes && typeof parcial.confirmacoes === 'object' ? parcial.confirmacoes : {};
    c.confirmacoes = Object.fromEntries(CONFIRMACOES.filter((k) => k in o).map((k) => [k, Boolean(o[k])]));
  }
  if ('codigo_teste' in parcial) {
    const t = String(parcial.codigo_teste || '').trim();
    if (t && !/^TEST\w{1,40}$/.test(t)) return erro('código de teste começa com TEST');
    c.codigo_teste = t;
  }
  return { ok: true, config: c };
}

export async function lerConfig(env) {
  const cfg = { ...PADRAO };
  const { results } = await env.DB.prepare(
    `SELECT chave, valor FROM config WHERE chave IN (${Object.keys(PADRAO).map(() => '?').join(',')})`,
  ).bind(...Object.keys(PADRAO)).all();
  for (const r of results) {
    try { cfg[r.chave] = JSON.parse(r.valor); } catch { /* valor estranho: fica o padrao */ }
  }
  // 0.1.0 gravava `checkout` (um so).
  if (!cfg.checkouts.length) {
    const antigo = await env.DB.prepare("SELECT valor FROM config WHERE chave = 'checkout'").first();
    if (antigo) try { cfg.checkouts = [JSON.parse(antigo.valor)]; } catch { /* ignora */ }
  }
  return cfg;
}

export async function gravarConfig(env, parcial) {
  const v = validarConfig(parcial || {});
  if (!v.ok) return v;
  const agora = Date.now();
  const linhas = Object.entries(v.config).map(([k, val]) => env.DB.prepare(
    `INSERT INTO config (chave, valor, quando) VALUES (?1, ?2, ?3)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, quando = excluded.quando`,
  ).bind(k, JSON.stringify(val), agora));
  if (linhas.length) await env.DB.batch(linhas);
  return { ok: true, config: await lerConfig(env) };
}

export async function gravarSegredo(env, nome, valor) {
  if (!segredoValido(nome)) throw new Error(`segredo desconhecido: ${nome}`);
  const limpo = String(valor || '').trim();
  await env.DB.prepare(
    `INSERT INTO segredos (nome, cifrado, dica, quando) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(nome) DO UPDATE SET cifrado = excluded.cifrado, dica = excluded.dica, quando = excluded.quando`,
  ).bind(nome, await cifrar(limpo, env.SENHA_HUB), dica(limpo), Date.now()).run();
  return dica(limpo);
}

/** O valor em claro, ou '' se nao houver (ou se a senha do Hub mudou sem recifrar). */
export async function lerSegredo(env, nome) {
  const r = await env.DB.prepare('SELECT cifrado FROM segredos WHERE nome = ?').bind(nome).first();
  if (!r) return '';
  try { return await decifrar(r.cifrado, env.SENHA_HUB); } catch { return ''; }
}

/** Um alerta por tipo a cada 24 h, no maximo (um robo na rota nao enche a tabela). */
export async function alertar(env, tipo, detalhe = '') {
  try {
    const dia = Date.now() - 24 * 3600 * 1000;
    const ja = await env.DB.prepare('SELECT id FROM alertas WHERE tipo = ? AND quando > ? AND resolvido IS NULL')
      .bind(tipo, dia).first();
    if (ja) return;
    await env.DB.prepare('INSERT INTO alertas (tipo, quando, detalhe) VALUES (?, ?, ?)')
      .bind(tipo, Date.now(), String(detalhe).slice(0, 400)).run();
  } catch (erro) {
    console.error(`alerta ${tipo} nao gravado: ${erro}`);
  }
}
