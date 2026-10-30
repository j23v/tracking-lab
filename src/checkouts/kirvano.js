// Adaptador da Kirvano: autentica o webhook e traduz o payload para a VENDA
// NORMALIZADA que o motor (src/motor.js) entende. Um adaptador por checkout;
// o resto do sistema nao sabe de onde a venda veio.
//
// O formato abaixo e o de vendas reais (28–29/10/2026):
//   event, sale_id, checkout_id (8 letras, NAO e o uuid do navegador), status,
//   total_price, ip, cookies{fbp, fbclid}, customer{name, email, phone_number,
//   document, address{city, state, zipcode}}, products[{id, name, ...}],
//   utm{src, utm_source, utm_medium, utm_campaign, utm_content, utm_term}

export const nome = 'kirvano';
/** Onde o /v.js poe o id da visita, e em quais links. */
export const dominios = ['kirvano.com'];
export const parametro = 'src';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iguais(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let dif = 0;
  for (let i = 0; i < x.length; i++) dif |= x[i] ^ y[i];
  return dif === 0;
}

/**
 * A Kirvano nao documenta por onde o token viaja; as vendas reais chegaram no
 * cabecalho `security-token`. Os outros lugares ficam aceitos (quem autoriza e
 * a comparacao, nao o lugar). Sem token configurado, recusa TUDO.
 */
export function autenticar(request, esperado) {
  const token = String(esperado || '').trim();
  if (!token) return { ok: false, onde: 'sem_token' };
  const url = new URL(request.url);
  const cab = (n) => request.headers.get(n) || '';
  const candidatos = [
    ['security-token', cab('security-token')],
    ['x-kirvano-token', cab('x-kirvano-token')],
    ['token', cab('token')],
    ['authorization', cab('authorization').replace(/^Bearer\s+/i, '')],
    ['query token', url.searchParams.get('token') || ''],
  ];
  for (const [onde, valor] of candidatos) {
    if (valor && iguais(valor.trim(), token)) return { ok: true, onde };
  }
  return { ok: false, onde: 'nenhum' };
}

/**
 * Payload -> venda normalizada.
 *   tipo: aprovada | reembolso | chargeback | outro
 * `SALE_REFUSED` (pagamento recusado) e `PIX_GENERATED` viram "outro": ninguem
 * pagou, nao ha Compra nem Reembolso.
 */
export function traduzir(p) {
  const evento = String(p?.event || '').trim().toUpperCase();
  const status = String(p?.status || '').trim().toUpperCase();
  let tipo = 'outro';
  if (evento === 'SALE_APPROVED' || (!evento && status === 'APPROVED')) tipo = 'aprovada';
  else if (evento === 'SALE_REFUNDED') tipo = 'reembolso';
  else if (evento === 'SALE_CHARGEBACK') tipo = 'chargeback';

  const c = p?.customer || {};
  const end = c.address && typeof c.address === 'object' ? c.address : {};
  const utm = p?.utm && typeof p.utm === 'object' ? p.utm : {};
  const src = [utm.src, p?.utms?.src, p?.src].find((v) => typeof v === 'string' && v.trim());
  const checkout = String(p?.checkout_id || '');

  return {
    origem: nome,
    tipo,
    evento,
    pedido: String(p?.sale_id || p?.checkout_id || ''),
    // O navegador da Kirvano usa `Purchase-<uuid do checkout>`; o webhook traz
    // um id de 8 letras. So um uuid de verdade deduplica com o navegador.
    idDedup: UUID.test(checkout) ? checkout : '',
    valor: p?.total_price,
    produtos: (Array.isArray(p?.products) ? p.products : []).map((i) => ({ id: i?.id, nome: i?.name })),
    cliente: {
      email: c.email, telefone: c.phone_number, nome: c.name,
      cidade: end.city || end.cidade, estado: end.state || end.uf, cep: end.zipcode || end.zip_code || end.cep,
    },
    ip: p?.ip,
    navegador: '',
    cookies: p?.cookies && typeof p.cookies === 'object' ? p.cookies : {},
    src: src ? src.trim().toLowerCase() : '',
    utm,
  };
}
