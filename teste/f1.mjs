// Suite da F1 (o motor), contra o runtime e o D1 DE VERDADE (wrangler dev, banco
// local numa pasta temporaria) e um Meta FALSO num servidor local. Nada sai do
// computador.
//
//   node teste/f1.mjs          (WRANGLER=<caminho> para usar outro wrangler)
//
// Cada CONTROLE prova que o teste consegue falhar: token errado nao entra, chave
// ruim nao e gravada, CPF nunca vai ao Meta, reenvio do checkout nao manda 2x,
// chave invalida nao e repetida sem trocar a chave, teste sem codigo nao roda.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = 8799;
const PORTA_META = 8800;
const BASE = `http://127.0.0.1:${PORTA}`;
const SENHA = 'senha-da-suite-f1-456';
const TOKEN_KIRVANO = 'tok-kirvano-da-suite';
const PRODUTO = 'Curso Exemplo';

const WR = process.env.WRANGLER
  || [join(RAIZ, 'node_modules', '.bin', 'wrangler.cmd'), join(RAIZ, 'node_modules', '.bin', 'wrangler')].find(existsSync);
if (!WR) { console.error('wrangler nao encontrado: rode `npm install` (ou defina WRANGLER=<caminho>).'); process.exit(2); }

let total = 0;
let falhas = 0;
const secao = (t) => console.log(`\n- ${t}`);
function ok(nome, cond, detalhe = '') {
  total++;
  console.log(`  ${cond ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? `  (${detalhe})` : ''}`);
  if (!cond) falhas++;
}
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ o Meta falso
const chamadas = [];
let falhou500 = false;
const meta = createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    if (req.url.startsWith('/pagina')) {
      // Uma pagina de vendas de mentira para a deteccao ("Suas plataformas").
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('x-litespeed-cache', 'hit');
      res.end(`<html><head><link rel="stylesheet" href="/wp-content/themes/x.css"><script src="https://cdn.utmify.com.br/scripts/utms/latest.js"></script>
<script src="${BASE}/v.js" async></script><script>fbq('init', '111111'); fbq('track','Purchase');</script></head>
<body class="elementor-page"><a href="https://pay.kirvano.com/abc">Comprar</a></body></html>`);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/dataset_quality')) {
      res.end(JSON.stringify({ web: [{ event_name: 'Purchase', event_match_quality: { composite_score: 9.0 } }] }));
      return;
    }
    const j = JSON.parse(corpo || '{}');
    const ev = j.data?.[0] || {};
    const pixel = req.url.split('/')[2];
    chamadas.push({ pixel, corpo: j, cru: corpo });
    const erro = (status, e) => { res.statusCode = status; res.end(JSON.stringify({ error: e })); };
    if (j.access_token === 'TOKEN-RUIM') return erro(401, { code: 190, message: 'Invalid OAuth access token.' });
    if (Date.now() / 1000 - ev.event_time > 7 * 86400) return erro(400, { code: 100, error_subcode: 2804003, message: 'event_time too old' });
    const pedido = ev.custom_data?.order_id;
    if (pedido === 'FALHA-500' && !falhou500) { falhou500 = true; res.statusCode = 500; res.end('{}'); return; }
    if (pedido === 'CHAVE-190' && j.access_token === 'TOKEN-BOM') return erro(400, { code: 190, message: 'Error validating access token' });
    res.end(JSON.stringify({ events_received: 1, fbtrace_id: 'trace-falso' }));
  });
});

// ------------------------------------------------------------ apoio
let cookie = '';
async function api(caminho, corpo, metodo) {
  const r = await fetch(`${BASE}${caminho}`, {
    method: metodo || (corpo ? 'POST' : 'GET'),
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
async function webhook(payload, token = TOKEN_KIRVANO) {
  const r = await fetch(`${BASE}/w/kirvano`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'security-token': token } : {}) },
    body: JSON.stringify(payload),
  });
  return r.status;
}
/** Espera o processamento em segundo plano (waitUntil) aparecer em `envios`. */
async function envio(pedido, evento = 'Purchase', pixel, aceitar = () => true, ms = 6000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const { j } = await api('/lab/api/envios?horas=48');
    const l = (j.ultimos || []).find((u) => u.pedido === pedido && u.evento === evento && (!pixel || u.pixel === pixel) && aceitar(u));
    if (l) return l;
    await espera(250);
  }
  return null;
}
const chamadasDe = (pedido) => chamadas.filter((c) => c.corpo.data?.[0]?.custom_data?.order_id === pedido);

const VISITA = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const venda = (extra = {}) => ({
  event: 'SALE_APPROVED', sale_id: 'V-001', checkout_id: 'Q8J1N6K3', status: 'APPROVED', total_price: 'R$ 97,00',
  ip: '2804:14c:9::77', cookies: { fbp: 'fb.1.1793100000000.987654321' },
  customer: {
    name: 'Joana Conceição da Silva', document: '12345678900', email: ' Joana.Teste@Exemplo.com ', phone_number: '(27) 99999-0000',
    address: { city: 'Serra', state: 'ES', zipcode: '29160-000' },
  },
  products: [{ id: 'p1', name: PRODUTO }],
  utm: { src: VISITA, utm_source: 'FB', utm_content: 'x::IwAR_utm_nao_deve_ganhar_1234567890' },
  ...extra,
});

// ------------------------------------------------------------ a suite
await new Promise((r) => meta.listen(PORTA_META, '127.0.0.1', r));
const estado = mkdtempSync(join(tmpdir(), 'tl-f1-'));
const wr = (args) => execFileSync(WR, args, { cwd: RAIZ, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
let worker;
try {
  secao('instalacao local');
  wr(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', `"${estado}"`]);
  ok('migracoes 0001 e 0002 aplicadas', true);
  worker = spawn(WR, ['dev', '--local', '--port', String(PORTA), '--ip', '127.0.0.1', '--persist-to', `"${estado}"`, '--test-scheduled',
    '--var', `SENHA_HUB:${SENHA}`, '--var', `META_GRAPH_BASE:http://127.0.0.1:${PORTA_META}`, '--var', 'META_GRAPH_VERSAO:v25.0',
    '--show-interactive-dev-session=false'], { cwd: RAIZ, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const fim = Date.now() + 90000;
  let subiu = false;
  while (Date.now() < fim && !subiu) {
    try { subiu = (await fetch(`${BASE}/saude`)).status === 200; } catch { /* subindo */ }
    if (!subiu) await espera(500);
  }
  if (!subiu) throw new Error('o worker nao subiu em 90 s');
  const saude = await (await fetch(`${BASE}/saude`)).json();
  const versao = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')).version;
  ok('/saude ok, na versao do package.json', saude.ok === true && saude.versao === versao, JSON.stringify(saude));
  const entrar = await fetch(`${BASE}/lab/entrar`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ senha: SENHA }) });
  cookie = (entrar.headers.get('set-cookie') || '').split(';')[0];
  ok('entrou no Hub', entrar.status === 303 && cookie.startsWith('tl_sessao='));
  ok('CONTROLE: API sem login recusa', (await fetch(`${BASE}/lab/api/config`)).status === 401);

  secao('webhook antes do token');
  ok('CONTROLE: sem token configurado -> 401', (await webhook(venda({ sale_id: 'V-SEMTOKEN' }))) === 401);
  await espera(300);
  ok('alerta "webhook_sem_token"', (await api('/lab/api/status')).j.alertas.some((a) => a.tipo === 'webhook_sem_token'));
  ok('token do webhook salvo', (await api('/lab/api/segredo', { nome: 'kirvano_token', valor: TOKEN_KIRVANO })).j.ok === true);
  ok('CONTROLE: token errado -> 401', (await webhook(venda({ sale_id: 'V-ERRADO' }), 'outro-token')) === 401);

  secao('venda antes do pixel e da chave: guardada, nao perdida');
  ok('webhook aceito', (await webhook(venda({ sale_id: 'V-SEMCFG', utm: {} }))) === 200);
  const semCfg = await envio('V-SEMCFG', 'Purchase', '*');
  ok('fica como sem_config, guardada', semCfg?.status === 'sem_config', semCfg?.status);
  ok('nada foi ao Meta', chamadas.length === 0);

  secao('configuracao');
  ok('CONTROLE: pixel invalido recusado', (await api('/lab/api/config', { pixels: ['abc'] })).status === 400);
  const cfg = await api('/lab/api/config', { pixels: ['111111'], dominio: 'loja.exemplo.com', produtos: [PRODUTO] });
  ok('pixel, dominio e produto gravados', cfg.j.ok && cfg.j.config.dominio === 'https://loja.exemplo.com/' && cfg.j.config.pixels[0] === '111111');

  secao('chave do Meta (conferida antes de gravar)');
  const ruim = await api('/lab/api/segredo', { nome: 'meta_token', valor: 'TOKEN-RUIM' });
  ok('CONTROLE: chave ruim recusada e NAO gravada', ruim.status === 422 && ruim.j.motivo === 'chave_invalida'
    && !(await api('/lab/api/status')).j.segredos.some((s) => s.nome === 'meta_token'));
  const n0 = chamadas.length;
  const boa = await api('/lab/api/segredo', { nome: 'meta_token', valor: 'TOKEN-BOM' });
  // (chave curta de mentira: a dica sai "…"; uma chave real do Meta tem ~200 caracteres)
  ok('chave boa gravada, so a dica volta', boa.j.ok === true && Boolean(boa.j.dica) && !JSON.stringify(boa.j).includes('TOKEN-BOM'));
  const conf = chamadas.slice(n0);
  ok('a conferencia usou um evento velho (nao entra no pixel)', conf.length === 1 && Date.now() / 1000 - conf[0].corpo.data[0].event_time > 8 * 86400);

  secao('reenvio da venda guardada');
  await api('/lab/api/reenviar', {});
  const guardada = await envio('V-SEMCFG', 'Purchase', '111111', (u) => u.status === 'enviado');
  ok('a venda que chegou antes da configuracao foi enviada', Boolean(guardada));
  ok('a linha "*" saiu', !(await envio('V-SEMCFG', 'Purchase', '*', () => true, 500)));

  secao('pagina de vendas');
  const js = await (await fetch(`${BASE}/v.js`)).text();
  let sintaxe = true;
  try { new Function(js); } catch { sintaxe = false; } // eslint-disable-line no-new-func
  ok('/v.js e JavaScript valido e marca os links da Kirvano', sintaxe && js.includes('kirvano') && js.includes('"src"'));
  const vis = await fetch(`${BASE}/visita`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': 'Mozilla/5.0 suite' },
    body: JSON.stringify({ id: VISITA, fbclid: 'IwAR_visita_da_suite_1234567890', fbclid_em: 1793100000000, fbp: 'fb.1.1.2', url: 'https://loja.exemplo.com/oferta' }),
  });
  ok('visita gravada (204)', vis.status === 204);
  ok('CONTROLE: visita com id ruim -> 400', (await fetch(`${BASE}/visita`, { method: 'POST', body: '{"id":"x"}' })).status === 400);

  secao('venda aprovada ligada a visita');
  ok('webhook aceito', (await webhook(venda())) === 200);
  const v1 = await envio('V-001');
  ok('enviada ao Meta', v1?.status === 'enviado', v1?.resposta);
  const c1 = chamadasDe('V-001')[0];
  const ev = c1?.corpo.data?.[0] || {};
  ok('event_id Purchase-<sale_id> (o checkout_id de 8 letras nao deduplica)', ev.event_id === 'Purchase-V-001' && v1?.campos?.includes('SEM_DEDUP'));
  ok('e-mail normalizado e em hash', ev.user_data?.em?.[0] === sha('joana.teste@exemplo.com'));
  ok('telefone com 55, em hash', ev.user_data?.ph?.[0] === sha('5527999990000'));
  ok('cidade/estado/CEP em hash', ev.user_data?.ct?.[0] === sha('serra') && ev.user_data?.st?.[0] === sha('es') && ev.user_data?.zp?.[0] === sha('29160000'));
  ok('IP e _fbp do CHECKOUT', ev.user_data?.client_ip_address === '2804:14c:9::77' && ev.user_data?.fbp === 'fb.1.1793100000000.987654321');
  ok('fbc da VISITA (ganha do utm_content)', ev.user_data?.fbc === 'fb.1.1793100000000.IwAR_visita_da_suite_1234567890');
  ok('navegador e URL da visita', ev.user_data?.client_user_agent === 'Mozilla/5.0 suite' && ev.event_source_url === 'https://loja.exemplo.com/oferta');
  ok('valor e moeda', ev.custom_data?.value === 97 && ev.custom_data?.currency === 'BRL');
  ok('CONTROLE: CPF nunca vai ao Meta', !c1?.cru.includes('12345678900'));
  ok('CONTROLE: e-mail em claro nunca vai ao Meta', !c1?.cru.toLowerCase().includes('joana.teste@exemplo.com'));

  secao('reenvio do checkout, outro produto, Pix gerado');
  const antes = chamadas.length;
  await webhook(venda());
  await espera(1200);
  ok('CONTROLE: o mesmo pedido nao vai 2x', chamadasDe('V-001').length === 1);
  await webhook(venda({ sale_id: 'V-OUTRO', products: [{ id: 'p9', name: 'Outro Produto' }] }));
  await webhook(venda({ sale_id: 'V-PIX', event: 'PIX_GENERATED', status: 'PENDING' }));
  await espera(1200);
  ok('outro produto e Pix gerado: nada ao Meta', chamadas.length === antes);

  secao('reembolso');
  await webhook(venda({ event: 'SALE_REFUNDED', status: 'REFUNDED' }));
  const r1 = await envio('V-001', 'Reembolso');
  const er = chamadasDe('V-001').find((c) => c.corpo.data[0].event_name === 'Reembolso')?.corpo.data[0];
  ok('evento "Reembolso" enviado', r1?.status === 'enviado' && er?.event_id === 'Reembolso-V-001' && er?.custom_data?.tipo === 'reembolso');

  secao('Meta fora do ar -> nova tentativa');
  await webhook(venda({ sale_id: 'FALHA-500' }));
  const f1 = await envio('FALHA-500');
  ok('primeira vez: falhou (5xx), guardada', f1?.status === 'falhou');
  await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('*/10 * * * *')}`);
  const f2 = await envio('FALHA-500', 'Purchase', '111111', (u) => u.status === 'enviado');
  ok('o cron mandou de novo e o Meta aceitou', Boolean(f2) && f2.tentativas === 2, f2 && `tentativas ${f2.tentativas}`);

  secao('chave invalida');
  await webhook(venda({ sale_id: 'CHAVE-190' }));
  const k1 = await envio('CHAVE-190');
  ok('fica como chave_invalida, com alerta', k1?.status === 'chave_invalida'
    && (await api('/lab/api/status')).j.alertas.some((a) => a.tipo === 'chave_invalida'));
  const nK = chamadasDe('CHAVE-190').length;
  await api('/lab/api/reenviar', {});
  ok('CONTROLE: sem trocar a chave, nao repete', chamadasDe('CHAVE-190').length === nK);
  await espera(20); // a troca precisa ser DEPOIS do erro (ms)
  ok('chave nova gravada', (await api('/lab/api/segredo', { nome: 'meta_token', valor: 'TOKEN-NOVO' })).j.ok === true);
  ok('alerta resolvido', !(await api('/lab/api/status')).j.alertas.some((a) => a.tipo === 'chave_invalida'));
  await api('/lab/api/reenviar', {});
  ok('com a chave nova, saiu', Boolean(await envio('CHAVE-190', 'Purchase', '111111', (u) => u.status === 'enviado')));

  secao('dois pixels');
  await api('/lab/api/config', { pixels: ['111111', '222222'] });
  await webhook(venda({ sale_id: 'V-002', utm: {} }));
  await envio('V-002', 'Purchase', '222222');
  const px = chamadasDe('V-002').map((c) => c.pixel).sort();
  ok('uma Compra para cada pixel', px.join(',') === '111111,222222', px.join(','));

  secao('teste com controle e nota');
  ok('CONTROLE: sem codigo TEST nao roda', (await api('/lab/api/teste-controle', {})).status === 409);
  ok('CONTROLE: codigo que nao comeca com TEST recusado', (await api('/lab/api/config', { codigo_teste: 'XYZ' })).status === 400);
  await api('/lab/api/config', { codigo_teste: 'TEST4821' });
  const t = await api('/lab/api/teste-controle', {});
  ok('caso ok aceito e caso deve_falhar recusado, nos 2 pixels', t.j.ok === true,
    JSON.stringify(Object.fromEntries(Object.entries(t.j.casos || {}).map(([k, v]) => [k, Object.values(v).map((x) => x.status)]))));
  ok('foi com o codigo de teste', chamadas.slice(-4).every((c) => c.corpo.test_event_code === 'TEST4821'));
  const q = await api('/lab/api/qualidade');
  ok('nota de qualidade por pixel', q.j['111111']?.web?.[0]?.event_match_quality?.composite_score === 9);

  secao('outros checkouts, ponta a ponta');
  await api('/lab/api/config', { pixels: ['111111'], produtos: [], codigo_teste: '' });
  const perfis = await api('/lab/api/perfis');
  ok('API lista os perfis prontos com o nivel', ['kirvano', 'kiwify', 'hotmart', 'eduzz', 'cakto', 'padrao']
    .every((id) => perfis.j.prontos?.some((p) => p.id === id && p.nivel)) && perfis.j.outro === null);
  const js2 = await (await fetch(`${BASE}/v.js`)).text();
  ok('/v.js marca links de varios checkouts (Hotmart src, Cakto sck)', js2.includes('hotmart') && js2.includes('cakto') && js2.includes('"sck"'));
  ok('CONTROLE: checkout desconhecido -> 404', (await fetch(`${BASE}/w/naoexiste`, { method: 'POST', body: '{}' })).status === 404);

  await api('/lab/api/segredo', { nome: 'hotmart_token', valor: 'hottok-da-suite' });
  const hot = {
    event: 'PURCHASE_APPROVED', data: {
      product: { id: 9, name: 'Curso H' }, buyer: { email: 'h@exemplo.com', name: 'Helo Dias', checkout_phone: '5521977776666' },
      purchase: { transaction: 'HP-E2E', price: { value: 197, currency_value: 'BRL' }, origin: { src: VISITA } },
    },
  };
  const rh = await fetch(`${BASE}/w/hotmart`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HOTMART-HOTTOK': 'hottok-da-suite' }, body: JSON.stringify(hot) });
  const eh = await envio('HP-E2E');
  const ch = chamadasDe('HP-E2E')[0]?.corpo.data[0];
  ok('Hotmart: aceito, enviado, ligado a visita', rh.status === 200 && eh?.status === 'enviado' && ch?.user_data?.fbc?.includes('IwAR_visita_da_suite'));
  ok('CONTROLE: Hotmart com hottok errado -> 401', (await fetch(`${BASE}/w/hotmart`, { method: 'POST', headers: { 'X-HOTMART-HOTTOK': 'errado' }, body: JSON.stringify(hot) })).status === 401);

  await api('/lab/api/segredo', { nome: 'padrao_token', valor: 'k-padrao-da-suite' });
  const pad = {
    orderId: 'PD-E2E', status: 'paid', customer: { name: 'Ivo Paz', email: 'i@exemplo.com', phone: '11933332222', ip: '2804::9' },
    products: [{ id: 'm', name: 'Mentoria', priceInCents: 49700 }], trackingParameters: { src: null }, commission: { totalPriceInCents: 49700 },
  };
  await fetch(`${BASE}/w/padrao?k=k-padrao-da-suite`, { method: 'POST', body: JSON.stringify(pad) });
  await envio('PD-E2E');
  const cp = chamadasDe('PD-E2E')[0]?.corpo.data[0];
  ok('Formato padrão (?k=): enviado com valor em reais e IP', cp?.custom_data?.value === 497 && cp?.user_data?.client_ip_address === '2804::9');

  ok('CONTROLE: "outro" sem perfil nem segredo -> 404', (await fetch(`${BASE}/w/outro?k=x`, { method: 'POST', body: '{}' })).status === 404);
  const exemploZ = { tipo_evento: 'venda.aprovada', codigo_venda: 'Z-E2E', valor_total: '149,90', comprador: { email: 'z@exemplo.com', nome: 'Zeca Luz' }, rastreio: { src: VISITA } };
  await api('/lab/api/segredo', { nome: 'outro_token', valor: 'segredo-z' });
  const n0z = chamadas.length;
  ok('CONTROLE: captura com ?k errado -> 401', (await fetch(`${BASE}/w/outro?k=errado`, { method: 'POST', body: JSON.stringify(exemploZ) })).status === 401);
  const cap = await fetch(`${BASE}/w/outro?k=segredo-z`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exemploZ) });
  ok('captura: guarda o exemplo (202) e NADA vai ao Meta', cap.status === 202 && chamadas.length === n0z);
  const an = await api('/lab/api/analisar-exemplo', {});
  ok('analisar-exemplo usa o capturado: campos e sugestao', Boolean(an.j.capturado) && an.j.campos?.length > 3 && an.j.sugestao?.campos?.src?.[0] === 'rastreio.src');
  const perfilZ = {
    nome: 'Checkout Z', eventos: { campos: ['tipo_evento'], aprovada: ['venda.aprovada'] },
    campos: { pedido: 'codigo_venda', valor: 'valor_total', email: 'comprador.email', nome: 'comprador.nome', src: 'rastreio.src' },
    autenticacao: { tipo: 'corpo', caminho: 'segredo' },
  };
  const prev = await api('/lab/api/analisar-exemplo', { exemplo: exemploZ, perfil: perfilZ });
  ok('previa da leitura antes de salvar (sem dado pessoal inteiro)', prev.j.leitura?.tipo === 'aprovada' && prev.j.leitura?.pedido === 'Z-E2E'
    && !JSON.stringify(prev.j.leitura).includes('z@exemplo.com') && prev.j.leitura.faltando.length === 0);
  ok('CONTROLE: perfil ruim nao e salvo', (await api('/lab/api/perfil-outro', { perfil: { eventos: {}, campos: {} } })).status === 400);
  ok('perfil do "outro" salvo', (await api('/lab/api/perfil-outro', { perfil: perfilZ })).j.ok === true);
  ok('o exemplo capturado foi apagado ao salvar o perfil', (await api('/lab/api/analisar-exemplo', {})).status === 400);
  // Formulario (application/x-www-form-urlencoded), com o segredo no corpo.
  const form = 'segredo=segredo-z&tipo_evento=venda.aprovada&codigo_venda=Z-E2E&valor_total=149%2C90&comprador%5Bemail%5D=z%40exemplo.com&rastreio%5Bsrc%5D=' + VISITA;
  const rz = await fetch(`${BASE}/w/outro`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const ez = await envio('Z-E2E');
  const cz = chamadasDe('Z-E2E')[0]?.corpo.data[0];
  ok('"outro" por formulario: aceito e enviado com valor 149,90', rz.status === 200 && ez?.status === 'enviado' && cz?.custom_data?.value === 149.9);
  ok('CONTROLE: "outro" com segredo errado -> 401',
    (await fetch(`${BASE}/w/outro`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.replace('segredo-z', 'nao') })).status === 401);

  secao('Hub (telas)');
  const app = await (await fetch(`${BASE}/lab`, { headers: { Cookie: cookie } })).text();
  ok('o Hub abre com a logo e o endereço do Worker', app.includes('src="/lab/logo.webp"') && app.includes(`const ORIGEM = '${BASE}'`) && !app.includes('{{'));
  // O erro de 30/10: um "</script>" dentro do JavaScript do Hub cortava a pagina.
  const jsHub = app.slice(app.indexOf('<script>') + 8, app.lastIndexOf('</script>'));
  let jsOk = true;
  try { new Function(jsHub); } catch { jsOk = false; } // eslint-disable-line no-new-func
  ok('o JavaScript do Hub e valido e nao fecha o proprio script', jsOk && !jsHub.includes('</script'));
  ok('CONTROLE: sem login, o Hub pede a senha', (await (await fetch(`${BASE}/lab`)).text()).includes('Entrar no seu Hub'));
  const logo = await fetch(`${BASE}/lab/logo.webp`);
  const bLogo = new Uint8Array(await logo.arrayBuffer());
  const icone = await fetch(`${BASE}/favicon.png`);
  const bIcone = new Uint8Array(await icone.arrayBuffer());
  // Confere os bytes de verdade (RIFF....WEBP / \x89PNG): o .bin foi empacotado como dado.
  ok('logo (WebP) e icone (PNG) publicos, bytes certos', logo.ok && /webp/.test(logo.headers.get('content-type') || '')
    && String.fromCharCode(...bLogo.slice(8, 12)) === 'WEBP' && icone.ok && bIcone[1] === 0x50 && bIcone[2] === 0x4e && bIcone[3] === 0x47);
  const st = (await api('/lab/api/status')).j;
  ok('status: pixel, chave so pela dica, visitas contadas', st.config.pixels.includes('111111') && st.segredos.some((s) => s.dica === 'TOKE…OVO')
    && !JSON.stringify(st).includes('TOKEN-NOVO') && st.visitas24h?.n >= 1 && st.visitas24h?.fbc >= 1);
  ok('status nao expoe IP nem navegador das visitas', !JSON.stringify(st).includes('Mozilla/5.0 suite'));
  const det = await api('/lab/api/detectar', { url: `http://127.0.0.1:${PORTA_META}/pagina` });
  ok('detectar: WordPress, Elementor, pixel, checkout Kirvano, UTMify, script', det.j.ok
    && det.j.sites.some((s) => s.id === 'wordpress') && det.j.sites.some((s) => s.id === 'elementor')
    && det.j.pixels.includes('111111') && det.j.checkouts.some((c) => c.id === 'kirvano')
    && det.j.ferramentas.some((f) => f.id === 'utmify') && det.j.script === true, JSON.stringify(det.j).slice(0, 300));
  ok('CONTROLE: detectar acha a Compra no navegador', det.j.compraNoNavegador === true);
  ok('a deteccao fica no status', (await api('/lab/api/status')).j.deteccao?.pixels?.includes('111111'));
  const conf1 = await api('/lab/api/confirmar', { chave: 'dup_checkout', valor: true });
  ok('confirmacao guardada', conf1.j.ok && conf1.j.confirmacoes.dup_checkout === true);
  ok('CONTROLE: confirmacao desconhecida e ignorada', (await api('/lab/api/confirmar', { chave: 'qualquer', valor: true })).j.confirmacoes.qualquer === undefined);
  ok('CONTROLE: repositorio invalido recusado', (await api('/lab/api/config', { repositorio: 'nao é repo' })).status === 400);
  ok('repositorio aceito (link do GitHub vira usuario/nome)', (await api('/lab/api/config', { repositorio: 'https://github.com/ana/tracking-lab' })).j.config.repositorio === 'ana/tracking-lab');
  ok('teste com controle fica registrado para a etapa', (await api('/lab/api/status')).j.ultimoTeste?.ok === true);
  ok('versao instalada informada', (await api('/lab/api/versao')).j.instalada === versao);
  ok('o Hub traz o botao do Assistente', app.includes('id="abrirIA"') && app.includes('id="painelIA"'));
  const stE = (await api('/lab/api/status')).j;
  ok('as 11 etapas vem do sistema, com a luz', stE.etapas?.length === 11 && stE.etapas.find((e) => e.id === 'chave')?.luz === 'ok');
  const perfisR = (await api('/lab/api/perfis')).j;
  ok('as receitas vem do sistema', Boolean(perfisR.receitas?.pagina?.wordpress && perfisR.receitas?.checkout?.hotmart));

  secao('IA da casa (a logica esta em teste/ia.mjs)');
  ok('CONTROLE: sem entrar, o chat nao abre', (await fetch(`${BASE}/lab/api/chat`, { method: 'POST', body: '{}' })).status === 401);
  ok('o Hub pergunta se a IA existe', typeof (await api('/lab/api/chat')).j.disponivel === 'boolean');
  ok('o Hub traz o chat', app.includes('id="chatForm"') && app.includes('IA do Tracking Lab'));
  const chatBm = await api('/lab/api/chat', { mensagens: [{ role: 'user', content: 'Posso gerar por outra BM?' }] });
  console.log(`    (chat local: HTTP ${chatBm.status})`);
  ok('o chat responde sem derrubar o Hub', [200, 503].includes(chatBm.status) && Boolean(chatBm.j.texto), `HTTP ${chatBm.status}`);

  secao('conector da IA (MCP)');
  ok('sem conector no comeco', (await api('/lab/api/conector')).j.ativo === false);
  const semMcp = `${BASE}/mcp/${'a'.repeat(48)}`;
  ok('CONTROLE: sem conector criado, o endereco nao existe', (await fetch(semMcp, { method: 'POST', body: '{}' })).status === 404);
  const criado = (await api('/lab/api/conector', {})).j;
  const urlMcp = criado.url || '';
  ok('endereco criado', /\/mcp\/[0-9a-f]{48}$/.test(urlMcp));
  const verConector = (await api('/lab/api/conector')).j;
  ok('depois, so a dica volta (nunca o endereco)', verConector.ativo === true && !JSON.stringify(verConector).includes(urlMcp.split('/').pop()));
  ok('CONTROLE: segredo errado -> 404', (await fetch(semMcp, { method: 'POST', body: '{}' })).status === 404);
  ok('CONTROLE: /mcp sem segredo -> 404', (await fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' })).status === 404);
  ok('GET no endereco -> 405 (sem fluxo aberto)', (await fetch(urlMcp)).status === 405);
  let idRpc = 0;
  const rpc = async (method, params, url = urlMcp) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++idRpc, method, params }) });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  const ferr = async (name, args = {}) => {
    const r = (await rpc('tools/call', { name, arguments: args })).j.result || {};
    return { erro: r.isError === true, txt: r.content?.[0]?.text || '', dados: r.structuredContent };
  };
  const ini = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'suite', version: '1' } });
  ok('initialize: versao, nome e instrucoes', ini.j.result?.protocolVersion === '2025-06-18' && ini.j.result?.serverInfo?.name === 'tracking-lab'
    && ini.j.result?.capabilities?.tools && /Tracking Lab/.test(ini.j.result?.instructions || ''));
  ok('versao desconhecida: responde uma suportada', (await rpc('initialize', { protocolVersion: '1999-01-01' })).j.result?.protocolVersion === '2025-06-18');
  const notif = await fetch(urlMcp, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  ok('notificacao -> 202 sem corpo', notif.status === 202);
  const lista = (await rpc('tools/list')).j.result?.tools || [];
  ok('11 ferramentas, todas com esquema', lista.length === 11 && lista.every((t) => t.name.startsWith('tl_') && t.inputSchema?.type === 'object'));
  ok('CONTROLE: nao existe ferramenta de ligar', !lista.some((t) => /ligar/.test(t.name)));
  const s1 = await ferr('tl_status');
  ok('tl_status: etapas e proxima', s1.dados?.etapas?.length === 11 && /Chave do Meta/.test(s1.txt) && /compras aceitas/.test(s1.txt));
  ok('CONTROLE: quem so le os dados tambem recebe a proxima etapa', s1.dados?.texto === s1.txt && /Próxima etapa: /.test(s1.dados?.texto || ''));
  const rp = await ferr('tl_receita', { etapa: 'pagina' });
  ok('tl_receita pagina: a linha e a receita do construtor detectado', rp.txt.includes(`${BASE}/v.js`) && /WordPress/.test(rp.txt) && !rp.txt.includes('<b>'));
  const rc = await ferr('tl_receita', { etapa: 'checkout', plataforma: 'hotmart' });
  ok('tl_receita checkout: URL e de onde vem o token', rc.txt.includes(`${BASE}/w/hotmart`) && /hottok/.test(rc.txt));
  ok('CONTROLE: etapa desconhecida da erro', (await ferr('tl_receita', { etapa: 'nada' })).erro);
  ok('tl_detectar_pagina', /ENCONTRADA/.test((await ferr('tl_detectar_pagina', { url: `http://127.0.0.1:${PORTA_META}/pagina` })).txt));
  ok('CONTROLE: pixel invalido da erro', (await ferr('tl_configurar', { pixels: ['abc'] })).erro);
  ok('CONTROLE: a IA nao tira o modo teste (codigo_teste nao passa)', (await ferr('tl_configurar', { codigo_teste: '' })).erro);
  ok('tl_configurar grava', !(await ferr('tl_configurar', { checkouts: ['kirvano', 'hotmart'] })).erro
    && (await api('/lab/api/config')).j.config.checkouts.includes('hotmart'));
  const kRuim = await ferr('tl_salvar_chave_meta', { chave: 'TOKEN-RUIM' });
  ok('CONTROLE: chave ruim recusada, sem repetir a chave', kRuim.erro && !kRuim.txt.includes('TOKEN-RUIM'));
  const kBoa = await ferr('tl_salvar_chave_meta', { chave: 'TOKEN-NOVO-DA-IA' });
  ok('chave colada no chat: conferida e guardada, so a dica volta', !kBoa.erro && /aceita/.test(kBoa.txt) && !kBoa.txt.includes('TOKEN-NOVO-DA-IA'));
  ok('tl_salvar_token_checkout', !(await ferr('tl_salvar_token_checkout', { checkout: 'kiwify', token: 'tk-kiwify-1234' })).erro);
  ok('CONTROLE: a IA nao troca o segredo do proprio conector', (await ferr('tl_salvar_token_checkout', { checkout: 'mcp', token: 'x' })).erro);
  ok('CONTROLE: confirmacao desconhecida da erro', (await ferr('tl_confirmar', { item: 'qualquer', feito: true })).erro);
  ok('tl_confirmar', !(await ferr('tl_confirmar', { item: 'privacidade', feito: true })).erro);
  ok('CONTROLE: codigo que nao comeca com TEST da erro', (await ferr('tl_teste_controle', { codigo_teste: 'XYZ' })).erro);
  const tIa = await ferr('tl_teste_controle', { codigo_teste: 'TEST777' });
  ok('tl_teste_controle: passou', /PASSOU/.test(tIa.txt) && !/NÃO PASSOU/.test(tIa.txt), tIa.txt.slice(0, 120));
  await api('/lab/api/config', { codigo_teste: '' });
  ok('tl_resultados: nota e envios', /Nota do Meta/.test((await ferr('tl_resultados')).txt));
  const anIa = await ferr('tl_analisar_exemplo', { exemplo: { status: 'pago', email: 'q@exemplo.com' } });
  ok('tl_analisar_exemplo: campos mascarados', anIa.dados?.campos?.length === 2 && !JSON.stringify(anIa.dados).includes('q@exemplo.com'));
  ok('CONTROLE: perfil ruim da erro', (await ferr('tl_salvar_perfil_outro', { perfil: { eventos: {}, campos: {} } })).erro);
  ok('CONTROLE: ferramenta desconhecida -> erro do protocolo', (await rpc('tools/call', { name: 'tl_nada' })).j.error?.code === -32602);
  ok('CONTROLE: metodo desconhecido -> erro do protocolo', (await rpc('resources/list')).j.error?.code === -32601);
  ok('CONTROLE: JSON ruim -> 400', (await fetch(urlMcp, { method: 'POST', body: '{' })).status === 400);
  const lote = await fetch(urlMcp, { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]) });
  ok('lote de mensagens', (await lote.json()).length === 2);
  const novoMcp = (await api('/lab/api/conector', {})).j.url;
  ok('CONTROLE: criar outro endereco derruba o anterior', (await fetch(urlMcp, { method: 'POST', body: '{}' })).status === 404 && (await rpc('ping', {}, novoMcp)).status === 200);
} catch (erro) {
  ok('suite', false, String(erro.stderr || erro.stack || erro.message).slice(-500));
} finally {
  if (worker) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(worker.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ja saiu */ }
    } else worker.kill();
  }
  meta.close();
  try { rmSync(estado, { recursive: true, force: true }); } catch { /* o Windows pode segurar */ }
}

console.log(`\n${total - falhas}/${total} ok${falhas ? ` — ${falhas} FALHA(S)` : ''}\n`);
process.exit(falhas ? 1 : 0);
