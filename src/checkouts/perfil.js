// O motor de PERFIS: um checkout e descrito por DADOS (src/checkouts/perfis.js
// ou o perfil "outro" montado pelo cliente), e este arquivo sabe ler qualquer um:
// autenticar o webhook e traduzir o payload para a VENDA NORMALIZADA.
//
// Venda normalizada (o que o motor de envio entende):
//   { origem, tipo: aprovada|reembolso|chargeback|outro, evento, pedido, idDedup,
//     valor (em reais), moeda, produtos[{id, nome}],
//     cliente{email, telefone, nome, cidade, estado, cep},
//     ip, navegador, cookies{fbp, fbc, fbclid}, src, utm{...}, teste }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMINHO = /^[\w$-]+(\.[\w$-]+)*$/;

/** "data.buyer.email" | "items.0.name" -> o valor (ou undefined). */
export function lerCaminho(obj, caminho) {
  if (!caminho) return undefined;
  let atual = obj;
  for (const parte of String(caminho).split('.')) {
    if (atual === null || atual === undefined) return undefined;
    atual = atual[parte];
  }
  return atual;
}

const lista = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);

/** O primeiro valor nao vazio entre os caminhos (string ou numero). */
export function primeiro(obj, caminhos) {
  for (const c of lista(caminhos)) {
    const v = lerCaminho(obj, c);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function iguais(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let dif = 0;
  for (let i = 0; i < x.length; i++) dif |= x[i] ^ y[i];
  return dif === 0;
}

async function hmacHex(algoritmo, chave, corpo) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(chave), { name: 'HMAC', hash: algoritmo }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(corpo));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Confere o webhook. `corpoTexto` sao os bytes exatos que chegaram (o HMAC e
 * sobre eles); `corpoJson` ja interpretado (para segredo dentro do corpo).
 * Sem token configurado, recusa TUDO.
 */
export async function autenticar(perfil, request, corpoTexto, corpoJson, esperado) {
  const token = String(esperado || '').trim();
  if (!token) return { ok: false, onde: 'sem_token' };
  const a = perfil.autenticacao || {};
  const url = new URL(request.url);
  if (a.tipo === 'hmac') {
    const recebida = String((a.query ? url.searchParams.get(a.query) : request.headers.get(a.cabecalho)) || '')
      .trim().toLowerCase().replace(/^sha(1|256)=/, '');
    if (!recebida) return { ok: false, onde: 'sem_assinatura' };
    const calculada = await hmacHex(a.algoritmo || 'SHA-1', token, corpoTexto);
    return iguais(recebida, calculada) ? { ok: true, onde: `hmac ${a.query || a.cabecalho}` } : { ok: false, onde: 'assinatura_errada' };
  }
  if (a.tipo === 'corpo') {
    const v = lerCaminho(corpoJson, a.caminho);
    return v !== undefined && v !== null && iguais(String(v).trim(), token) ? { ok: true, onde: `corpo ${a.caminho}` } : { ok: false, onde: 'nenhum' };
  }
  // 'cabecalho' (padrao): cabecalhos e/ou parametros da URL, o que vier primeiro e bater.
  for (const nome of lista(a.nomes)) {
    const v = String(request.headers.get(nome) || '').replace(/^Bearer\s+/i, '').trim();
    if (v && iguais(v, token)) return { ok: true, onde: `cabecalho ${nome}` };
  }
  for (const nome of lista(a.query)) {
    const v = String(url.searchParams.get(nome) || '').trim();
    if (v && iguais(v, token)) return { ok: true, onde: `url ${nome}` };
  }
  return { ok: false, onde: 'nenhum' };
}

/** Valor em centavos: inteiro = centavos; texto com virgula/ponto = reais. */
function deCentavos(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v / 100 : v;
  const s = String(v || '').trim();
  if (!s) return null;
  if (/[.,]/.test(s)) return s; // ja veio em reais
  const n = Number(s.replace(/\D/g, ''));
  return Number.isFinite(n) ? n / 100 : null;
}

/** Qual o tipo da venda: o PRIMEIRO campo de evento nao vazio decide. */
function tipoDoEvento(perfil, p) {
  const e = perfil.eventos || {};
  const valor = String(primeiro(p, e.campos) || '').trim().toLowerCase();
  const tem = (k) => lista(e[k]).some((x) => String(x).toLowerCase() === valor);
  // Reembolso e chargeback antes: um payload de reembolso pode trazer status antigo.
  if (!valor) return { tipo: 'outro', evento: '' };
  if (tem('chargeback')) return { tipo: 'chargeback', evento: valor };
  if (tem('reembolso')) return { tipo: 'reembolso', evento: valor };
  if (tem('aprovada')) return { tipo: 'aprovada', evento: valor };
  return { tipo: 'outro', evento: valor };
}

function produtosDe(perfil, p) {
  const pr = perfil.produtos || {};
  const itens = pr.lista ? lerCaminho(p, pr.lista) : null;
  if (Array.isArray(itens) && itens.length) {
    return itens.map((i) => ({ id: String(primeiro(i, pr.id) || ''), nome: String(primeiro(i, pr.nome) || '') }));
  }
  const nome = primeiro(p, pr.nomeUnico);
  const id = primeiro(p, pr.idUnico);
  return nome || id ? [{ id: String(id || ''), nome: String(nome || '') }] : [];
}

/** Payload -> venda normalizada, pelo perfil. */
export function traduzir(perfil, p) {
  const c = perfil.campos || {};
  const { tipo, evento } = tipoDoEvento(perfil, p);
  const pega = (k) => primeiro(p, c[k]);
  const ddd = pega('telefoneDdd');
  const tel = pega('telefone');
  const valorReais = pega('valor');
  const valorCent = valorReais === '' ? pega('valorCentavos') : '';
  const idDedup = pega('idDedupUuid');
  const utm = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const v = pega(k);
    if (v !== '') utm[k] = String(v);
  }
  const teste = perfil.eventos?.teste ? lerCaminho(p, perfil.eventos.teste) === true : false;
  return {
    origem: perfil.id,
    tipo: teste ? 'outro' : tipo,
    evento: teste ? 'teste' : evento,
    pedido: String(pega('pedido') || ''),
    idDedup: UUID.test(String(idDedup)) ? String(idDedup) : '',
    valor: valorReais !== '' ? valorReais : valorCent !== '' ? deCentavos(valorCent) : null,
    moeda: String(pega('moeda') || ''),
    produtos: produtosDe(perfil, p),
    cliente: {
      email: String(pega('email') || ''),
      telefone: `${ddd && !String(tel).startsWith(String(ddd)) ? ddd : ''}${tel || ''}`,
      nome: String(pega('nome') || ''),
      cidade: String(pega('cidade') || ''),
      estado: String(pega('estado') || ''),
      cep: String(pega('cep') || ''),
    },
    ip: String(pega('ip') || ''),
    navegador: String(pega('navegador') || ''),
    cookies: { fbp: String(pega('fbp') || ''), fbc: String(pega('fbc') || ''), fbclid: String(pega('fbclid') || '') },
    src: String(pega('src') || '').trim().toLowerCase(),
    utm,
  };
}

// ---------------------------------------------------------------------------
// O perfil "outro" (montado pelo cliente / pela IA dele): validacao
// ---------------------------------------------------------------------------

const CAMPOS = ['pedido', 'valor', 'valorCentavos', 'moeda', 'email', 'nome', 'telefone', 'telefoneDdd', 'cidade',
  'estado', 'cep', 'ip', 'navegador', 'fbp', 'fbc', 'fbclid', 'src', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_content', 'utm_term', 'idDedupUuid'];

function caminhos(v, nome) {
  const l = lista(v).map((x) => String(x).trim()).filter(Boolean);
  if (l.length > 5) throw new Error(`${nome}: no máximo 5 caminhos`);
  for (const c of l) if (!CAMINHO.test(c)) throw new Error(`${nome}: caminho inválido "${c}"`);
  return l;
}

/** Valida e limpa o perfil "outro". Lanca com uma mensagem em portugues. */
export function validarPerfil(entrada) {
  const p = entrada || {};
  const out = { id: 'outro', nome: String(p.nome || 'Outro checkout').slice(0, 60), nivel: 'cliente' };
  const a = p.autenticacao || {};
  if (a.tipo === 'hmac') {
    if (!['SHA-1', 'SHA-256'].includes(a.algoritmo || 'SHA-1')) throw new Error('hmac: algoritmo SHA-1 ou SHA-256');
    if (!a.query && !a.cabecalho) throw new Error('hmac: diga onde vem a assinatura (query ou cabecalho)');
    out.autenticacao = { tipo: 'hmac', algoritmo: a.algoritmo || 'SHA-1', ...(a.query ? { query: String(a.query) } : { cabecalho: String(a.cabecalho) }) };
  } else if (a.tipo === 'corpo') {
    out.autenticacao = { tipo: 'corpo', caminho: caminhos(a.caminho, 'autenticacao.caminho')[0] };
    if (!out.autenticacao.caminho) throw new Error('autenticacao.caminho: onde está o segredo no corpo');
  } else {
    // Padrao: um segredo na URL (?k=...) -- serve para QUALQUER plataforma.
    out.autenticacao = {
      tipo: 'cabecalho',
      nomes: lista(a.nomes).map(String).filter((n) => /^[\w-]{1,40}$/.test(n)).slice(0, 4),
      query: lista(a.query?.length ? a.query : ['k']).map(String).filter((n) => /^[\w-]{1,20}$/.test(n)).slice(0, 2),
    };
  }
  const e = p.eventos || {};
  out.eventos = {
    campos: caminhos(e.campos, 'eventos.campos'),
    aprovada: lista(e.aprovada).map(String).slice(0, 10),
    reembolso: lista(e.reembolso).map(String).slice(0, 10),
    chargeback: lista(e.chargeback).map(String).slice(0, 10),
  };
  if (!out.eventos.campos.length || !out.eventos.aprovada.length) throw new Error('eventos: diga o campo do status e o valor de "venda aprovada"');
  out.campos = {};
  for (const k of CAMPOS) {
    const l = caminhos(p.campos?.[k], `campos.${k}`);
    if (l.length) out.campos[k] = l;
  }
  if (!out.campos.pedido || !out.campos.email) throw new Error('campos: "pedido" e "email" são obrigatórios');
  const pr = p.produtos || {};
  out.produtos = {};
  for (const k of ['lista', 'id', 'nome', 'nomeUnico', 'idUnico']) {
    const l = caminhos(pr[k], `produtos.${k}`);
    if (l.length) out.produtos[k] = k === 'lista' ? l[0] : l;
  }
  if (p.pagina) {
    const dominios = lista(p.pagina.dominios).map((d) => String(d).trim().toLowerCase())
      .filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)).slice(0, 5);
    const parametro = String(p.pagina.parametro || 'src');
    if (dominios.length && /^[a-z_]{1,20}$/.test(parametro)) out.pagina = { dominios, parametro };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ajuda para montar o perfil "outro" a partir de um webhook de exemplo
// ---------------------------------------------------------------------------

const PALPITES = [
  ['email', /(^|\.)(e-?mail)$/i],
  ['nome', /(^|\.)(full_?name|name|nome)$/i],
  ['telefone', /(^|\.)(phone(_?number)?|mobile|cell_?phone|telefone|celular|whatsapp)$/i],
  ['pedido', /(^|\.)(order_?id|sale_?id|transaction(_?id)?|invoice_?id|code|id)$/i],
  ['valor', /(^|\.)(total(_?price)?|amount|price|valor|value|sale_amount)$/i],
  ['valorCentavos', /(InCents|_cents|centavos)$/i],
  ['ip', /(^|\.)(ip|ip_?address|buyer_ip|client_ip)$/i],
  ['src', /(^|\.)(src)$/i],
  ['fbp', /(^|\.)(fbp|_fbp)$/i],
  ['fbc', /(^|\.)(fbc|_fbc)$/i],
  ['fbclid', /(^|\.)(fbclid)$/i],
  ['cidade', /(^|\.)(city|cidade)$/i],
  ['estado', /(^|\.)(state|uf|estado)$/i],
  ['cep', /(^|\.)(zip_?code|zip|cep|postal_?code)$/i],
  ['utm_source', /(^|\.)utm_?source$/i],
  ['utm_medium', /(^|\.)utm_?medium$/i],
  ['utm_campaign', /(^|\.)utm_?campaign$/i],
  ['utm_content', /(^|\.)utm_?content$/i],
  ['utm_term', /(^|\.)utm_?term$/i],
];
// O campo que diz o que aconteceu (em ingles ou portugues): event, status,
// order_status, webhook_event_type, sale_status_enum, tipo_evento, situacao...
const EVENTO = /(^|\.)(\w*event\w*|\w*status\w*|\w*evento\w*|situacao\w*|tipo)$/i;

function mascarar(caminho, v) {
  if (typeof v !== 'string') return v;
  if (EVENTO.test(caminho)) return v; // o valor do status e o que monta o perfil
  if (/@/.test(v)) return `${v.slice(0, 2)}…@…`;
  if (v.length > 6) return `${v.slice(0, 3)}…(${v.length})`;
  return v;
}

/** Lista os campos do exemplo (com amostras mascaradas) e sugere um perfil. */
export function analisarExemplo(exemplo) {
  const campos = [];
  const andar = (o, base, nivel) => {
    if (nivel > 6 || campos.length > 300) return;
    if (Array.isArray(o)) { if (o.length) andar(o[0], `${base}.0`, nivel + 1); return; }
    if (o && typeof o === 'object') { for (const [k, v] of Object.entries(o)) andar(v, base ? `${base}.${k}` : k, nivel + 1); return; }
    campos.push({ caminho: base, tipo: typeof o, amostra: mascarar(base, o) });
  };
  andar(exemplo, '', 0);
  const sugestao = { campos: {}, eventos: { campos: [], aprovada: [], reembolso: [], chargeback: [] } };
  for (const [k, re] of PALPITES) {
    const achados = campos.filter((c) => re.test(c.caminho)).map((c) => c.caminho);
    // O mais raso primeiro (ex.: "order_id" antes de "items.0.id").
    achados.sort((a, b) => a.split('.').length - b.split('.').length);
    if (achados.length) sugestao.campos[k] = achados.slice(0, 2);
  }
  sugestao.eventos.campos = campos.filter((c) => EVENTO.test(c.caminho) && c.tipo === 'string').map((c) => c.caminho).slice(0, 2);
  const lst = campos.find((c) => /\.0\./.test(c.caminho) && /(name|nome)$/i.test(c.caminho));
  if (lst) {
    const [listaCam] = lst.caminho.split('.0.');
    sugestao.produtos = { lista: listaCam, nome: [lst.caminho.split('.0.')[1]], id: ['id'] };
  }
  return { campos, sugestao };
}
