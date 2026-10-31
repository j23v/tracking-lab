// Tracking Lab -- o Worker que roda na conta Cloudflare do cliente.
//
//   /saude              publica: a instalacao esta de pe? (sem nada sensivel)
//   /v.js, /visita      a pagina de vendas (src/pagina.js)
//   /w/<checkout>       o webhook de cada checkout, lido pelo PERFIL dele
//                       (src/checkouts/perfis.js; "outro" = perfil do cliente)
//   /lab, /lab/api/*    o Hub, atras da senha do cliente (SENHA_HUB)
//   /mcp/<segredo>      o conector da IA do cliente (src/mcp.js)
//   cron (10 min)       nova tentativa de envio, limpeza das visitas
//
// As acoes que o Hub e a IA fazem igual ficam em src/acoes.js.

import {
  analisar, confirmar, detectar, envios, estado, gravarMarca, gruposDaPagina, lerCorpo,
  perfilDe, qualidade, rodarTeste, salvarPerfilOutro, salvarSegredo,
} from './acoes.js';
import { autenticar, traduzir } from './checkouts/perfil.js';
import { EM_BREVE, PERFIS } from './checkouts/perfis.js';
import { alertar, gravarConfig, lerConfig, lerSegredo } from './config.js';
import { paginaEntrar, paginaSemSenha } from './hub.js';
import { paginaApp } from './hub/app.js';
import { respostaIcone, respostaLogo } from './hub/marca.js';
import { rotaChat } from './ia.js';
import { conectorAtivo, criarConector, rotaMcp } from './mcp.js';
import { formatoDoPayload, processarVenda, reenviarPendentes } from './motor.js';
import { limparVisitas, rotaDaVisita, scriptDaPagina } from './pagina.js';
import { CHECKOUT_INFO, RECEITAS_PAGINA } from './receitas.js';
import {
  COOKIE, cookieDaSessao, estadoDaSenha, lerCookie, novaSessao, senhaConfere, sessaoValida,
} from './sessao.js';

// ⚠️ Sem `export` aqui: o modulo principal do Worker so pode exportar handlers
// (o runtime recusa subir com uma constante exportada -- visto na F0).
const VERSAO = '0.5.1';
// A origem publica do Tracking Lab (versoes novas e a rotina de atualizacao).
const ORIGEM_REPO = 'j23v/tracking-lab';

const html = (corpo, status = 200, extra = {}) => new Response(corpo, {
  status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
});
const json = (dados, status = 200) => new Response(JSON.stringify(dados), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
// Respostas das acoes trazem o HTTP em `status`; ele nao vai no corpo.
const resp = ({ status = 200, ...dados }) => json(dados, status);

async function logado(request, env) {
  return sessaoValida(lerCookie(request, COOKIE), env.SENHA_HUB);
}

async function corpoJson(request) {
  try { return await request.json(); } catch { return null; }
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

async function rotaDaApi(caminho, request, env) {
  const metodo = request.method;
  const origem = new URL(request.url).origin;

  if (caminho === '/lab/api/status') return json(await estado(env, VERSAO));

  if (caminho === '/lab/api/config') {
    if (metodo === 'GET') return json({ config: await lerConfig(env) });
    if (metodo === 'POST') {
      const r = await gravarConfig(env, (await corpoJson(request)) || {});
      return json(r, r.ok ? 200 : 400);
    }
  }

  // Chave do Meta ou token do webhook -- digitados no Hub ou salvos pela IA.
  if (caminho === '/lab/api/segredo' && metodo === 'POST') {
    const { nome, valor } = (await corpoJson(request)) || {};
    return resp(await salvarSegredo(env, nome, valor));
  }

  // Os checkouts (perfis prontos com o nivel de confianca, o "outro") e as
  // receitas de cada etapa -- as mesmas que a IA le pelo conector.
  if (caminho === '/lab/api/perfis') {
    const cfg = await lerConfig(env);
    const descreve = (p) => ({
      id: p.id, nome: p.nome, nivel: p.nivel, webhook: `${origem}/w/${p.id}`, autenticacao: p.autenticacao,
      eventos: p.eventos, marca_links: p.pagina || null,
    });
    return json({
      prontos: Object.values(PERFIS).map(descreve),
      outro: cfg.perfil_outro ? descreve(cfg.perfil_outro) : null,
      em_breve: EM_BREVE,
      usados: cfg.checkouts,
      receitas: { pagina: RECEITAS_PAGINA, checkout: CHECKOUT_INFO },
    });
  }

  if (caminho === '/lab/api/analisar-exemplo' && metodo === 'POST') {
    const { exemplo, perfil } = (await corpoJson(request)) || {};
    return resp(await analisar(env, exemplo, perfil));
  }

  if (caminho === '/lab/api/perfil-outro' && metodo === 'POST') {
    const corpo = (await corpoJson(request)) || {};
    const r = await salvarPerfilOutro(env, corpo.perfil === undefined ? corpo : corpo.perfil);
    return json(r, r.ok ? 200 : 400);
  }

  if (caminho === '/lab/api/teste-controle' && metodo === 'POST') {
    const r = await rodarTeste(env);
    return json(r, r.casos ? 200 : 409);
  }

  if (caminho === '/lab/api/detectar' && metodo === 'POST') {
    const { url } = (await corpoJson(request)) || {};
    return resp(await detectar(env, url, origem));
  }

  if (caminho === '/lab/api/confirmar' && metodo === 'POST') {
    const { chave, valor } = (await corpoJson(request)) || {};
    const r = await confirmar(env, chave, valor);
    return json(r, r.ok ? 200 : 400);
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
    const r = await qualidade(env);
    return json(r, r.erro ? 409 : 200);
  }

  if (caminho === '/lab/api/envios') return json(await envios(env, new URL(request.url).searchParams.get('horas')));

  // O conector da IA: ver se existe e criar/trocar o endereco (o segredo so
  // aparece na criacao; criar de novo derruba o anterior).
  if (caminho === '/lab/api/conector') {
    if (metodo === 'GET') return json(await conectorAtivo(env));
    if (metodo === 'POST') return json(await criarConector(env, origem));
  }

  // A IA da casa (src/ia.js). Sem o binding `AI`, o Hub esconde o chat.
  if (caminho === '/lab/api/chat') {
    if (metodo === 'GET') return json({ disponivel: Boolean(env.AI) });
    if (metodo === 'POST') return resp(await rotaChat(env, await request.json().catch(() => null), { origem, versao: VERSAO }));
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
      const st = await estado(env, VERSAO);
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
    const mcp = caminho.match(/^\/mcp\/([0-9a-f]{32,64})$/);
    if (mcp) return rotaMcp(request, env, mcp[1], { versao: VERSAO });
    if (caminho === '/mcp') return json({ erro: 'use o endereço completo do conector, que aparece no Hub (Assistente)' }, 404);

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
