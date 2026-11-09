# Atualização automática

O app procura versões novas sozinho, baixa em segundo plano, confere e instala na próxima vez que é aberto,
sem perguntar nada. Código em [`updater/`](../updater), tela em **Configurações › Aplicativo › Atualizações**.

## Fluxo

```
App aberto: ao abrir (15 s depois) e a cada 6 h
  └─ baixa o latest.json (URL configurável)
       └─ versão publicada > instalada (semver)?  não → "Você está na versão mais recente"
            └─ sim: baixa o .zip para <dados do usuário>/updates  (retoma de onde parou; até 5 tentativas)
                 └─ confere o SHA-256  ✗ → apaga o arquivo e registra o erro (nada é instalado)
                      └─ ✓ extrai em updates/staging-X e guarda em updates/state.json   (nenhuma pergunta)

Próxima vez que o app abrir (antes de mostrar a janela)
  └─ há versão guardada, mais nova e que não falhou antes?
       1. grava o plano e inicia o atualizador separado (cópia fora da pasta do app)
       2. o app fecha
       3. atualizador: espera o app fechar → backup da versão atual (updates/backup)
          → põe os arquivos novos no lugar → reabre o app
       4. o app novo grava updates/started-X.ok ao abrir
          ├─ apareceu em até 90 s → "atualização concluída"
          └─ não apareceu (ou o app fechou sozinho) → restaura o backup e reabre a versão antiga,
             que avisa "A atualização não deu certo" e não tenta essa versão de novo sozinha
```

Para quem usa, a abertura fica um pouco mais lenta uma vez: o app abre, fecha e abre de novo já atualizado.
Nas Configurações, **Atualizar agora** aplica na hora, sem esperar a próxima abertura.

- **Dados preservados:** banco de e-mails, configurações, sites e chaves (senhas criptografadas, tokens)
  ficam em `<dados do usuário>`, fora da pasta do app, e o atualizador nunca mexe neles.
  - Linux: `~/.config/MultiHub Chat`
  - Windows: `%APPDATA%\MultiHub Chat`
- **Versão já baixada:** o `.zip` conferido fica em `updates/` com um `.json` do hash e não é baixado de novo.
  Download interrompido continua do ponto em que parou (cabeçalho HTTP `Range`). Se o latest.json mudar
  o hash, o pedaço antigo é descartado.
- **Versão que falhou:** não é aplicada de novo sozinha (evita repetir sem fim); "Atualizar agora" ainda funciona.
- **Registro:** tudo vai para `updates/update.log`, do app e do atualizador separado. O arquivo gira em 1 MB.
  "Abrir pasta do registro" nas Configurações mostra o arquivo.

### Instalações suportadas

Só duas: o **AppImage** (Linux) e a **instalação do Windows** (instalador NSIS). Os builds geram só esses
dois. Uma versão portátil do Windows ou a pasta `linux-unpacked` rodada direto não se atualiza: o app mostra
o motivo nas Configurações.

| Tipo | Como o app foi instalado | O que é trocado | Pacote (.zip) contém |
|---|---|---|---|
| `linux-appimage` | AppImage | o arquivo `.AppImage` (variável `APPIMAGE`) | só o `.AppImage` |
| `win-dir` | instalador NSIS | a pasta de instalação (o desinstalador é mantido) | o conteúdo de `win-unpacked` |

- **Pasta sem permissão de escrita** (ex.: instalado em `Program Files` para todos os usuários): o app
  avisa para instalar a versão nova manualmente. O instalador padrão instala por usuário e funciona.
- **Modo de desenvolvimento** (`npm start`): verifica e baixa, mas não instala.

### Atualizador separado

O app não sobrescreve os próprios arquivos em uso. Ele copia o script para `updates/` e o inicia
desacoplado:

- Linux: `/bin/sh updates/apply.sh updates/plan.env`
- Windows: `powershell -File updates\apply.ps1 -Plan updates\plan.json`

Ele espera o processo do app terminar (até 90 s), faz o backup, troca os arquivos e reabre o app. Se a
versão nova não iniciar, restaura o backup. O resultado vai para `updates/result.json`, que o app lê na
abertura seguinte. O backup fica até a próxima atualização.

Variáveis do AppImage (`APPDIR`, `LD_LIBRARY_PATH`…) não passam para o app reaberto.

## latest.json

```json
{
  "version": "1.2.0",
  "date": "2026-11-09T19:00:00.000Z",
  "notes": "Novidades da versão…",
  "files": {
    "linux-appimage": { "url": "https://github.com/Braido350/multihub-chat/releases/download/v1.2.0/MultiHubChat-1.2.0-linux-appimage.zip", "sha256": "…", "size": 123 },
    "win-dir":        { "url": "…/MultiHubChat-1.2.0-win-dir.zip",      "sha256": "…", "size": 123 }
  }
}
```

Também aceita `url` e `sha256` direto na raiz, para quem publica um tipo só.

## Publicar uma versão

1. Suba a versão em `package.json` (ex.: `1.2.0`) e gere os builds:
   ```bash
   npm run build:all        # ou build:linux / build:win
   ```
2. Gere os pacotes e o latest.json:
   ```bash
   npm run release -- --base-url https://github.com/Braido350/multihub-chat/releases/download/v1.2.0/ --notes-file NOTAS.md
   ```
   O script pega o que achar em `dist/`: o AppImage e a pasta `win-unpacked` (base da instalação do Windows).
   A saída fica em `dist/release/`: um `.zip` por tipo e o `latest.json`, com SHA-256 e tamanho.
3. Crie o release `v1.2.0` no GitHub e anexe **todos** os arquivos de `dist/release/`, inclusive o
   `latest.json`.
4. No app, a URL é sempre a do release mais recente:
   `https://github.com/Braido350/multihub-chat/releases/latest/download/latest.json`
   - **Para todos:** coloque a URL em `package.json › multihub.updateUrl` antes do build.
   - **Num app já instalado:** cole a URL em Configurações › Aplicativo › Atualizações.
   - **Em teste:** use a variável `MULTIHUB_UPDATE_URL`.

> **Segurança:** o SHA-256 garante que o arquivo baixado é o publicado no latest.json, e a URL é `https`.
> Quem controlar o repositório controla as atualizações: proteja a conta do GitHub (2FA).

## Testar

**Automático**, com versão falsa (`9.9.9-fake`), servidor local e app falso:

```bash
npm run test:updater
```

Cobre:

- semver e o zip, inclusive permissões e o bloqueio de `../`;
- conexão que cai no meio do download e é retomada;
- SHA-256 errado;
- não baixar de novo e não perguntar nada;
- nada muda com o app aberto, e na próxima abertura a versão é aplicada pelo `apply.sh` de verdade:
  espera o app fechar, backup, troca, dados intactos e log;
- versão que não inicia, com restauração, aviso e sem tentar de novo ao abrir;
- troca de um AppImage pelo "Atualizar agora".

**No app**, com versão falsa:

```bash
MULTIHUB_FAKE_VERSION=0.0.1 MULTIHUB_UPDATE_URL=https://…/latest.json npm start
```

Configurações › Aplicativo › Atualizações › **Verificar atualizações** mostra o download, a conferência e
as notas. Em desenvolvimento não instala, nem ao abrir.

Para a troca completa, rode o AppImage gerado com `MULTIHUB_FAKE_VERSION=0.0.1` e um latest.json local.

O `apply.ps1` (Windows) foi escrito com a mesma lógica do `apply.sh`, mas não foi executado num Windows de
verdade. Teste uma vez com o app instalado pelo instalador antes de publicar.
