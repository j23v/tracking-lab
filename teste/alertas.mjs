// Suite das regras dos alertas (src/alertas.js), sem banco e sem rede.
//
//   node teste/alertas.mjs
//
// Cada CONTROLE prova que a regra NAO acende quando nao deve: alerta falso faz
// a pessoa parar de ler os alertas.

import { TIPOS, avaliar, descreverAlerta, versaoMaior } from '../src/alertas.js';

let total = 0;
let falhas = 0;
const secao = (t) => console.log(`\n- ${t}`);
function ok(nome, cond, detalhe = '') {
  total++;
  console.log(`  ${cond ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? `  (${detalhe})` : ''}`);
  if (!cond) falhas++;
}

const AGORA = Date.UTC(2026, 10, 2, 12);
const DIA = 24 * 3600 * 1000;
const aceso = (d, tipo) => avaliar(d, AGORA).acesos.some((a) => a.tipo === tipo);
const detalhe = (d, tipo) => avaliar(d, AGORA).acesos.find((a) => a.tipo === tipo)?.detalhe || '';
const envios = (extra = {}) => ({ semConfig: 0, falhou: 0, recusadas: 0, motivo: '', expiradas: 0, compras7d: 0, ligadas7d: 0, ...extra });

secao('visitas');
ok('0 visitas em 24 h depois de ter visitas: acende', aceso({ visitas: { ultimas24h: 0, antes7d: 40 } }, 'sem_visitas'));
ok('CONTROLE: com visitas hoje, nao acende', !aceso({ visitas: { ultimas24h: 3, antes7d: 40 } }, 'sem_visitas'));
ok('CONTROLE: instalacao nova (nunca teve visita), nao acende', !aceso({ visitas: { ultimas24h: 0, antes7d: 0 } }, 'sem_visitas'));

secao('script da pagina');
const det = (script, okPagina = true) => ({ ok: okPagina, script, url: 'https://loja.com/' });
ok('script sumiu depois de ja ter sido visto: acende', aceso({ deteccao: det(false), scriptVisto: true }, 'script_sumiu'));
ok('CONTROLE: script nunca colado ainda, nao acende', !aceso({ deteccao: det(false), scriptVisto: false }, 'script_sumiu'));
ok('CONTROLE: pagina fora do ar nao vira "script sumiu"', !aceso({ deteccao: det(false, false), scriptVisto: true }, 'script_sumiu'));
ok('CONTROLE: sem dominio, a regra nem e avaliada (o alerta fica como esta)', !avaliar({}, AGORA).conferidos.includes('script_sumiu'));

secao('envios');
ok('vendas esperando a configuracao: acende, com o motivo', /esperando o pixel ou a chave/.test(detalhe({ envios: envios({ semConfig: 2 }) }, 'vendas_paradas')));
ok('vendas sem resposta do Meta: acende', aceso({ envios: envios({ falhou: 1 }) }, 'vendas_paradas'));
ok('recusadas: acende, com a mensagem do Meta', /recusadas · 400 invalid/.test(detalhe({ envios: envios({ recusadas: 3, motivo: '400 invalid' }) }, 'recusadas')));
ok('expiradas: acende', aceso({ envios: envios({ expiradas: 1 }) }, 'expiradas'));
ok('menos da metade ligada a visita: acende', /40% de 20/.test(detalhe({ envios: envios({ compras7d: 20, ligadas7d: 8 }) }, 'poucas_ligadas')));
ok('CONTROLE: poucas compras (menos de 10) nao acendem', !aceso({ envios: envios({ compras7d: 5, ligadas7d: 0 }) }, 'poucas_ligadas'));
ok('CONTROLE: tudo certo, nada acende', avaliar({ envios: envios({ compras7d: 30, ligadas7d: 25 }) }, AGORA).acesos.length === 0);

secao('nota do Meta');
ok('nota abaixo de 6: acende, com o pixel', /nota 4.5 no pixel 123/.test(detalhe({ nota: { min: 4.5, pixel: '123' }, modoTeste: false }, 'nota_baixa')));
ok('CONTROLE: nota 8 nao acende', !aceso({ nota: { min: 8 }, modoTeste: false }, 'nota_baixa'));
ok('CONTROLE: em modo teste nao acende', !aceso({ nota: { min: 3 }, modoTeste: true }, 'nota_baixa'));
ok('CONTROLE: sem nota ainda, nao acende', !aceso({ nota: null }, 'nota_baixa'));
ok('CONTROLE: nao deu para ler a nota hoje: a regra nem e avaliada', !avaliar({}, AGORA).conferidos.includes('nota_baixa'));

secao('versao');
ok('versaoMaior', versaoMaior('0.6.0', '0.5.1') && versaoMaior('1.0.0', '0.9.9') && !versaoMaior('0.5.1', '0.5.1') && !versaoMaior('0.5.0', '0.5.1'));
ok('versao nova ha 15 dias: acende', aceso({ versao: { instalada: '0.5.1', ultima: '0.6.0', desde: AGORA - 15 * DIA } }, 'versao_antiga'));
ok('CONTROLE: versao nova ha 3 dias (a rotina e semanal), nao acende', !aceso({ versao: { instalada: '0.5.1', ultima: '0.6.0', desde: AGORA - 3 * DIA } }, 'versao_antiga'));
ok('CONTROLE: em dia, nao acende', !aceso({ versao: { instalada: '0.6.0', ultima: '0.6.0', desde: null } }, 'versao_antiga'));

secao('textos');
ok('todo tipo tem texto e etapa', Object.values(TIPOS).every((t) => t.texto && t.etapa));
ok('nenhum texto tecnico', Object.values(TIPOS).every((t) => !/webhook_|token_|tl_|fbc|EMQ|json/i.test(t.texto)));
const d = descreverAlerta({ tipo: 'produto_fora', quando: 1, detalhe: 'Curso X' });
ok('descrever: texto, etapa e dispensavel', d.texto.includes('produto') && d.etapa === 'checkout' && d.dispensavel === true);
ok('CONTROLE: os de condicao nao sao dispensaveis', !descreverAlerta({ tipo: 'sem_visitas' }).dispensavel);
ok('tipo desconhecido nao quebra', descreverAlerta({ tipo: 'xyz' }).texto === 'xyz');

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
