// Os alertas: o que faz o rastreamento parar SEM ninguem perceber (a pagina
// perdeu o script, a chave caiu, vendas paradas, a nota caiu...). O cron confere
// e acende/apaga sozinho; o Hub e a IA mostram o mesmo texto.
//
// Dois tipos:
//   - de CONDICAO: o cron reavalia a cada passada e apaga quando a causa some;
//   - de EVENTO (um aviso de venda estranho, por exemplo): ficam ate a causa ser
//     resolvida no Hub ou a pessoa dispensar.
//
// A parte cara (as regras do dia, a pagina, a nota do Meta e a versao nova) roda 1x por dia e
// fica guardada; a avaliacao usa o que estiver guardado.

import { lerConfig, lerSegredo, resolverAlertas } from './config.js';
import { detectarPagina } from './deteccao.js';
import { lerQualidade } from './meta.js';
import { atualizarRegras, lerRegras, versaoMeta } from './regras.js';

const HORA = 3600 * 1000;
const DIA = 24 * HORA;

/** O texto da pessoa e a etapa que resolve. `dispensavel`: so os de evento. */
export const TIPOS = {
  chave_invalida: { texto: 'A chave do Meta parou de funcionar: as vendas não estão chegando ao Meta. Gere outra e cole na etapa Chave do Meta.', etapa: 'chave' },
  webhook_sem_token: { texto: 'Chegou um aviso de venda sem o token do checkout, e ele foi recusado.', etapa: 'checkout', dispensavel: true },
  webhook_token_errado: { texto: 'Chegou um aviso de venda com o token errado, e ele foi recusado.', etapa: 'checkout', dispensavel: true },
  formato_novo: { texto: 'Um aviso de venda chegou sem o número do pedido. O checkout pode ter mudado o formato.', etapa: 'checkout', dispensavel: true },
  produto_fora: { texto: 'Chegou uma venda de um produto fora da sua lista, e ela não foi ao Meta.', etapa: 'checkout', dispensavel: true },
  sem_visitas: { texto: 'Nenhuma visita registrada nas últimas 24 h. A linha do Tracking Lab pode ter saído da página.', etapa: 'pagina' },
  script_sumiu: { texto: 'A linha do Tracking Lab não está mais na sua página de vendas.', etapa: 'pagina' },
  vendas_paradas: { texto: 'Há vendas esperando para ir ao Meta há mais de 6 h.', etapa: 'resultados' },
  recusadas: { texto: 'O Meta recusou vendas nas últimas 24 h.', etapa: 'resultados' },
  expiradas: { texto: 'Vendas passaram do prazo de 7 dias do Meta e não chegaram lá.', etapa: 'resultados', dispensavel: true },
  poucas_ligadas: { texto: 'Menos da metade das compras foi ligada à visita da página. A nota do Meta tende a cair.', etapa: 'pagina' },
  nota_baixa: { texto: 'A nota da Compra no Meta está baixa.', etapa: 'resultados' },
  versao_antiga: { texto: 'Há uma versão nova do Tracking Lab há mais de 14 dias, e a sua não atualizou.', etapa: 'atualizacoes' },
};

/** Os de condicao: o cron apaga quando a causa some. */
const DE_CONDICAO = ['sem_visitas', 'script_sumiu', 'vendas_paradas', 'recusadas', 'expiradas', 'poucas_ligadas', 'nota_baixa', 'versao_antiga'];

export function descreverAlerta(a) {
  const t = TIPOS[a.tipo] || { texto: a.tipo };
  return { ...a, texto: t.texto, etapa: t.etapa || null, dispensavel: Boolean(t.dispensavel) };
}

/** a > b em versoes "0.5.1". */
export function versaoMaior(a, b) {
  const x = String(a || '').split('.').map(Number);
  const y = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/**
 * Os dados -> os alertas acesos. Puro (a suite testa sem banco). Um campo
 * ausente nos dados = nao deu para conferir: o alerta fica como esta.
 * Devolve { acesos: [{tipo, detalhe}], conferidos: [tipos avaliados] }.
 */
export function avaliar(d, agora = Date.now()) {
  const acesos = [];
  const conferidos = [];
  const regra = (tipo, aceso, detalhe = '') => {
    conferidos.push(tipo);
    if (aceso) acesos.push({ tipo, detalhe: String(detalhe).slice(0, 400) });
  };
  if (d.visitas) regra('sem_visitas', d.visitas.ultimas24h === 0 && d.visitas.antes7d > 0, `${d.visitas.antes7d} visitas nos 6 dias anteriores`);
  if (d.deteccao !== undefined) {
    const det = d.deteccao;
    regra('script_sumiu', Boolean(det?.ok && det.script === false && d.scriptVisto), det?.url || '');
  }
  if (d.envios) {
    const e = d.envios;
    const partes = [e.semConfig ? `${e.semConfig} esperando o pixel ou a chave` : '', e.falhou ? `${e.falhou} sem resposta do Meta (tentamos de novo sozinhos)` : ''].filter(Boolean);
    regra('vendas_paradas', e.semConfig + e.falhou > 0, partes.join('; '));
    regra('recusadas', e.recusadas > 0, `${e.recusadas} recusadas${e.motivo ? ` · ${e.motivo}` : ''}`);
    regra('expiradas', e.expiradas > 0, `${e.expiradas} nos últimos 7 dias`);
    const pct = e.compras7d ? Math.round((100 * e.ligadas7d) / e.compras7d) : 100;
    regra('poucas_ligadas', e.compras7d >= 10 && pct < 50, `${pct}% de ${e.compras7d} compras em 7 dias`);
  }
  if (d.nota !== undefined) {
    const n = d.nota;
    regra('nota_baixa', Boolean(n && !d.modoTeste && typeof n.min === 'number' && n.min < 6), n ? `nota ${n.min}${n.pixel ? ` no pixel ${n.pixel}` : ''}` : '');
  }
  if (d.versao) {
    const v = d.versao;
    const atrasada = Boolean(v.ultima && versaoMaior(v.ultima, v.instalada) && v.desde && agora - v.desde > 14 * DIA);
    regra('versao_antiga', atrasada, `instalada ${v.instalada}, mais nova ${v.ultima}`);
  }
  return { acesos, conferidos };
}

async function marca(env, chave) {
  const r = await env.DB.prepare('SELECT valor FROM config WHERE chave = ?').bind(chave).first();
  if (!r) return null;
  try { return JSON.parse(r.valor); } catch { return r.valor; }
}
async function gravar(env, chave, valor) {
  await env.DB.prepare(
    `INSERT INTO config (chave, valor, quando) VALUES (?1, ?2, ?3)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, quando = excluded.quando`,
  ).bind(chave, JSON.stringify(valor), Date.now()).run();
}

/** Guarda a leitura da pagina (Hub, IA ou cron) e lembra se o script ja foi visto. */
export async function registrarDeteccao(env, r) {
  if (!r?.quando) return;
  await gravar(env, 'deteccao', r);
  if (r.script) await gravar(env, 'script_visto', r.quando);
}

/** A versao mais nova publicada na origem (arquivo publico), ou '' sem rede. */
export async function versaoDaOrigem(env, repo, buscar = fetch) {
  const base = String(env.TL_ORIGEM_RAW || 'https://raw.githubusercontent.com').replace(/\/$/, '');
  try {
    const r = await buscar(`${base}/${repo}/main/package.json`, { signal: AbortSignal.timeout(8000) });
    return r.ok ? String((await r.json()).version || '') : '';
  } catch {
    return '';
  }
}

/** A parte de 1x por dia: as regras do dia, a pagina, a nota do Meta e a versao nova. Nunca lanca. */
async function conferenciaDiaria(env, { versao, repo, buscar }) {
  await atualizarRegras(env, repo, buscar);
  const regras = await lerRegras(env);
  const cfg = await lerConfig(env);
  if (cfg.dominio) await registrarDeteccao(env, await detectarPagina(cfg.dominio, '', buscar));
  const token = await lerSegredo(env, 'meta_token');
  if (cfg.pixels.length && token) {
    let nota = null;
    for (const pixel of cfg.pixels) {
      const q = await lerQualidade({ token, pixel, versao: versaoMeta(env, regras), base: env.META_GRAPH_BASE }, buscar);
      const compra = (q.web || []).find((e) => e.event_name === 'Purchase');
      const s = compra?.event_match_quality?.composite_score;
      if (typeof s === 'number' && (!nota || s < nota.min)) nota = { min: s, pixel };
    }
    // Sem nota (Meta fora, poucas vendas): guarda vazio, e o alerta nao acende.
    await gravar(env, 'nota_compra', nota ? { ...nota, quando: Date.now() } : { quando: Date.now() });
  }
  const ultima = await versaoDaOrigem(env, repo, buscar);
  if (ultima) {
    const antes = await marca(env, 'versao_origem');
    const nova = versaoMaior(ultima, versao);
    // `desde`: quando a versao nova apareceu para esta instalacao.
    const desde = nova ? (antes?.ultima === ultima && antes.desde ? antes.desde : Date.now()) : null;
    await gravar(env, 'versao_origem', { ultima, desde });
  }
  await gravar(env, 'conferencia_diaria', Date.now());
}

/**
 * A conferencia (cron, a cada passada; ou o botao "Conferir agora"). Liga os
 * alertas de condicao que valem e apaga os que nao valem mais. Nunca lanca.
 */
export async function conferir(env, { versao, repo, agora = Date.now(), forcar = false, buscar = fetch } = {}) {
  try {
    const ultimaDiaria = Number(await marca(env, 'conferencia_diaria')) || 0;
    if (forcar || agora - ultimaDiaria > 20 * HORA) await conferenciaDiaria(env, { versao, repo, buscar });

    const cfg = await lerConfig(env);
    const um = (sql, ...p) => env.DB.prepare(sql).bind(...p).first();
    const v24 = await um('SELECT count(*) n FROM visitas WHERE vista >= ?', agora - DIA);
    const v7 = await um('SELECT count(*) n FROM visitas WHERE vista >= ? AND vista < ?', agora - 7 * DIA, agora - DIA);
    const parado = Math.floor((agora - 6 * HORA) / 1000);
    const espera = await um(
      `SELECT sum(status = 'sem_config') sc, sum(status = 'falhou') fa FROM envios
       WHERE evento_json IS NOT NULL AND teste = 0 AND status IN ('sem_config','falhou')
         AND CAST(json_extract(evento_json, '$.event_time') AS INTEGER) < ?`, parado);
    const rec = await um("SELECT count(*) n, max(resposta) r FROM envios WHERE status = 'recusado' AND teste = 0 AND quando >= ?", agora - DIA);
    const exp = await um("SELECT count(*) n FROM envios WHERE status = 'expirado' AND teste = 0 AND quando >= ?", agora - 7 * DIA);
    const lig = await um(
      `SELECT count(*) n, sum(visita IS NOT NULL AND visita NOT LIKE 'nao-achada:%') l FROM envios
       WHERE evento = 'Purchase' AND status = 'enviado' AND teste = 0 AND quando >= ?`, agora - 7 * DIA);
    const det = await marca(env, 'deteccao');
    const nota = await marca(env, 'nota_compra');
    const vo = await marca(env, 'versao_origem');

    const { acesos, conferidos } = avaliar({
      visitas: { ultimas24h: v24?.n || 0, antes7d: v7?.n || 0 },
      deteccao: cfg.dominio ? det : undefined,
      scriptVisto: Boolean(await marca(env, 'script_visto')),
      envios: {
        semConfig: espera?.sc || 0, falhou: espera?.fa || 0, recusadas: rec?.n || 0,
        motivo: String(rec?.r || '').slice(0, 160), expiradas: exp?.n || 0, compras7d: lig?.n || 0, ligadas7d: lig?.l || 0,
      },
      nota: nota ? (typeof nota.min === 'number' ? nota : null) : undefined,
      modoTeste: Boolean(cfg.codigo_teste),
      versao: vo ? { instalada: versao, ultima: vo.ultima, desde: vo.desde } : undefined,
    }, agora);

    for (const a of acesos) {
      const ja = await um('SELECT id FROM alertas WHERE tipo = ? AND resolvido IS NULL', a.tipo);
      if (ja) await env.DB.prepare('UPDATE alertas SET detalhe = ? WHERE id = ?').bind(a.detalhe, ja.id).run();
      else await env.DB.prepare('INSERT INTO alertas (tipo, quando, detalhe) VALUES (?, ?, ?)').bind(a.tipo, agora, a.detalhe).run();
    }
    const apagar = conferidos.filter((t) => DE_CONDICAO.includes(t) && !acesos.some((a) => a.tipo === t));
    await resolverAlertas(env, apagar);
    await gravar(env, 'ultima_conferencia', agora);
    return { acesos: acesos.map((a) => a.tipo), apagados: apagar };
  } catch (erro) {
    console.error(`conferencia: ${erro}`);
    return { erro: String(erro).slice(0, 200) };
  }
}

/** "Dispensar" no Hub: so os de evento (os de condicao voltariam no proximo cron). */
export async function dispensar(env, tipo) {
  if (!TIPOS[tipo]?.dispensavel) return { ok: false, status: 400, erro: 'este aviso some sozinho quando a causa for resolvida' };
  await resolverAlertas(env, [tipo]);
  return { ok: true, status: 200 };
}
