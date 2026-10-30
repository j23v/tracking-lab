// A API de Conversoes do Meta: normalizacao e hash, a montagem do evento a
// partir da VENDA NORMALIZADA (src/checkouts/*), o envio, a conferencia da chave
// e a nota de qualidade (Dataset Quality API).
//
// Vem do envio que roda em producao desde 28/10/2026 (EMQ da Compra 9,0 no 1o
// dia), generalizado: varios pixels, qualquer checkout, pais e moeda da config.

const GRAPH = 'https://graph.facebook.com';
export const GRAPH_VERSAO_PADRAO = 'v25.0';

// ---------------------------------------------------------------------------
// Normalizacao e hash (como o Meta pede: minusculo, sem espaco, SHA-256 hex)
// ---------------------------------------------------------------------------

export async function sha256(texto) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizarEmail(email) {
  return String(email || '').normalize('NFC').trim().toLowerCase();
}

/** So digitos; no Brasil, poe o 55 na frente do numero nacional (DDD + numero). */
export function normalizarTelefone(bruto, pais = 'br') {
  let d = String(bruto || '').replace(/\D/g, '').replace(/^0+/, '');
  if (pais === 'br' && (d.length === 10 || d.length === 11)) d = `55${d}`;
  return d.length >= 8 && d.length <= 15 ? d : '';
}

function normalizarNome(parte) {
  return String(parte || '').normalize('NFC').toLowerCase().replace(/[^\p{L}]/gu, '');
}

/** "Maria da Silva Souza" -> fn "maria", ln "souza". Um nome so: sem ln. */
export function dividirNome(completo) {
  const partes = String(completo || '').trim().split(/\s+/).map(normalizarNome).filter(Boolean);
  return { fn: partes[0] || '', ln: partes.length > 1 ? partes[partes.length - 1] : '' };
}

/** "R$ 1.169,80" | "169.80" | 169.8 -> 169.8 (ou null). */
export function valorNumerico(bruto) {
  if (typeof bruto === 'number') return Number.isFinite(bruto) ? bruto : null;
  let s = String(bruto || '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function ipValido(v) {
  const s = String(v || '').trim();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || (/^[0-9a-f:]+$/i.test(s) && s.includes(':')) ? s : '';
}

const FBP = /^fb\.\d\.\d+\.\d+$/;
const FBC = /^fb\.\d\.\d+\./;
const FBCLID = /^[\w-]{20,}$/;

// ---------------------------------------------------------------------------
// O evento
// ---------------------------------------------------------------------------

/**
 * Monta o evento (Purchase ou o "Reembolso" proprio) a partir da venda
 * normalizada e da visita ligada pelo `src` (ou null). Separado do envio para
 * a suite conferir o que vai ao Meta sem rede.
 *
 * Prioridades (as que deram EMQ 9,0 na producao):
 *   IP e _fbp: os do CHECKOUT (o momento da compra), senao os da visita;
 *   fbc: o da visita -> o do checkout -> o fbclid cru do checkout -> o do utm_content.
 */
export async function montarEvento(venda, visita, cfg, agoraSeg, nome = 'Purchase') {
  const pais = String(cfg.pais || 'br').toLowerCase();
  const c = venda.cliente || {};
  const ud = {};
  const campos = [];

  const email = normalizarEmail(c.email);
  if (email) {
    const h = await sha256(email);
    ud.em = [h];
    ud.external_id = [h];
    campos.push('em', 'external_id');
  }
  const tel = normalizarTelefone(c.telefone, pais);
  if (tel) { ud.ph = [await sha256(tel)]; campos.push('ph'); }
  const { fn, ln } = dividirNome(c.nome);
  if (fn) { ud.fn = [await sha256(fn)]; campos.push('fn'); }
  if (ln) { ud.ln = [await sha256(ln)]; campos.push('ln'); }
  const ct = normalizarNome(c.cidade);
  const st = String(c.estado || '').normalize('NFC').toLowerCase().replace(/[^a-z]/g, '');
  const zp = String(c.cep || '').replace(/\D/g, '');
  if (ct) { ud.ct = [await sha256(ct)]; campos.push('ct'); }
  if (st.length === 2) { ud.st = [await sha256(st)]; campos.push('st'); }
  if (zp.length >= 5) { ud.zp = [await sha256(zp)]; campos.push('zp'); }
  ud.country = [await sha256(pais)];
  campos.push('country');

  const ipCheckout = ipValido(venda.ip);
  const ip = ipCheckout || ipValido(visita?.ip);
  if (ip) { ud.client_ip_address = ip; campos.push(ipCheckout ? 'ip:checkout' : 'ip:visita'); }
  const ua = venda.navegador || visita?.ua || '';
  if (ua) { ud.client_user_agent = String(ua).slice(0, 500); campos.push(venda.navegador ? 'ua:checkout' : 'ua:visita'); }

  const ck = venda.cookies || {};
  const fbpCheckout = FBP.test(String(ck.fbp || '')) ? ck.fbp : '';
  const fbp = fbpCheckout || visita?.fbp || '';
  if (fbp) { ud.fbp = fbp; campos.push(fbpCheckout ? 'fbp:checkout' : 'fbp:visita'); }
  const fbcCheckout = FBC.test(String(ck.fbc || '')) ? ck.fbc : '';
  const fbclidCheckout = FBCLID.test(String(ck.fbclid || '')) ? ck.fbclid : '';
  const fbclidUtm = fbclidDoUtm(venda.utm?.utm_content);
  const [fbc, deOnde] = visita?.fbc ? [visita.fbc, 'visita']
    : fbcCheckout ? [fbcCheckout, 'checkout']
      : fbclidCheckout ? [`fb.1.${agoraSeg * 1000}.${fbclidCheckout}`, 'checkout']
        : fbclidUtm ? [`fb.1.${agoraSeg * 1000}.${fbclidUtm}`, 'utm'] : ['', ''];
  if (fbc) { ud.fbc = fbc; campos.push(`fbc:${deOnde}`); }

  // So a Purchase tem par no navegador do checkout para deduplicar, e so quando
  // o checkout da um id que o navegador tambem usa (`idDedup`).
  const dedupNavegador = nome === 'Purchase' ? Boolean(venda.idDedup) : true;
  const eventId = `${nome}-${nome === 'Purchase' && venda.idDedup ? venda.idDedup : venda.pedido}`;

  // A moeda do checkout (quando ele manda) ganha da configuracao.
  const moeda = /^[a-z]{3}$/i.test(String(venda.moeda || '')) ? venda.moeda : cfg.moeda || 'BRL';
  const custom = { currency: String(moeda).toUpperCase(), content_type: 'product', order_id: venda.pedido };
  if (nome === 'Reembolso') custom.tipo = venda.tipo === 'chargeback' ? 'chargeback' : 'reembolso';
  const valor = valorNumerico(venda.valor);
  if (valor !== null) custom.value = valor;
  const ids = (venda.produtos || []).map((p) => String(p?.id || '')).filter(Boolean);
  if (ids.length) custom.content_ids = ids;

  const evento = {
    event_name: nome,
    event_time: agoraSeg,
    event_id: eventId,
    action_source: 'website',
    event_source_url: visita?.url || cfg.dominio || undefined,
    user_data: ud,
    custom_data: custom,
  };
  if (!evento.event_source_url) delete evento.event_source_url;
  return { evento, campos: campos.join(','), dedupNavegador };
}

/** O fbclid que a UTMify poe no utm_content (`::IwAR...` ou `<conteudo>::IwAR...`). */
export function fbclidDoUtm(conteudo) {
  const achado = String(conteudo || '').match(/::([\w-]{20,})/);
  return achado ? achado[1] : '';
}

// ---------------------------------------------------------------------------
// O envio
// ---------------------------------------------------------------------------

/**
 * Manda UM evento a UM pixel. Nunca lanca. Devolve o status para o registro:
 *   enviado         o Meta aceitou (events_received 1)
 *   falhou          rede, 5xx ou 429 -- vale tentar de novo
 *   chave_invalida  erro 190 -- tenta de novo quando a chave for trocada
 *   recusado        outro 4xx -- o Meta nao quer este evento; nao repete
 * O token vai no CORPO, e nao na URL: URL aparece em log de erro.
 */
export async function enviarEvento({ evento, pixel, token, versao, base, codigoTeste, partnerAgent }, buscar = fetch) {
  const corpo = { data: [evento], access_token: token };
  if (codigoTeste) corpo.test_event_code = codigoTeste;
  if (partnerAgent) corpo.partner_agent = partnerAgent;
  const raiz = String(base || GRAPH).replace(/\/$/, '');
  let r;
  try {
    r = await buscar(`${raiz}/${versao || GRAPH_VERSAO_PADRAO}/${encodeURIComponent(pixel)}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
    });
  } catch (erro) {
    return { status: 'falhou', resposta: `rede: ${String(erro).slice(0, 200)}` };
  }
  const resposta = await r.json().catch(() => ({}));
  if (r.ok && resposta?.events_received === 1) {
    return { status: 'enviado', resposta: `fbtrace ${resposta.fbtrace_id || '?'}` };
  }
  const e = resposta?.error;
  const msg = (e
    ? `${r.status} ${e.code ?? ''}/${e.error_subcode ?? ''} ${e.message || ''}${e.error_user_msg ? ` | ${e.error_user_msg}` : ''}`
    : `${r.status} ${JSON.stringify(resposta).slice(0, 200)}`).slice(0, 400);
  if (r.status >= 500 || r.status === 429) return { status: 'falhou', resposta: msg };
  if (e?.code === 190) return { status: 'chave_invalida', resposta: msg };
  return { status: 'recusado', resposta: msg };
}

/**
 * Confere se a chave envia para o pixel SEM sujar o pixel: manda um evento de 9
 * dias atras. Chave boa -> o Meta recusa pela DATA (subcodigo 2804003) e nada
 * entra. Chave ruim -> recusa pela chave (190). Medido no Meta de verdade em
 * 29/10/2026.
 *
 * (A BM restrita nao aparece aqui: ela nem deixa GERAR a chave -- o Hub explica
 * isso na etapa da chave.)
 */
export async function conferirChave({ token, pixel, versao, base }, buscar = fetch) {
  const velho = Math.floor(Date.now() / 1000) - 9 * 86400;
  const evento = {
    event_name: 'Purchase', event_time: velho, event_id: 'Purchase-CONFERENCIA', action_source: 'website',
    user_data: { em: ['0'.repeat(64)], client_user_agent: 'conferencia' }, custom_data: { currency: 'BRL', value: 1 },
  };
  const r = await enviarEvento({ evento, pixel, token, versao, base }, buscar);
  if (/2804003/.test(r.resposta || '')) return { ok: true };
  if (r.status === 'chave_invalida') return { ok: false, motivo: 'chave_invalida', detalhe: r.resposta };
  if (r.status === 'enviado') return { ok: false, motivo: 'inesperado', detalhe: 'o Meta aceitou um evento de 9 dias (nao devia)' };
  return { ok: false, motivo: r.status === 'falhou' ? 'rede' : 'recusada', detalhe: r.resposta };
}

/** A nota de qualidade (EMQ) por evento, pela Dataset Quality API. */
export async function lerQualidade({ token, pixel, versao, base }, buscar = fetch) {
  const raiz = String(base || GRAPH).replace(/\/$/, '');
  const campos = encodeURIComponent('web{event_name,event_match_quality,event_coverage,dedupe_key_feedback,data_freshness}');
  try {
    const r = await buscar(`${raiz}/${versao || GRAPH_VERSAO_PADRAO}/dataset_quality?dataset_id=${encodeURIComponent(pixel)}&fields=${campos}`,
      { headers: { Authorization: `Bearer ${token}` } });
    const dados = await r.json().catch(() => ({}));
    return { status: r.status, ...dados };
  } catch (erro) {
    return { status: 0, erro: `rede: ${String(erro).slice(0, 200)}` };
  }
}
