// As etapas do Hub e os passos de cada plataforma, num lugar so: o Hub mostra
// (src/hub/app.html, via /lab/api/status e /lab/api/perfis) e a IA do cliente
// le pelo conector (src/mcp.js). Assim a tela e o assistente dizem a mesma coisa.

export const RECEITAS_PAGINA = {
  wordpress: { nome: 'WordPress', passos: ['No painel do WordPress, instale (se não tiver) o plugin <b>Header Footer Code Manager</b>.', 'Vá em <b>HFCM → Add New</b>. Nome: <i>Tracking Lab</i> · Site Display: <b>Site Wide</b> · Location: <b>Header</b>.', 'Cole a linha e salve.', 'Se usa cache (LiteSpeed, WP Rocket…): <b>limpe o cache</b>.'] },
  elementor: { nome: 'Elementor', passos: ['Com Elementor Pro: <b>Elementor → Código personalizado → Adicionar novo</b>, local <b>&lt;head&gt;</b>, todas as páginas.', 'Sem o Pro: use o plugin <b>Header Footer Code Manager</b> (receita do WordPress).', 'Cole a linha, publique e limpe o cache.'] },
  gtm: { nome: 'Google Tag Manager', passos: ['No GTM: <b>Tags → Nova → HTML personalizado</b>.', 'Cole a linha. Acionador: <b>All Pages</b>.', '<b>Enviar → Publicar</b>.'] },
  shopify: { nome: 'Shopify', passos: ['<b>Loja virtual → Temas → … → Editar código</b>.', 'Abra <b>theme.liquid</b> e cole a linha logo antes de <code>&lt;/head&gt;</code>.', 'Salve.'] },
  wix: { nome: 'Wix', passos: ['<b>Configurações → Código personalizado → Adicionar código</b>.', 'Cole a linha, escolha <b>Todas as páginas</b> e <b>Head</b>.', 'Aplique e publique o site.'] },
  webflow: { nome: 'Webflow', passos: ['<b>Project settings → Custom code → Head code</b>.', 'Cole a linha e publique.'] },
  framer: { nome: 'Framer', passos: ['<b>Site settings → General → Custom code → End of &lt;head&gt;</b>.', 'Cole a linha e publique.'] },
  html: { nome: 'HTML / outro', passos: ['Cole a linha dentro do <code>&lt;head&gt;</code> de todas as páginas de vendas.', 'Publique e limpe o cache, se houver.'] },
};

/** Onde cadastrar o webhook e de onde vem o token, por checkout. */
export const CHECKOUT_INFO = {
  kirvano: { onde: 'Na Kirvano: <b>Integrações → Webhooks → Novo</b>.', token: 'O <b>token</b> que a Kirvano mostra no webhook' },
  kiwify: { onde: 'Na Kiwify: <b>Apps → Webhooks → Criar webhook</b>.', token: 'O <b>token</b> do webhook (a Kiwify assina cada aviso com ele)' },
  hotmart: { onde: 'Na Hotmart: <b>Ferramentas → Webhook (API e notificações) → Cadastrar webhook</b>, versão 2.0.', token: 'O <b>hottok</b> que aparece na tela do webhook' },
  eduzz: { onde: 'Na Eduzz: <b>Configurações → Webhooks</b> (MyEduzz) e cadastre a URL.', token: 'A <b>chave de origem</b> (originSecret)' },
  cakto: { onde: 'Na Cakto: <b>Integrações → Webhooks → Adicionar</b>.', token: 'O <b>secret</b> do webhook' },
  padrao: { onde: 'Na plataforma (ou no Zapier/Make/n8n): um webhook para a URL, no <b>Formato padrão</b> (orderId, status, customer, products, trackingParameters).', token: 'Um segredo criado no Hub (vai na URL)', gerar: true },
  outro: { onde: 'Na plataforma: um webhook para a URL.', token: 'Um segredo criado no Hub (vai na URL)', gerar: true },
};

const conf = (st, k) => Boolean(st.config?.confirmacoes?.[k]);
const seg = (st, nome) => (st.segredos || []).some((s) => s.nome === nome);
export const ferramentasRisco = (st) => (st.deteccao?.ferramentas || []).filter((f) => f.id === 'utmify' || f.id === 'metawp');

/**
 * As 11 etapas e a luz de cada uma: ok (verde), meio (amarela), bad (vermelha),
 * '' (apagada), opc (opcional). A MESMA regra para a tela e para a IA.
 */
export const ETAPAS = [
  { id: 'plataformas', titulo: 'Suas plataformas', luz: (st) => (st.deteccao && st.config?.pixels?.length && st.config?.checkouts?.length ? 'ok' : st.deteccao || st.config?.pixels?.length ? 'meio' : '') },
  { id: 'chave', titulo: 'Chave do Meta', luz: (st) => (seg(st, 'meta_token') ? 'ok' : '') },
  { id: 'pagina', titulo: 'Página de vendas', luz: (st) => (st.deteccao?.script || st.visitas24h?.n ? 'ok' : st.deteccao ? 'meio' : '') },
  { id: 'checkout', titulo: 'Checkout', luz: (st) => { const u = st.config?.checkouts || []; if (!u.length) return ''; const n = u.filter((id) => seg(st, `${id}_token`)).length; if (n === u.length && st.ultimoWebhook) return 'ok'; return n ? 'meio' : ''; } },
  { id: 'duplicacao', titulo: 'Anti-duplicação', luz: (st) => (st.deteccao?.compraNoNavegador ? 'bad' : conf(st, 'dup_checkout') && (!ferramentasRisco(st).length || conf(st, 'dup_ferramentas')) ? 'ok' : '') },
  { id: 'teste', titulo: 'Teste com controle', luz: (st) => (st.ultimoTeste ? (st.ultimoTeste.ok ? 'ok' : 'bad') : '') },
  { id: 'ligar', titulo: 'Ligar de verdade', luz: (st) => (!st.config?.codigo_teste && st.ultimoTeste?.ok ? 'ok' : '') },
  { id: 'resultados', titulo: 'Resultados', luz: (st) => ((st.envios24h || []).some((e) => e.status === 'enviado' && !e.teste) ? 'ok' : '') },
  { id: 'privacidade', titulo: 'Privacidade', luz: (st) => (conf(st, 'privacidade') ? 'ok' : '') },
  { id: 'reembolso', titulo: 'Reembolso no Meta', opcional: true, luz: (st) => (conf(st, 'reembolso') ? 'ok' : 'opc') },
  { id: 'atualizacoes', titulo: 'Atualizações', luz: (st) => (conf(st, 'rotina') && st.config?.repositorio ? 'ok' : st.config?.repositorio ? 'meio' : '') },
];

export function estadoDasEtapas(st) {
  return ETAPAS.map((e) => ({ id: e.id, titulo: e.titulo, opcional: Boolean(e.opcional), luz: e.luz(st) }));
}

/** Texto simples (para a IA): tira as marcas de HTML das receitas. */
export const semHtml = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
