// As paginas de FORA do Hub: entrar e "falta a senha". Mesmo tema do Hub
// (cinza-escuro, fonte Chakra Petch). O Hub em si e src/hub/app.html.

import { logoSvg } from './hub/marca.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `:root{--bg:#141619;--p1:#1b1e23;--borda:#2f343c;--borda2:#3a404a;--tx:#e6e9ee;--tx2:#a7afbb;--tx3:#7b8492;--verde:#35e35a;--verde2:#1f9e3d;--verm:#ff5a5a;--r:3px}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 'Chakra Petch',ui-sans-serif,system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px 16px}
.box{width:100%;max-width:420px}.marca{display:flex;align-items:center;gap:10px;margin-bottom:18px}.marca svg{width:72px;height:auto}
.nome{font-weight:700;letter-spacing:.12em;text-transform:uppercase}.nome b{color:var(--verde)}
.card{background:var(--p1);border:1px solid var(--borda);border-radius:var(--r);padding:24px}
h1{font-size:22px;margin:0 0 6px;letter-spacing:.02em}.mu{color:var(--tx2)}.sm{font-size:13px}
label{font:600 11px/1 'Chakra Petch',sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--tx3);display:block;margin:16px 0 6px}
input{width:100%;font:inherit;padding:10px 12px;background:var(--bg);color:var(--tx);border:1px solid var(--borda2);border-radius:var(--r);outline:none}
input:focus{border-color:var(--verde2);box-shadow:0 0 0 3px rgba(53,227,90,.12)}
button{width:100%;font:600 15px/1 'Chakra Petch',sans-serif;letter-spacing:.06em;border:0;border-radius:var(--r);padding:12px;background:var(--verde);color:#0b1a0f;cursor:pointer;margin-top:14px}
.err{border-left:3px solid var(--verm);background:#2a1719;padding:10px 12px;border-radius:var(--r);margin:12px 0}`;

function pagina(titulo, corpo) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&display=swap" rel="stylesheet"><style>${CSS}</style></head>
<body><div class="box"><div class="marca">${logoSvg({ tamanho: 72 })}<span class="nome">Tracking <b>Lab</b></span></div>${corpo}</div></body></html>`;
}

export function paginaEntrar({ erro = '' } = {}) {
  return pagina('Entrar — Tracking Lab', `<div class="card"><h1>Entrar no seu Hub</h1>
<p class="mu">Use a senha que você criou na tela da Cloudflare, na instalação.</p>
${erro ? `<div class="err">${esc(erro)}</div>` : ''}
<form method="post" action="/lab/entrar"><label for="s">Senha do Hub</label><input id="s" type="password" name="senha" autocomplete="current-password" aria-label="Senha do Hub" required autofocus>
<button type="submit">Entrar</button></form></div>`);
}

export function paginaSemSenha(estado) {
  const motivo = estado === 'curta'
    ? 'A senha do Hub tem menos de 12 caracteres.'
    : 'A senha do Hub ainda não foi criada.';
  return pagina('Falta a senha — Tracking Lab', `<div class="card"><h1>Quase lá</h1>
<div class="err">${esc(motivo)}</div>
<p>No painel da Cloudflare: <b>Workers e Pages → seu projeto → Configurações → Variáveis e segredos</b> →
adicione (ou edite) o segredo <b>SENHA_HUB</b> com pelo menos 12 caracteres → <b>Implantar</b>. Depois recarregue esta página.</p>
<p class="mu sm">Prefere ajuda? Cole esta mensagem no seu assistente de IA.</p></div>`);
}
