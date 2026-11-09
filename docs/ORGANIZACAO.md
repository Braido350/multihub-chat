# Organização da Caixa de entrada (grupos virtuais)

A Caixa de entrada, de todas as contas ou de cada conta, aparece em grupos direto na lista de mensagens:

```
Importante   (não lidas)
Propaganda   (não lidas)
Outros       (não lidas)
Suspeitos    (não lidas; só aparece quando há itens, recolhido)
```

- **Virtuais:** o grupo fica só no banco do app (`inbox_class`). Nada é movido no servidor de e-mail.
- **Sem LLM e sem serviço externo:** regras, reputação e um classificador estatístico, tudo neste computador.
  A camada de LLM continua existindo só como opção da **análise de risco** (Configurações › E-mail › Segurança).
- **Na dúvida, Outros:** abaixo do limiar de confiança a mensagem vai para Outros, nunca para Propaganda.
  Esconder algo importante é pior do que deixar passar uma propaganda.
- As outras pastas (Enviados, Arquivo, Spam…) e a **busca** continuam como lista simples, com lidas e não lidas.

## Na lista

| O quê | Como |
|---|---|
| Recolher/abrir um grupo | Clique no cabeçalho (o estado é lembrado). Suspeitos começa recolhido |
| Contagem | Não lidas do grupo; no filtro Lidas, o total |
| Mais mensagens | "Mostrar mais" no fim do grupo (paginação no banco, da mais recente para a mais antiga) |
| Mudar o grupo | Arraste a mensagem para outro grupo, ou clique direito / pressão longa › **Mover para** |
| Regra por remetente | Clique direito › **Sempre classificar este remetente como** (desfazer no aviso ou em Configurações › Remetentes) |
| Ao ler | A mensagem continua no grupo da categoria (sem negrito), para você rever depois |
| Mensagem aberta | Fica onde está até você abrir outra ou clicar em ⟳, para a seleção não pular |
| Filtros | Não lidas, **Lidas**, Favoritas, Com anexo e Conversas atuam dentro dos grupos; grupo vazio some |

Ler uma mensagem muda **onde ela aparece**, não a classificação: a categoria continua guardada e usada no aprendizado.

## Como a decisão é tomada

A primeira camada com confiança suficiente decide. Cada mensagem guarda a confiança (0–100), a origem e um
motivo curto, consultáveis em **Configurações › E-mail › Organização da caixa de entrada**.

| # | Camada | Origem | Quando decide |
|---|---|---|---|
| 1 | Você moveu a mensagem | `manual` | Sempre (vence até a análise de risco) |
| 2 | Regra "sempre classificar como" / lista de confiáveis | `remetente` | Sempre (a análise de risco ainda vale: imitação vai para Suspeitos) |
| 3 | Reputação pelas suas correções | `reputacao` | 2 movimentos coerentes do mesmo remetente (3 do mesmo domínio) |
| 4 | Regras com confiança ≥ 90 | `regra` | Sinais muito fortes (você respondeu, já escreveu para a pessoa…) |
| 5 | Reputação pelo histórico | `reputacao` | ≥ 3 mensagens anteriores do remetente com o mesmo rótulo (≥ 90 %), ≥ 2 respostas suas, ou "apaga sem abrir"; domínio com ≥ 6 |
| 6 | Regras acima do limiar | `regra` | Importante ≥ 70, Outros ≥ 60, **Propaganda ≥ 85** |
| 7 | Modelo Naive Bayes local | `modelo` | Importante ≥ 75, **Propaganda ≥ 90**; nunca manda para Propaganda algo com relação pessoal |
| 8 | Na dúvida | `padrao` | Outros |

**Suspeitos:** se a análise de risco (regras, antivírus e, se ligado, o LLM) ou a lista de bloqueados indicar
golpe, a mensagem aparece em Suspeitos, com o selo de risco, os links neutralizados e os anexos só para salvar.
A sensibilidade e o modo sombra ficam em Configurações › Segurança. Só um "Mover para" seu tira uma mensagem de lá.

### Camada 1: regras com pontuação (`email/service/organize/rules.js`)

Cada regra soma pontos para uma categoria e deixa um motivo em português. Confiança = 50 + metade da diferença
entre a categoria vencedora e a segunda (máx. 98).

| Importante | Propaganda | Outros |
|---|---|---|
| Você respondeu esta mensagem (+60) ou nesta conversa (+50) | `List-Unsubscribe` (+25), `List-Id` (+10) | `Auto-Submitted` (+30) |
| Você favoritou (+45) | `Precedence: bulk` (+20) / `list` (+10), `Feedback-ID` (+8) | Assunto de aviso/recibo: pedido, nota fiscal, fatura, código… (+30, e −15 em Propaganda) |
| Você já escreveu para o remetente (+40) | Plataforma de marketing: Mailchimp, RD Station, HubSpot… (+25); de envio em massa: SendGrid, SES… (+12) | Remetente de avisos/sistema: notificacoes@, seguranca@… (+15) |
| Endereçada só a você, sem envio em massa (+20) | Remetente newsletter/marketing@ (+20), noreply (+8) | Remetente noreply (+10) |
| Sem cabeçalhos de envio em massa (+15) | Assunto com oferta, desconto, cupom, frete grátis… (+20 a +35) | Texto de aviso/recibo (+10) |
| Mesmo domínio da sua conta (+20), "Re:" (+10) | Link de descadastro no corpo (+20), muitas imagens para pouco texto (+15), links de rastreamento (+10) | |

Os cabeçalhos de envio em massa vêm junto com o envelope na sincronização (`messages.hdr`); o corpo, quando já
está no cache, acrescenta termos, links e imagens. As mensagens que já estavam no cache recebem os cabeçalhos
em segundo plano (só esses campos, em lotes de 200, com a conta ociosa).

### Camada 2: reputação (`organize/reputation.js`)

Recalculada do banco a cada ciclo (agregados por remetente e por domínio): o que você moveu, os rótulos de
treino das mensagens anteriores, abertura, resposta e "apagou ou arquivou sem abrir". Domínios de e-mail
gratuito (gmail.com…) e os das suas contas não viram reputação de domínio.

### Camada 3: modelo estatístico (`organize/bayes.js`)

Naive Bayes multinomial binarizado sobre o assunto, o remetente, o texto e marcadores estruturais
(`f:lu`, `f:espm`, `f:tome`…). Treino **incremental**: cada exemplo soma (ou, se o rótulo mudar, subtrai
exatamente) as contagens das suas palavras (`nb_tokens`). Passa a decidir com ≥ 30 exemplos e pelo menos duas
categorias com ≥ 8. A soma dos logs é dividida por √n para a confiança não ficar exagerada.

**Rótulos de treino** (nunca a decisão do próprio modelo, para não se autorreforçar):

| Fonte | Rótulo | Peso |
|---|---|---|
| Você moveu entre grupos | o grupo escolhido | **3** |
| Regra de remetente / confiáveis | a categoria | 2 |
| Você respondeu, a conversa tem resposta sua, ou favoritou | Importante | 1,5 |
| Regras com confiança ≥ 85 | a categoria | 1 |
| Apagou/arquivou sem abrir | Propaganda (se parece envio em massa) ou Outros | 1 / 0,5 |
| Mensagem suspeita (análise de risco) | não treina | — |

## Processo em segundo plano (`organize/index.js`)

- Roda no serviço de e-mail (utilityProcess), em lotes de 200 com pausa entre eles: a interface e a
  sincronização não travam (6 mil mensagens em ~1,5 s no teste de carga).
- **Idempotente e retomável:** o estado fica em `inbox_class` (versão, geração e "impressões digitais" das
  entradas). Rodar de novo não refaz nada; fechar o app no meio e abrir de novo continua de onde parou.
- **Ciclo:** classifica e treina → recalcula a reputação → se o modelo ou a reputação mudaram o bastante, sobe a
  geração e reclassifica as decisões automáticas (classifique, treine, reclassifique).
- **Na chegada:** mensagens novas da Caixa de entrada são classificadas dentro da própria sincronização, antes de
  aparecerem na lista (não passam por Outros para pular depois).
- **Reprocessa quando muda:** resposta, favorito, cabeçalhos ou corpo baixados, conversa respondida, resultado da
  análise de risco, configuração. Ler ou mover de pasta só atualiza o rótulo de treino, não a categoria.

## Configurações › E-mail › Organização da caixa de entrada

- Progresso do processo, estado do modelo (exemplos por categoria, vocabulário) e remetentes com atalho.
- Não lidas por grupo e **quantas mensagens cada camada decidiu** (você, regras de remetente, regras, reputação,
  modelo, na dúvida).
- **Aprender com o meu uso** (liga/desliga o treino), **Reclassificar tudo** e **Redefinir aprendizado**
  (apaga modelo, reputação e correções; as regras de remetente ficam).
- Tabela por mensagem: grupo, confiança, origem e motivo, com busca e filtros.

## Migração do banco (v7, automática)

`email/service/db.js` aplica sozinho ao abrir o app (controle por `PRAGMA user_version`):

```sql
ALTER TABLE messages ADD COLUMN hdr TEXT;            -- cabeçalhos de envio em massa (JSON); NULL = ainda não baixados
CREATE INDEX messages_from ON messages (from_addr);
CREATE TABLE inbox_class (...);                      -- grupo, categoria, confiança, origem, motivo, manual, treino
CREATE INDEX inbox_class_grp ON inbox_class (grp);
CREATE TABLE nb_tokens (token PRIMARY KEY, imp, prop, outr) WITHOUT ROWID;
```

Configurações novas na tabela `settings`: `senders_config` (confiáveis, bloqueados e regras; as listas antigas
do agente LLM são copiadas para cá na primeira abertura), `security_config` (modo sombra, sensibilidade,
quarentena), `organize_config` (aprendizado), `nb_meta` e os contadores `organize_*`.

## Como testar

### Automático (sem rede, sem custo)

```bash
node email/test/run-organize-cases.js
```

Usa um banco temporário com os exemplos de [`email/test/organize-cases.json`](../email/test/organize-cases.json)
e confere 35 pontos:

| Exemplo | Lida? | Esperado |
|---|---|---|
| Cliente escrevendo só para você, sem lista | não | Importante |
| Resposta numa conversa em que você respondeu | não | Importante |
| Colega do mesmo domínio para quem você já escreveu | não | Importante |
| Amiga respondendo a sua mensagem | não | Importante |
| Black Friday via Mailchimp (List-Unsubscribe, imagens, descadastro) | não | Propaganda |
| Curso via RD Station com "últimas vagas com desconto" | não | Propaganda |
| "Oferta de cashback" sem cabeçalhos nem corpo | não | **Outros** (na dúvida) |
| Pedido enviado (noreply, Amazon SES) | não | Outros |
| Notificação do GitHub (List-Id) | não | Outros |
| Código de verificação (Auto-Submitted) | não | Outros |
| Fatura disponível | não | Outros |
| "Itaú" escrevendo de um Gmail (perigoso) | não | Suspeitos |
| Newsletter via MailerLite | sim | Propaganda |
| Cliente que você respondeu | sim | Importante |
| Chamado aberto (automático) | sim | Outros |
| Golpe dos "Correios" | sim | Suspeitos |

Também confere: filtros Lidas e Não lidas, ler → continua no grupo, marcar como não lida → continua no
grupo, idempotência, aprendizado a partir do banco (modelo e reputação classificam remetentes novos que as regras
não decidem), retomada depois de interromper, mover/desfazer, atalho depois de 2 movimentos, regra de remetente
por domínio, conversas e "Mostrar mais".

### No app, com servidor IMAP de verdade (GreenMail)

1. Suba o GreenMail como em [EMAIL.md](EMAIL.md#como-testar-sem-contas-reais) e abra o app.
2. **Configurações (engrenagem no rodapé da barra lateral) › E-mail › Contas › + Adicionar conta › Outro**:
   `alice@local.test`, senha `secret`, IMAP `127.0.0.1:3993`, SMTP `127.0.0.1:3465`, usuário `alice`.
3. `node email/test/seed-greenmail.js` envia os mesmos exemplos (com List-Unsubscribe, Precedence, Auto-Submitted
   e Return-Path), grava as mensagens "enviadas" que criam as conversas e marca as lidas e respondidas.
4. Na aba de E-mail, confira:
   - cada exemplo no grupo da tabela acima; o golpe do "Itaú" em **Suspeitos** (recolhido) com links riscados;
   - abrir uma mensagem: ela fica no lugar; abrir outra: a anterior continua no grupo, sem negrito;
   - arrastar uma Propaganda para Importante; clique direito › Mover para / Sempre classificar este remetente;
   - filtros Lidas, Não lidas, Favoritas e Com anexo; a busca acha lidas e não lidas;
   - Configurações › Organização: decisões por mensagem com confiança e motivo; Reclassificar tudo.

`node email/test/seed-greenmail.js --dry` mostra os cabeçalhos de cada exemplo sem enviar nada.

## Limites conhecidos

- O modelo começa vazio: nas primeiras mensagens valem as regras e a reputação. Com o histórico do banco ele
  costuma ficar pronto na primeira varredura (precisa de 30 exemplos de pelo menos duas categorias).
- Mensagens antigas só têm o corpo no cache se já foram abertas ou estão entre as 15 mais recentes de cada
  Caixa de entrada; as demais são classificadas pelo envelope e pelos cabeçalhos.
- Em conversas, o grupo da conversa é o da mensagem mais recente dela na Caixa de entrada. "Mover para" numa
  conversa vale para todas as mensagens dela.

## Prioritários

Filtro **★ Prioritários** na Caixa de entrada: só as mensagens com relevância (0–100) acima do **limiar** (barra que
aparece com o filtro; padrão 60). Cada linha mostra a nota e o motivo, com a origem dos pontos, por exemplo
`84 · +10 marcado importante, +2 aberto · nota calculada 72 (regra padrão: categoria Importante)`.

### Nota exibida

**nota = nota calculada + ajuste manual + atividade**, limitada a 0–100. As três partes ficam em colunas separadas
(`priority_score.base`, `manual`, `activity`), então recalcular a nota nunca apaga um clique.

**Ajuste manual.** Na leitura, **★ Importante** soma 10 à nota atual (60 vira 70) e **Não importante** tira 10.
Clicar de novo desfaz. O ajuste é gravado em `priority_feedback.adjust`.

**Atividade** (sem LLM), gravada em `priority_activity` com data, uma vez por e-mail e tipo de ação:

| Ação | Pontos | Onde é registrada |
|---|---|---|
| Abrir | +2 | leitura (só Caixa de entrada) |
| Ler por mais de 20 s | +3 | leitura (a mensagem continua aberta e a janela visível) |
| Responder | +8 | ao enviar a resposta |
| Encaminhar | +6 | ao enviar o encaminhamento |
| Favoritar | +5 | ★ (tirar dos favoritos desfaz) |
| Baixar ou abrir anexo | +4 | Salvar / Abrir anexo |
| Clicar em link | +3 | clique num link do e-mail |
| Excluir sem abrir | −8 | Excluir / Excluir para sempre de uma não lida |
| Arquivar sem ler | −4 | Arquivar uma não lida |

Respondida ou favorita em outro programa (sem ação gravada) conta como a ação, na data do e-mail. Marcações e ações
perdem peso com a idade: meia-vida de 45 dias (uma resposta de 45 dias atrás vale +4).

### Nota calculada (`email/service/organize/priority.js`)

**Regra padrão**: Importante 72, Outros 40, Propaganda 12, Suspeito 0 (suspeitos ficam em no máximo 5).
**Aprendido**, a partir das marcações e da atividade dos **outros** e-mails (a própria mensagem não entra no
aprendizado dela; o efeito dela é só o ajuste e a atividade acima):

| Parte | Peso |
|---|---|
| Remetente | 1,6 |
| Domínio (exceto Gmail, Outlook etc.) | 0,8 |
| Tópicos vistos em 2+ e-mails | 1,0 |
| 7 vizinhos mais próximos pelo vetor do conteúdo (só marcações explícitas, similaridade ≥ 0,2) | 1,4 |

No aprendizado, uma marcação vale ±1 (com a queda por idade). A atividade de um e-mail vale 0,35 a cada 8 pontos,
no máximo 0,5 por e-mail: ensina remetente, domínio e tópicos, mas menos que um clique explícito.
`aprendido = 50 + 50·tanh(soma/1,5)`. Com poucas marcações a regra padrão ainda pesa (o aprendido chega a 100% com
15 marcações), então o filtro nunca fica vazio.

Cada marcação grava id do e-mail, remetente, domínio, assunto, tópicos (até 8 palavras-chave, assunto vale 3×), vetor do
conteúdo (256 dimensões, *hashing* de palavras e pares, calculado no app, sem rede), rótulo, ajuste e data.

### LLM (opcional)

Só nos casos ambíguos (nota até 12 pontos do limiar, sem marcação sua), das últimas 72 h, 15 por rodada, dentro do
limite diário. Vai só um **perfil resumido** (8 remetentes de cada lado, 10 tópicos aprovados e 10 rejeitados,
3 exemplos de cada) e o e-mail (1200 caracteres), nunca o histórico. O perfil é refeito a cada marcação ou ação.
A opinião entra na nota calculada (`0,4·regras + 0,6·LLM`) e fica guardada para não perguntar de novo.
**Modelos gratuitos** (OpenRouter) só recebem mensagens **não lidas** que chegaram **depois que a chave foi colocada**;
vale também para a análise de segurança.

### Banco

v8: `priority_feedback`, `priority_score`; configurações `priority_config` e `priority_profile`; `openrouter_key_at`.
v9: `priority_feedback.adjust`; `priority_score.base`, `manual`, `activity`; tabela `priority_activity`.

Testes: `node email/test/run-priority-cases.js` (60 vira 70, limites de 0 e 100, desfazer, ajuste preservado no
recálculo, pontos e motivo de cada ação, uma vez por ação, queda por idade, aprendizado pela atividade).
