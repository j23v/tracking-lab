// A marca do Tracking Lab: a logo do dono (o tubo de laboratorio em forma de
// infinito), com o liquido verde baixado ate logo abaixo do topo dos furos e o
// fundo tirado para o tema escuro do Hub (30/10/2026; originais e versoes
// grandes fora deste projeto).
//
// Os arquivos sao .bin de proposito: o wrangler empacota *.bin como dados por
// padrao, sem regra no wrangler.jsonc -- que a atualizacao do cliente nao toca.
//   logo.bin   WebP, 96 px de altura (o Hub mostra com 36-48 px: nitida em tela 2x)
//   icone.bin  PNG 64x64, so o infinito (icone da aba)

import LOGO from './logo.bin';
import ICONE from './icone.bin';

const cabecalhos = (tipo) => ({ 'Content-Type': tipo, 'Cache-Control': 'public, max-age=86400' });

export const respostaLogo = () => new Response(LOGO, { headers: cabecalhos('image/webp') });
export const respostaIcone = () => new Response(ICONE, { headers: cabecalhos('image/png') });

/** A logo no HTML (o mesmo arquivo em todas as telas). */
export const logoImg = (altura = 36) => `<img src="/lab/logo.webp" alt="Tracking Lab" height="${altura}" style="height:${altura}px;width:auto;display:block">`;
