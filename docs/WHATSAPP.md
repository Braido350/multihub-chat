# Recursos extras do WhatsApp (Configurações › WhatsApp)

Recursos extras para cada aba de WhatsApp Web do app (sites com o endereço `web.whatsapp.com`). Cada aba tem
a própria configuração, salva em `whatsapp-tools.json`, na pasta de dados do app.

## Por que não a extensão WA Web Plus

A extensão foi baixada (`ekcgkejcjdcmonfpmnljobemcbpnkamh`, versão 5.2.6, Manifest V3) e analisada antes de
qualquer tentativa de carregá-la. **Ela não é usada**, porque depende de login e de servidor da empresa:

- a licença é ativada em `wawplus.com/api`, com checkout em `wawplus.com/checkout?token=…`;
- parte da configuração é baixada de `wawplus.com/settings.json`;
- ela pede as permissões `identity` e `identity.email` e chama `chrome.identity.getProfileUserInfo`
  (e-mail da conta Google do navegador). O Electron não tem essa API.

No lugar dela, os recursos são feitos por um script próprio injetado em cada aba.

## Como funciona

| Arquivo | Papel |
|---|---|
| `whatsapp/host.js` | Processo principal: configuração e dados por aba, validação, exportação em CSV, ponte com as Configurações (`app:wa`). |
| `whatsapp/inject.js` | Roda dentro da página do WhatsApp. Cada recurso liga e desliga sozinho e informa o próprio estado. |
| `preload.js` | Só em `web.whatsapp.com`: pede o script ao processo principal (`wa:boot`) e expõe a ponte `__waTools`. |
| `settings/whatsapp.js` | Telas Recursos, Agendadas e automação, e Mensagens apagadas. |

O WhatsApp Web expõe o próprio sistema de módulos (`require("__debug").modulesMap`, cerca de 4.400 módulos
`WAWeb*`). Os recursos de privacidade trocam funções desses módulos. Os recursos visuais usam só CSS e DOM.

**Quando o WhatsApp mudar:** cada recurso procura o que precisa. Se não encontrar, só ele para, com o estado
"não funcionou" e o motivo em Configurações › WhatsApp. Os outros recursos e a aba continuam normais.
Um recurso visual que erra 3 vezes seguidas também é desligado sozinho. Desligar um recurso desfaz as trocas
e devolve as funções originais do WhatsApp.

## O que foi verificado

Os testes rodaram em 10/11/2026, com o WhatsApp Web daquele dia, no Electron do projeto, numa aba
**sem conta conectada**. Não havia número de teste disponível. "Conectado (simulado)" significa que a lista de
conversas foi simulada na página para os recursos internos ligarem sobre os módulos reais do WhatsApp.

| Recurso | Como funciona | Verificado | Falta confirmar com uma conta conectada |
|---|---|---|---|
| Ocultar online | Troca `WAWebPresenceChatAction.sendPresenceAvailable` e `WAWebContactPresenceBridge.setPresenceAvailable` (e o caminho `PresenceService`) por "indisponível". | Funções trocadas e restauradas. O código do WhatsApp chama `o("WAWebContactPresenceBridge").setPresenceAvailable` na hora de usar, então a troca tem efeito. | Se os contatos realmente deixam de ver "online". |
| Ocultar "digitando…" e "gravando…" | `sendChatStateComposing` e `sendChatStateRecording` (Bridge e `ChatStateService`), `markComposing` e `markRecording`. | Trocadas e restauradas. A caixa de texto chama `o("WAWebPresenceChatAction").markComposing`, e a gravação de áudio chama `markRecording`. | Ver do outro lado. |
| Não enviar confirmação de leitura | `WAWebSendReadReceiptJob.markChatRead` e `WAWebChatSendConversationSeen.sendConversationSeen` (e `ChatReadService`). | Trocadas e restauradas. A chamada trocada termina sem enviar nada. | Ver do outro lado (status e grupos podem ter exceções). |
| Desfocar conversas, mensagens e fotos | CSS (`#pane-side`, `#main [data-id]`). Passar o mouse mostra. | Classes aplicadas e removidas. Avisa quando a lista de conversas tem estrutura diferente. | Aparência real com conversas na tela. |
| Guardar mensagens apagadas | Guarda o texto das mensagens recebidas (`WAWebCollections.Msg`, evento `add`) e intercepta `WAWebDBProcessRevokeMsgs.processRevokeMsgsAndGetCleanupEligibleKeys` e `processRevokeMsgs`, que o WhatsApp chama com o id da mensagem original (`revokeMsgKey`) antes de apagar o conteúdo. O texto aparece dentro do aviso "Mensagem apagada" (id `newMsgKey`) e fica registrado em Configurações. | Na página real: a função de apagar foi interceptada, o texto apareceu no aviso e foi guardado; mensagens apagadas por você são ignoradas. A 1ª versão esperava a mensagem mudar de tipo, o que o WhatsApp não faz: ele remove a mensagem e cria outra com outro id. | Apagar de verdade com outro celular. Só recupera mensagens que estavam carregadas na aba (chegaram ou foram abertas com ela aberta); de mídia fica só o tipo. |
| Respostas rápidas | Botão ⚡ acima da caixa de texto. Escreve com `execCommand("insertText")`. `{nome}` vira o primeiro nome do contato. | Botão criado e escondido quando não há conversa aberta. | Escrita no editor do WhatsApp. |
| Etiquetas por conversa | Botão 🏷 no cabeçalho da conversa; etiquetas coloridas na lista. Ficam salvas pelo nome da conversa. | Recurso liga, salva por aba e desliga limpando tudo. | Etiquetas na lista com conversas reais. Renomear o contato perde as etiquetas dele. |
| Mensagens agendadas | `WAWebFindChatAction.findOrCreateLatestChat` + `WAWebSendTextMsgChatAction.sendTextMsgToChat`, o mesmo caminho que a caixa de texto do WhatsApp usa. Confere a cada 15 s. | Funções presentes. Validação de número, data e limite. | Envio real. O app precisa estar aberto; com mais de 12 h de atraso, marca como falha em vez de enviar. |
| Exportar contatos e grupos | `WAWebCollections.Contact` e `Chat` geram um CSV (separador `;`, com BOM para o Excel e proteção contra fórmulas). | O comando responde (lista vazia sem login). | Conteúdo com contatos reais. |
| Envio em massa ⚠ | Mesmo caminho das agendadas. No máximo 50 números, intervalo aleatório (mínimo de 20 s), para depois de 3 falhas seguidas e continua de onde parou se a aba recarregar. | **Desligado por padrão**; ligar pede confirmação com o aviso de banimento. Limites validados. | Envio real. |
| Resposta automática ⚠ | `Msg` `add` → responde só a conversas individuais (nunca grupos, status ou canais), uma vez por período por conversa, com atraso aleatório de 4–12 s. | **Desligado por padrão**, com o mesmo aviso. | Envio real. |

O WhatsApp proíbe automação e envio em massa nos termos de uso e pode banir o número. Por isso esses dois
recursos começam desligados e só ligam depois do aviso.

### Como repetir os testes

Os scripts de teste usados ficaram fora do repositório. Para repetir com uma conta conectada:

1. Ligue os recursos em Configurações › WhatsApp e veja o estado de cada um (atualiza a cada 3 s).
2. Com um segundo celular, confira online, "digitando…", risquinhos azuis e mensagem apagada.
3. Se um estado mostrar "não funcionou", o motivo traz o módulo ou a função que o WhatsApp mudou.
