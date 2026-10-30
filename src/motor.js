// O motor: venda normalizada -> evento -> cada pixel configurado, com registro
// de tudo em `envios` e nova tentativa pelo cron.
//
// ⚠️ Nada aqui lanca para fora: o webhook ja respondeu 200 ao checkout, e o
// resultado de cada venda fica em `envios` (e e isso que o Hub mostra).
//
// Diferenca para a primeira versao (em producao desde 28/10/2026): venda que
// chega SEM pixel ou chave configurados nao se perde mais -- fica guardada (ja
// com hash) e sai quando a configuracao chegar, dentro dos 7 dias do Meta.

import { alertar, lerConfig, lerSegredo } from './config.js';
import { GRAPH_VERSAO_PADRAO, enviarEvento, montarEvento } from './meta.js';

const SETE_DIAS = 7 * 24 * 3600;
// Margem: o Meta recusa evento com mais de 7 dias; tenta so ate 6 dias e meio.
const LIMITE_REENVIO = SETE_DIAS - 12 * 3600;
const MAX_TENTATIVAS = 12;
const REENVIAVEIS = ['falhou', 'chave_invalida', 'sem_config'];

/** O mesmo produto, sem diferenca de maiusculas/espacos. Vazio nunca casa. */
export function mesmoProduto(a, b) {
  const limpa = (s) => String(s || '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  const x = limpa(a);
  const y = limpa(b);
  return Boolean(x && y && x === y);
}

/**
 * Os NOMES dos campos do payload, nunca os valores -- confirma o formato do
 * webhook sem guardar dado pessoal (e e o que avisa "o checkout mudou").
 */
export function formatoDoPayload(p) {
  const chaves = (o, nivel) => Object.keys(o || {}).sort().map((k) => {
    const v = o[k];
    if (Array.isArray(v)) {
      const dentro = v[0] && typeof v[0] === 'object' ? Object.keys(v[0]).sort().join(',') : '';
      return `${k}[${dentro}]`;
    }
    if (v && typeof v === 'object') return nivel < 2 ? `${k}{${chaves(v, nivel + 1)}}` : `${k}{${Object.keys(v).sort().join(',')}}`;
    return k;
  }).join(nivel === 1 ? ' ' : ',');
  return chaves(p, 1).slice(0, 2000);
}

function opcoesDeEnvio(env, cfg) {
  return {
    versao: String(env.META_GRAPH_VERSAO || GRAPH_VERSAO_PADRAO),
    // So para a suite apontar um Meta falso.
    base: env.META_GRAPH_BASE || undefined,
    codigoTeste: cfg.codigo_teste || '',
  };
}

async function registrar(env, l) {
  await env.DB.prepare(
    `INSERT INTO envios (pedido, evento, pixel, event_id, quando, status, visita, campos, formato, resposta, teste, tentativas, evento_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT(pedido, evento, pixel) DO UPDATE SET
       event_id = excluded.event_id, quando = excluded.quando, status = excluded.status,
       visita = COALESCE(excluded.visita, envios.visita), campos = excluded.campos,
       formato = COALESCE(excluded.formato, envios.formato), resposta = excluded.resposta,
       teste = excluded.teste, tentativas = excluded.tentativas, evento_json = excluded.evento_json`,
  ).bind(l.pedido, l.evento, l.pixel, l.event_id || null, Date.now(), l.status, l.visita || null, l.campos || '',
    l.formato || null, l.resposta || null, l.teste ? 1 : 0, l.tentativas || 0, l.evento_json || null).run();
}

/** Manda (ou guarda) um evento pronto para um pixel e registra o resultado. */
async function enviarERegistrar(env, cfg, token, base, pixel, evento, tentativas) {
  const op = opcoesDeEnvio(env, cfg);
  const r = await enviarEvento({ evento, pixel, token, ...op });
  const guardar = REENVIAVEIS.includes(r.status);
  await registrar(env, {
    ...base, pixel, status: r.status, resposta: r.resposta, teste: Boolean(op.codigoTeste),
    tentativas, evento_json: guardar ? JSON.stringify(evento) : null,
  });
  if (r.status === 'chave_invalida') await alertar(env, 'chave_invalida', r.resposta);
  return r.status;
}

/**
 * Uma venda que chegou pelo webhook. Devolve um resumo (para a suite e o log),
 * nunca lanca.
 */
export async function processarVenda(env, venda, formato, { agoraSeg = Math.floor(Date.now() / 1000) } = {}) {
  try {
    const nome = venda.tipo === 'aprovada' ? 'Purchase'
      : venda.tipo === 'reembolso' || venda.tipo === 'chargeback' ? 'Reembolso' : null;
    if (!nome) return { acao: 'ignorado', motivo: venda.evento || 'evento sem compra' };
    if (!venda.pedido) return { acao: 'ignorado', motivo: 'sem pedido' };

    const cfg = await lerConfig(env);
    if (cfg.produtos.length && !venda.produtos.some((p) => cfg.produtos.some((n) => mesmoProduto(p.nome, n)))) {
      return { acao: 'ignorado', motivo: 'outro produto' };
    }

    let visita = null;
    if (venda.src) {
      visita = await env.DB.prepare('SELECT id, ip, ua, fbc, fbp, url FROM visitas WHERE id = ?').bind(venda.src).first();
    }
    const { evento, campos, dedupNavegador } = await montarEvento(venda, visita, cfg, agoraSeg, nome);
    const base = {
      pedido: venda.pedido, evento: nome, event_id: evento.event_id, formato,
      visita: visita?.id || (venda.src ? `nao-achada:${venda.src.slice(0, 40)}` : null),
      campos: `${campos}${dedupNavegador ? '' : ',SEM_DEDUP'}`,
    };

    const token = await lerSegredo(env, 'meta_token');
    if (!cfg.pixels.length || !token) {
      await registrar(env, { ...base, pixel: '*', status: 'sem_config', evento_json: JSON.stringify(evento) });
      return { acao: 'guardado', motivo: 'sem pixel ou chave' };
    }

    const resultados = {};
    for (const pixel of cfg.pixels) {
      const ja = await env.DB.prepare('SELECT status, teste FROM envios WHERE pedido = ? AND evento = ? AND pixel = ?')
        .bind(venda.pedido, nome, pixel).first();
      // Reenvio do checkout: o que ja foi aceito de verdade nao vai de novo.
      if (ja?.status === 'enviado' && !ja.teste) { resultados[pixel] = 'ja_enviado'; continue; }
      resultados[pixel] = await enviarERegistrar(env, cfg, token, base, pixel, evento, 1);
    }
    return { acao: 'enviado', resultados, campos: base.campos };
  } catch (erro) {
    console.error(`Tracking Lab: erro no pedido ${venda?.pedido}: ${erro}`);
    return { acao: 'erro', motivo: String(erro).slice(0, 200) };
  }
}

/**
 * Cron: tenta de novo o que falhou (rede, 5xx, chave trocada, configuracao que
 * chegou depois da venda). Apaga o evento guardado quando nao ha mais o que
 * fazer. Nunca lanca.
 */
export async function reenviarPendentes(env, { agoraSeg = Math.floor(Date.now() / 1000), limite = 50 } = {}) {
  const resumo = { tentados: 0, enviados: 0, expirados: 0 };
  try {
    const cfg = await lerConfig(env);
    const token = await lerSegredo(env, 'meta_token');
    const { results } = await env.DB.prepare(
      `SELECT * FROM envios WHERE evento_json IS NOT NULL AND status IN ('falhou','chave_invalida','sem_config')
       ORDER BY quando LIMIT ?`,
    ).bind(limite).all();
    for (const l of results) {
      const evento = JSON.parse(l.evento_json);
      const expirou = agoraSeg - Number(evento.event_time) > LIMITE_REENVIO || l.tentativas >= MAX_TENTATIVAS;
      if (expirou) {
        await env.DB.prepare(`UPDATE envios SET evento_json = NULL, status = CASE WHEN status = 'enviado' THEN status ELSE 'expirado' END
          WHERE pedido = ? AND evento = ? AND pixel = ?`).bind(l.pedido, l.evento, l.pixel).run();
        resumo.expirados++;
        continue;
      }
      if (!token || !cfg.pixels.length) continue;
      // Com chave invalida, so vale tentar se a chave foi trocada depois do erro.
      if (l.status === 'chave_invalida') {
        const s = await env.DB.prepare("SELECT quando FROM segredos WHERE nome = 'meta_token'").first();
        if (!s || s.quando <= l.quando) continue;
      }
      const base = {
        pedido: l.pedido, evento: l.evento, event_id: l.event_id, visita: l.visita, campos: l.campos, formato: l.formato,
      };
      const alvos = l.pixel === '*' ? cfg.pixels : [l.pixel];
      for (const pixel of alvos) {
        resumo.tentados++;
        const st = await enviarERegistrar(env, cfg, token, base, pixel, evento, (l.tentativas || 0) + 1);
        if (st === 'enviado') resumo.enviados++;
      }
      if (l.pixel === '*') {
        await env.DB.prepare("DELETE FROM envios WHERE pedido = ? AND evento = ? AND pixel = '*'").bind(l.pedido, l.evento).run();
      }
    }
  } catch (erro) {
    resumo.erro = String(erro).slice(0, 200);
  }
  return resumo;
}

/**
 * O teste com controle (Hub): uma Compra ficticia que o Meta deve ACEITAR e a
 * mesma com 8 dias, que ele deve RECUSAR. So em modo teste (codigo TEST...),
 * para nada contar nas campanhas. Prova que "aceita" e o Meta aceitando.
 */
export async function testeComControle(env) {
  const cfg = await lerConfig(env);
  const token = await lerSegredo(env, 'meta_token');
  if (!cfg.codigo_teste) return { ok: false, erro: 'falta o código de teste (TEST…) do Gerenciador de Eventos' };
  if (!cfg.pixels.length || !token) return { ok: false, erro: 'falta o pixel ou a chave do Meta' };
  const agora = Math.floor(Date.now() / 1000);
  const venda = {
    tipo: 'aprovada', pedido: `TESTE-${Date.now()}`, idDedup: '', valor: 1, produtos: [{ id: 'teste', nome: 'Teste' }],
    cliente: { email: 'teste.tracking-lab@exemplo.com', telefone: '11999990000', nome: 'Teste Tracking Lab', cidade: 'Sao Paulo', estado: 'SP', cep: '01000000' },
    ip: '2804:14c:5b81:8000::1', navegador: 'Mozilla/5.0 (teste Tracking Lab)', cookies: { fbp: `fb.1.${agora * 1000}.1234567890` },
    utm: { utm_content: '::IwAR_teste_tracking_lab_0123456789' },
  };
  const op = opcoesDeEnvio(env, cfg);
  const casos = {};
  for (const [caso, quando] of [['ok', agora], ['deve_falhar', agora - 8 * 24 * 3600]]) {
    const { evento } = await montarEvento({ ...venda, pedido: `${venda.pedido}-${caso}` }, null, cfg, quando);
    casos[caso] = {};
    for (const pixel of cfg.pixels) casos[caso][pixel] = await enviarEvento({ evento, pixel, token, ...op });
  }
  const passou = cfg.pixels.every((p) => casos.ok[p].status === 'enviado' && casos.deve_falhar[p].status === 'recusado');
  return { ok: passou, casos };
}
