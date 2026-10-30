-- Tracking Lab 0.1 (F1): um registro por venda, evento E pixel (o cliente pode
-- ter mais de um pixel), e o evento ja montado guardado para nova tentativa.
--
-- `evento_json`: o evento pronto (dados da pessoa ja em hash; IP e navegador
-- como o Meta pede). Fica so enquanto ha o que tentar de novo -- e apagado ao
-- enviar e, de qualquer jeito, depois de 7 dias (o Meta nao aceita mais).
-- `pixel = '*'`: venda que chegou antes de haver pixel/chave configurados; o
-- reenvio manda para os pixels que existirem na hora.

CREATE TABLE IF NOT EXISTS envios_novo (
  pedido      TEXT NOT NULL,
  evento      TEXT NOT NULL,
  pixel       TEXT NOT NULL,
  event_id    TEXT,
  quando      INTEGER NOT NULL,       -- ms, ultima tentativa
  status      TEXT NOT NULL,          -- enviado | falhou | chave_invalida | recusado | sem_config
  visita      TEXT,
  campos      TEXT,
  formato     TEXT,
  resposta    TEXT,
  teste       INTEGER NOT NULL DEFAULT 0,
  tentativas  INTEGER NOT NULL DEFAULT 0,
  evento_json TEXT,
  PRIMARY KEY (pedido, evento, pixel)
);

INSERT OR IGNORE INTO envios_novo (pedido, evento, pixel, event_id, quando, status, visita, campos, formato, resposta, teste)
  SELECT pedido, evento, '?', event_id, quando, status, visita, campos, formato, resposta, teste FROM envios;

DROP TABLE envios;
ALTER TABLE envios_novo RENAME TO envios;
CREATE INDEX IF NOT EXISTS idx_envios_quando ON envios(quando);
CREATE INDEX IF NOT EXISTS idx_envios_pendentes ON envios(status) WHERE evento_json IS NOT NULL;
