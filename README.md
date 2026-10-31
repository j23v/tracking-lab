# Tracking Lab

Suas vendas do checkout chegam ao Meta pelo servidor, ligadas ao clique do anúncio, com um Hub que
ensina e confere cada passo.

> **Versão 0.5 (em teste).** O **Hub** tem as 11 etapas, cada uma com o passo a passo e a sua
> luz: suas plataformas (lidas da página), chave do Meta, página, checkout, anti-duplicação, teste
> com controle, ligar, resultados, privacidade, reembolso e atualizações. O botão **Assistente**
> traz uma IA grátis que explica os passos, na sua própria conta Cloudflare, liga a sua IA ao
> Tracking Lab (Claude, ChatGPT, Goose, Cursor…) ou dá um texto pronto para colar em qualquer outra.
> Já funcionam a instalação e o envio das vendas ao Meta (Compra e
> Reembolso, ligados à visita da página, com nova tentativa automática). Checkouts com perfil
> pronto: **Kirvano** (confirmado em vendas reais), **Kiwify**, **Hotmart**, **Eduzz** e **Cakto**
> (pela documentação, confirmados na 1ª venda real). Também há o **Formato padrão** (API) e o
> **Outro checkout**, montado a partir de um webhook de exemplo, para qualquer plataforma com
> webhook.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/j23v/tracking-lab)

## Instalar (≈10 min)
1. Entre (ou crie) na Cloudflare e no GitHub.
2. Aperte o botão acima, dê um nome e crie a **senha do Hub** (campo `SENHA_HUB`, 12+ caracteres).
3. No fim, abra `https://<seu-projeto>.<sua-conta>.workers.dev/lab` e entre com a senha.
   Para conferir sem entrar: `.../saude` deve mostrar `"ok": true`.

Usa uma IA que roda comandos (Claude Code, Codex, Cursor, Goose)? Peça: *"instale o Tracking Lab
seguindo o AGENTS.md"*.

## Atualizações
A rotina **Atualizar Tracking Lab** traz o código novo toda segunda, ou quando você aperta *Run
workflow* na aba *Actions*. A Cloudflare publica a versão nova sozinha. A configuração do seu Hub
não é tocada.

⚠️ A Cloudflare **não copia** essa rotina na instalação. Coloque-a uma vez (1 minuto) com os
passos abaixo; o Hub vai ganhar um botão para isso:
1. No seu repositório: **Add file → Create new file**.
2. Nome: `.github/workflows/atualizar.yml`.
3. Cole o conteúdo [deste arquivo](https://github.com/j23v/tracking-lab/blob/main/.github/workflows/atualizar.yml).
4. Aperte **Commit**.

## Licença
O código fica visível porque o botão da Cloudflare exige um repositório público. O uso segue a
licença do Tracking Lab (termos em breve). Nenhuma licença aberta é concedida.

## Para desenvolver
```bash
npm install
cp .dev.vars.example .dev.vars   # e ponha uma senha de 12+ caracteres
npx wrangler d1 migrations apply DB --local
npm run dev
npm run testar
```
