# MultiHub Chat

App desktop em Electron (Node/Bun) que reúne WhatsApp Web, Chatwoot e e-mail em uma única janela.

## Fluxo obrigatório para pedidos que alteram código

Este projeto autoriza o uso de subagentes neste fluxo, com os modelos e esforços abaixo, sem pedir confirmação a cada solicitação. A sessão principal só orquestra: não escreve código nem reescreve o plano.

Nunca use `model: "fable"`, em nenhum subagente ou etapa.

Em todo prompt enviado ao `planejador` e ao `executor`, inclua a regra "não escrever comentários no código" (ver "Regras de código").

### 1. Classificar o pedido

| Tamanho | Critério                                                                          | Fluxo                                                                             |
| ------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Trivial | 1 arquivo, poucas linhas, sem decisão de projeto (texto, constante, rename local) | `executor` direto → `validador`                                                   |
| Normal  | Poucos arquivos, comportamento novo ou correção de bug                            | `planejador` → `executor` → `validador`                                           |
| Grande  | Arquitetura, migração, IPC/segurança, vários módulos                              | `planejador` com `effort: "xhigh"` → `executor` por etapa → `validador` por etapa |

Na dúvida entre dois tamanhos, use o maior.

### 2. Planejar: `planejador` (Opus 5.5, effort high)

- Envie o pedido do usuário com as palavras dele e o contexto já levantado na conversa.
- Em pedidos grandes, use `effort: "high"` e peça o plano em etapas independentes, cada uma com sua própria verificação.
- Se o plano trouxer dúvidas que só o usuário pode decidir, pergunte antes de executar.

### 3. Executar: `executor` (Haiku 5.5, effort low)

- Passe o plano completo, sem resumir. No fluxo trivial, passe o pedido do usuário com as palavras dele.
- Etapas que o plano marcar como independentes, sem arquivos em comum, podem ir para executores em paralelo. As demais vão em sequência.
- Se o executor parar por ambiguidade, devolva a dúvida ao `planejador`. Não improvise a resposta.

### 4. Validar: `validador` (Sonnet 5.5, effort medium)

- Passe o plano (no fluxo trivial, o pedido) e o relatório do executor.
- O validador roda a verificação (ver "Verificação") e reprova se o diff adicionar comentários.
- Mudanças em `preload.js`, `shell-preload.js`, `email/preload.js`, `main.js`, `whatsapp/inject.js` ou `updater/` afetam IPC, injeção de script ou atualização do app: valide com `model: "opus"` e `effort: "high"`.

### 5. Reprovação: suba o modelo em vez de repetir

Conte as reprovações por etapa.

1. Primeira: envie os problemas a um novo `executor` com `model: "sonnet"` e `effort: "medium"`, e valide de novo.
2. Segunda: devolva o plano e os problemas ao `planejador` para revisar o plano. Execute com `model: "sonnet"` e `effort: "medium"`, e valide de novo.
3. Terceira: pare e apresente os problemas ao usuário.

### 6. Responder

Informe o que mudou, o veredito do validador, o modelo usado em cada etapa e qualquer verificação que falhou, foi pulada ou depende do usuário.

## Sem o fluxo

- Perguntas, explicações e revisões que não alteram código: responda direto.
- Mudanças só em documentação (`README.md`, `NOTAS-*.md`, `docs/`, este arquivo): faça direto, sem subagentes.
- Buscas amplas no código para responder a uma pergunta: subagente `Explore`.

## Regras de código

- Não adicione comentários em arquivos de código (`//`, `/* */`, JSDoc, `#`, `<!-- -->`). Nomes e estrutura devem explicar o código.
- Não remova nem altere comentários existentes, salvo pedido do usuário.
- Exceções: comentários que o usuário pedir explicitamente e diretivas sem as quais o código não funciona (ex.: shebang `#!`).

## Verificação

- Testes: `bun run test:updater` e cada arquivo `email/test/run-*.js` com `node`, um por vez.
- Se a mudança afeta o que o usuário vê ou faz no app: rode `bun run start` em segundo plano, confira se abre sem erros no terminal e encerre o processo. O que depende de olhar a tela fica para o usuário conferir; diga isso na resposta.
- Commit só quando o usuário pedir.
