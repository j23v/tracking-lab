// A pagina de vendas: o script `/v.js` (uma linha colada no <head>) e o
// registro da visita (`POST /visita`). E por eles que a venda volta a saber de
// qual clique de anuncio veio: o id da visita entra no link do checkout (`src`
// na Kirvano) e volta no webhook.
//
// O IP e o navegador saem do PROPRIO pedido -- o script nao manda nenhum dos dois.

const ID_DA_VISITA = /^[a-z0-9]{16,40}$/;
// A venda costuma sair no mesmo dia; 30 dias cobrem quem volta depois sem
// guardar IP e navegador para sempre (LGPD).
const DIAS_DA_VISITA = 30;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function cortar(v, max) {
  return typeof v === 'string' && v ? v.slice(0, max) : null;
}

/** `_fbc` do cookie, ou montado do fbclid (formato do Meta: fb.1.<ms>.<fbclid>). */
function fbcDaVisita(dados, agora) {
  const doCookie = cortar(dados?.fbc, 500);
  if (doCookie && /^fb\.\d\.\d+\./.test(doCookie)) return doCookie;
  const fbclid = cortar(dados?.fbclid, 400);
  if (!fbclid || !/^[\w-]+$/.test(fbclid)) return null;
  const quando = Number(dados?.fbclid_em) > 0 ? Math.floor(Number(dados.fbclid_em)) : agora;
  return `fb.1.${quando}.${fbclid}`;
}

/**
 * `POST /visita`. O corpo vem como texto (sendBeacon, sem pre-voo de CORS).
 * Responde 204 sempre que o pedido for bem formado: o navegador nao tem o que
 * fazer com erro, e quem mede e o D1.
 */
export async function rotaDaVisita(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const responder = (status) => new Response(null, { status, headers: CORS });
  let dados;
  try {
    const texto = await request.text();
    if (texto.length > 4000) return responder(413);
    dados = JSON.parse(texto);
  } catch {
    return responder(400);
  }
  const id = String(dados?.id || '').toLowerCase();
  if (!ID_DA_VISITA.test(id)) return responder(400);

  const agora = Date.now();
  try {
    // O que ja foi visto nao se perde: um segundo aviso sem fbclid (outra
    // pagina, o clique no botao) nao apaga o clique do anuncio do primeiro.
    await env.DB.prepare(
      `INSERT INTO visitas (id, criada, vista, ip, ua, fbc, fbp, url)
       VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET
         vista = excluded.vista,
         ip = COALESCE(excluded.ip, visitas.ip),
         ua = COALESCE(excluded.ua, visitas.ua),
         fbc = COALESCE(visitas.fbc, excluded.fbc),
         fbp = COALESCE(excluded.fbp, visitas.fbp),
         url = COALESCE(visitas.url, excluded.url)`,
    ).bind(id, agora, request.headers.get('CF-Connecting-IP') || null,
      cortar(request.headers.get('User-Agent') || '', 500), fbcDaVisita(dados, agora),
      cortar(dados?.fbp, 200), cortar(dados?.url, 500)).run();
  } catch (erro) {
    console.error(`Visita ${id} nao gravada: ${erro}`);
    return responder(500);
  }
  return responder(204);
}

/** Chamado pelo cron: visita velha nao fica guardada (nunca lanca). */
export async function limparVisitas(env) {
  try {
    const limite = Date.now() - DIAS_DA_VISITA * 24 * 3600 * 1000;
    const r = await env.DB.prepare('DELETE FROM visitas WHERE vista < ?').bind(limite).run();
    return { apagadas: r?.meta?.changes ?? 0 };
  } catch (erro) {
    return { erro: String(erro) };
  }
}

/**
 * `GET /v.js`: o script da pagina. Fica no Worker, e nao colado inteiro na
 * pagina, para que um conserto seja so uma atualizacao -- na pagina vai uma
 * linha so. Caminho e nome neutros de proposito: bloqueador de anuncio derruba
 * "pixel", "track" e parecidos.
 *
 * `grupos` = [{ dominios, parametro }] dos perfis de checkout (todos os prontos
 * e o "outro" do cliente): o link de cada checkout recebe o parametro que ESSE
 * checkout devolve no webhook (`src` na Kirvano, `sck` na Cakto...).
 */
export function scriptDaPagina(origem, grupos) {
  const g = grupos.filter((x) => x?.dominios?.length && x.parametro);
  // Ex.: [["(^|\\.)(kirvano\\.com)$","src"], ...] -- o JSON.stringify cuida das barras.
  const regras = g.map((x) => [`(^|\\.)(${x.dominios.map((d) => d.replace(/\./g, '\\.')).join('|')})$`, x.parametro]);
  const seletor = g.flatMap((x) => x.dominios).map((d) => `a[href*="${d}"]`).join(',') || 'a[data-tl-nada]';
  const js = `(function(){try{
var W=${JSON.stringify(origem)},K='tl_v',F='tl_fbclid',G=${JSON.stringify(regras)}.map(function(r){return [new RegExp(r[0]),r[1]];}),S=${JSON.stringify(seletor)};
function ck(n){var m=document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]*)'));return m?decodeURIComponent(m[1]):'';}
function ler(k){try{return localStorage.getItem(k)||'';}catch(e){return '';}}
function por(k,v){try{localStorage.setItem(k,v);}catch(e){}}
var id=ler(K);
if(!/^[a-z0-9]{16,40}$/.test(id)){var a=new Uint8Array(12);crypto.getRandomValues(a);id='';for(var i=0;i<a.length;i++){id+=('0'+a[i].toString(16)).slice(-2);}por(K,id);}
var q=new URLSearchParams(location.search),fb=q.get('fbclid')||'',fbEm='';
if(fb){por(F,fb+'|'+Date.now());}else{var s=ler(F).split('|');fb=s[0]||'';fbEm=s[1]||'';}
function enviar(){var d=JSON.stringify({id:id,fbclid:fb,fbclid_em:fbEm,fbc:ck('_fbc'),fbp:ck('_fbp'),url:location.href.split('#')[0].slice(0,500)});
try{if(navigator.sendBeacon&&navigator.sendBeacon(W+'/visita',d))return;}catch(e){}
try{fetch(W+'/visita',{method:'POST',body:d,keepalive:true,mode:'no-cors'});}catch(e){}}
function marcar(el){try{var u=new URL(el.href),P='';for(var i=0;i<G.length;i++){if(G[i][0].test(u.hostname)){P=G[i][1];break;}}if(!P)return;if(u.searchParams.get(P)!==id){u.searchParams.set(P,id);el.href=u.toString();}}catch(e){}}
function todos(){var l=document.querySelectorAll(S);for(var i=0;i<l.length;i++){marcar(l[i]);}}
document.addEventListener('click',function(e){var el=e.target&&e.target.closest?e.target.closest(S):null;if(el){marcar(el);enviar();}},true);
setTimeout(function(){todos();enviar();},1500);
setInterval(todos,3000);
}catch(e){}})();`;
  return new Response(js, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Curto: um conserto chega a quem abrir a pagina em minutos.
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
