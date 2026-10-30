// Tracking Lab -- F0, a prova do botao "Deploy to Cloudflare".
//
// So o esqueleto que o botao precisa provar:
//   - o banco D1 criado pelo botao, com as tabelas da migracao;
//   - a senha do Hub (SENHA_HUB) pedida pela tela do botao;
//   - o login do Hub e um painel que confere a instalacao;
//   - o cron de 10 minutos;
//   - o cofre dos segredos (src/cofre.js).
// O motor (Compra ao Meta) entra na F1; as etapas do Hub, na F2.

import { paginaEntrar, paginaPainel, paginaSemSenha } from './hub.js';
import {
  COOKIE, cookieDaSessao, estadoDaSenha, lerCookie, novaSessao, senhaConfere, sessaoValida,
} from './sessao.js';

// ⚠️ Sem `export` aqui: o modulo principal do Worker so pode exportar handlers
// (o runtime recusa subir com uma constante exportada -- visto na F0).
const VERSAO = '0.0.1';
const TABELAS = ['alertas', 'config', 'envios', 'segredos', 'visitas'];

const html = (corpo, status = 200, extra = {}) => new Response(corpo, {
  status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
});
const json = (dados, status = 200) => new Response(JSON.stringify(dados), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function estado(env) {
  const st = { versao: VERSAO, banco: 'ok', tabelas: [], tabelasFaltando: [...TABELAS], ultimoCron: null, segredos: [] };
  if (!env.DB) return { ...st, banco: 'sem_binding' };
  try {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    st.tabelas = results.map((r) => r.name).filter((n) => TABELAS.includes(n)).sort();
    st.tabelasFaltando = TABELAS.filter((t) => !st.tabelas.includes(t));
    if (!st.tabelasFaltando.includes('config')) {
      const c = await env.DB.prepare("SELECT valor FROM config WHERE chave = 'ultimo_cron'").first();
      st.ultimoCron = c ? Number(c.valor) : null;
    }
    if (!st.tabelasFaltando.includes('segredos')) {
      // So o nome e a dica: o valor cifrado nunca sai daqui.
      const { results: s } = await env.DB.prepare('SELECT nome, dica FROM segredos ORDER BY nome').all();
      st.segredos = s;
    }
  } catch (erro) {
    st.banco = `erro: ${String(erro).slice(0, 120)}`;
  }
  return st;
}

async function logado(request, env) {
  return sessaoValida(lerCookie(request, COOKIE), env.SENHA_HUB);
}

export default {
  async fetch(request, env) {
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
      if (caminho === '/lab/api/status') return json(await estado(env));
      if (caminho === '/lab') return html(paginaPainel(await estado(env)));
      return html(paginaEntrar({ erro: 'Página não encontrada.' }), 404);
    }

    return json({ erro: 'nao encontrado' }, 404);
  },

  async scheduled(evento, env) {
    // F0: so prova que o cron roda. Na F1 entram: nova tentativa de envio,
    // limpeza das visitas (30 dias), regras do dia e conferencias.
    if (!env.DB) return;
    await env.DB.prepare(
      `INSERT INTO config (chave, valor, quando) VALUES ('ultimo_cron', ?1, ?1)
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, quando = excluded.quando`,
    ).bind(String(Date.now())).run();
  },
};
