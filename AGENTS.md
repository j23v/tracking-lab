# Tracking Lab — instruções para assistentes de IA

Você está ajudando uma pessoa (normalmente sem conhecimento técnico) a instalar e configurar o
Tracking Lab: um sistema que roda na conta Cloudflare **dela** e manda as vendas do checkout ao
Meta pelo servidor. Fale simples, em passos curtos, e confirme antes de agir.

## Como instalar
- **Caminho padrão:** o botão "Deploy to Cloudflare" do `README.md`. Ele copia o projeto para o
  GitHub da pessoa, cria o banco e pede a senha do Hub. Guie-a por ele.
- **Se você roda comandos** e a pessoa preferir:
  1. `npm install`
  2. `npx wrangler login` (ela aprova no navegador)
  3. `npm run deploy`
  4. Antes do deploy, peça à pessoa para criar a senha do Hub (12+ caracteres) e grave com
     `npx wrangler secret put SENHA_HUB`.
- **Confira a instalação** abrindo `https://<projeto>.<conta>.workers.dev/saude`. Deve vir
  `"ok": true`. Se vier `senha: "falta"` ou `"curta"`, ajude a gravar a `SENHA_HUB`.

## Depois de instalado
- Tudo se configura no **Hub** (`/lab`), etapa por etapa. **Quem diz se um passo ficou certo é o
  Hub**, não você: depois de cada ação, peça para conferir lá (ou use `tl_status` e
  `tl_detectar_pagina` pelo conector).
- Faça **só** o que a etapa pede. Antes de clicar ou mudar algo em qualquer painel (Kirvano,
  Meta, WordPress), diga o que vai fazer e espere o "pode".

## A IA da casa
No Hub, o botão **Assistente** abre um chat grátis, com um modelo aberto na conta Cloudflare da
pessoa. Ele só explica os passos; a única coisa que salva é a chave do Meta colada no chat, que é
conferida no Meta. Para agir de verdade, use o conector.

## O conector (o melhor caminho)
No Hub, o botão **Assistente** cria o endereço do conector (`/mcp/<segredo>`, um servidor MCP). Com
ele ligado, você tem as ferramentas `tl_*`: comece por `tl_status` e use `tl_receita` para o passo
a passo já personalizado. Criar outro endereço derruba o anterior. "Ligar de verdade" é só pelo
botão no Hub.

## Configurar pela API do Hub (sem o conector)
Entre com `POST /lab/entrar` (formulário, campo `senha`) e use o cookie `tl_sessao` nas chamadas:

| O quê | Chamada |
|---|---|
| ver tudo | `GET /lab/api/status` |
| pixel, domínio, produtos | `POST /lab/api/config` `{"pixels":["123..."],"dominio":"loja.com","produtos":["Nome exato do produto na Kirvano"]}` |
| modo teste | `POST /lab/api/config` `{"codigo_teste":"TEST..."}` (vazio `""` = valendo) |
| chave do Meta | `POST /lab/api/segredo` `{"nome":"meta_token","valor":"EAA..."}` (conferida no Meta antes de gravar; configure o pixel antes) |
| checkouts usados | `POST /lab/api/config` `{"checkouts":["hotmart"]}` (ids: kirvano, kiwify, hotmart, eduzz, cakto, padrao, outro) |
| perfis e endereços de webhook | `GET /lab/api/perfis` |
| token do webhook | `POST /lab/api/segredo` `{"nome":"<checkout>_token","valor":"..."}` (ex.: `hotmart_token` = o hottok; `kiwify_token` = o token do webhook; `eduzz_token` = o originSecret; `cakto_token` = o secret; `padrao_token`/`outro_token` = um segredo que você cria e põe na URL como `?k=`) |
| montar o "Outro checkout" | `POST /lab/api/analisar-exemplo` `{"exemplo":{...}}` → campos e sugestão; repita com `"perfil":{...}` para ver a leitura; salve com `POST /lab/api/perfil-outro` `{"perfil":{...}}` |
| teste com controle | `POST /lab/api/teste-controle` (precisa do modo teste) |
| nota do Meta | `GET /lab/api/qualidade` |
| envios recentes | `GET /lab/api/envios?horas=24` |

### Checkout sem perfil pronto ("Outro checkout")
1. Pegue um webhook de exemplo, de um destes jeitos:
   - do histórico de webhooks do checkout;
   - pela **captura**: grave um `outro_token` (um segredo qualquer) e cadastre no checkout a URL
     `/w/outro?k=<esse segredo>`. Enquanto não há perfil, o Tracking Lab só guarda o último
     webhook (24 h, no banco da própria pessoa) e não manda nada ao Meta.

   Não use serviços de terceiros para isso: o exemplo tem dados de comprador.
2. Mande o exemplo para `analisar-exemplo` (sem `exemplo`, ele usa o capturado). Com a sugestão,
   monte o perfil:
   - `eventos.campos` e o valor exato de `aprovada` (e de `reembolso`/`chargeback`, se houver);
   - `campos.pedido`, `campos.email` e o que mais existir (`valor` em reais ou `valorCentavos`,
     `telefone`, `ip`, `src`…);
   - `produtos`;
   - `autenticacao`: segredo na URL `?k=` por padrão; ou `{"tipo":"corpo","caminho":"..."}`;
     ou `{"tipo":"hmac","algoritmo":"SHA-256","cabecalho":"X-Signature"}`;
   - `pagina` (`dominios` do checkout e o `parametro` que ele devolve no webhook).
3. Confira a `leitura` antes de salvar. **Nunca** ponha em `aprovada` um status que não seja venda
   paga: isso mandaria Compra falsa ao Meta.
4. O endereço do webhook é `/w/outro`.

Se a plataforma deixa escolher o formato do webhook (ou se a pessoa usa Zapier/Make/n8n), o
**Formato padrão** (`/w/padrao`) é mais simples. É o mesmo formato de pedido que a UTMify publica
(`orderId`, `status: paid|refunded|chargedback`, `customer`, `products`, `trackingParameters`,
`commission.totalPriceInCents`).

O que colar na página e a URL do webhook aparecem no painel (`/lab`). Ordem que funciona:
1. checkouts usados e o token do webhook de cada um;
2. pixel;
3. chave do Meta;
4. modo teste e teste com controle;
5. tirar o modo teste.

## Chave do Meta e token do webhook
- Se a pessoa colar a chave no chat perguntando se é ela: confirme com naturalidade (a chave do
  Meta começa com `EAA`) e salve com `tl_salvar_chave_meta`. Sem conector, diga onde colar no Hub
  (etapa "Chave do Meta").
- Não repita a chave inteira nas suas respostas. Nada de sermão: se ela quiser trocar a chave
  depois, é 1 minuto no Hub.

## Nunca
- Gerar a chave do Meta por outra BM para contornar um bloqueio do Meta ("violou os Termos"). Isso
  pode estender o bloqueio. O caminho é a apelação ou outra conta.
- Mandar Compra pelo navegador (`fbq('track','Purchase')`) na página: a Compra sai só do servidor.
