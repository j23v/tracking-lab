// O conector da IA do cliente: um servidor MCP (Model Context Protocol, o padrao
// que Claude, ChatGPT, Goose e Cursor usam para "botoes" externos), no proprio
// Worker do cliente, em /mcp/<segredo>.
//
// Feito a mao e SEM estado (transporte "Streamable HTTP", respostas JSON): nada
// de Durable Object nem pacote novo -- a atualizacao do cliente nao mexe no
// wrangler.jsonc, entao o Tracking Lab nao pode depender de binding novo.
//
// Autenticacao: o segredo no endereco (criado no Hub; criar outro derruba o
// anterior). Quem tem o endereco tem os mesmos poderes do Hub, MENOS "ligar de
// verdade" (so pelo botao no Hub) e a senha do Hub.

import {
  analisar, confirmar, detectar, envios, estado, qualidade, rodarTeste, salvarPerfilOutro, salvarSegredo,
} from './acoes.js';
import { PERFIS } from './checkouts/perfis.js';
import {
  CONFIRMACOES, IDS_DE_CHECKOUT, gravarConfig, gravarSegredo, lerSegredo,
} from './config.js';
import { CHECKOUT_INFO, RECEITAS_PAGINA, ferramentasRisco, semHtml } from './receitas.js';

const VERSOES = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization',
};

const INSTRUCOES = `Você é o assistente do Tracking Lab da pessoa: um sistema na conta Cloudflare DELA que manda as vendas do checkout ao Meta pelo servidor.
Fale simples, em passos curtos. Comece por tl_status: ele diz em que etapa a pessoa está e o que está vermelho.
Regras:
1. Use tl_receita para o passo a passo da etapa: já vem personalizado para as plataformas dela. Não invente caminhos de menu.
2. Antes de mudar algo num painel de terceiros (Kirvano, Meta, WordPress…), diga o que vai fazer e espere o "pode".
3. Quem diz se ficou certo é o Tracking Lab: depois de cada passo, confira com tl_status ou tl_detectar_pagina.
4. Chave do Meta colada no chat: confirme com naturalidade (começa com EAA) e salve com tl_salvar_chave_meta. Não repita a chave inteira.
5. "Ligar de verdade" é só pelo botão no Hub (/lab): oriente a pessoa a apertar.
6. Nunca gere a chave do Meta por outra BM para fugir de um bloqueio do Meta. Nunca ponha Compra (Purchase) no navegador da página.
7. No "Outro checkout", nunca ponha em "aprovada" um status que não seja venda PAGA.`;

export const ETAPA_IDS = ['plataformas', 'chave', 'pagina', 'checkout', 'duplicacao', 'teste', 'ligar', 'resultados', 'privacidade', 'reembolso', 'atualizacoes'];

const FERRAMENTAS = [
  { name: 'tl_status', title: 'Estado do Tracking Lab', description: 'As 11 etapas com a luz de cada uma (ok/meio/bad/vazia), a próxima etapa, os alertas e os números das últimas 24 h. Comece por aqui.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'tl_receita', title: 'Passo a passo de uma etapa', description: 'O passo a passo de uma etapa, já personalizado para as plataformas da pessoa (construtor da página, checkout, pixel). Use antes de orientar.', inputSchema: { type: 'object', properties: { etapa: { type: 'string', enum: ETAPA_IDS }, plataforma: { type: 'string', description: 'Opcional: wordpress, elementor, gtm, shopify, wix, webflow, framer, html (página) ou o id do checkout.' } }, required: ['etapa'] }, annotations: { readOnlyHint: true } },
  { name: 'tl_detectar_pagina', title: 'Ler a página de vendas', description: 'Lê a página de vendas de fora e diz: construtor, pixels, checkouts dos botões, ferramentas, se a linha do Tracking Lab está lá e se há Compra no navegador. Sem url, usa a página configurada.', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'tl_configurar', title: 'Configurar', description: 'Grava pixel(s), checkout(s) usados, produtos aceitos, página de vendas e o repositório do GitHub da pessoa. Só os campos enviados mudam.', inputSchema: { type: 'object', properties: { pixels: { type: 'array', items: { type: 'string' } }, checkouts: { type: 'array', items: { type: 'string', enum: IDS_DE_CHECKOUT } }, produtos: { type: 'array', items: { type: 'string' } }, dominio: { type: 'string' }, repositorio: { type: 'string', description: 'usuario/nome no GitHub' } } } },
  { name: 'tl_salvar_chave_meta', title: 'Salvar a chave do Meta', description: 'Salva a chave (token) da API de Conversões. O Tracking Lab confere no Meta antes de guardar e responde só se foi aceita. Precisa do pixel configurado antes.', inputSchema: { type: 'object', properties: { chave: { type: 'string' } }, required: ['chave'] } },
  { name: 'tl_salvar_token_checkout', title: 'Salvar o token do checkout', description: 'Salva o token do webhook de um checkout (Kirvano: token; Kiwify: token; Hotmart: hottok; Eduzz: originSecret; Cakto: secret). Para "padrao" e "outro", use um segredo que a pessoa vai pôr na URL como ?k=.', inputSchema: { type: 'object', properties: { checkout: { type: 'string', enum: IDS_DE_CHECKOUT }, token: { type: 'string' } }, required: ['checkout', 'token'] } },
  { name: 'tl_confirmar', title: 'Confirmar um item', description: 'Marca o que só a pessoa pode afirmar: dup_checkout (desligou a Compra no checkout), dup_ferramentas (UTMify/plugin resolvidos), privacidade (publicou a política), reembolso (fez a conversão e o público), rotina (instalou a rotina de atualização). Só marque depois que ela disser que fez.', inputSchema: { type: 'object', properties: { item: { type: 'string', enum: CONFIRMACOES }, feito: { type: 'boolean' } }, required: ['item', 'feito'] } },
  { name: 'tl_teste_controle', title: 'Teste com controle', description: 'Grava o código TEST… do Gerenciador de Eventos e manda duas compras de mentira: uma que o Meta deve aceitar e outra (8 dias atrás) que ele deve recusar. Enquanto o código estiver gravado, todas as vendas vão como teste.', inputSchema: { type: 'object', properties: { codigo_teste: { type: 'string' } }, required: ['codigo_teste'] } },
  { name: 'tl_resultados', title: 'Resultados', description: 'A nota de qualidade do Meta (EMQ, 0 a 10) por evento e por pixel, a cobertura de cada dado e os envios dos últimos 7 dias.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'tl_analisar_exemplo', title: 'Analisar um webhook de exemplo', description: 'Para o "Outro checkout": lista os campos de um webhook de exemplo (amostras mascaradas) e sugere o perfil. Sem exemplo, usa o último capturado em /w/outro. Com "perfil", mostra como a venda seria lida.', inputSchema: { type: 'object', properties: { exemplo: { description: 'O webhook de exemplo (objeto JSON ou texto)' }, perfil: { type: 'object' } } }, annotations: { readOnlyHint: true } },
  { name: 'tl_salvar_perfil_outro', title: 'Salvar o perfil do "Outro checkout"', description: 'Salva o perfil montado. Confira antes com tl_analisar_exemplo (com o perfil) se a leitura está certa — principalmente que "aprovada" é só venda paga.', inputSchema: { type: 'object', properties: { perfil: { type: 'object' } }, required: ['perfil'] } },
];

function iguais(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let dif = 0;
  for (let i = 0; i < x.length; i++) dif |= x[i] ^ y[i];
  return dif === 0;
}

export async function conectorAtivo(env) {
  const r = await env.DB.prepare("SELECT dica, quando FROM segredos WHERE nome = 'mcp_token'").first();
  return r ? { ativo: true, dica: r.dica, quando: r.quando } : { ativo: false };
}

/** Cria (ou troca) o endereco do conector. O segredo so aparece aqui. */
export async function criarConector(env, origem) {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  const segredo = [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  const dica = await gravarSegredo(env, 'mcp_token', segredo);
  return { ativo: true, url: `${origem}/mcp/${segredo}`, dica, quando: Date.now() };
}

// ------------------------------------------------------------------ as ferramentas

const LUZ = { ok: 'OK', meio: 'falta pouco', bad: 'PROBLEMA', '': 'a fazer', opc: 'opcional' };

export function textoStatus(st) {
  const proxima = st.etapas.find((e) => !e.opcional && e.luz !== 'ok');
  const compras = (st.envios24h || []).filter((e) => e.evento === 'Purchase' && !e.teste);
  const aceitas = compras.filter((e) => e.status === 'enviado').reduce((s, e) => s + e.n, 0);
  const linhas = st.etapas.map((e, i) => `${String(i + 1).padStart(2, '0')}. ${e.titulo}: ${LUZ[e.luz] ?? e.luz}`);
  return [
    `Modo: ${st.config?.codigo_teste ? 'TESTE (as vendas não contam nas campanhas)' : st.ultimoTeste?.ok ? 'valendo' : 'configurando'}.`,
    proxima ? `Próxima etapa: ${proxima.titulo} (use tl_receita com etapa "${proxima.id}").` : 'Todas as etapas obrigatórias estão OK.',
    '', ...linhas, '',
    `Últimas 24 h: ${aceitas} compras aceitas pelo Meta; ${st.visitas24h?.n || 0} visitas (${st.visitas24h?.fbc || 0} com clique de anúncio).`,
    ...(st.alertas || []).map((a) => `ALERTA: ${a.tipo}${a.detalhe ? ` (${a.detalhe})` : ''}`),
  ].join('\n');
}

export function receita(etapa, st, origem, plataforma) {
  const cfg = st.config || {};
  const px = (cfg.pixels || []).join(', ') || '(ainda sem pixel)';
  const usados = cfg.checkouts || [];
  const linha = `<script src="${origem}/v.js" async></script>`;
  const lista = (passos) => passos.map((p, i) => `${i + 1}. ${semHtml(p)}`).join('\n');
  switch (etapa) {
    case 'plataformas':
      return `Descubra as plataformas com tl_detectar_pagina (url da página de vendas). Depois confirme com a pessoa qual pixel as campanhas usam (Gerenciador de Anúncios → conjunto de anúncios → Conversão → "Conjunto de dados") e qual checkout ela usa, e grave com tl_configurar (pixels, checkouts).\nCheckouts com perfil pronto: ${Object.values(PERFIS).map((p) => `${p.id} (${p.nome})`).join(', ')}, e "outro" para qualquer outro.`;
    case 'chave':
      return `1. Gerenciador de Eventos (business.facebook.com/events_manager2) → pixel ${px}.\n2. Configurações → API de Conversões → "Gerar token de acesso".\n3. A pessoa cola no Hub ou aqui no chat; salve com tl_salvar_chave_meta.\nSe aparecer "você não pode gerar tokens… violou nossos Termos": é bloqueio do Meta na BM. Caminho: pedir revisão em developers.facebook.com/appeal ou usar um pixel numa conta saudável. NÃO gerar por outra BM.`;
    case 'pagina': {
      const det = (st.deteccao?.sites || []).map((s) => s.id).filter((s) => RECEITAS_PAGINA[s]);
      const alvo = RECEITAS_PAGINA[plataforma] ? plataforma : det[0] || 'html';
      return `A linha (no <head> de todas as páginas de vendas):\n${linha}\n\nReceita ${RECEITAS_PAGINA[alvo].nome}${det.length ? ` (detectado: ${det.join(', ')})` : ''}:\n${lista(RECEITAS_PAGINA[alvo].passos)}\n\nNão coloque fbq('track','Purchase') na página. Depois, confira com tl_detectar_pagina (campo "script").`;
    }
    case 'checkout': {
      const ids = plataforma && IDS_DE_CHECKOUT.includes(plataforma) ? [plataforma] : usados;
      if (!ids.length) return 'Nenhum checkout escolhido ainda: grave com tl_configurar (checkouts).';
      return ids.map((id) => {
        const info = CHECKOUT_INFO[id] || CHECKOUT_INFO.outro;
        const url = `${origem}/w/${id}${info.gerar ? '?k=<o segredo que você salvar com tl_salvar_token_checkout>' : ''}`;
        const extra = id === 'outro' && !cfg.perfil_outro ? '\nSem perfil ainda: salve um segredo, cadastre a URL e mande um aviso de teste (fica capturado 24 h, nada vai ao Meta); depois tl_analisar_exemplo → montar o perfil → tl_salvar_perfil_outro.' : '';
        return `${id}:\n1. ${semHtml(info.onde)}\n2. URL do webhook: ${url}\n3. Eventos: venda aprovada, reembolso e chargeback.\n4. ${semHtml(info.token)} → salve com tl_salvar_token_checkout (checkout "${id}").${extra}`;
      }).join('\n\n');
    }
    case 'duplicacao': {
      const r = ferramentasRisco(st);
      return `Regra: no pixel ${px}, só o Tracking Lab manda a Compra.\n${usados.map((id) => `- ${id}: no pixel do checkout, manter InitiateCheckout e AddPaymentInfo e DESLIGAR a Compra (Purchase); se houver "API de conversões"/servidor do checkout, desligar nesse pixel.`).join('\n')}\n${r.map((f) => `- ${f.nome}: ${f.id === 'utmify' ? 'remover este pixel da integração de pixel da UTMify' : 'garantir que o plugin não manda Compra para este pixel'}.`).join('\n')}\n${st.deteccao?.compraNoNavegador ? '- A PÁGINA tem fbq(...Purchase): tirar.\n' : ''}Quando a pessoa disser que fez: tl_confirmar dup_checkout${r.length ? ' e dup_ferramentas' : ''}.`;
    }
    case 'teste':
      return `1. Gerenciador de Eventos → pixel ${px} → Testar eventos → aba "Eventos do servidor" → copiar o código TEST….\n2. Rodar tl_teste_controle com esse código. Esperado: compra de teste "enviado" e controle "recusado".\n3. A pessoa vê a compra chegar na aba do Meta.`;
    case 'ligar':
      return 'Só pelo botão "Ligar de verdade" no Hub (/lab, etapa Ligar). Ele tira o código de teste: a partir daí as vendas valem para as campanhas. Precisa do teste com controle aprovado antes.';
    case 'resultados':
      return 'Use tl_resultados. A nota do Meta atualiza com até ~48 h de atraso. Não prometa ROAS: o que medimos é a qualidade do sinal.';
    case 'privacidade':
      return 'No Hub, etapa Privacidade: preencher nome/razão social, CPF/CNPJ e e-mail → "Gerar o texto" → publicar como página "Política de Privacidade" e pôr o link no rodapé. Depois: tl_confirmar privacidade.';
    case 'reembolso':
      return '1. Gerenciador de Eventos → Conversões personalizadas → Criar → evento "Reembolso".\n2. Gerenciador de Anúncios → Colunas → incluir "Reembolso".\n3. Públicos → personalizado → Site → evento "Reembolso", 180 dias → usar para EXCLUIR das campanhas.\nDepois: tl_confirmar reembolso.';
    case 'atualizacoes':
      return `1. Gravar o repositório da pessoa no GitHub (usuario/nome) com tl_configurar (repositorio).\n2. No Hub, etapa Atualizações, o botão "Instalar a rotina no GitHub" abre o arquivo pronto: apertar "Commit changes".\n3. Depois: tl_confirmar rotina.${cfg.repositorio ? `\nRepositório gravado: ${cfg.repositorio}.` : ''}`;
    default:
      return 'Etapa desconhecida.';
  }
}

async function chamar(nome, args, env, origem, versao) {
  const a = args && typeof args === 'object' ? args : {};
  const st = () => estado(env, versao);
  switch (nome) {
    case 'tl_status': { const s = await st(); return { texto: textoStatus(s), dados: { etapas: s.etapas, modo_teste: Boolean(s.config?.codigo_teste), alertas: s.alertas } }; }
    case 'tl_receita': {
      if (!ETAPA_IDS.includes(a.etapa)) return { erro: `etapa: use ${ETAPA_IDS.join(', ')}` };
      return { texto: receita(a.etapa, await st(), origem, a.plataforma) };
    }
    case 'tl_detectar_pagina': {
      const r = await detectar(env, a.url, origem);
      if (!r.quando) return { erro: r.erro || 'não abriu a página' };
      const { status, ...d } = r;
      return { texto: `Página ${d.url} (HTTP ${d.status ?? '?'}): construtor ${(d.sites || []).map((s) => s.nome).join(', ') || 'não reconhecido'}; pixels ${(d.pixels || []).join(', ') || 'nenhum'}; checkouts nos botões ${(d.checkouts || []).map((c) => c.nome).join(', ') || 'nenhum'}; linha do Tracking Lab ${d.script ? 'ENCONTRADA' : 'não encontrada'}; Compra no navegador ${d.compraNoNavegador ? 'SIM (tirar)' : 'não'}; ferramentas ${(d.ferramentas || []).map((f) => f.nome).join(', ') || 'nenhuma'}.`, dados: d };
    }
    case 'tl_configurar': {
      const permitido = ['pixels', 'checkouts', 'produtos', 'dominio', 'repositorio'];
      const parcial = Object.fromEntries(Object.entries(a).filter(([k]) => permitido.includes(k)));
      if (!Object.keys(parcial).length) return { erro: `mande pelo menos um de: ${permitido.join(', ')}` };
      const r = await gravarConfig(env, parcial);
      if (!r.ok) return { erro: r.erro };
      return { texto: `Gravado: ${Object.keys(parcial).join(', ')}.`, dados: Object.fromEntries(permitido.map((k) => [k, r.config[k]])) };
    }
    case 'tl_salvar_chave_meta': {
      const r = await salvarSegredo(env, 'meta_token', a.chave);
      if (!r.ok) return { erro: r.motivo === 'chave_invalida' ? `O Meta recusou esta chave para o pixel ${r.pixel}. Confira se foi gerada no pixel certo.` : r.erro || r.detalhe || 'chave recusada' };
      return { texto: `Chave aceita pelo Meta e guardada (${r.dica}).` };
    }
    case 'tl_salvar_token_checkout': {
      if (!IDS_DE_CHECKOUT.includes(a.checkout)) return { erro: `checkout: use ${IDS_DE_CHECKOUT.join(', ')}` };
      const r = await salvarSegredo(env, `${a.checkout}_token`, a.token);
      if (!r.ok) return { erro: r.erro };
      return { texto: `Token do ${a.checkout} guardado (${r.dica}).` };
    }
    case 'tl_confirmar': {
      if (!CONFIRMACOES.includes(a.item)) return { erro: `item: use ${CONFIRMACOES.join(', ')}` };
      const r = await confirmar(env, a.item, a.feito);
      return r.ok ? { texto: `${a.item}: ${a.feito ? 'confirmado' : 'desmarcado'}.` } : { erro: r.erro };
    }
    case 'tl_teste_controle': {
      const c = await gravarConfig(env, { codigo_teste: a.codigo_teste });
      if (!c.ok) return { erro: c.erro };
      const r = await rodarTeste(env);
      if (!r.casos) return { erro: r.erro };
      const porPixel = Object.keys(r.casos.ok).map((p) => `pixel ${p}: compra de teste ${r.casos.ok[p].status}, controle ${r.casos.deve_falhar[p].status}`);
      return { texto: `${r.ok ? 'PASSOU' : 'NÃO PASSOU'} — ${porPixel.join('; ')}. ${r.ok ? 'Agora a pessoa aperta "Ligar de verdade" no Hub.' : 'Veja as respostas do Meta nos dados.'}`, dados: r };
    }
    case 'tl_resultados': {
      const [q, e] = await Promise.all([qualidade(env), envios(env, 168)]);
      const notas = q.erro ? q.erro : Object.entries(q).map(([px, d]) => (d.web || []).map((ev) => `pixel ${px} · ${ev.event_name}: ${ev.event_match_quality?.composite_score ?? '—'}`).join('; ') || `pixel ${px}: sem nota ainda`).join(' | ');
      return { texto: `Nota do Meta: ${notas}. Envios (7 dias): ${e.resumo.map((r) => `${r.evento} ${r.status}${r.teste ? ' (teste)' : ''}: ${r.n}`).join(', ') || 'nenhum'}.`, dados: { qualidade: q, envios: e } };
    }
    case 'tl_analisar_exemplo': {
      const r = await analisar(env, a.exemplo, a.perfil);
      if (r.status !== 200) return { erro: r.erro_perfil || r.erro };
      const { status, ...d } = r;
      return { texto: `${d.campos.length} campos${d.capturado ? ' (exemplo capturado)' : ''}. Sugestão em "sugestao"${d.leitura ? `; leitura: tipo ${d.leitura.tipo}, pedido ${d.leitura.pedido || '—'}, faltando ${d.leitura.faltando.join(', ') || 'nada'}` : ''}.`, dados: d };
    }
    case 'tl_salvar_perfil_outro': {
      const r = await salvarPerfilOutro(env, a.perfil);
      return r.ok ? { texto: 'Perfil do "Outro checkout" salvo.', dados: r.perfil } : { erro: r.erro };
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ o protocolo

async function atender(msg, env, origem, versao) {
  const { id, method, params } = msg || {};
  const resultado = (r) => ({ jsonrpc: '2.0', id, result: r });
  const falha = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return falha(-32600, 'pedido inválido');
  if (id === undefined) return null; // notificacao (ex.: notifications/initialized): sem resposta
  if (method === 'initialize') {
    const pedida = params?.protocolVersion;
    return resultado({
      protocolVersion: VERSOES.includes(pedida) ? pedida : VERSOES[1],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'tracking-lab', title: 'Tracking Lab', version: versao },
      instructions: INSTRUCOES,
    });
  }
  if (method === 'ping') return resultado({});
  if (method === 'tools/list') return resultado({ tools: FERRAMENTAS });
  if (method === 'tools/call') {
    let r;
    try {
      r = await chamar(params?.name, params?.arguments, env, origem, versao);
    } catch (erro) {
      console.error(`MCP ${params?.name}: ${erro}`);
      r = { erro: 'falha interna no Tracking Lab' };
    }
    if (r === null) return falha(-32602, `ferramenta desconhecida: ${params?.name}`);
    if (r.erro) return resultado({ content: [{ type: 'text', text: r.erro }], isError: true });
    return resultado({ content: [{ type: 'text', text: r.texto }], ...(r.dados ? { structuredContent: r.dados } : {}) });
  }
  return falha(-32601, `método não suportado: ${method}`);
}

/** `/mcp/<segredo>`: POST com JSON-RPC (uma mensagem ou um lote). */
export async function rotaMcp(request, env, segredo, { versao }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const certo = await lerSegredo(env, 'mcp_token');
  // Endereco errado (ou conector desligado): 404, sem dizer mais nada.
  if (!certo || !iguais(segredo, certo)) return new Response('nao encontrado', { status: 404, headers: CORS });
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { ...CORS, Allow: 'POST, OPTIONS' } });
  }
  let corpo;
  try { corpo = await request.json(); } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }, { status: 400, headers: CORS });
  }
  const origem = new URL(request.url).origin;
  const lote = Array.isArray(corpo);
  const respostas = (await Promise.all((lote ? corpo : [corpo]).map((m) => atender(m, env, origem, versao)))).filter(Boolean);
  if (!respostas.length) return new Response(null, { status: 202, headers: CORS });
  return Response.json(lote ? respostas : respostas[0], { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}
