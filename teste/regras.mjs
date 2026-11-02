// Suite das regras do dia (src/regras.js), sem banco e sem rede.
//
//   node teste/regras.mjs
//
// Cada CONTROLE prova que regra adulterada, sem a nossa assinatura ou invalida
// NAO entra: um erro aqui atingiria todos os clientes ao mesmo tempo.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERFIS } from '../src/checkouts/perfis.js';
import { GRAPH_VERSAO_PADRAO } from '../src/meta.js';
import {
  CHAVE_PUBLICA, buscarRegras, conferirAssinatura, perfilComRegras, validarRegras, versaoMeta,
} from '../src/regras.js';

let total = 0;
let falhas = 0;
const secao = (t) => console.log(`\n- ${t}`);
function ok(nome, cond, detalhe = '') {
  total++;
  console.log(`  ${cond ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? `  (${detalhe})` : ''}`);
  if (!cond) falhas++;
}

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const b64 = (buf) => Buffer.from(buf).toString('base64');
const par = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const outro = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const pub = b64(await crypto.subtle.exportKey('raw', par.publicKey));
const assinar = async (texto, chave = par.privateKey) => b64(await crypto.subtle.sign({ name: 'Ed25519' }, chave, new TextEncoder().encode(texto)));
const BOA = { formato: 1, versao: '2026-11-02.2', meta_graph_versao: 'v26.0', perfis: { kirvano: { campos: { pedido: ['sale_id', 'order_code'] } } }, avisos: [{ texto: 'Teste', ate: '2026-12-01' }] };

secao('o arquivo publicado');
const arq = readFileSync(join(RAIZ, 'regras', 'regras.json'), 'utf8');
const sigArq = readFileSync(join(RAIZ, 'regras', 'regras.json.sig'), 'utf8');
ok('regras.json esta assinado com a chave publica do codigo', await conferirAssinatura(arq, sigArq, CHAVE_PUBLICA));
ok('e e valido', validarRegras(JSON.parse(arq)).ok);
ok('CONTROLE: o mesmo arquivo com um byte trocado nao confere', !(await conferirAssinatura(arq.replace('v25', 'v24'), sigArq, CHAVE_PUBLICA)));

secao('assinatura');
const texto = `${JSON.stringify(BOA, null, 2)}\n`;
const sig = await assinar(texto);
ok('assinatura certa confere', await conferirAssinatura(texto, sig, pub));
ok('o mesmo texto com finais de linha do Windows confere', await conferirAssinatura(texto.replace(/\n/g, '\r\n'), sig, pub));
ok('CONTROLE: texto adulterado nao confere', !(await conferirAssinatura(texto.replace('v26', 'v27'), sig, pub)));
ok('CONTROLE: assinado por outra chave nao confere', !(await conferirAssinatura(texto, await assinar(texto, outro.privateKey), pub)));
ok('CONTROLE: assinatura vazia ou lixo nao confere (e nao quebra)', !(await conferirAssinatura(texto, '', pub)) && !(await conferirAssinatura(texto, '%%%', pub)));

secao('validacao');
ok('regras boas', validarRegras(BOA).ok && validarRegras(BOA).regras.meta_graph_versao === 'v26.0');
const ruim = (extra, msg) => ok(`CONTROLE: ${msg}`, !validarRegras({ ...BOA, ...extra }).ok, validarRegras({ ...BOA, ...extra }).erro);
ruim({ formato: 2 }, 'formato desconhecido');
ruim({ versao: 'ontem' }, 'versao fora do padrao');
ruim({ meta_graph_versao: 'v9.0' }, 'versao do Meta absurda');
ruim({ meta_graph_versao: 'latest' }, 'versao do Meta sem numero');
ruim({ perfis: { nada: { campos: { pedido: ['x'] } } } }, 'checkout desconhecido');
ruim({ perfis: { kirvano: { autenticacao: { tipo: 'cabecalho', nomes: [] } } } }, 'ajuste na autenticacao');
ruim({ perfis: { kirvano: { campos: { pedido: [] } } } }, 'ajuste que apaga o numero do pedido');
ruim({ perfis: { kirvano: { eventos: { aprovada: [] } } } }, 'ajuste que apaga a venda aprovada');
ruim({ perfis: { kirvano: { campos: { email: ['a b c'] } } } }, 'caminho invalido');
ruim({ avisos: [{ texto: 'x'.repeat(301) }] }, 'aviso longo demais');
ruim({ avisos: Array.from({ length: 6 }, () => ({ texto: 'x' })) }, 'avisos demais');
ok('campo estranho no topo e ignorado (nao vira regra)', !('codigo' in validarRegras({ ...BOA, codigo: 'alert(1)' }).regras));

secao('aplicacao');
const regras = validarRegras(BOA).regras;
const k = perfilComRegras('kirvano', regras);
ok('o ajuste troca so o caminho pedido', JSON.stringify(k.campos.pedido) === '["sale_id","order_code"]' && k.campos.email[0] === 'customer.email');
ok('a autenticacao fica a do codigo', JSON.stringify(k.autenticacao) === JSON.stringify(PERFIS.kirvano.autenticacao));
ok('CONTROLE: o perfil do codigo nao foi alterado', JSON.stringify(PERFIS.kirvano.campos.pedido) === '["sale_id","checkout_id"]');
ok('sem ajuste, vale o do codigo', perfilComRegras('hotmart', regras) === PERFIS.hotmart && perfilComRegras('kirvano', null) === PERFIS.kirvano);
ok('ajuste quebrado guardado de antes: vale o do codigo', perfilComRegras('kirvano', { perfis: { kirvano: { campos: { pedido: [] } } } }) === PERFIS.kirvano);
ok('versao do Meta: regras > codigo', versaoMeta({}, regras) === 'v26.0' && versaoMeta({}, null) === GRAPH_VERSAO_PADRAO);
ok('versao do Meta: a do ambiente (testes) ganha', versaoMeta({ META_GRAPH_VERSAO: 'v24.0' }, regras) === 'v24.0');

secao('busca');
const servidor = (corpo, assinatura, status = 200) => async (url) => ({
  ok: status === 200, text: async () => (url.endsWith('.sig') ? assinatura : corpo),
});
const env = { TL_REGRAS_CHAVE: pub, TL_ORIGEM_RAW: 'https://exemplo.invalid' };
ok('arquivo bom: aceito', (await buscarRegras(env, 'x/y', servidor(texto, sig))).ok);
ok('CONTROLE: assinatura errada: recusado', (await buscarRegras(env, 'x/y', servidor(texto.replace('v26', 'v27'), sig))).motivo === 'assinatura');
ok('CONTROLE: sem arquivo: recusado', (await buscarRegras(env, 'x/y', servidor('', '', 404))).motivo === 'sem_arquivo');
const invalido = `${JSON.stringify({ ...BOA, meta_graph_versao: 'v99.0' })}\n`;
ok('CONTROLE: assinado mas invalido: recusado', /^invalida/.test((await buscarRegras(env, 'x/y', servidor(invalido, await assinar(invalido)))).motivo));
ok('CONTROLE: sem a chave de teste, vale a do codigo (e a de teste nao passa)', (await buscarRegras({}, 'x/y', servidor(texto, sig))).motivo === 'assinatura');
ok('rede caiu: recusado, sem quebrar', /^rede/.test((await buscarRegras(env, 'x/y', async () => { throw new Error('offline'); })).motivo));

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
