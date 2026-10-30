// Tracking Lab -- o Worker que roda na conta Cloudflare do cliente.
//
//   /saude              publica: a instalacao esta de pe? (sem nada sensivel)
//   /v.js, /visita      a pagina de vendas (src/pagina.js)
//   /w/<checkout>       o webhook de cada checkout, lido pelo PERFIL dele
//                       (src/checkouts/perfis.js; "outro" = perfil do cliente)
//   /lab, /lab/api/*    o Hub, atras da senha do cliente (SENHA_HUB)
//   cron (10 min)       nova tentativa de envio, limpeza das visitas
//
// F0 (instalacao pelo botao), F1 (o motor), F1b (qualquer checkout) e F2 (as
// telas do Hub: src/hub/app.html, que usa a API /lab/api/*).

import { analisarExemplo, autenticar, traduzir, validarPerfil } from './checkouts/perfil.js';
import { EM_BREVE, PERFIS } from './checkouts/perfis.js';
import {
  alertar, gravarConfig, gravarSegredo, lerConfig, lerSegredo, segredoValido,
} from './config.js';
import { detectarPagina } from './deteccao.js';
import { paginaEntrar, paginaSemSenha } from './hub.js';
import { paginaApp } from './hub/app.js';
import { respostaIcone, respostaLogo } from './hub/marca.js';
import { GRAPH_VERSAO_PADRAO, conferirChave, lerQualidade } from './meta.js';
import {
  formatoDoPayload, processarVenda, reenviarPendentes, testeComControle,
} from './motor.js';
import { limparVisitas, rotaDaVisita, scriptDaPagina } from './pagina.js';
import {
  COOKIE, cookieDaSessao, estadoDaSenha, lerCookie, novaSessao, senhaConfere, sessaoValida,
} from './sessao.js';

// ⚠️ Sem `export` aqui: o modulo principal do Worker so pode exportar handlers
// (o runtime recusa subir com uma constante exportada -- visto na F0).
const VERSAO = '0.3.2';
const TABELAS = ['alertas', 'config', 'envios', 'segredos', 'visitas'];
// A origem publica do Tracking Lab (versoes novas e a rotina de atualizacao).
const ORIGEM_REPO = 'j23v/tracking-lab';

const html = (corpo, status = 200, extra = {}) => new Response(corpo, {
  status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
});
const json = (dados, status = 200) => new Response(JSON.stringify(dados), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function gravarMarca(env, chave, valor) {
  await env.DB.prepare(
    `INSERT INTO config (chave, valor, quando) VALUES (?1, ?2, ?3)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, quando = excluded.quando`,
  ).bind(chave, typeof valor === 'string' ? valor : JSON.stringify(valor), Date.now()).run();
}

async function estado(env) {
  const st = {
    versao: VERSAO, banco: 'ok', tabelas: [], tabelasFaltando: [...TABELAS], ultimoCron: null,
    segredos: [], config: null, ultimoWebhook: null, envios24h: [], alertas: [],
    deteccao: null, ultimoTeste: null, visitas24h: null,
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
    // So o nome e a dica: o valor cifrado nunca sai daqui.
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
    // So contagens: a visita tem IP e navegador, que nao saem daqui.
    st.visitas24h = await env.DB.prepare(
      'SELECT count(*) n, sum(fbc IS NOT NULL) fbc, sum(fbp IS NOT NULL) fbp, max(vista) ultima FROM visitas WHERE vista >= ?',
    ).bind(desde).first();
  } catch (erro) {
    st.banco = `erro: ${String(erro).slice(0, 120)}`;
  }
  return st;
}

async function logado(request, env) {
  return sessaoValida(lerCookie(request, COOKIE), env.SENHA_HUB);
}

async function corpoJson(request) {
  try { return await request.json(); } catch { return null; }
}

/** O perfil de um checkout: um dos prontos, ou o "outro" que o cliente montou. */
function perfilDe(id, cfg) {
  if (id === 'outro') return cfg?.perfil_outro || null;
  return PERFIS[id] || null;
}

/** Os links de checkout que o /v.js marca: todos os perfis prontos + o "outro". */
function gruposDaPagina(cfg) {
  return [...Object.values(PERFIS).map((p) => p.pagina), cfg?.perfil_outro?.pagina].filter(Boolean);
}

/**
 * Corpo do webhook: JSON, ou formulario (algumas plataformas mandam
 * `customer[email]=...`), que vira objeto aninhado para os caminhos do perfil.
 */
function lerCorpo(texto, tipo) {
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

/** `POST /w/<checkout>`: autentica, responde rapido e processa em segundo plano. */
async function rotaDoWebhook(request, env, ctx, id) {
  const cfg = await lerConfig(env);
  const perfil = perfilDe(id, cfg);
  if (!perfil && id !== 'outro') return json({ erro: 'checkout desconhecido' }, 404);
  const texto = await request.text();
  if (texto.length > 200000) return json({ erro: 'corpo grande demais' }, 413);

  // "Outro checkout" ainda sem perfil: modo CAPTURA. Com o segredo certo na URL
  // (?k=), guarda o ULTIMO webhook (no banco do proprio cliente) para montar o
  // perfil a partir dele -- sem mandar dado de comprador a servico de terceiros.
  // Apagado ao salvar o perfil ou em 24 h. Nada vai ao Meta neste modo.
  if (!perfil) {
    const token = await lerSegredo(env, 'outro_token');
    if (!token) return json({ erro: 'monte o perfil do "outro checkout" no Hub (ou grave outro_token para capturar um exemplo)' }, 404);
    const k = new URL(request.url).searchParams.get('k') || '';
    if (!(await autenticar({ autenticacao: { tipo: 'cabecalho', query: ['k'] } }, request, texto, {}, token)).ok || !k) {
      return json({ erro: 'token invalido' }, 401);
    }
    await gravarMarca(env, 'exemplo_outro', { quando: Date.now(), tipo: request.headers.get('Content-Type') || '', texto: texto.slice(0, 20000) });
    return json({ ok: true, capturado: true }, 202);
  }
  const cru = lerCorpo(texto, request.headers.get('Content-Type'));
  const auth = await autenticar(perfil, request, texto, cru || {}, await lerSegredo(env, `${id}_token`));
  if (!auth.ok) {
    ctx.waitUntil(alertar(env, auth.onde === 'sem_token' ? 'webhook_sem_token' : 'webhook_token_errado', `${id}: ${auth.onde}`));
    return json({ erro: 'token invalido' }, 401);
  }
  if (!cru || typeof cru !== 'object') return json({ erro: 'corpo nao e JSON nem formulario' }, 400);
  const venda = traduzir(perfil, cru);
  const formato = formatoDoPayload(cru);
  ctx.waitUntil((async () => {
    await gravarMarca(env, 'ultimo_webhook', { quando: Date.now(), checkout: id, evento: venda.evento, tipo: venda.tipo, onde: auth.onde, formato });
    const r = await processarVenda(env, venda, formato);
    console.log(`Webhook ${id} ${venda.pedido} (${venda.evento}): ${JSON.stringify(r)}`);
  })());
  return json({ ok: true });
}

/** Amostra segura da venda lida (para conferir o perfil sem expor dado pessoal). */
function vendaParaConferir(v) {
  const m = (s) => (s ? `${String(s).slice(0, 2)}…(${String(s).length})` : '');
  return {
    tipo: v.tipo, evento: v.evento, pedido: v.pedido, valor: v.valor, moeda: v.moeda, produtos: v.produtos,
    cliente: { email: m(v.cliente.email), telefone: m(v.cliente.telefone), nome: m(v.cliente.nome), cidade: v.cliente.cidade, estado: v.cliente.estado, cep: m(v.cliente.cep) },
    ip: v.ip ? 'sim' : '', src: v.src, fbp: v.cookies.fbp ? 'sim' : '', fbc: v.cookies.fbc || v.cookies.fbclid ? 'sim' : '', utm: v.utm,
    faltando: ['pedido', 'email'].filter((k) => (k === 'email' ? !v.cliente.email : !v[k])),
  };
}

async function rotaDaApi(caminho, request, env) {
  const metodo = request.method;

  if (caminho === '/lab/api/status') return json(await estado(env));

  if (caminho === '/lab/api/config') {
    if (metodo === 'GET') return json({ config: await lerConfig(env) });
    if (metodo === 'POST') {
      const r = await gravarConfig(env, (await corpoJson(request)) || {});
      return json(r, r.ok ? 200 : 400);
    }
  }

  // Chave do Meta ou token do webhook -- digitados no Hub ou salvos pela IA do
  // cliente. A chave do Meta so e gravada depois de conferida no Meta contra
  // TODOS os pixels configurados.
  if (caminho === '/lab/api/segredo' && metodo === 'POST') {
    const { nome, valor } = (await corpoJson(request)) || {};
    if (!segredoValido(nome) || !String(valor || '').trim()) return json({ ok: false, erro: 'nome ou valor inválido' }, 400);
    if (nome === 'meta_token') {
      const cfg = await lerConfig(env);
      if (!cfg.pixels.length) return json({ ok: false, erro: 'configure o pixel antes da chave' }, 409);
      for (const pixel of cfg.pixels) {
        const c = await conferirChave({
          token: String(valor).trim(), pixel, versao: env.META_GRAPH_VERSAO || GRAPH_VERSAO_PADRAO, base: env.META_GRAPH_BASE,
        });
        if (!c.ok) return json({ ok: false, pixel, motivo: c.motivo, detalhe: c.detalhe }, 422);
      }
    }
    const d = await gravarSegredo(env, nome, valor);
    // Chave nova: o que estava parado por chave invalida ou sem configuracao sai agora.
    if (nome === 'meta_token') await env.DB.prepare("UPDATE alertas SET resolvido = ? WHERE tipo = 'chave_invalida' AND resolvido IS NULL").bind(Date.now()).run();
    return json({ ok: true, nome, dica: d });
  }

  // Os checkouts: perfis prontos (com o nivel de confianca), o "outro" e o que
  // o cliente precisa cadastrar em cada um.
  if (caminho === '/lab/api/perfis') {
    const cfg = await lerConfig(env);
    const origem = new URL(request.url).origin;
    const descreve = (p) => ({
      id: p.id, nome: p.nome, nivel: p.nivel, webhook: `${origem}/w/${p.id}`, autenticacao: p.autenticacao,
      eventos: p.eventos, marca_links: p.pagina || null,
    });
    return json({
      prontos: Object.values(PERFIS).map(descreve),
      outro: cfg.perfil_outro ? descreve(cfg.perfil_outro) : null,
      em_breve: EM_BREVE,
      usados: cfg.checkouts,
    });
  }

  // Monta o perfil do "outro checkout" a partir de um webhook de exemplo:
  // devolve os campos (amostras mascaradas), uma sugestao e -- se vier um perfil
  // (ou o id de um pronto) -- como a venda seria lida.
  if (caminho === '/lab/api/analisar-exemplo' && metodo === 'POST') {
    const { exemplo, perfil } = (await corpoJson(request)) || {};
    let cru = typeof exemplo === 'string' ? lerCorpo(exemplo, '') : exemplo;
    let capturado = null;
    if (!cru) {
      // Sem exemplo colado: usa o ultimo capturado em /w/outro (se tiver menos de 24 h).
      const m = await env.DB.prepare("SELECT valor FROM config WHERE chave = 'exemplo_outro'").first();
      const ex = m ? JSON.parse(m.valor) : null;
      if (ex && Date.now() - ex.quando < 24 * 3600 * 1000) { cru = lerCorpo(ex.texto, ex.tipo); capturado = ex.quando; }
    }
    if (!cru || typeof cru !== 'object') return json({ erro: 'cole o webhook de exemplo (JSON ou formulário) ou mande um para /w/outro?k=<segredo>' }, 400);
    const r = analisarExemplo(cru);
    let leitura = null;
    if (perfil) {
      const cfg = await lerConfig(env);
      let p = typeof perfil === 'string' ? perfilDe(perfil, cfg) : null;
      if (!p && typeof perfil === 'object') {
        try { p = validarPerfil(perfil); } catch (e) { return json({ ...r, erro_perfil: e.message }, 400); }
      }
      if (p) leitura = vendaParaConferir(traduzir(p, cru));
    }
    return json({ ...r, leitura, capturado });
  }

  if (caminho === '/lab/api/perfil-outro' && metodo === 'POST') {
    const corpo = (await corpoJson(request)) || {};
    const r = await gravarConfig(env, { perfil_outro: corpo.perfil === undefined ? corpo : corpo.perfil });
    if (r.ok) await env.DB.prepare("DELETE FROM config WHERE chave = 'exemplo_outro'").run();
    return json(r.ok ? { ok: true, perfil: r.config.perfil_outro } : r, r.ok ? 200 : 400);
  }

  if (caminho === '/lab/api/teste-controle' && metodo === 'POST') {
    const r = await testeComControle(env);
    if (r.casos) await gravarMarca(env, 'ultimo_teste', { quando: Date.now(), ok: r.ok });
    return json(r, r.casos ? 200 : 409);
  }

  // "Suas plataformas": le a pagina de vendas de fora. Sem URL, usa a pagina
  // configurada; com URL, ela passa a ser a pagina de vendas.
  if (caminho === '/lab/api/detectar' && metodo === 'POST') {
    const { url } = (await corpoJson(request)) || {};
    const cfg = await lerConfig(env);
    const alvo = String(url || cfg.dominio || '').trim();
    if (!alvo) return json({ ok: false, erro: 'diga o endereço da página de vendas' }, 400);
    const r = await detectarPagina(alvo, new URL(request.url).origin);
    if (r.quando) {
      await gravarMarca(env, 'deteccao', r);
      // A pagina que o cliente acabou de dizer passa a ser a pagina de vendas.
      if (r.ok && (url || !cfg.dominio)) await gravarConfig(env, { dominio: r.url });
    }
    return json(r, r.quando ? 200 : 422);
  }

  // O que so o cliente pode afirmar ("desliguei a Compra no checkout").
  if (caminho === '/lab/api/confirmar' && metodo === 'POST') {
    const { chave, valor } = (await corpoJson(request)) || {};
    const cfg = await lerConfig(env);
    const r = await gravarConfig(env, { confirmacoes: { ...cfg.confirmacoes, [chave]: Boolean(valor) } });
    return json(r.ok ? { ok: true, confirmacoes: r.config.confirmacoes } : r, r.ok ? 200 : 400);
  }

  // Versao instalada x a mais nova da origem, e a rotina de atualizacao (para o
  // link "instalar a rotina" no GitHub do cliente). So le arquivos publicos.
  if (caminho === '/lab/api/versao') {
    const bruto = (arq) => fetch(`https://raw.githubusercontent.com/${ORIGEM_REPO}/main/${arq}`, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.text() : '')).catch(() => '');
    const [pacote, rotina] = await Promise.all([bruto('package.json'), bruto('.github/workflows/atualizar.yml')]);
    let ultima = '';
    try { ultima = JSON.parse(pacote).version || ''; } catch { /* sem rede: fica vazio */ }
    return json({ instalada: VERSAO, ultima, origem: ORIGEM_REPO, rotina });
  }

  if (caminho === '/lab/api/reenviar' && metodo === 'POST') return json(await reenviarPendentes(env));

  if (caminho === '/lab/api/qualidade') {
    const cfg = await lerConfig(env);
    const token = await lerSegredo(env, 'meta_token');
    if (!cfg.pixels.length || !token) return json({ erro: 'falta o pixel ou a chave do Meta' }, 409);
    const porPixel = {};
    for (const pixel of cfg.pixels) {
      porPixel[pixel] = await lerQualidade({ token, pixel, versao: env.META_GRAPH_VERSAO || GRAPH_VERSAO_PADRAO, base: env.META_GRAPH_BASE });
    }
    return json(porPixel);
  }

  if (caminho === '/lab/api/envios') {
    const horas = Math.min(Math.max(Number(new URL(request.url).searchParams.get('horas')) || 24, 1), 24 * 30);
    const desde = Date.now() - horas * 3600 * 1000;
    const resumo = (await env.DB.prepare(
      'SELECT evento, status, teste, count(*) n FROM envios WHERE quando >= ? GROUP BY evento, status, teste',
    ).bind(desde).all()).results;
    // Sem dado pessoal: ids de pedido, campos (nomes), status e a resposta do Meta.
    const ultimos = (await env.DB.prepare(
      `SELECT pedido, evento, pixel, event_id, quando, status, visita, campos, resposta, teste, tentativas
       FROM envios WHERE quando >= ? ORDER BY quando DESC LIMIT 20`,
    ).bind(desde).all()).results;
    return json({ horas, resumo, ultimos });
  }

  return json({ erro: 'nao encontrado' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const caminho = url.pathname.replace(/\/+$/, '') || '/';
    const segura = url.protocol === 'https:';

    // Saude: publica, sem nada sensivel. E o que a IA do cliente (ou o nosso
    // suporte) le para saber se a instalacao deu certo.
    if (caminho === '/saude') {
      const st = await estado(env);
      return json({
        ok: st.banco === 'ok' && st.tabelasFaltando.length === 0 && estadoDaSenha(env.SENHA_HUB) === 'ok',
        versao: VERSAO, banco: st.banco, tabelas_faltando: st.tabelasFaltando,
        senha: estadoDaSenha(env.SENHA_HUB), ultimo_cron: st.ultimoCron,
      });
    }

    if (caminho === '/lab/logo.webp') return respostaLogo();
    if (caminho === '/favicon.png' || caminho === '/favicon.ico') return respostaIcone();

    if (caminho === '/v.js' && (request.method === 'GET' || request.method === 'HEAD')) {
      // Sem o banco (instalacao pela metade), marca ao menos os checkouts prontos.
      const cfg = await lerConfig(env).catch(() => null);
      return scriptDaPagina(url.origin, gruposDaPagina(cfg));
    }
    if (caminho === '/visita' && (request.method === 'POST' || request.method === 'OPTIONS')) {
      return rotaDaVisita(request, env);
    }
    const wh = caminho.match(/^\/w\/([a-z]+)$/);
    if (wh && request.method === 'POST') {
      return rotaDoWebhook(request, env, ctx, wh[1]);
    }

    if (caminho === '/') return Response.redirect(new URL('/lab', url).toString(), 302);

    if (caminho === '/lab' || caminho.startsWith('/lab/')) {
      const senha = estadoDaSenha(env.SENHA_HUB);
      if (senha !== 'ok') return html(paginaSemSenha(senha), 503);

      if (caminho === '/lab/entrar' && request.method === 'POST') {
        const form = await request.formData().catch(() => null);
        if (!(await senhaConfere(form?.get('senha'), env.SENHA_HUB))) {
          // Atraso fixo: tentar senha no chute fica caro.
          await new Promise((r) => setTimeout(r, 600));
          return html(paginaEntrar({ erro: 'Senha errada. É a que você criou na tela da Cloudflare.' }), 401);
        }
        return new Response(null, {
          status: 303,
          headers: { Location: '/lab', 'Set-Cookie': cookieDaSessao(await novaSessao(env.SENHA_HUB), segura) },
        });
      }
      if (caminho === '/lab/sair' && request.method === 'POST') {
        return new Response(null, { status: 303, headers: { Location: '/lab', 'Set-Cookie': cookieDaSessao('', segura).replace(/Max-Age=\d+/, 'Max-Age=0') } });
      }

      if (!(await logado(request, env))) {
        return caminho.startsWith('/lab/api/') ? json({ erro: 'entre no Hub primeiro' }, 401) : html(paginaEntrar());
      }
      if (caminho.startsWith('/lab/api/')) {
        try {
          return await rotaDaApi(caminho, request, env);
        } catch (erro) {
          console.error(`API ${caminho}: ${erro}`);
          return json({ erro: 'falha interna' }, 500);
        }
      }
      if (caminho === '/lab') return html(paginaApp({ origem: url.origin, versao: VERSAO }));
      return html(paginaEntrar({ erro: 'Página não encontrada.' }), 404);
    }

    return json({ erro: 'nao encontrado' }, 404);
  },

  async scheduled(evento, env) {
    if (!env.DB) return;
    await gravarMarca(env, 'ultimo_cron', String(Date.now()));
    // O exemplo capturado do "outro checkout" tem dado de comprador: nao passa de 24 h.
    await env.DB.prepare("DELETE FROM config WHERE chave = 'exemplo_outro' AND quando < ?").bind(Date.now() - 24 * 3600 * 1000).run();
    const reenvio = await reenviarPendentes(env);
    const visitas = await limparVisitas(env);
    console.log(`Cron: reenvio ${JSON.stringify(reenvio)} visitas ${JSON.stringify(visitas)}`);
  },
};
