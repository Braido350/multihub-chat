#!/bin/sh
# Atualizador separado do MultiHub Chat (Linux). O app copia este script para <dados do usuário>/updates,
# grava o plano (plan.env) e fecha. Aqui: espera o app fechar, faz backup da versão atual, troca pelos arquivos
# novos, reabre o app e espera ele avisar que iniciou; se não iniciar, restaura o backup e reabre a versão antiga.
# Banco, configurações e chaves ficam em <dados do usuário>, fora da pasta do app: nada disso é tocado.
# Uso: sh apply.sh plan.env
set -u
. "$1" || exit 1

log() { printf '%s [atualizador %s→%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$U_FROM" "$U_VERSION" "$*" >> "$U_LOG"; }
result() { printf '{"status":"%s","version":"%s","from":"%s","at":"%s"}\n' "$1" "$U_VERSION" "$U_FROM" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$U_RESULT"; }
launch() { # abre o app desacoplado deste script
  if [ "$U_MODE" = file ]; then chmod +x "$U_EXE" 2>/dev/null; fi
  nohup "$U_EXE" >/dev/null 2>&1 &
  LAUNCHED=$!
}

log "início (modo $U_MODE, alvo $U_TARGET)"

# 1) Espera o app fechar
i=0
while kill -0 "$U_PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt $((U_WAIT_EXIT * 2)) ]; then log "o app (pid $U_PID) não fechou em ${U_WAIT_EXIT}s: atualização cancelada"; result cancelled; exit 1; fi
  sleep 0.5
done
sleep 1 # processos auxiliares do Electron terminando
log "app fechado"

# 2) Backup da versão atual
rm -rf "$U_BACKUP"
if ! mv "$U_TARGET" "$U_BACKUP"; then
  log "não foi possível fazer o backup de $U_TARGET: atualização cancelada"
  result cancelled
  launch
  exit 1
fi
log "backup feito em $U_BACKUP"

restore() {
  log "restaurando a versão $U_FROM"
  rm -rf "$U_TARGET"
  if mv "$U_BACKUP" "$U_TARGET"; then log "versão $U_FROM restaurada"; else log "ERRO: não foi possível restaurar; o backup continua em $U_BACKUP"; fi
  result rollback
  launch
}

# 3) Troca pelos arquivos novos (já extraídos e conferidos pelo app)
if ! mv "$U_STAGED" "$U_TARGET"; then
  log "falha ao copiar os arquivos novos"
  restore
  exit 1
fi
[ "$U_MODE" = file ] && chmod +x "$U_TARGET"
log "arquivos da versão $U_VERSION no lugar"

# 4) Reabre e espera o app avisar que iniciou
rm -f "$U_MARKER"
launch
log "app reaberto (pid $LAUNCHED); esperando iniciar"
i=0
while [ ! -f "$U_MARKER" ]; do
  i=$((i + 1))
  failed=""
  if [ "$i" -gt $((U_WAIT_START * 2)) ]; then failed="não iniciou em ${U_WAIT_START}s"; fi
  if [ "$i" -gt 4 ] && ! kill -0 "$LAUNCHED" 2>/dev/null; then sleep 1; [ -f "$U_MARKER" ] && break; failed="fechou sozinha antes de iniciar"; fi
  if [ -n "$failed" ]; then
    log "a versão $U_VERSION $failed"
    kill "$LAUNCHED" 2>/dev/null
    sleep 2
    kill -9 "$LAUNCHED" 2>/dev/null
    restore
    exit 1
  fi
  sleep 0.5
done
log "versão $U_VERSION iniciou: atualização concluída"
result ok
exit 0
