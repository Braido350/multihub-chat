# MultiHub Chat

Aplicativo desktop (Electron) que reúne até **3 sites de atendimento** em uma única janela, com troca rápida pela barra lateral: WhatsApp Web, [Chatwoot](https://www.chatwoot.com/) ou qualquer outro site.

- Site principal configurado na primeira abertura; mais 2 pelo botão **+** (botão direito no ícone → **Editar…** para trocar)
- Aba de **E-mail** (botão **+** → E-mail): caixa unificada para Gmail, Locaweb e qualquer IMAP/SMTP; veja [docs/EMAIL.md](docs/EMAIL.md)
- Login separado por site
- Notificações nativas do sistema e aviso de chamadas do WhatsApp Web
- Fica na bandeja ao fechar e inicia junto com o sistema
- Atalhos: Ctrl+1..3 troca de site, F5 recarrega, Ctrl + / Ctrl - / Ctrl 0 zoom, F11 tela cheia
- Corretor ortográfico pt-BR
- O instalador do Windows fecha versões abertas do app antes de instalar

> Projeto independente, sem vínculo com WhatsApp, Meta ou Chatwoot Inc.

## Desenvolvimento
    bun install
    bun run start

## Gerar executáveis (saída em `dist/`)
    bun run build:linux   # AppImage
    bun run build:win     # instalador NSIS + portátil .exe
    bun run build:all     # os dois (Windows a partir do Linux exige wine)

A versão fica no campo `version` do `package.json`.

## Linux
    chmod +x MultiHubChat-*.AppImage
    ./MultiHubChat-*.AppImage
Se reclamar de FUSE: `sudo dnf install fuse-libs` (Fedora) ou `sudo apt install libfuse2` (Debian/Ubuntu).

## Windows sem wine
Use o workflow `.github/workflows/build.yml` (GitHub Actions), que compila cada sistema no seu próprio runner.

## Licença
MIT
