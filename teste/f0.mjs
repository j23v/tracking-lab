// Suite da F0 (prova do botao), contra o runtime e o D1 DE VERDADE (wrangler dev,
// banco local numa pasta temporaria). Nada vai para a Cloudflare: o deploy so
// roda em `--dry-run`.
//
//   node teste/f0.mjs          (WRANGLER=<caminho> para usar outro wrangler)
//
// Cada CONTROLE existe para provar que o teste consegue falhar: senha errada nao
// entra; cookie adulterado nao entra; cofre com a senha errada nao abre.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cifrar, decifrar, dica, recifrar } from '../src/cofre.js';
import { estadoDaSenha, novaSessao, senhaConfere, sessaoValida } from '../src/sessao.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = 8797;
const BASE = `http://127.0.0.1:${PORTA}`;
const SENHA = 'senha-da-suite-f0-123';

// O wrangler do `npm install`; WRANGLER=<caminho> usa outro ja instalado.
const WR = process.env.WRANGLER
  || [join(RAIZ, 'node_modules', '.bin', 'wrangler.cmd'), join(RAIZ, 'node_modules', '.bin', 'wrangler')].find(existsSync);
if (!WR) {
  console.error('wrangler nao encontrado: rode `npm install` (ou defina WRANGLER=<caminho>).');
  process.exit(2);
}

let total = 0;
let falhas = 0;
const secao = (t) => console.log(`\n- ${t}`);
function ok(nome, cond, detalhe = '') {
  total++;
  console.log(`  ${cond ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? `  (${detalhe})` : ''}`);
  if (!cond) falhas++;
}
const wrangler = (args) => execFileSync(WR, args, { cwd: RAIZ, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

// ------------------------------------------------ 1. o que o botao le
secao('configuracao que o botao "Deploy to Cloudflare" le');
const cfg = JSON.parse(readFileSync(join(RAIZ, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8'));
const d1 = cfg.d1_databases?.[0] || {};
ok('D1 com binding "DB" e nome padrao', d1.binding === 'DB' && Boolean(d1.database_name));
ok('D1 SEM database_id (o botao cria o banco)', !('database_id' in d1));
ok('deploy aplica as migracoes pelo BINDING antes de publicar',
  /wrangler d1 migrations apply DB --remote && wrangler deploy/.test(pkg.scripts?.deploy || ''));
ok('.dev.vars.example pede SENHA_HUB', /^SENHA_HUB=/m.test(readFileSync(join(RAIZ, '.dev.vars.example'), 'utf8')));
ok('descricao do SENHA_HUB para a tela do botao', Boolean(pkg.cloudflare?.bindings?.SENHA_HUB?.description));
ok('um cron so', cfg.triggers?.crons?.length === 1);

// ------------------------------------------------ 2. cofre e sessao (sem rede)
secao('cofre dos segredos');
const chave = 'EAAGm0PXteste1234567890x9Q';
const guardado = await cifrar(chave, SENHA);
ok('cifrado nao contem a chave', !guardado.includes(chave) && guardado.startsWith('v1.'));
ok('decifra com a senha certa', (await decifrar(guardado, SENHA)) === chave);
let abriu = true;
try { await decifrar(guardado, 'outra-senha-qualquer'); } catch { abriu = false; }
ok('CONTROLE: senha errada nao abre', !abriu);
const adulterado = guardado.slice(0, -2) + (guardado.endsWith('A') ? 'BB' : 'AA');
let abriuAdulterado = true;
try { await decifrar(adulterado, SENHA); } catch { abriuAdulterado = false; }
ok('CONTROLE: texto adulterado nao abre', !abriuAdulterado);
ok('duas gravacoes da mesma chave saem diferentes', (await cifrar(chave, SENHA)) !== guardado);
const novo = await recifrar(guardado, SENHA, 'senha-nova-da-suite');
ok('troca de senha: recifra e abre com a nova', (await decifrar(novo, 'senha-nova-da-suite')) === chave);
ok('dica mostra so o comeco e o fim', dica(chave) === 'EAAG…x9Q');

secao('sessao do Hub');
ok('estado da senha: falta / curta / ok',
  estadoDaSenha('') === 'falta' && estadoDaSenha('curta') === 'curta' && estadoDaSenha(SENHA) === 'ok');
ok('senha certa confere', await senhaConfere(SENHA, SENHA));
ok('CONTROLE: senha errada nao confere', !(await senhaConfere('errada-errada-123', SENHA)));
ok('CONTROLE: senha curta no servidor nunca confere', !(await senhaConfere('curta', 'curta')));
const s = await novaSessao(SENHA, 1_000_000);
ok('sessao valida dentro do prazo', await sessaoValida(s, SENHA, 1_000_001));
ok('CONTROLE: sessao vencida', !(await sessaoValida(s, SENHA, 1_000_000 + 13 * 3600 * 1000)));
ok('CONTROLE: trocar a senha derruba a sessao', !(await sessaoValida(s, 'outra-senha-longa-1', 1_000_001)));

// ------------------------------------------------ 3. o pacote publica?
secao('deploy em ensaio (--dry-run, nada sai do computador)');
const saidaDry = join(mkdtempSync(join(tmpdir(), 'tl-dry-')), 'out');
let dryOk = true;
let dryMsg = '';
try { wrangler(['deploy', '--dry-run', '--outdir', `"${saidaDry}"`]); } catch (e) { dryOk = false; dryMsg = String(e.stderr || e.message).slice(-300); }
ok('wrangler deploy --dry-run passa', dryOk, dryMsg);

// ------------------------------------------------ 4. runtime + D1 de verdade
secao('instalacao local (migracao + wrangler dev)');
const estado = mkdtempSync(join(tmpdir(), 'tl-f0-'));
let worker;
try {
  wrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', `"${estado}"`]);
  ok('migracao aplicada no D1 local', true);

  worker = spawn(WR, ['dev', '--local', '--port', String(PORTA), '--ip', '127.0.0.1', '--persist-to', `"${estado}"`,
    '--test-scheduled', '--var', `SENHA_HUB:${SENHA}`, '--show-interactive-dev-session=false'],
  { cwd: RAIZ, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const fim = Date.now() + 90000;
  let subiu = false;
  while (Date.now() < fim && !subiu) {
    try { subiu = (await fetch(`${BASE}/saude`)).status === 200; } catch { /* subindo */ }
    if (!subiu) await new Promise((r) => setTimeout(r, 500));
  }
  if (!subiu) throw new Error('o worker nao subiu em 90 s');

  const saude = await (await fetch(`${BASE}/saude`)).json();
  ok('/saude ok', saude.ok === true, JSON.stringify(saude));
  ok('/saude nao mostra a senha', !JSON.stringify(saude).includes(SENHA));

  const semLogin = await fetch(`${BASE}/lab`);
  ok('/lab sem login pede a senha', semLogin.status === 200 && (await semLogin.text()).includes('Entrar no seu Hub'));
  ok('CONTROLE: API sem login recusa', (await fetch(`${BASE}/lab/api/status`)).status === 401);

  const errada = await fetch(`${BASE}/lab/entrar`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ senha: 'errada-errada-123' }),
  });
  ok('CONTROLE: senha errada -> 401 e sem cookie', errada.status === 401 && !errada.headers.get('set-cookie'));

  const certa = await fetch(`${BASE}/lab/entrar`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ senha: SENHA }),
  });
  const cookie = (certa.headers.get('set-cookie') || '').split(';')[0];
  ok('senha certa -> entra (cookie HttpOnly)', certa.status === 303 && cookie.startsWith('tl_sessao=')
    && /HttpOnly/i.test(certa.headers.get('set-cookie') || ''));

  const painel = await (await fetch(`${BASE}/lab`, { headers: { Cookie: cookie } })).text();
  ok('com login, abre o Hub (nao a tela de entrar)', painel.includes('id="passos"') && !painel.includes('Entrar no seu Hub'));

  const st = await (await fetch(`${BASE}/lab/api/status`, { headers: { Cookie: cookie } })).json();
  ok('status: nenhuma tabela faltando', st.banco === 'ok' && st.tabelasFaltando.length === 0, st.tabelas.join(','));

  const [exp] = cookie.slice('tl_sessao='.length).split('.');
  const falso = `tl_sessao=${exp}.${'0'.repeat(64)}`;
  ok('CONTROLE: cookie adulterado nao entra',
    (await (await fetch(`${BASE}/lab`, { headers: { Cookie: falso } })).text()).includes('Entrar no seu Hub'));

  ok('antes do cron: ultimo_cron vazio', st.ultimoCron === null);
  await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('*/10 * * * *')}`);
  const depois = await (await fetch(`${BASE}/lab/api/status`, { headers: { Cookie: cookie } })).json();
  ok('cron rodou e gravou no banco', Number(depois.ultimoCron) > 0);
} catch (erro) {
  ok('instalacao local', false, String(erro.stderr || erro.message).slice(-400));
} finally {
  if (worker) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(worker.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ja saiu */ }
    } else worker.kill();
  }
  try { rmSync(estado, { recursive: true, force: true }); } catch { /* o Windows pode segurar */ }
}

console.log(`\n${total - falhas}/${total} ok${falhas ? ` — ${falhas} FALHA(S)` : ''}\n`);
process.exit(falhas ? 1 : 0);
