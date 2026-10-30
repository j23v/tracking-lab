#!/usr/bin/env bash
# Aplica a versao nova da origem (pasta em $1) na copia do cliente (pasta atual).
#
# Este arquivo vem da ORIGEM a cada execucao da rotina "Atualizar Tracking Lab".
# Por isso um conserto aqui chega a todos os clientes sem mexer na rotina em si
# (.github/), que a Cloudflare NAO copia na instalacao e que o GitHub nao deixa
# uma rotina reescrever (visto no teste de 30/10/2026).
#
# O que e do cliente e nunca se toca:
#   wrangler.jsonc        nome do projeto e id do banco, gravados pela Cloudflare
#   package.json "name"   tambem renomeado pela Cloudflare na instalacao
#   .github/              as rotinas
set -euo pipefail

ORIGEM="${1:?uso: aplicar.sh <pasta da origem>}"
test -f "$ORIGEM/src/index.js" || { echo "origem sem src/index.js: nada aplicado"; exit 1; }

nome=$(jq -r '.name' package.json)

rsync -a --exclude '.git/' --exclude '.github/' --exclude 'wrangler.jsonc' --exclude 'node_modules/' "$ORIGEM"/ ./
# src/ inteira espelhada: um arquivo que saiu da origem sai daqui tambem.
rsync -a --delete "$ORIGEM"/src/ ./src/

jq --arg n "$nome" '.name = $n' package.json > package.json.novo
mv package.json.novo package.json
