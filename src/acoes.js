// As acoes do Tracking Lab que o Hub (/lab/api/*) e o conector da IA (/mcp)
// fazem IGUAL: ler o estado, salvar a chave (conferida no Meta), detectar a
// pagina, rodar o teste com controle, ler a nota, montar o "outro checkout".
// Uma regra so para os dois caminhos.

import { analisarExemplo, traduzir, validarPerfil } from './checkouts/perfil.js';
import { PERFIS } from './checkouts/perfis.js';
import {
  gravarConfig, gravarSegredo, lerConfig, lerSegredo, segredoValido,
} from './config.js';
import { detectarPagina } from './deteccao.js';
import { GRAPH_VERSAO_PADRAO, conferirChave, lerQualidade } from './meta.js';
import { testeComControle } from './motor.js';
import { estadoDasEtapas } from './receitas.js';

export const TABELAS = ['alertas', 'config', 'envios', 'segredos', 'visitas'];

export async function gravarMarca(env, chave, valor) {
  await env.DB.prepare(
    `INSERT INTO config (chave, valor, quando) VALUES (?1, ?2, ?3)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, quando = excluded.quando`,
  ).bind(chave, typeof valor === 'string' ? valor : JSON.stringify(valor), Date.now()).run();
}

/** Tudo que o Hub mostra (sem segredo: so nome e dica; sem IP nem navegador das visitas). */
export async function estado(env, versao) {
  const st = {
    versao, banco: 'ok', tabelas: [], tabelasFaltando: [...TABELAS], ultimoCron: null,
    segredos: [], config: null, ultimoWebhook: null, envios24h: [], alertas: [],
    deteccao: null, ultimoTeste: null, visitas24h: null, etapas: [],
  };
  if (!env.DB) return { ...st, banco: 'sem_binding' };
  try {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    st.tabelas = results.map((r) => r.name).filter((n) => TABELAS.includes(n)).sort();
    st.tabelasFaltando = TABELAS.filter((t) => !st.tabelas.includes(t));
    if (st.tabelasFaltando.length) return st;
    const marca = async (k) => (await env.DB.prepare('SELECT valor FROM config WHERE chave = ?').bind(k).first())?.valor ?? null;
    const cron = await marca('ultimo_cron');
    st.ultimoCron = cron ? Number(cron) : null;
    const wh = await marca('ultimo_webhook');
    st.ultimoWebhook = wh ? JSON.parse(wh) : null;
    st.segredos = (await env.DB.prepare('SELECT nome, dica, quando FROM segredos ORDER BY nome').all()).results;
    st.config = await lerConfig(env);
    const desde = Date.now() - 24 * 3600 * 1000;
    st.envios24h = (await env.DB.prepare(
      'SELECT evento, status, teste, count(*) n FROM envios WHERE quando >= ? GROUP BY evento, status, teste ORDER BY evento, n DESC',
    ).bind(desde).all()).results;
    st.alertas = (await env.DB.prepare('SELECT tipo, quando, detalhe FROM alertas WHERE resolvido IS NULL ORDER BY quando DESC LIMIT 10').all()).results;
    const det = await marca('deteccao');
    st.deteccao = det ? JSON.parse(det) : null;
    const t = await marca('ultimo_teste');
    st.ultimoTeste = t ? JSON.parse(t) : null;
    st.visitas24h = await env.DB.prepare(
      'SELECT count(*) n, sum(fbc IS NOT NULL) fbc, sum(fbp IS NOT NULL) fbp, max(vista) ultima FROM visitas WHERE vista >= ?',
    ).bind(desde).first();
    st.etapas = estadoDasEtapas(st);
  } catch (erro) {
    st.banco = `erro: ${String(erro).slice(0, 120)}`;
  }
  return st;
}

/** O perfil de um checkout: um dos prontos, ou o "outro" que o cliente montou. */
export function perfilDe(id, cfg) {
  if (id === 'outro') return cfg?.perfil_outro || null;
  return PERFIS[id] || null;
}

/** Os links de checkout que o /v.js marca: todos os perfis prontos + o "outro". */
export function gruposDaPagina(cfg) {
  return [...Object.values(PERFIS).map((p) => p.pagina), cfg?.perfil_outro?.pagina].filter(Boolean);
}

/**
 * Corpo do webhook: JSON, ou formulario (algumas plataformas mandam
 * `customer[email]=...`), que vira objeto aninhado para os caminhos do perfil.
 */
export function lerCorpo(texto, tipo) {
  try { return JSON.parse(texto); } catch { /* tenta formulario */ }
  if (!/x-www-form-urlencoded/i.test(tipo || '') && !/^[\w[\].%-]+=/.test(texto)) return null;
  const obj = {};
  for (const [chave, valor] of new URLSearchParams(texto)) {
    const partes = chave.replace(/\]/g, '').split(/[[.]/).filter(Boolean);
    let atual = obj;
    partes.forEach((p, i) => {
      if (i === partes.length - 1) atual[p] = valor;
      else atual = (atual[p] = atual[p] && typeof atual[p] === 'object' ? atual[p] : {});
    });
  }
  return obj;
}

/** Amostra segura da venda lida (para conferir o perfil sem expor dado pessoal). */
export function vendaParaConferir(v) {
  const m = (s) => (s ? `${String(s).slice(0, 2)}…(${String(s).length})` : '');
  return {
    tipo: v.tipo, evento: v.evento, pedido: v.pedido, valor: v.valor, moeda: v.moeda, produtos: v.produtos,
    cliente: { email: m(v.cliente.email), telefone: m(v.cliente.telefone), nome: m(v.cliente.nome), cidade: v.cliente.cidade, estado: v.cliente.estado, cep: m(v.cliente.cep) },
    ip: v.ip ? 'sim' : '', src: v.src, fbp: v.cookies.fbp ? 'sim' : '', fbc: v.cookies.fbc || v.cookies.fbclid ? 'sim' : '', utm: v.utm,
    faltando: ['pedido', 'email'].filter((k) => (k === 'email' ? !v.cliente.email : !v[k])),
  };
}

const opcoesMeta = (env) => ({ versao: env.META_GRAPH_VERSAO || GRAPH_VERSAO_PADRAO, base: env.META_GRAPH_BASE });

/**
 * Guarda a chave do Meta ou o token de um checkout. A chave do Meta so e
 * gravada depois de conferida no Meta contra TODOS os pixels configurados.
 * Devolve { ok, status, ... } (status = o HTTP que o Hub responde).
 */
export async function salvarSegredo(env, nome, valor) {
  const v = String(valor || '').trim();
  if (!segredoValido(nome) || !v) return { ok: false, status: 400, erro: 'nome ou valor inválido' };
  if (nome === 'meta_token') {
    const cfg = await lerConfig(env);
    if (!cfg.pixels.length) return { ok: false, status: 409, erro: 'configure o pixel antes da chave' };
    for (const pixel of cfg.pixels) {
      const c = await conferirChave({ token: v, pixel, ...opcoesMeta(env) });
      if (!c.ok) return { ok: false, status: 422, pixel, motivo: c.motivo, detalhe: c.detalhe };
    }
  }
  const dica = await gravarSegredo(env, nome, v);
  // Chave nova: o que estava parado por chave invalida sai no proximo reenvio.
  if (nome === 'meta_token') await env.DB.prepare("UPDATE alertas SET resolvido = ? WHERE tipo = 'chave_invalida' AND resolvido IS NULL").bind(Date.now()).run();
  return { ok: true, status: 200, nome, dica };
}

/** "Suas plataformas": le a pagina de fora. Com URL, ela passa a ser a pagina de vendas. */
export async function detectar(env, url, origemDoWorker) {
  const cfg = await lerConfig(env);
  const alvo = String(url || cfg.dominio || '').trim();
  if (!alvo) return { ok: false, status: 400, erro: 'diga o endereço da página de vendas' };
  const r = await detectarPagina(alvo, origemDoWorker);
  if (r.quando) {
    await gravarMarca(env, 'deteccao', r);
    if (r.ok && (url || !cfg.dominio)) await gravarConfig(env, { dominio: r.url });
  }
  return { ...r, status: r.quando ? 200 : 422 };
}

export async function confirmar(env, chave, valor) {
  const cfg = await lerConfig(env);
  const r = await gravarConfig(env, { confirmacoes: { ...cfg.confirmacoes, [chave]: Boolean(valor) } });
  return r.ok ? { ok: true, confirmacoes: r.config.confirmacoes } : r;
}

export async function rodarTeste(env) {
  const r = await testeComControle(env);
  if (r.casos) await gravarMarca(env, 'ultimo_teste', { quando: Date.now(), ok: r.ok });
  return r;
}

export async function qualidade(env) {
  const cfg = await lerConfig(env);
  const token = await lerSegredo(env, 'meta_token');
  if (!cfg.pixels.length || !token) return { erro: 'falta o pixel ou a chave do Meta' };
  const porPixel = {};
  for (const pixel of cfg.pixels) porPixel[pixel] = await lerQualidade({ token, pixel, ...opcoesMeta(env) });
  return porPixel;
}

export async function envios(env, horas = 24) {
  const h = Math.min(Math.max(Number(horas) || 24, 1), 24 * 30);
  const desde = Date.now() - h * 3600 * 1000;
  const resumo = (await env.DB.prepare(
    'SELECT evento, status, teste, count(*) n FROM envios WHERE quando >= ? GROUP BY evento, status, teste',
  ).bind(desde).all()).results;
  // Sem dado pessoal: ids de pedido, campos (nomes), status e a resposta do Meta.
  const ultimos = (await env.DB.prepare(
    `SELECT pedido, evento, pixel, event_id, quando, status, visita, campos, resposta, teste, tentativas
     FROM envios WHERE quando >= ? ORDER BY quando DESC LIMIT 20`,
  ).bind(desde).all()).results;
  return { horas: h, resumo, ultimos };
}

/**
 * Monta o perfil do "outro checkout": campos do exemplo (amostras mascaradas),
 * sugestao e -- com um perfil -- como a venda seria lida. Sem exemplo, usa o
 * ultimo capturado em /w/outro (menos de 24 h).
 */
export async function analisar(env, exemplo, perfil) {
  let cru = typeof exemplo === 'string' ? lerCorpo(exemplo, '') : exemplo;
  let capturado = null;
  if (!cru) {
    const m = await env.DB.prepare("SELECT valor FROM config WHERE chave = 'exemplo_outro'").first();
    const ex = m ? JSON.parse(m.valor) : null;
    if (ex && Date.now() - ex.quando < 24 * 3600 * 1000) { cru = lerCorpo(ex.texto, ex.tipo); capturado = ex.quando; }
  }
  if (!cru || typeof cru !== 'object') return { status: 400, erro: 'cole o webhook de exemplo (JSON ou formulário) ou mande um para /w/outro?k=<segredo>' };
  const r = analisarExemplo(cru);
  let leitura = null;
  if (perfil) {
    const cfg = await lerConfig(env);
    let p = typeof perfil === 'string' ? perfilDe(perfil, cfg) : null;
    if (!p && typeof perfil === 'object') {
      try { p = validarPerfil(perfil); } catch (e) { return { ...r, status: 400, erro_perfil: e.message }; }
    }
    if (p) leitura = vendaParaConferir(traduzir(p, cru));
  }
  return { ...r, leitura, capturado, status: 200 };
}

export async function salvarPerfilOutro(env, perfil) {
  const r = await gravarConfig(env, { perfil_outro: perfil });
  if (r.ok) await env.DB.prepare("DELETE FROM config WHERE chave = 'exemplo_outro'").run();
  return r.ok ? { ok: true, perfil: r.config.perfil_outro } : r;
}
