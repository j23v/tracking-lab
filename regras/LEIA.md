# Regras do dia

O Tracking Lab de cada cliente lê `regras.json` daqui uma vez por dia e só aceita o arquivo se a
assinatura (`regras.json.sig`) conferir com a chave pública que está no código (`src/regras.js`).

O arquivo traz só dados:
- `meta_graph_versao`: a versão da API do Meta (ex.: `"v25.0"`);
- `perfis`: ajustes nos caminhos dos campos e nos valores dos eventos de um checkout pronto
  (ex.: `{"kirvano": {"campos": {"pedido": ["sale_id"]}}}`), nunca na autenticação;
- `avisos`: até 5 avisos curtos para o Painel (`{"texto": "...", "ate": "AAAA-MM-DD"}`).

Assinatura errada, arquivo quebrado ou regra inválida: o cliente fica com o que já tinha. Ele pode
desligar as regras na etapa Atualizações e voltar ao que veio no código.
