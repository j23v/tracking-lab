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
  Hub**, não você: depois de cada ação, peça para conferir lá (ou use a ferramenta de conferência
  do conector do Tracking Lab, quando existir).
- Faça **só** o que a etapa pede. Antes de clicar ou mudar algo em qualquer painel (Kirvano,
  Meta, WordPress), diga o que vai fazer e espere o "pode".

## Configurar pela API do Hub (enquanto as telas das etapas não ficam prontas)
Entre com `POST /lab/entrar` (formulário, campo `senha`) e use o cookie `tl_sessao` nas chamadas:

| O quê | Chamada |
|---|---|
| ver tudo | `GET /lab/api/status` |
| pixel, domínio, produtos | `POST /lab/api/config` `{"pixels":["123..."],"dominio":"loja.com","produtos":["Nome exato do produto na Kirvano"]}` |
| modo teste | `POST /lab/api/config` `{"codigo_teste":"TEST..."}` (vazio `""` = valendo) |
| chave do Meta | `POST /lab/api/segredo` `{"nome":"meta_token","valor":"EAA..."}` (conferida no Meta antes de gravar; configure o pixel antes) |
| token do webhook | `POST /lab/api/segredo` `{"nome":"kirvano_token","valor":"..."}` |
| teste com controle | `POST /lab/api/teste-controle` (precisa do modo teste) |
| nota do Meta | `GET /lab/api/qualidade` |
| envios recentes | `GET /lab/api/envios?horas=24` |

O que colar na página e a URL do webhook aparecem no painel (`/lab`). Ordem que funciona:
1. token do webhook;
2. pixel;
3. chave do Meta;
4. modo teste e teste com controle;
5. tirar o modo teste.

## Chave do Meta e token do webhook
- Se a pessoa colar a chave no chat perguntando se é ela: confirme com naturalidade (a chave do
  Meta começa com `EAA`) e salve pelo conector do Tracking Lab, quando houver. Sem conector, diga
  onde colar no Hub (etapa "Chave do Meta").
- Não repita a chave inteira nas suas respostas. Nada de sermão: se ela quiser trocar a chave
  depois, é 1 minuto no Hub.

## Nunca
- Gerar a chave do Meta por outra BM para contornar um bloqueio do Meta ("violou os Termos"). Isso
  pode estender o bloqueio. O caminho é a apelação ou outra conta.
- Mandar Compra pelo navegador (`fbq('track','Purchase')`) na página: a Compra sai só do servidor.
