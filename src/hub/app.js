// O Hub: uma pagina so (src/hub/app.html), servida depois do login. Ela le e
// grava tudo pela API do Hub (/lab/api/*). O HTML vem como texto (regra padrao
// do wrangler para *.html -- nao depende do wrangler.jsonc, que a atualizacao
// do cliente nao toca).

import APP from './app.html';
import { logoSvg } from './marca.js';

export function paginaApp({ origem, versao }) {
  return APP
    .replaceAll('{{ORIGEM}}', String(origem).replace(/['"<>\\]/g, ''))
    .replaceAll('{{VERSAO}}', String(versao).replace(/[^\w.-]/g, ''))
    .replace('{{LOGO}}', logoSvg({ tamanho: 62 }));
}
