// Tracking Lab -- o Worker que roda na conta Cloudflare do cliente.
//
//   /saude              publica: a instalacao esta de pe? (sem nada sensivel)
//   /v.js, /visita      a pagina de vendas (src/pagina.js)
//   /w/kirvano          o webhook do checkout (src/checkouts/kirvano.js -> src/motor.js)
//   /lab, /lab/api/*    o Hub, atras da senha do cliente (SENHA_HUB)
//   cron (10 min)       nova tentativa de envio, limpeza das visitas
//
// F0 (instalacao pelo botao) e F1 (o motor). As telas das etapas do Hub sao a F2:
// por enquanto o painel mostra o estado e a API ja faz tudo.

import * as kirvano from './checkouts/kirvano.js';
import {
  SEGREDOS, alertar, gravarConfig, gravarSegredo, lerConfig, lerSegredo,
} from './config.js';
import { paginaEntrar, paginaPainel, paginaSemSenha } from './hub.js';
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
const VERSAO = '0.1.0';
const TABELAS = ['alertas', 'config', 'envios', 'segredos', 'visitas'];

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

const ADAPTADORES = { kirvano };

/** `POST /w/<checkout>`: autentica, responde rapido e processa em segundo plano. */
async function rotaDoWebhook(request, env, ctx, adaptador) {
  const auth = adaptador.autenticar(request, await lerSegredo(env, `${adaptador.nome}_token`));
  if (!auth.ok) {
    ctx.waitUntil(alertar(env, auth.onde === 'sem_token' ? 'webhook_sem_token' : 'webhook_token_errado',
      `${adaptador.nome}: ${auth.onde}`));
    return json({ erro: 'token invalido' }, 401);
  }
  let cru;
  try { cru = JSON.parse(await request.text()); } catch { return json({ erro: 'corpo nao e JSON' }, 400); }
  const venda = adaptador.traduzir(cru);
  const formato = formatoDoPayload(cru);
  ctx.waitUntil((async () => {
    await gravarMarca(env, 'ultimo_webhook', { quando: Date.now(), checkout: adaptador.nome, evento: venda.evento, onde: auth.onde, formato });
    const r = await processarVenda(env, venda, formato);
    console.log(`Webhook ${adaptador.nome} ${venda.pedido} (${venda.evento}): ${JSON.stringify(r)}`);
  })());
  return json({ ok: true });
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
    if (!SEGREDOS.includes(nome) || !String(valor || '').trim()) return json({ ok: false, erro: 'nome ou valor inválido' }, 400);
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

  if (caminho === '/lab/api/teste-controle' && metodo === 'POST') {
    const r = await testeComControle(env);
    return json(r, r.casos ? 200 : 409);
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

    if (caminho === '/v.js' && (request.method === 'GET' || request.method === 'HEAD')) {
      return scriptDaPagina(url.origin, kirvano);
    }
    if (caminho === '/visita' && (request.method === 'POST' || request.method === 'OPTIONS')) {
      return rotaDaVisita(request, env);
    }
    const wh = caminho.match(/^\/w\/([a-z]+)$/);
    if (wh && request.method === 'POST') {
      const adaptador = ADAPTADORES[wh[1]];
      if (!adaptador) return json({ erro: 'checkout desconhecido' }, 404);
      return rotaDoWebhook(request, env, ctx, adaptador);
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
      if (caminho === '/lab') return html(paginaPainel(await estado(env), url.origin));
      return html(paginaEntrar({ erro: 'Página não encontrada.' }), 404);
    }

    return json({ erro: 'nao encontrado' }, 404);
  },

  async scheduled(evento, env) {
    if (!env.DB) return;
    await gravarMarca(env, 'ultimo_cron', String(Date.now()));
    const reenvio = await reenviarPendentes(env);
    const visitas = await limparVisitas(env);
    console.log(`Cron: reenvio ${JSON.stringify(reenvio)} visitas ${JSON.stringify(visitas)}`);
  },
};
