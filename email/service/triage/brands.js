// Marcas mais imitadas em golpes no Brasil e no mundo, com os domínios oficiais (registráveis).
// "keywords": nomes que, no nome do remetente ou num domínio que NÃO é oficial, indicam imitação.
// "strict": palavra distinta o bastante para valer também dentro de domínios (ex.: "itau-seguro.com").
// "domainKeywords": quando só algumas palavras valem dentro de domínios.
// "gov": órgão público, que só envia de gov.br; usar o nome dele fora disso pesa mais.
module.exports = [
  { name: "Itaú", keywords: ["itau", "itaú"], strict: true, domains: ["itau.com.br", "itau.com", "itaucard.com.br", "itaupersonnalite.com.br", "iti.com.br", "rede.com.br"] },
  { name: "Bradesco", keywords: ["bradesco"], strict: true, domains: ["bradesco.com.br", "bradescocartoes.com.br", "bradescoseguros.com.br", "next.me", "bradesconext.com.br"] },
  { name: "Banco do Brasil", keywords: ["banco do brasil", "bancodobrasil"], strict: true, domains: ["bb.com.br", "bancobrasil.com.br", "bancodobrasil.com.br"] },
  { name: "Caixa", keywords: ["caixa economica", "caixa econômica", "caixa tem", "caixatem"], strict: true, gov: true, domains: ["caixa.gov.br", "caixa.com.br"] },
  { name: "Santander", keywords: ["santander"], strict: true, domains: ["santander.com.br", "santander.com", "santandernegocios.com.br"] },
  { name: "Nubank", keywords: ["nubank", "nu pagamentos"], strict: true, domains: ["nubank.com.br", "nu.com.br", "nubank.com", "nu.com.mx", "nu.com.co"] },
  { name: "Banco Inter", keywords: ["banco inter"], strict: false, domains: ["bancointer.com.br", "inter.co", "interbank.com.br"] },
  { name: "C6 Bank", keywords: ["c6 bank", "c6bank"], strict: true, domains: ["c6bank.com.br", "c6bank.com"] },
  { name: "PicPay", keywords: ["picpay"], strict: true, domains: ["picpay.com", "picpay.com.br"] },
  { name: "Mercado Pago", keywords: ["mercado pago", "mercadopago"], strict: true, domains: ["mercadopago.com.br", "mercadopago.com", "mercadolivre.com.br", "mercadolibre.com"] },
  { name: "Mercado Livre", keywords: ["mercado livre", "mercadolivre"], strict: true, domains: ["mercadolivre.com.br", "mercadolibre.com", "mercadopago.com.br", "mlstatic.com"] },
  { name: "Correios", keywords: ["correios"], strict: true, domains: ["correios.com.br"] },
  { name: "Receita Federal", keywords: ["receita federal"], strict: true, gov: true, domains: ["gov.br", "receita.fazenda.gov.br", "fazenda.gov.br"] },
  { name: "gov.br", keywords: ["gov.br", "governo federal", "ministerio", "ministério"], strict: false, gov: true, domains: ["gov.br"] },
  { name: "Serasa", keywords: ["serasa"], strict: true, domains: ["serasa.com.br", "serasaexperian.com.br", "serasa.com", "serasaconsumidor.com.br", "serasaecred.com.br"] },
  { name: "Detran", keywords: ["detran"], strict: true, gov: true, domains: ["gov.br", "detran.sp.gov.br", "detran.rj.gov.br", "detran.mg.gov.br", "detran.ro.gov.br"] },
  { name: "PayPal", keywords: ["paypal"], strict: true, domains: ["paypal.com", "paypal.com.br", "paypal-communication.com"] },
  { name: "Netflix", keywords: ["netflix"], strict: true, domains: ["netflix.com", "netflix.net", "nflxext.com", "nflximg.net"] },
  { name: "Amazon", keywords: ["amazon"], strict: false, domains: ["amazon.com", "amazon.com.br", "amazonses.com", "amazon.co.uk", "aws.amazon.com", "amazonaws.com", "primevideo.com"] },
  { name: "Apple", keywords: ["apple", "icloud", "itunes"], strict: false, domains: ["apple.com", "icloud.com", "me.com", "itunes.com", "insideapple.apple.com"] },
  { name: "Microsoft", keywords: ["microsoft", "outlook", "office 365", "office365"], domainKeywords: ["microsoft"], strict: false, domains: ["microsoft.com", "outlook.com", "office.com", "office365.com", "live.com", "hotmail.com", "microsoftonline.com", "sharepoint.com", "onmicrosoft.com", "microsoftrewards.com", "microsoft365.com", "microsoftstore.com", "microsoftemail.com", "msn.com", "bing.com", "xbox.com", "windows.com", "azure.com", "skype.com", "live.net", "msauth.net", "msftauth.net"] },
  { name: "Google", keywords: ["google", "gmail"], strict: false, domains: ["google.com", "gmail.com", "google.com.br", "googlemail.com", "youtube.com", "accounts.google.com"] },
  { name: "WhatsApp / Meta", keywords: ["whatsapp", "facebook", "instagram"], strict: false, domains: ["whatsapp.com", "facebook.com", "facebookmail.com", "instagram.com", "meta.com", "fb.com"] },
  { name: "Locaweb", keywords: ["locaweb"], strict: true, domains: ["locaweb.com.br", "locaweb.com"] },
  { name: "DocuSign", keywords: ["docusign"], strict: true, domains: ["docusign.com", "docusign.net"] },
  { name: "Dropbox", keywords: ["dropbox"], strict: true, domains: ["dropbox.com", "dropboxmail.com"] },
  { name: "Magalu", keywords: ["magalu", "magazine luiza"], strict: true, domains: ["magazineluiza.com.br", "magalu.com", "magalu.com.br"] },
  { name: "Shopee", keywords: ["shopee"], strict: true, domains: ["shopee.com.br", "shopee.com", "shopeemobile.com"] },
];
