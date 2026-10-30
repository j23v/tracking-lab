// Paginas do Hub (F0: entrar, painel de instalacao, falta de senha). HTML
// simples, sem framework, servido pelo proprio Worker. As etapas de verdade
// entram na F2.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `:root{--bg:#f4f5f7;--sf:#fff;--sf2:#f8f9fb;--bd:#e2e5ea;--tx:#16181d;--mu:#5d6470;--ac:#4f46e5;--act:#fff;--ok:#15803d;--oks:#e8f6ed;--bad:#b91c1c;--bads:#fdeceb;--off:#9aa2b1}
@media (prefers-color-scheme:dark){:root{--bg:#0e1015;--sf:#171a21;--sf2:#1d2129;--bd:#2a2f3a;--tx:#eceef3;--mu:#9aa2b1;--ac:#8b86ff;--act:#0e1015;--ok:#4ade80;--oks:#14301f;--bad:#f87171;--bads:#3a1a1a;--off:#5d6470}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.box{max-width:640px;margin:40px auto;padding:0 16px}.card{background:var(--sf);border:1px solid var(--bd);border-radius:12px;padding:22px}
h1{font-size:22px;margin:0 0 6px}.mu{color:var(--mu)}.brand{display:flex;gap:8px;align-items:center;font-weight:750;margin-bottom:14px}
.logo{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--ac),#22c1c3)}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--bd);border-radius:8px;background:var(--sf);color:var(--tx)}
button{font:inherit;font-weight:600;border:0;border-radius:9px;padding:10px 16px;background:var(--ac);color:var(--act);cursor:pointer;margin-top:12px}
.err{background:var(--bads);color:var(--tx);border-radius:9px;padding:10px 12px;margin:10px 0}
.ck{display:flex;gap:10px;padding:9px 0;border-top:1px solid var(--bd)}.ck:first-child{border-top:0}
.ic{flex:none;width:22px;height:22px;border-radius:99px;display:grid;place-items:center;font-size:13px;font-weight:800;background:var(--sf2);color:var(--off)}
.ic.ok{background:var(--oks);color:var(--ok)}.ic.bad{background:var(--bads);color:var(--bad)}.ck b{display:block}.sm{font-size:13px}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px}a{color:var(--ac)}`;

function pagina(titulo, corpo) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title><meta name="robots" content="noindex"><style>${CSS}</style></head>
<body><div class="box"><div class="brand"><span class="logo"></span>Tracking Lab</div>${corpo}</div></body></html>`;
}

export function paginaEntrar({ erro = '' } = {}) {
  return pagina('Entrar — Tracking Lab', `<div class="card"><h1>Entrar no seu Hub</h1>
<p class="mu">Use a senha que você criou na tela da Cloudflare, na instalação.</p>
${erro ? `<div class="err">${esc(erro)}</div>` : ''}
<form method="post" action="/lab/entrar"><input type="password" name="senha" autocomplete="current-password" aria-label="Senha do Hub" required autofocus>
<button type="submit">Entrar</button></form></div>`);
}

export function paginaSemSenha(estado) {
  const motivo = estado === 'curta'
    ? 'A senha do Hub tem menos de 12 caracteres.'
    : 'A senha do Hub ainda não foi criada.';
  return pagina('Falta a senha — Tracking Lab', `<div class="card"><h1>Quase lá</h1>
<div class="err">${esc(motivo)}</div>
<p>No painel da Cloudflare: <b>Workers e Pages → tracking-lab → Configurações → Variáveis e segredos</b> →
adicione (ou edite) o segredo <b>SENHA_HUB</b> com pelo menos 12 caracteres → <b>Implantar</b>. Depois recarregue esta página.</p>
<p class="mu sm">Prefere ajuda? Cole esta mensagem no seu assistente de IA.</p></div>`);
}

const item = (estado, titulo, detalhe) => `<div class="ck"><span class="ic ${estado}">${estado === 'ok' ? '✓' : estado === 'bad' ? '!' : '·'}</span><div><b>${esc(titulo)}</b><span class="mu sm">${esc(detalhe)}</span></div></div>`;

const CODE = 'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;background:var(--sf2);border:1px solid var(--bd);border-radius:7px;padding:8px 10px;display:block;overflow:auto;white-space:pre;margin:4px 0 10px';

/**
 * Painel: a instalacao e o estado do motor. As telas passo a passo de cada
 * etapa sao a F2; por enquanto a configuracao entra pela API (/lab/api/*),
 * que o assistente de IA usa.
 */
export function paginaPainel(st, origem = '') {
  const quando = (ms) => new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const faltam = st.tabelasFaltando.length;
  const cfg = st.config || { pixels: [], produtos: [] };
  const seg = Object.fromEntries((st.segredos || []).map((s) => [s.nome, s]));
  const contar = (ev, status) => (st.envios24h || []).filter((e) => e.evento === ev && (!status || e.status === status)).reduce((s, e) => s + e.n, 0);
  const wh = st.ultimoWebhook;
  return pagina('Hub — Tracking Lab', `<div class="card"><div class="row"><h1>Instalação</h1>
<form method="post" action="/lab/sair"><button type="submit" style="margin:0;background:var(--sf2);color:var(--tx)">Sair</button></form></div>
<p class="mu">Versão ${esc(st.versao)}.</p>
${item(st.banco === 'ok' && !faltam ? 'ok' : 'bad', 'Banco de dados', st.banco !== 'ok' ? `não respondeu (${st.banco})` : faltam ? `faltam tabelas: ${st.tabelasFaltando.join(', ')}` : `${st.tabelas.length} tabelas criadas`)}
${item('ok', 'Senha do Hub', 'criada na instalação')}
${item(st.ultimoCron ? 'ok' : '', 'Rotina a cada 10 minutos', st.ultimoCron ? `rodou às ${quando(st.ultimoCron)}` : 'ainda não rodou (espere até 10 min)')}
</div>
<div class="card" style="margin-top:14px"><h1>Rastreamento</h1>
<p class="mu">${cfg.codigo_teste ? `<b>Modo teste</b> (${esc(cfg.codigo_teste)}): as compras aparecem em "Testar eventos" e não valem nas campanhas.` : 'Valendo: as compras vão para as campanhas.'}</p>
${item(cfg.pixels.length ? 'ok' : '', 'Pixel', cfg.pixels.length ? cfg.pixels.join(', ') : 'falta configurar')}
${item(seg.meta_token ? 'ok' : '', 'Chave do Meta', seg.meta_token ? `${seg.meta_token.dica} · conferida no Meta` : 'falta')}
${item(seg.kirvano_token ? 'ok' : '', 'Token do webhook (Kirvano)', seg.kirvano_token ? seg.kirvano_token.dica : 'falta')}
${item(cfg.produtos.length ? 'ok' : '', 'Produtos', cfg.produtos.length ? cfg.produtos.join(' · ') : 'todos os produtos do webhook')}
${item(wh ? 'ok' : '', 'Último webhook', wh ? `${quando(wh.quando)} · ${wh.evento || '?'}` : 'nenhum ainda')}
${item(contar('Purchase', 'enviado') ? 'ok' : '', 'Últimas 24 h', `Compras aceitas: ${contar('Purchase', 'enviado')} · com problema: ${contar('Purchase') - contar('Purchase', 'enviado')} · Reembolsos: ${contar('Reembolso')}`)}
${(st.alertas || []).map((a) => item('bad', `Alerta: ${a.tipo}`, `${quando(a.quando)} · ${a.detalhe || ''}`)).join('')}
<p class="sm" style="margin:14px 0 2px"><b>Na página de vendas</b> (no &lt;head&gt;, todas as páginas):</p>
<code style="${CODE}">${esc(`<script src="${origem}/v.js" async></script>`)}</code>
<p class="sm" style="margin:0 0 2px"><b>No webhook da Kirvano</b> (venda aprovada, reembolso, chargeback):</p>
<code style="${CODE}">${esc(`${origem}/w/kirvano`)}</code>
</div>
<p class="mu sm" style="margin-top:14px">As telas passo a passo de cada etapa estão em construção. Enquanto isso, o seu assistente de IA configura pelo Hub (veja o AGENTS.md).</p>`);
}
