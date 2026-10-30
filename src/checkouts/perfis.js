// Os perfis de checkout que vem prontos. Cada um e DADO (lido por
// src/checkouts/perfil.js), para que um checkout novo -- ou um conserto -- possa
// chegar a todos pelas regras do dia, sem atualizar codigo.
//
// `nivel` diz de onde veio o perfil:
//   confirmado   vendas reais passaram por ele
//   documentado  documentacao oficial / fontes publicas; confirmar na 1a venda real
// Regra: "venda aprovada" so com valor documentado. Nome de reembolso a confirmar
// e inofensivo (no pior caso o reembolso nao vai); aprovada errada mandaria
// Compra falsa ao Meta.
//
// Para o resto (a cauda longa: ~170 plataformas na UTMify), ha o "Formato
// padrao" e o perfil "outro" montado pelo cliente.

export const PERFIS = {
  kirvano: {
    id: 'kirvano', nome: 'Kirvano', nivel: 'confirmado',
    // Vendas reais (desde 06/09/2026) chegaram no cabecalho `security-token`.
    autenticacao: { tipo: 'cabecalho', nomes: ['security-token', 'x-kirvano-token', 'token', 'authorization'], query: ['token'] },
    // `event` decide; so sem `event` o `status` vale.
    eventos: { campos: ['event', 'status'], aprovada: ['SALE_APPROVED', 'APPROVED'], reembolso: ['SALE_REFUNDED'], chargeback: ['SALE_CHARGEBACK'] },
    campos: {
      pedido: ['sale_id', 'checkout_id'], valor: ['total_price'], email: ['customer.email'], nome: ['customer.name'],
      telefone: ['customer.phone_number'], cidade: ['customer.address.city'], estado: ['customer.address.state'],
      cep: ['customer.address.zipcode', 'customer.address.zip_code'], ip: ['ip'],
      fbp: ['cookies.fbp'], fbc: ['cookies.fbc'], fbclid: ['cookies.fbclid'],
      src: ['utm.src', 'utms.src', 'src'], utm_source: ['utm.utm_source'], utm_medium: ['utm.utm_medium'],
      utm_campaign: ['utm.utm_campaign'], utm_content: ['utm.utm_content'], utm_term: ['utm.utm_term'],
      // O navegador da Kirvano usa `Purchase-<uuid>`; o webhook traz 8 letras.
      idDedupUuid: ['checkout_id'],
    },
    produtos: { lista: 'products', id: ['id'], nome: ['name'] },
    pagina: { dominios: ['kirvano.com'], parametro: 'src' },
  },

  kiwify: {
    id: 'kiwify', nome: 'Kiwify', nivel: 'documentado',
    // HMAC-SHA1 do corpo, com o token do webhook, em ?signature= (doc oficial;
    // a suite confere o vetor de teste da propria Kiwify).
    autenticacao: { tipo: 'hmac', algoritmo: 'SHA-1', query: 'signature' },
    // Renovacao de assinatura (subscription_renewed) NAO vira Compra nova.
    eventos: {
      campos: ['webhook_event_type', 'order_status'],
      aprovada: ['order_approved', 'paid'], reembolso: ['order_refunded', 'refunded'], chargeback: ['chargeback', 'chargedback'],
    },
    campos: {
      pedido: ['order_id'], valorCentavos: ['Commissions.charge_amount', 'Commissions.product_base_price'],
      moeda: ['Commissions.currency'], email: ['Customer.email'], nome: ['Customer.full_name', 'Customer.first_name'],
      telefone: ['Customer.mobile'], cidade: ['Customer.city'], estado: ['Customer.state'], cep: ['Customer.zipcode'],
      ip: ['Customer.ip'], src: ['TrackingParameters.src', 'TrackingParameters.sck'],
      utm_source: ['TrackingParameters.utm_source'], utm_medium: ['TrackingParameters.utm_medium'],
      utm_campaign: ['TrackingParameters.utm_campaign'], utm_content: ['TrackingParameters.utm_content'],
      utm_term: ['TrackingParameters.utm_term'],
    },
    produtos: { nomeUnico: ['Product.product_name'], idUnico: ['Product.product_id'] },
    pagina: { dominios: ['kiwify.com.br', 'kiwify.app'], parametro: 'src' },
  },

  hotmart: {
    id: 'hotmart', nome: 'Hotmart', nivel: 'documentado',
    autenticacao: { tipo: 'cabecalho', nomes: ['x-hotmart-hottok'] },
    // PURCHASE_COMPLETE chega semanas depois do APPROVED, para a MESMA compra:
    // contar os dois dobraria a venda. So o APPROVED vira Compra.
    eventos: { campos: ['event'], aprovada: ['PURCHASE_APPROVED'], reembolso: ['PURCHASE_REFUNDED'], chargeback: ['PURCHASE_CHARGEBACK'] },
    campos: {
      pedido: ['data.purchase.transaction'], valor: ['data.purchase.price.value', 'data.purchase.full_price.value'],
      moeda: ['data.purchase.price.currency_value'], email: ['data.buyer.email'], nome: ['data.buyer.name'],
      telefone: ['data.buyer.checkout_phone', 'data.buyer.phone'], cidade: ['data.buyer.address.city'],
      estado: ['data.buyer.address.state'], cep: ['data.buyer.address.zipcode'], ip: ['data.purchase.buyer_ip'],
      src: ['data.purchase.origin.src', 'data.purchase.origin.sck'],
    },
    produtos: { nomeUnico: ['data.product.name'], idUnico: ['data.product.id'] },
    pagina: { dominios: ['hotmart.com'], parametro: 'src' },
  },

  eduzz: {
    id: 'eduzz', nome: 'Eduzz', nivel: 'documentado',
    autenticacao: { tipo: 'corpo', caminho: 'data.producer.originSecret' },
    eventos: {
      campos: ['event'], aprovada: ['myeduzz.invoice_paid'],
      reembolso: ['myeduzz.invoice_refunded'], chargeback: ['myeduzz.invoice_chargeback'],
    },
    campos: {
      pedido: ['data.id'], valor: ['data.paid.value'], moeda: ['data.paid.currency'], email: ['data.buyer.email'],
      nome: ['data.buyer.name'], telefone: ['data.buyer.cellphone', 'data.buyer.phone'],
      cidade: ['data.buyer.address.city'], estado: ['data.buyer.address.state'], cep: ['data.buyer.address.zipCode'],
      src: ['data.tracker.code1'], utm_source: ['data.utm.source'], utm_medium: ['data.utm.medium'],
      utm_campaign: ['data.utm.campaign'], utm_content: ['data.utm.content'], utm_term: ['data.utm.term'],
    },
    produtos: { lista: 'data.items', id: ['productId'], nome: ['name'] },
    // O parametro de URL que vira `tracker.code1` ainda nao foi confirmado: sem
    // marcar links, a Compra vai com os dados do comprador (sem a visita).
  },

  cakto: {
    id: 'cakto', nome: 'Cakto', nivel: 'documentado',
    autenticacao: { tipo: 'corpo', caminho: 'secret' },
    eventos: { campos: ['event'], aprovada: ['purchase_approved'], reembolso: ['refund', 'purchase_refunded'], chargeback: ['chargeback', 'purchase_chargeback'] },
    campos: {
      pedido: ['data.id', 'data.refId'], valor: ['data.amount'], email: ['data.customer.email'], nome: ['data.customer.name'],
      telefone: ['data.customer.phone'], ip: ['data.customer.ip', 'data.ip'],
      // Relato de terceiro (18/09/2026): sck, UTMs, fbc e fbp vem soltos em `data`.
      src: ['data.sck', 'data.src'], fbc: ['data.fbc'], fbp: ['data.fbp'],
      utm_source: ['data.utm_source'], utm_medium: ['data.utm_medium'], utm_campaign: ['data.utm_campaign'],
      utm_content: ['data.utm_content'], utm_term: ['data.utm_term'],
    },
    produtos: { nomeUnico: ['data.product.name'], idUnico: ['data.product.id'] },
    pagina: { dominios: ['cakto.com.br'], parametro: 'sck' },
  },

  // O FORMATO PADRAO do Tracking Lab, para qualquer plataforma que deixe
  // escolher o formato do webhook, para Zapier/Make/n8n e para integradores.
  // Os nomes seguem o formato de pedido que a UTMify publica para plataformas
  // sem integracao pronta (orderId, status paid/refunded/chargedback, customer,
  // products, trackingParameters) -- quem ja manda nesse formato quase nao muda
  // nada. Extras opcionais: trackingParameters.fbc/fbp/fbclid, customer.userAgent.
  padrao: {
    id: 'padrao', nome: 'Formato padrão (API)', nivel: 'confirmado',
    autenticacao: { tipo: 'cabecalho', nomes: ['x-api-token', 'x-tracking-lab-token'], query: ['k'] },
    eventos: { campos: ['status'], aprovada: ['paid'], reembolso: ['refunded'], chargeback: ['chargedback'], teste: 'isTest' },
    campos: {
      pedido: ['orderId'], valorCentavos: ['commission.totalPriceInCents'], moeda: ['commission.currency'],
      email: ['customer.email'], nome: ['customer.name'], telefone: ['customer.phone'], ip: ['customer.ip'],
      navegador: ['customer.userAgent'], cidade: ['customer.city'], estado: ['customer.state'], cep: ['customer.zipcode'],
      src: ['trackingParameters.src', 'trackingParameters.sck'], fbc: ['trackingParameters.fbc'],
      fbp: ['trackingParameters.fbp'], fbclid: ['trackingParameters.fbclid'],
      utm_source: ['trackingParameters.utm_source'], utm_medium: ['trackingParameters.utm_medium'],
      utm_campaign: ['trackingParameters.utm_campaign'], utm_content: ['trackingParameters.utm_content'],
      utm_term: ['trackingParameters.utm_term'],
    },
    produtos: { lista: 'products', id: ['id'], nome: ['name'] },
  },
};

/** Os checkouts mais pedidos que ainda vao pelo "outro"/padrao ate haver formato confirmado. */
export const EM_BREVE = ['Perfect Pay', 'Ticto', 'Braip', 'Greenn', 'Monetizze', 'Lastlink', 'Payt', 'Hubla', 'Guru', 'Pepper', 'Doppus', 'Cartpanda'];
