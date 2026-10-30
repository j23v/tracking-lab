-- Tracking Lab -- tabelas iniciais (F0). Aplicadas pelo `npm run deploy`
-- (botao "Deploy to Cloudflare") com `wrangler d1 migrations apply DB`.

-- Configuracao do cliente, preenchida no Hub (pixel, dominio, checkout,
-- produtos, plataformas). Fica FORA do codigo: atualizar nunca apaga.
CREATE TABLE IF NOT EXISTS config (
  chave  TEXT PRIMARY KEY,
  valor  TEXT NOT NULL,
  quando INTEGER NOT NULL      -- ms
);

-- Chave do Meta e token do webhook, cifrados (src/cofre.js). `dica` e o que o
-- Hub mostra (EAAG…x9Q) -- o valor inteiro nunca volta para a tela.
CREATE TABLE IF NOT EXISTS segredos (
  nome    TEXT PRIMARY KEY,
  cifrado TEXT NOT NULL,
  dica    TEXT NOT NULL,
  quando  INTEGER NOT NULL
);

-- A visita da pagina de vendas (o /v.js). Apagada em 30 dias.
CREATE TABLE IF NOT EXISTS visitas (
  id     TEXT PRIMARY KEY,
  criada INTEGER NOT NULL,
  vista  INTEGER NOT NULL,
  ip     TEXT,
  ua     TEXT,
  fbc    TEXT,
  fbp    TEXT,
  url    TEXT
);
CREATE INDEX IF NOT EXISTS idx_visitas_vista ON visitas(vista);

-- Um registro por venda e evento mandado (ou nao) ao Meta.
CREATE TABLE IF NOT EXISTS envios (
  pedido   TEXT NOT NULL,
  evento   TEXT NOT NULL,
  event_id TEXT,
  quando   INTEGER NOT NULL,
  status   TEXT NOT NULL,
  visita   TEXT,
  campos   TEXT,
  formato  TEXT,
  resposta TEXT,
  teste    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pedido, evento)
);
CREATE INDEX IF NOT EXISTS idx_envios_quando ON envios(quando);

-- Alertas do Hub (chave caiu, script sumiu, formato novo do webhook...).
CREATE TABLE IF NOT EXISTS alertas (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo      TEXT NOT NULL,
  quando    INTEGER NOT NULL,
  detalhe   TEXT,
  resolvido INTEGER
);
