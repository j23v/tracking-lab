// "Suas plataformas": le a pagina de vendas DE FORA (como um visitante) e
// descobre onde ela esta feita, quais pixels rodam, quais checkouts os botoes
// abrem e o que pode duplicar a Compra. E o que deixa o Hub personalizado.

import { PERFIS } from './checkouts/perfis.js';

const SITES = [
  ['wordpress', 'WordPress', (h) => /wp-content\/|wp-includes\/|<meta[^>]+generator[^>]+WordPress/i.test(h)],
  ['elementor', 'Elementor', (h) => /elementor/i.test(h)],
  ['gtm', 'Google Tag Manager', (h) => /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/.test(h)],
  ['shopify', 'Shopify', (h) => /cdn\.shopify\.com|Shopify\.theme/i.test(h)],
  ['wix', 'Wix', (h) => /static\.wixstatic\.com|wix\.com/i.test(h)],
  ['webflow', 'Webflow', (h) => /webflow\.com|data-wf-page/i.test(h)],
  ['framer', 'Framer', (h) => /framerusercontent\.com|framer\.com/i.test(h)],
  ['nuvemshop', 'Nuvemshop', (h) => /nuvemshop|tiendanube/i.test(h)],
];

const FERRAMENTAS = [
  ['utmify', 'UTMify', (h) => /utmify/i.test(h), 'pode mandar Compra para o mesmo pixel'],
  ['metawp', 'Meta for WordPress', (h) => /official-facebook-pixel|facebook-for-wordpress|pixel-caffeine/i.test(h), 'pode mandar Compra pelo navegador ou servidor'],
  ['clarity', 'Microsoft Clarity', (h) => /clarity\.ms/i.test(h), 'não interfere (entra na política de privacidade)'],
  ['ga4', 'Google Analytics', (h) => /gtag\/js\?id=G-|googletagmanager\.com\/gtag/i.test(h), 'não interfere'],
  ['hotjar', 'Hotjar', (h) => /hotjar/i.test(h), 'não interfere (entra na política de privacidade)'],
];

/** O HTML -> o que achamos. Separado da busca para a suite testar sem rede. */
export function analisarPagina(html, cabecalhos = {}, origemDoWorker = '') {
  const h = String(html || '');
  const cab = Object.fromEntries(Object.entries(cabecalhos).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const sites = SITES.filter(([, , t]) => t(h)).map(([id, nome]) => ({ id, nome }));
  if (cab['x-litespeed-cache'] || /hostinger/i.test(cab.platform || '') || /hostinger/i.test(cab.server || '') || /hcdn/i.test(cab.server || '')) {
    sites.push({ id: 'hostinger', nome: 'Hostinger (cache LiteSpeed)' });
  }
  const pixels = [...new Set([...h.matchAll(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,20})['"]/g)].map((m) => m[1]))];
  const compraNoNavegador = /fbq\(\s*['"]track(Single)?['"]\s*,\s*(['"]\d+['"]\s*,\s*)?['"]Purchase['"]/.test(h);
  const links = [...h.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const hosts = links.map((u) => { try { return new URL(u, 'https://x.invalid').hostname.toLowerCase(); } catch { return ''; } }).filter(Boolean);
  const checkouts = Object.values(PERFIS).filter((p) => p.pagina && hosts.some((x) => p.pagina.dominios.some((d) => x === d || x.endsWith(`.${d}`))))
    .map((p) => ({ id: p.id, nome: p.nome }));
  const ferramentas = FERRAMENTAS.filter(([, , t]) => t(h)).map(([id, nome, , nota]) => ({ id, nome, nota }));
  const origem = String(origemDoWorker || '').replace(/\/$/, '');
  const script = origem ? h.includes(`${origem}/v.js`) : /\/v\.js["'?]/.test(h);
  return { sites, pixels, compraNoNavegador, checkouts, ferramentas, script };
}

/** Busca a pagina (como um navegador comum) e analisa. Nunca lanca. */
export async function detectarPagina(url, origemDoWorker, buscar = fetch) {
  let alvo;
  try { alvo = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`); } catch { return { ok: false, erro: 'endereço inválido' }; }
  if (!/^https?:$/.test(alvo.protocol)) return { ok: false, erro: 'endereço inválido' };
  // Sem cache: a conferencia tem que ver a pagina de AGORA (ex.: logo depois de colar o script).
  alvo.searchParams.set('tl', String(Date.now()));
  try {
    const r = await buscar(alvo.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrackingLab/1.0; +conferencia)', Accept: 'text/html' },
      redirect: 'follow', signal: AbortSignal.timeout(12000),
    });
    const html = (await r.text()).slice(0, 1_500_000);
    const cab = {};
    r.headers.forEach((v, k) => { cab[k] = v; });
    return { ok: r.ok, status: r.status, url: `${alvo.origin}${alvo.pathname}`, quando: Date.now(), ...analisarPagina(html, cab, origemDoWorker) };
  } catch (erro) {
    return { ok: false, erro: `não abriu: ${String(erro.message || erro).slice(0, 120)}` };
  }
}
