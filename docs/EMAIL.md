# Aba de E-mail

Cliente de e-mail próprio do MultiHub Chat (IMAP/SMTP), com caixa de entrada unificada para várias contas.
Não usa iframe nem webview do Gmail ou da Locaweb: os servidores continuam guardando as mensagens e o app
funciona como cliente.

## Arquitetura

```
┌───────────── Processo principal (main.js) ─────────────┐
│ barra lateral · abas · bandeja · safeStorage (chaveiro)│
│        │ cria/encerra            ▲ contador não lidas  │
│        ▼                         │                     │
│  email/host.js ── parentPort ────┘                     │
│        │  (criptografar/descriptografar, abrir login)  │
└────────┼───────────────────────────────────────────────┘
         │ fork                          MessagePort direto
         ▼                              ┌──────────────────────────┐
┌──── utilityProcess (Node 24) ────┐    │ Aba E-mail (renderer)    │
│ email/service/index.js  (RPC)   ◄├────┤ email/ui/* + preload.js  │
│  ├ sync.js   ImapFlow, IDLE      │    │ sandbox, CSP, sem rede   │
│  ├ store.js  consultas           │    │ Configurações (renderer) │
│  ├ db.js     node:sqlite (WAL)   │◄───┤ settings/* (engrenagem)  │
│  ├ organize/ grupos da entrada   │    └──────────────────────────┘
│  └ google-oauth.js  PKCE/loopback│
└──────┬───────────────┬───────────┘
       │ IMAP/SMTP TLS │ HTTPS (token)
       ▼               ▼
  Gmail · Locaweb · qualquer IMAP     oauth2.googleapis.com
```

- **Por que não um serviço Bun separado:** o app é Electron e já tem um Node 24 embutido. Um sidecar em Bun
  exigiria empacotar um binário por sistema, abrir uma porta HTTP local (que também precisaria de
  autenticação) e gerenciar mais um processo no instalador. O Bun continua sendo usado para instalar
  pacotes e rodar scripts. ImapFlow e Nodemailer são JavaScript puro, e o SQLite vem embutido
  (`node:sqlite`, com FTS5), então não há módulo nativo para recompilar. Por isso o build do Windows a
  partir do Linux continua funcionando.
- **utilityProcess:** IMAP, SQLite e sincronização rodam fora do processo principal, então a janela não trava.
  Se o serviço cair, o `host.js` reinicia o processo e reconecta a aba.
- **Fonte da verdade:** o servidor IMAP. O SQLite guarda um cache (cabeçalhos, flags e, a partir da fase 2,
  os corpos) para a caixa unificada, os filtros e a busca serem instantâneos.

## Modelo de dados (`email/service/db.js`)

| Tabela     | Conteúdo |
|------------|----------|
| `accounts` | e-mail, provedor, servidores, cor, assinatura, `secret` (senha ou refresh token **criptografado** pelo chaveiro do sistema) |
| `folders`  | pastas do servidor, `role` (inbox/sent/drafts/archive/junk/trash), estado incremental (`uidvalidity`, `last_uid`, `highest_modseq`) e não lidas |
| `messages` | cabeçalhos (assunto, remetente, destinatários, data), flags, anexo sim/não, prévia do texto, `thread_key` (X-GM-THRID ou raiz do References) |
| `bodies`   | HTML **já sanitizado**, texto, nº de imagens remotas bloqueadas, lista de anexos (com o número da parte MIME) |
| `settings` | Client ID/secret do Google (criptografados), remetentes, segurança e estado da organização |
| `inbox_class` | grupo virtual de cada mensagem da Caixa de entrada (Importante/Propaganda/Outros/Suspeito), confiança, origem e motivo, escolha manual e estado do treino ([ORGANIZACAO.md](ORGANIZACAO.md)) |
| `nb_tokens` | contagens do classificador Naive Bayes local |

`messages.hdr` guarda os cabeçalhos de envio em massa (List-Unsubscribe, Precedence, Return-Path…) baixados
junto com o envelope.

As migrações são controladas por `PRAGMA user_version`.

## Estrutura

```
email/
  host.js               processo principal: inicia o serviço, chaveiro, canal com a aba
  preload.js            expõe window.mail.call()/on() à interface
  service/
    index.js            RPC, contas, validação de conexão, provedores
    sync.js             AccountWorker: conexão, IDLE, sincronização incremental
    body.js             corpo: download, MIME (mailparser), sanitização (sanitize-html)
    compose.js          escrever/responder/encaminhar, rascunhos, envio (Nodemailer) e cópia em Enviados
    store.js            consultas SQL
    db.js               schema e migrações
    google-oauth.js     OAuth2 do Google (navegador + 127.0.0.1 + PKCE)
    organize/           grupos virtuais da Caixa de entrada: regras, reputação, Naive Bayes, processo em 2º plano
    triage/             análise de risco (regras, antivírus, LLM opcional)
  ui/                   index.html, app.css, app.js
settings/               tela de Configurações do app (engrenagem); settings/email.js = seção E-mail
```

## Configurações (engrenagem no rodapé da barra lateral)

A tela de Configurações do app é uma view própria, por cima dos sites, com seções por módulo
(`Settings.register` em `settings/settings.js`). A seção **E-mail** reúne o que antes ficava espalhado pela aba:

| Página | Conteúdo |
|---|---|
| Contas | adicionar (Gmail, Locaweb, IMAP), editar nome/remetente/cor, remover, sincronizar, reconectar, status |
| Organização da caixa de entrada | progresso do aprendizado, decisões por camada, aprender liga/desliga, reclassificar, redefinir, decisão por mensagem |
| Remetentes | confiáveis, bloqueados e regras "sempre classificar como" |
| Segurança | modo sombra, sensibilidade, quarentena, análise e imagens remotas por conta, antivírus, camada de LLM opcional |
| Assinaturas | assinatura de cada conta |

A aba de E-mail fica só com o uso do dia a dia. O menu ⋯ de cada conta tem "Sincronizar agora" e
"Configurações da conta…". As Configurações usam o mesmo canal direto com o serviço de e-mail; se a aba de E-mail
estiver fechada, o serviço sobe só enquanto as Configurações estiverem abertas.

## Sincronização

- **Primeiro acesso:** baixa os cabeçalhos das 300 mensagens mais recentes de cada pasta principal.
- **Depois:** só os UIDs novos (`last_uid+1:*`), flags alteradas (CONDSTORE `CHANGEDSINCE` quando o servidor
  suporta) e exclusões (UID SEARCH). Se `UIDVALIDITY` muda, a pasta é baixada de novo.
- **Pasta sem mudanças** (mesmo `UIDNEXT`, `HIGHESTMODSEQ` e total): não é aberta.
- **Tempo real:** a conexão fica em IMAP IDLE na Caixa de entrada; as outras pastas são verificadas a cada 5 min.
- **Gmail:** “Arquivo” = “Todos os e-mails” sem os marcadores Inbox/Sent/Draft (via X-GM-LABELS), para não
  duplicar mensagens.
- **Quedas:** reconecta com espera crescente (5 s → 5 min). Falha de login espera 30 min ou “Tentar de novo”.

## Segurança

- Senhas e refresh tokens são criptografados com `safeStorage` (DPAPI no Windows, Keychain no macOS,
  libsecret/KWallet no Linux). Sem chaveiro, o app não salva contas; com o backend `basic_text`, exibe um aviso.
- O segredo descriptografado fica só na memória do serviço e nunca vai para a interface nem para logs.
  O logger do ImapFlow fica desligado.
- A aba de E-mail não tem acesso à rede: todas as requisições http(s)/ws são bloqueadas na sessão
  `persist:email`. Isso bloqueia imagens remotas e pixels de rastreamento por padrão. A CSP da página
  proíbe scripts externos e inline.
- Todo texto vindo de e-mails é inserido com `textContent`. O HTML é sanitizado no serviço
  (`sanitize-html`: sem script, eventos `on*`, `javascript:`, iframe, form, `<title>`), guardado já limpo e
  exibido em um iframe `sandbox` **sem `allow-scripts`**, com CSP própria (`img-src data:`).
- Imagens remotas ficam desativadas (`data-remote-src`). Só com o clique em “Mostrar imagens” o serviço as
  baixa (até 5 MB cada, só `image/*`, nunca endereços da rede local) e as entrega como `data:`.
- Imagens embutidas (`cid:`) viram `data:` (até 3 MB cada, 10 MB por mensagem).
- Baixar o corpo usa `BODY.PEEK`: não marca a mensagem como lida. Ela só é marcada ao abrir a conversa.
- Anexos: limite de 50 MB. “Abrir” grava numa pasta temporária própria e usa o programa padrão do sistema.
  Executáveis, scripts e documentos com macro (`.exe`, `.bat`, `.js`, `.sh`, `.AppImage`, `.docm`…)
  nunca são abertos pelo app, só salvos. O processo principal confere isso de novo.
- Mensagens acima de 20 MB: só as partes de texto são baixadas para leitura, e os anexos ficam disponíveis para salvar.
- O serviço só pode pedir ao processo principal para abrir `https://accounts.google.com/…`.

## Configuração das contas

### Locaweb

Escolha **Locaweb** e informe e-mail e senha. Servidores usados: `email-ssl.com.br`, IMAP 993 (SSL) e
SMTP 465 (SSL). Se a sua conta usar outros, altere em **Servidores (avançado)**.

### Gmail: senha de app (recomendado para @gmail.com pessoal)

1. Ative a verificação em 2 etapas na Conta Google.
2. Gere uma senha em <https://myaccount.google.com/apppasswords>.
3. No Gmail: Configurações → Encaminhamento e POP/IMAP → confira que o IMAP está ativo.
4. No app: **Gmail → Senha de app** e cole a senha de 16 letras.

Não expira, mas é revogada se você trocar a senha da conta Google.

### Gmail: OAuth2

1. Em <https://console.cloud.google.com/> crie um projeto e ative a **Gmail API**.
2. **Google Auth Platform → Branding/Público:** tipo **Externo**, status **Teste**, e adicione o seu
   e-mail como usuário de teste.
3. **Acesso a dados:** adicione o escopo `https://mail.google.com/` (é um escopo *restrito*).
4. **Clientes → Criar cliente → App para computador.** Copie o Client ID e o Client secret.
5. No app: **Gmail → Entrar com Google** e cole os dois valores (ficam criptografados), ou defina
   as variáveis abaixo antes de abrir o app.

Limitação do Google: em contas @gmail.com com o app em **Teste**, o refresh token **expira em 7 dias**.
A conta aparece com “!” e a opção **Reconectar com Google**. Para acabar com isso seria preciso publicar
o app e passar pela verificação de escopo restrito do Google. No Google Workspace, um app **Interno** não
tem essa limitação.

### Variáveis de ambiente (opcionais)

| Variável | Uso |
|----------|-----|
| `MULTIHUB_GOOGLE_CLIENT_ID` | Client ID do Google; tem prioridade sobre o salvo no app |
| `MULTIHUB_GOOGLE_CLIENT_SECRET` | Client secret correspondente |

### Outro provedor

**Outro (IMAP/SMTP)** aceita qualquer servidor com TLS (IMAP 993, SMTP 465 SSL ou 587 STARTTLS).
O SMTP sem TLS é recusado de propósito.

## Como testar sem contas reais

```bash
podman run -d --rm --name mh-greenmail \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=alice:secret@local.test' \
  -p 3143:3143 -p 3993:3993 -p 3025:3025 -p 3465:3465 docker.io/greenmail/standalone:2.1.3

NODE_TLS_REJECT_UNAUTHORIZED=0 bun run start   # certificado autoassinado do GreenMail: só para teste!
```

No app: **Configurações (engrenagem) › E-mail › Contas › + Adicionar conta › Outro**, com e-mail
`alice@local.test`, senha `secret`, IMAP `127.0.0.1:3993`, SMTP `127.0.0.1:3465` (SSL) e usuário `alice`.
Para enviar mensagens de teste, use o SMTP sem TLS na porta 3025, ou rode
`node email/test/seed-greenmail.js` (e-mails de exemplo de cada grupo da Caixa de entrada, lidos e não lidos). O GreenMail aceita qualquer senha, então ele não serve para testar
o tratamento de senha errada.

## Fases

1. **Feito:** contas (Gmail OAuth2/senha de app, Locaweb, IMAP genérico), caixa unificada, filtro por conta,
   pasta, não lidas, favoritas, com anexo e busca simples; IDLE; contador na aba; aba única no “+”.
2. **Feito:** leitura de conversas, HTML seguro, imagens remotas sob demanda, anexos (abrir/salvar),
   lida/não lida, favoritar, arquivar, excluir (Lixeira → excluir para sempre), spam e mover para qualquer pasta.
   Atalhos: `j`/`k` navegam, `e` arquiva, `#` exclui, `u` não lida, `s` favorita, `!` spam.
   Pastas sem SPECIAL-USE são reconhecidas pelo nome (Arquivo, Lixeira, Spam, Enviados…); sem pasta de
   arquivo, o app cria “Arquivo”. No Gmail, tirar algo de “Todos os e-mails” usa COPY (MOVE apagaria).
3. **Feito:** escrever, responder, responder a todos, encaminhar (com os anexos originais), anexos (botão ou
   arrastar, até 25 MB), imagem colada no texto, rascunhos salvos no servidor 4 s após parar de digitar
   (uma versão só; sobrevivem a F5), assinatura e "Seu nome" por conta, escolha da conta remetente
   (responder usa a conta que recebeu), sugestão de destinatários, "Desfazer" por 5 s e cópia em Enviados
   (exceto no Gmail, que guarda sozinho). Atalhos: `c` escreve, `r` responde, `a` responde a todos,
   `f` encaminha, `Ctrl+Enter` envia, `Esc` fecha (o rascunho fica salvo).
4. Busca FTS5 no cache + `X-GM-RAW`/`SEARCH` no servidor, notificações nativas de novas mensagens.
5. Refinamentos: atalhos, reordenar contas, recriptografar segredos quando o chaveiro trocar a chave, limites de cache.
6. Análise de risco (anti-golpe): ver [TRIAGEM.md](TRIAGEM.md). **6a e 6b feitas** (regras, reputação local e
   agente LLM opcional com Claude ou OpenRouter); da 6c, a quarentena (links neutralizados, anexos só para salvar)
   está feita; 6d (métricas e auditoria) a fazer.
7. **Feito:** Caixa de entrada em grupos virtuais (Importante, Propaganda, Outros, Suspeitos, Já lidos) por
   regras, reputação e Naive Bayes locais, sem LLM ([ORGANIZACAO.md](ORGANIZACAO.md)); Configurações
   centralizadas na engrenagem da barra lateral.
