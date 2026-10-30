// Suite dos PERFIS de checkout (sem rede, sem Worker): cada perfil pronto le um
// webhook de exemplo do formato daquele checkout, autentica do jeito dele, e os
// CONTROLES provam que o teste consegue falhar (assinatura errada, segredo
// errado, evento que nao e venda virando Compra...).
//
//   node teste/perfis.mjs
//
// Os exemplos seguem: vendas reais (Kirvano), o vetor de teste oficial e os
// campos de vendas reais (Kiwify), a documentacao oficial (Hotmart, Eduzz,
// Cakto) e o formato de pedido publicado pela UTMify (o "Formato padrao").

import { analisarExemplo, autenticar, traduzir, validarPerfil } from '../src/checkouts/perfil.js';
import { PERFIS } from '../src/checkouts/perfis.js';

let total = 0;
let falhas = 0;
const secao = (t) => console.log(`\n- ${t}`);
function ok(nome, cond, detalhe = '') {
  total++;
  console.log(`  ${cond ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? `  (${detalhe})` : ''}`);
  if (!cond) falhas++;
}
const req = (url, cab = {}, corpo = '{}') => new Request(url, { method: 'POST', headers: cab, body: corpo });
const auth = (perfil, r, corpo, token) => autenticar(perfil, r, corpo, JSON.parse(corpo), token);

// ------------------------------------------------------------------ Kirvano
secao('Kirvano (confirmado: vendas reais)');
{
  const p = {
    event: 'SALE_APPROVED', sale_id: '80MWWQWY', checkout_id: 'Q8J1N6K3', status: 'APPROVED', total_price: 'R$ 44,60',
    ip: '177.10.1.2', cookies: { fbclid: 'IwAR_cookie_kirvano_0123456789' },
    customer: { name: 'Ana Souza', email: 'ana@exemplo.com', phone_number: '27999990000', address: { city: 'Serra', state: 'ES', zipcode: '29160000' } },
    products: [{ id: 'p1', name: 'Curso' }], utm: { src: 'ABC123', utm_source: 'FB' },
  };
  const v = traduzir(PERFIS.kirvano, p);
  ok('aprovada, pedido, valor, e-mail, telefone', v.tipo === 'aprovada' && v.pedido === '80MWWQWY' && v.valor === 'R$ 44,60'
    && v.cliente.email === 'ana@exemplo.com' && v.cliente.telefone === '27999990000');
  ok('src (minúsculo), IP, fbclid do cookie, produto', v.src === 'abc123' && v.ip === '177.10.1.2'
    && v.cookies.fbclid.startsWith('IwAR') && v.produtos[0].nome === 'Curso');
  ok('checkout_id de 8 letras nao deduplica', v.idDedup === '');
  ok('CONTROLE: SALE_REFUSED nao e venda', traduzir(PERFIS.kirvano, { ...p, event: 'SALE_REFUSED' }).tipo === 'outro');
  ok('CONTROLE: PIX_GENERATED nao e venda', traduzir(PERFIS.kirvano, { ...p, event: 'PIX_GENERATED', status: 'PENDING' }).tipo === 'outro');
  ok('reembolso com status antigo "APPROVED" continua reembolso', traduzir(PERFIS.kirvano, { ...p, event: 'SALE_REFUNDED' }).tipo === 'reembolso');
  const c = JSON.stringify(p);
  ok('token no cabecalho security-token', (await auth(PERFIS.kirvano, req('https://x/w/kirvano', { 'security-token': 'tk-1' }, c), c, 'tk-1')).ok);
  ok('CONTROLE: token errado', !(await auth(PERFIS.kirvano, req('https://x/w/kirvano', { 'security-token': 'tk-2' }, c), c, 'tk-1')).ok);
  ok('CONTROLE: sem token configurado recusa tudo', (await auth(PERFIS.kirvano, req('https://x/w/kirvano', { 'security-token': '' }, c), c, '')).onde === 'sem_token');
}

// ------------------------------------------------------------------- Kiwify
secao('Kiwify (assinatura: vetor de teste oficial)');
{
  const corpo = '{"order_id":"9b1c2d3e-0000-4000-8000-000000000001","order_status":"paid","webhook_event_type":"order_approved"}';
  const certa = 'bf18f352a4f981b91dfa3f6d8742a81080ab8c86';
  ok('HMAC-SHA1 bate com o vetor oficial', (await auth(PERFIS.kiwify, req(`https://x/w/kiwify?signature=${certa}`, {}, corpo), corpo, 'kiwify-token-de-teste')).ok);
  ok('CONTROLE: assinatura com 1 caractere trocado', !(await auth(PERFIS.kiwify, req(`https://x/w/kiwify?signature=${certa.replace(/.$/, '7')}`, {}, corpo), corpo, 'kiwify-token-de-teste')).ok);
  ok('CONTROLE: corpo alterado (mesma assinatura)', !(await auth(PERFIS.kiwify, req(`https://x/w/kiwify?signature=${certa}`, {}, corpo.replace('paid', 'pago')), corpo.replace('paid', 'pago'), 'kiwify-token-de-teste')).ok);
  ok('CONTROLE: sem ?signature', (await auth(PERFIS.kiwify, req('https://x/w/kiwify', {}, corpo), corpo, 'kiwify-token-de-teste')).onde === 'sem_assinatura');
  const p = {
    order_id: 'k-1', order_status: 'paid', webhook_event_type: 'order_approved',
    Product: { product_id: 'pp', product_name: 'Curso K' }, Customer: { email: 'b@exemplo.com', full_name: 'Bia Lima', mobile: '+5511988887777' },
    Commissions: { charge_amount: 9700, currency: 'BRL' }, TrackingParameters: { src: 'VIS1', utm_source: 'FB' },
  };
  const v = traduzir(PERFIS.kiwify, p);
  ok('aprovada, valor em centavos -> reais, produto unico', v.tipo === 'aprovada' && v.valor === 97 && v.produtos[0].nome === 'Curso K' && v.moeda === 'BRL');
  ok('src em TrackingParameters', v.src === 'vis1' && v.utm.utm_source === 'FB');
  ok('CONTROLE: renovacao de assinatura nao vira Compra nova', traduzir(PERFIS.kiwify, { ...p, webhook_event_type: 'subscription_renewed' }).tipo === 'outro');
  ok('reembolso e chargeback', traduzir(PERFIS.kiwify, { ...p, webhook_event_type: 'order_refunded', order_status: 'refunded' }).tipo === 'reembolso'
    && traduzir(PERFIS.kiwify, { ...p, webhook_event_type: 'chargeback', order_status: 'chargedback' }).tipo === 'chargeback');
  ok('pix gerado nao e venda', traduzir(PERFIS.kiwify, { ...p, webhook_event_type: 'pix_created', order_status: 'waiting_payment' }).tipo === 'outro');
}

// ------------------------------------------------------------------ Hotmart
secao('Hotmart (documentado)');
{
  const p = {
    event: 'PURCHASE_APPROVED', version: '2.0.0',
    data: {
      product: { id: 123, name: 'Curso H' },
      buyer: { email: 'c@exemplo.com', name: 'Caio Prado', checkout_phone: '5521977776666', address: { city: 'Niterói', state: 'RJ', zipcode: '24000000' } },
      purchase: { transaction: 'HP1699', price: { value: 197.0, currency_value: 'BRL' }, origin: { sck: 'VIS2', src: '' } },
    },
  };
  const v = traduzir(PERFIS.hotmart, p);
  ok('aprovada, transacao, valor, moeda, telefone, produto', v.tipo === 'aprovada' && v.pedido === 'HP1699' && v.valor === 197
    && v.moeda === 'BRL' && v.cliente.telefone === '5521977776666' && v.produtos[0].id === '123');
  ok('id da visita no sck quando o src vem vazio', v.src === 'vis2');
  ok('CONTROLE: PURCHASE_COMPLETE (semanas depois) nao conta de novo', traduzir(PERFIS.hotmart, { ...p, event: 'PURCHASE_COMPLETE' }).tipo === 'outro');
  ok('CONTROLE: boleto impresso nao e venda', traduzir(PERFIS.hotmart, { ...p, event: 'PURCHASE_BILLET_PRINTED' }).tipo === 'outro');
  ok('reembolso e chargeback', traduzir(PERFIS.hotmart, { ...p, event: 'PURCHASE_REFUNDED' }).tipo === 'reembolso'
    && traduzir(PERFIS.hotmart, { ...p, event: 'PURCHASE_CHARGEBACK' }).tipo === 'chargeback');
  const c = JSON.stringify(p);
  ok('hottok no cabecalho X-HOTMART-HOTTOK', (await auth(PERFIS.hotmart, req('https://x/w/hotmart', { 'X-HOTMART-HOTTOK': 'hot-1' }, c), c, 'hot-1')).ok);
  ok('CONTROLE: hottok errado', !(await auth(PERFIS.hotmart, req('https://x/w/hotmart', { 'X-HOTMART-HOTTOK': 'hot-2' }, c), c, 'hot-1')).ok);
}

// -------------------------------------------------------------------- Eduzz
secao('Eduzz (documentado)');
{
  const p = {
    event: 'myeduzz.invoice_paid',
    data: {
      id: '12345678', status: 'paid', paid: { value: 301.5, currency: 'BRL' }, producer: { originSecret: 'origem-1' },
      buyer: { email: 'd@exemplo.com', name: 'Duda Reis', cellphone: '11966665555', address: { city: 'Campinas', state: 'SP', zipCode: '13000-000' } },
      items: [{ productId: 'P567', name: 'Widget X' }, { productId: 'P789', name: 'Gadget Y' }],
      utm: { source: 'fb', campaign: 'c1' }, tracker: { code1: 'VIS3' },
    },
  };
  const v = traduzir(PERFIS.eduzz, p);
  ok('aprovada, fatura, valor, celular, 2 itens, UTMs', v.tipo === 'aprovada' && v.pedido === '12345678' && v.valor === 301.5
    && v.cliente.telefone === '11966665555' && v.produtos.length === 2 && v.utm.utm_campaign === 'c1');
  const c = JSON.stringify(p);
  ok('segredo em data.producer.originSecret', (await auth(PERFIS.eduzz, req('https://x/w/eduzz', {}, c), c, 'origem-1')).ok);
  ok('CONTROLE: segredo errado no corpo', !(await auth(PERFIS.eduzz, req('https://x/w/eduzz', {}, c), c, 'origem-2')).ok);
}

// -------------------------------------------------------------------- Cakto
secao('Cakto (documentado)');
{
  const p = {
    secret: 'ck-1', event: 'purchase_approved',
    data: {
      id: 'b1c2-uuid', refId: 'ABC', status: 'paid', amount: 67.9, sck: 'VIS4', fbp: 'fb.1.1793100000000.123', fbc: 'fb.1.1793100000000.IwAR_x',
      customer: { email: 'e@exemplo.com', name: 'Edu Neves', phone: '31955554444' }, product: { id: 'pr1', name: 'Ebook' },
    },
  };
  const v = traduzir(PERFIS.cakto, p);
  ok('aprovada, valor, fbc e fbp do checkout, sck', v.tipo === 'aprovada' && v.valor === 67.9 && v.cookies.fbp.startsWith('fb.1.')
    && v.cookies.fbc.startsWith('fb.1.') && v.src === 'vis4');
  const c = JSON.stringify(p);
  ok('segredo em "secret" no corpo', (await auth(PERFIS.cakto, req('https://x/w/cakto', {}, c), c, 'ck-1')).ok);
  ok('CONTROLE: segredo errado', !(await auth(PERFIS.cakto, req('https://x/w/cakto', {}, c), c, 'ck-9')).ok);
}

// ------------------------------------------------------------ Formato padrao
secao('Formato padrão (o formato de pedido publicado pela UTMify)');
{
  const p = {
    orderId: 'GP-9', platform: 'GlobalPay', paymentMethod: 'pix', status: 'paid', createdAt: '2026-10-30 10:00:00', approvedDate: '2026-10-30 10:01:00',
    customer: { name: 'Fabi Rocha', email: 'f@exemplo.com', phone: '11944443333', document: '12345678900', country: 'BR', ip: '2804::5' },
    products: [{ id: 'x1', name: 'Mentoria', planId: null, planName: null, quantity: 1, priceInCents: 49700 }],
    trackingParameters: { src: 'VIS5', sck: null, utm_source: 'FB', utm_campaign: null, utm_medium: null, utm_content: null, utm_term: null },
    commission: { totalPriceInCents: 49700, gatewayFeeInCents: 2000, userCommissionInCents: 47700 },
  };
  const v = traduzir(PERFIS.padrao, p);
  ok('aprovada, centavos -> reais, IP, src', v.tipo === 'aprovada' && v.valor === 497 && v.ip === '2804::5' && v.src === 'vis5');
  ok('CONTROLE: isTest=true nao vira Compra', traduzir(PERFIS.padrao, { ...p, isTest: true }).tipo === 'outro');
  ok('CONTROLE: refused nao e venda', traduzir(PERFIS.padrao, { ...p, status: 'refused' }).tipo === 'outro');
  const c = JSON.stringify(p);
  ok('token no cabecalho x-api-token', (await auth(PERFIS.padrao, req('https://x/w/padrao', { 'x-api-token': 'pd-1' }, c), c, 'pd-1')).ok);
  ok('ou segredo na URL (?k=), para quem nao escolhe cabecalho', (await auth(PERFIS.padrao, req('https://x/w/padrao?k=pd-1', {}, c), c, 'pd-1')).ok);
  ok('CONTROLE: ?k errado', !(await auth(PERFIS.padrao, req('https://x/w/padrao?k=pd-2', {}, c), c, 'pd-1')).ok);
}

// ------------------------------------------------------------ "Outro checkout"
secao('"Outro checkout": perfil montado a partir de um exemplo');
{
  // Um checkout "desconhecido", com nomes em portugues e telefone com DDD separado.
  const exemplo = {
    tipo_evento: 'venda.aprovada', codigo_venda: 'Z-77', valor_total: '149,90',
    comprador: { email_contato: 'g@exemplo.com', nome_completo: 'Gabi Torres', ddd: '48', telefone: '933332222', ip: '200.1.2.3' },
    rastreio: { src: 'VIS6', utm_source: 'ig' }, itens: [{ id: 'i1', nome: 'Workshop' }],
  };
  const a = analisarExemplo(exemplo);
  ok('lista os campos do exemplo', a.campos.length >= 10 && a.campos.some((c) => c.caminho === 'comprador.email_contato'));
  ok('amostras mascaradas (e-mail nao aparece inteiro)', !JSON.stringify(a.campos).includes('g@exemplo.com'));
  ok('o valor do status aparece inteiro (e o que monta o perfil)', a.campos.find((c) => c.caminho === 'tipo_evento')?.amostra === 'venda.aprovada');
  ok('sugere src, ip e a lista de produtos', a.sugestao.campos.src?.[0] === 'rastreio.src' && a.sugestao.campos.ip?.[0] === 'comprador.ip'
    && a.sugestao.produtos?.lista === 'itens');
  const perfil = validarPerfil({
    nome: 'Checkout Z', eventos: { campos: ['tipo_evento'], aprovada: ['venda.aprovada'], reembolso: ['venda.reembolsada'] },
    campos: {
      pedido: 'codigo_venda', valor: 'valor_total', email: 'comprador.email_contato', nome: 'comprador.nome_completo',
      telefoneDdd: 'comprador.ddd', telefone: 'comprador.telefone', ip: 'comprador.ip', src: 'rastreio.src', utm_source: 'rastreio.utm_source',
    },
    produtos: { lista: 'itens', id: 'id', nome: 'nome' }, pagina: { dominios: ['pay.checkoutz.com'], parametro: 'src' },
  });
  ok('perfil valido: segredo na URL (?k=) por padrao', perfil.autenticacao.tipo === 'cabecalho' && perfil.autenticacao.query[0] === 'k');
  const v = traduzir(perfil, exemplo);
  ok('le a venda: aprovada, valor, telefone com DDD, IP, src, produto', v.tipo === 'aprovada' && v.valor === '149,90'
    && v.cliente.telefone === '48933332222' && v.ip === '200.1.2.3' && v.src === 'vis6' && v.produtos[0].nome === 'Workshop');
  let erro = '';
  try { validarPerfil({ eventos: { campos: ['x'] }, campos: { pedido: 'a', email: 'b' } }); } catch (e) { erro = e.message; }
  ok('CONTROLE: sem o valor de "venda aprovada" e recusado', /aprovada/.test(erro), erro);
  erro = '';
  try { validarPerfil({ eventos: { campos: ['x'], aprovada: ['y'] }, campos: { pedido: 'a;drop', email: 'b' } }); } catch (e) { erro = e.message; }
  ok('CONTROLE: caminho invalido e recusado', /inválido/.test(erro), erro);
  erro = '';
  try { validarPerfil({ eventos: { campos: ['x'], aprovada: ['y'] }, campos: { pedido: 'a' } }); } catch (e) { erro = e.message; }
  ok('CONTROLE: sem e-mail e recusado', /email/.test(erro), erro);
}

// ------------------------------------------------------------ todos os perfis
secao('todos os perfis prontos');
for (const p of Object.values(PERFIS)) {
  ok(`${p.id}: tem aprovada, pedido e e-mail`, p.eventos.aprovada.length > 0 && p.campos.pedido?.length > 0 && p.campos.email?.length > 0);
}

console.log(`\n${total - falhas}/${total} ok${falhas ? ` — ${falhas} FALHA(S)` : ''}\n`);
process.exit(falhas ? 1 : 0);
