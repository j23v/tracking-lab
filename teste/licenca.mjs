// Suite da licenca (src/licenca.js), sem banco e sem rede.
//
//   node teste/licenca.mjs
//
// Cada CONTROLE prova que licenca falsa, adulterada ou de outra chave NAO passa,
// e que uma assinatura das regras do dia nao serve como licenca.

import { lerLicenca } from '../src/licenca.js';
import { conferirAssinatura } from '../src/regras.js';

let total = 0;
let falhas = 0;
const secao = (t) => console.log(`\n- ${t}`);
function ok(nome, cond, detalhe = '') {
  total++;
  console.log(`  ${cond ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? `  (${detalhe})` : ''}`);
  if (!cond) falhas++;
}

const b64 = (b) => Buffer.from(b).toString('base64');
const b64url = (b) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const par = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const outro = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PUB = b64(await crypto.subtle.exportKey('raw', par.publicKey));
const assinar = async (texto, chave = par.privateKey) => b64url(await crypto.subtle.sign({ name: 'Ed25519' }, chave, new TextEncoder().encode(texto)));
async function licenca(dados, { chave, prefixo = 'tracking-lab-licenca:' } = {}) {
  const d = b64url(JSON.stringify(dados));
  return `TL1-${d}.${await assinar(prefixo + d, chave)}`;
}
const BOA = { v: 1, e: 'Ana@Exemplo.com', p: 'K-123', n: 2, d: '2026-11-02' };

secao('leitura');
const l = await lerLicenca(await licenca(BOA), PUB);
ok('licenca certa: e-mail e pedido', l.ok && l.email === 'ana@exemplo.com' && l.pedido === 'K-123');
ok('com espacos em volta (copiada do e-mail)', (await lerLicenca(`  ${await licenca(BOA)}\n`, PUB)).ok);

secao('controles');
ok('CONTROLE: assinada por outra chave', (await lerLicenca(await licenca(BOA, { chave: outro.privateKey }), PUB)).motivo === 'assinatura');
const boa = await licenca(BOA);
const [dados, sig] = boa.slice(4).split('.');
const outrosDados = b64url(JSON.stringify({ ...BOA, n: 50 }));
ok('CONTROLE: trocar os perfis (50) com a mesma assinatura', (await lerLicenca(`TL1-${outrosDados}.${sig}`, PUB)).motivo === 'assinatura');
ok('CONTROLE: assinatura de regras do dia (sem o prefixo) nao vale como licenca', (await lerLicenca(await licenca(BOA, { prefixo: '' }), PUB)).motivo === 'assinatura');
ok('CONTROLE: e o contrario: a assinatura da licenca nao confere como regras', !(await conferirAssinatura(JSON.stringify(BOA), Buffer.from(sig, 'base64url').toString('base64'), PUB)));
ok('CONTROLE: lixo, vazio e formato errado', !(await lerLicenca('', PUB)).ok && !(await lerLicenca('TL1-abc', PUB)).ok && !(await lerLicenca(`TL2-${dados}.${sig}`, PUB)).ok);
ok('CONTROLE: perfis fora de 1 a 50', !(await lerLicenca(await licenca({ ...BOA, n: 0 }), PUB)).ok && !(await lerLicenca(await licenca({ ...BOA, n: 51 }), PUB)).ok);
ok('CONTROLE: sem e-mail valido', !(await lerLicenca(await licenca({ ...BOA, e: 'ana' }), PUB)).ok);
ok('CONTROLE: versao desconhecida', !(await lerLicenca(await licenca({ ...BOA, v: 2 }), PUB)).ok);
ok('CONTROLE: sem a chave de teste, vale a do codigo (e a de teste nao passa)', !(await lerLicenca(boa)).ok);

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
