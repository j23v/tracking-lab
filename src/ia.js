// A IA da casa: um chat dentro do Hub, com um modelo aberto do Workers AI, na
// conta Cloudflare do proprio cliente. Sem plano pago e sem chave de IA.
//
// Ela SO EXPLICA. Nos testes de 30/10/2026, nenhum modelo gratis usou as
// ferramentas do conector com seguranca (um chegou a mandar gerar a chave por
// outra BM). Por isso: sem ferramentas, com o estado e a receita reais no
// contexto. O que nao pode errar nao passa pelo modelo: a chave colada e salva
// aqui mesmo (e o Meta confere), e as regras duras tem resposta fixa.
//
// O binding `AI` e opcional: copia antiga nao o recebe pela atualizacao (a rotina
// nao mexe no wrangler.jsonc). Sem ele, o Hub esconde o chat.

import { estado, salvarSegredo } from './acoes.js';
import { ETAPA_IDS, receita, textoStatus } from './mcp.js';

// gpt-oss-120b: o melhor nos testes (acertou 9 de 10 e respondeu em 2 a 8 s).
const MODELO = '@cf/openai/gpt-oss-120b';
const MAX_TOKENS = 1000;
const MAX_MENSAGENS = 6;
const MAX_CARACTERES = 1500;

const CHAVE_META = /\bEAA[A-Za-z0-9_-]{20,}/;
const CHAVE_META_G = new RegExp(CHAVE_META.source, 'g');

const SISTEMA = `Você é o ajudante do Tracking Lab, dentro do Hub da pessoa. O Tracking Lab manda as vendas do checkout ao Meta pelo servidor.
Fale em português simples, em passos curtos, no máximo 6 linhas.
Você SÓ explica. Você não consegue salvar, ligar, conferir nem mudar nada: quem faz é a pessoa, nos campos e botões do Hub. A única exceção é a chave do Meta: se ela colar a chave aqui no chat, o sistema salva sozinho.
Regras:
0. O PASSO A PASSO foi escrito para um assistente: fale direto com a pessoa ("escolha o seu pixel"), nunca "pergunte à pessoa".
1. Use somente o que está em ESTADO e PASSO A PASSO. Se a resposta não estiver lá, diga "não tenho essa informação" e peça um print. Nunca invente menu ou caminho.
2. Nunca diga que algo foi salvo, conferido ou que ficou certo. Quem diz é o Hub: mande apertar "Conferir" na etapa.
3. "Ligar de verdade" é só a pessoa, no botão do Hub.
4. Nunca gerar a chave do Meta por outra BM para fugir de bloqueio: responda não, e indique pedir revisão em developers.facebook.com/appeal ou usar um pixel numa conta saudável.
5. Nunca colocar Compra (Purchase) no navegador da página: responda não. A Compra sai só do servidor.
6. Não prometa resultado nem ROAS. Assunto fora do Tracking Lab: diga que só ajuda com o Tracking Lab.`;

// Respostas fixas: nestes assuntos, um erro do modelo custaria caro ao cliente.
const REGRAS = [
  {
    quando: /(outr[ao]|nov[ao]|amig|terceir)[^.?!]{0,30}\b(bm|business|empresa)\b|\b(bm|business)\b[^.?!]{0,30}(outr[ao]|amig|terceir)/i,
    texto: 'Não. Gerar a chave por outra BM para fugir de um bloqueio do Meta pode estender o bloqueio. O caminho é pedir revisão em developers.facebook.com/appeal ou usar um pixel numa conta saudável.',
  },
  {
    quando: /fbq|\bpurchase\b[^.?!]{0,60}(navegador|browser|p[aá]gina|obrigado|site)|(navegador|browser|obrigado)[^.?!]{0,60}(purchase|compra)|compra[^.?!]{0,40}(no navegador|na p[aá]gina|no browser|no site)/i,
    texto: 'A Compra não vai na página: no Tracking Lab, ela sai só do servidor. Se já existe uma na página, tire. A etapa Anti-duplicação mostra se ela foi encontrada.',
  },
  {
    quando: /\bligar?\b[^.?!]{0,30}(de verdade|pra mim|para mim|agora)|(pode|consegue)[^.?!]{0,10}\bligar\b/i,
    texto: 'Quem liga é você: na etapa Ligar de verdade, aperte o botão. Ele depende do teste com controle aprovado.',
  },
];

// O chat nao tem ferramentas: os nomes tl_* das receitas viram o que a pessoa ve no Hub.
const NOMES_NO_HUB = [
  [/tl_detectar_pagina(?: \(campo "script"\))?/g, 'o botão "Conferir" da etapa'],
  [/tl_salvar_chave_meta/g, 'o campo da etapa'],
  [/tl_salvar_token_checkout(?: \(checkout "\w+"\))?/g, 'o campo da etapa'],
  [/tl_confirmar(?: \w+)?(?: e \w+)?/g, 'a confirmação na etapa'],
  [/tl_configurar(?: \([^)]*\))?/g, 'a etapa Suas plataformas'],
  [/tl_teste_controle/g, 'o botão do teste na etapa'],
  [/tl_resultados/g, 'a etapa Resultados'],
  [/tl_\w+/g, 'o Hub'],
];
export const nomesDoHub = (t) => NOMES_NO_HUB.reduce((s, [de, para]) => s.replace(de, para), String(t));

const ETAPA_DA_PERGUNTA = [
  [/webhook|token do checkout/i, 'checkout'],
  [/\blinha\b|script|elementor|wordpress|\bgtm\b|shopify|\bwix\b|webflow|framer/i, 'pagina'],
  [/\bchave\b|\btoken\b/i, 'chave'],
  [/duplic|utmify/i, 'duplicacao'],
  [/\bteste\b|c[oó]digo test/i, 'teste'],
  [/reembolso/i, 'reembolso'],
  [/privacidade/i, 'privacidade'],
  [/atualiza/i, 'atualizacoes'],
];
const PLATAFORMA = /elementor|wordpress|gtm|shopify|wix|webflow|framer|kirvano|kiwify|hotmart|eduzz|cakto/i;

function ultimaDaPessoa(mensagens) {
  return [...mensagens].reverse().find((m) => m.role === 'user')?.content || '';
}

/** So o que a pessoa e a IA disseram, curto, e nunca com a chave do Meta. */
export function limparHistorico(mensagens) {
  return (Array.isArray(mensagens) ? mensagens : [])
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_MENSAGENS)
    .map((m) => ({ role: m.role, content: m.content.replace(CHAVE_META_G, '[chave do Meta]').slice(0, MAX_CARACTERES) }));
}

/** Resposta aproveitavel? O modelo as vezes devolve o raciocinio interno. */
function respostaBoa(r) {
  const escolha = r?.choices?.[0];
  const texto = String(escolha?.message?.content ?? r?.response ?? '').trim();
  if (!texto || escolha?.finish_reason === 'length') return '';
  if (/^(analysis|assistant\s*final|<\|)/i.test(texto) || texto.includes('<|')) return '';
  return nomesDoHub(texto);
}

/**
 * O coracao do chat, sem Worker em volta (a suite testa com um modelo falso).
 * `deps`: { ai, salvarChave(chave), contexto(perguntaLimpa) }.
 */
export async function responder(deps, mensagens) {
  const crua = ultimaDaPessoa(Array.isArray(mensagens) ? mensagens.filter((m) => typeof m?.content === 'string') : []);
  const chave = crua.match(CHAVE_META)?.[0];
  if (chave) {
    const r = await deps.salvarChave(chave);
    if (r.ok) return { status: 200, fonte: 'sistema', recarregar: true, texto: `Chave aceita pelo Meta e guardada (${r.dica}). Confira a luz da etapa Chave do Meta.` };
    if (r.motivo === 'chave_invalida') return { status: 200, fonte: 'sistema', texto: `O Meta recusou esta chave para o pixel ${r.pixel}. Confira se ela foi gerada no pixel certo.` };
    if (r.status === 409) return { status: 200, fonte: 'sistema', texto: 'Antes da chave, escolha o pixel na etapa Suas plataformas. Depois, cole a chave de novo.' };
    return { status: 200, fonte: 'sistema', texto: 'Não consegui conferir a chave agora. Tente de novo na etapa Chave do Meta.' };
  }
  const regra = REGRAS.find((x) => x.quando.test(crua));
  if (regra) return { status: 200, fonte: 'regra', texto: regra.texto };

  const historico = limparHistorico(mensagens);
  if (!historico.length) return { status: 400, erro: 'mensagem vazia', texto: 'Escreva sua pergunta.' };
  const messages = [{ role: 'system', content: `${SISTEMA}\n\n${await deps.contexto(crua)}` }, ...historico];
  try {
    // Uma nova tentativa: a resposta com raciocinio interno e rara e nao se repete.
    for (let i = 0; i < 2; i++) {
      const texto = respostaBoa(await deps.ai.run(MODELO, { messages, max_tokens: MAX_TOKENS, temperature: 0.2 }));
      if (texto) return { status: 200, fonte: 'ia', texto };
    }
    return { status: 502, erro: 'falha', texto: 'Não consegui responder agora. Tente de novo, ou siga o passo a passo da etapa.' };
  } catch (erro) {
    const msg = String(erro);
    if (/4006|daily free|neurons/i.test(msg)) {
      return { status: 429, erro: 'cota', texto: 'A cota grátis de IA de hoje acabou. Ela volta às 21h (horário de Brasília). As etapas do Hub continuam funcionando, e você pode usar a opção "Só copiar e colar".' };
    }
    console.error(`IA da casa: ${msg.slice(0, 200)}`);
    return { status: 502, erro: 'falha', texto: 'Não consegui responder agora. Tente de novo, ou siga o passo a passo da etapa.' };
  }
}

async function contextoReal(env, { origem, versao, etapa }, pergunta) {
  const st = await estado(env, versao);
  const daPergunta = ETAPA_DA_PERGUNTA.find(([re]) => re.test(pergunta))?.[1];
  const proxima = st.etapas.find((e) => !e.opcional && e.luz !== 'ok')?.id;
  const alvo = daPergunta || (ETAPA_IDS.includes(etapa) ? etapa : proxima) || 'resultados';
  const titulo = st.etapas.find((e) => e.id === alvo)?.titulo || alvo;
  const plataforma = pergunta.match(PLATAFORMA)?.[0].toLowerCase();
  return nomesDoHub(`ESTADO\n${textoStatus(st).replace(/ \(use tl_receita[^)]*\)/, '')}\n\nPASSO A PASSO DA ETAPA "${titulo}"\n${receita(alvo, st, origem, plataforma)}`);
}

/** POST /lab/api/chat: { mensagens: [{role, content}], etapa }. */
export async function rotaChat(env, corpo, { origem, versao }) {
  if (!env.AI) return { status: 503, erro: 'sem_ia', texto: 'A IA da casa não está ligada nesta instalação. Use as outras opções do Assistente.' };
  return responder({
    ai: env.AI,
    salvarChave: (chave) => salvarSegredo(env, 'meta_token', chave),
    contexto: (pergunta) => contextoReal(env, { origem, versao, etapa: corpo?.etapa }, pergunta),
  }, corpo?.mensagens);
}
