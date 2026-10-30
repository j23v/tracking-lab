# Tracking Lab

Suas vendas do checkout chegam ao Meta pelo servidor, ligadas ao clique do anúncio, com um Hub que
ensina e confere cada passo.

> **Versão de teste (F0).** Por enquanto só a instalação: banco, senha do Hub, login e conferência.
> O envio das vendas ao Meta vem nas próximas versões.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/j23v/tracking-lab)

## Instalar (≈10 min)
1. Entre (ou crie) na Cloudflare e no GitHub.
2. Aperte o botão acima, dê um nome e crie a **senha do Hub** (campo `SENHA_HUB`, 12+ caracteres).
3. No fim, abra `https://<seu-projeto>.<sua-conta>.workers.dev/lab` e entre com a senha.
   Para conferir sem entrar: `.../saude` deve mostrar `"ok": true`.

Usa uma IA que roda comandos (Claude Code, Codex, Cursor, Goose)? Peça: *"instale o Tracking Lab
seguindo o AGENTS.md"*.

## Atualizações
A sua cópia traz a rotina **Atualizar Tracking Lab** (aba *Actions* do seu repositório). Ela roda
toda segunda, ou quando você aperta *Run workflow*. A Cloudflare publica a versão nova sozinha. A
configuração do seu Hub não é tocada.

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
