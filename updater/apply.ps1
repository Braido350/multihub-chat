# Atualizador separado do MultiHub Chat (Windows). O app copia este script para <dados do usuário>\updates,
# grava o plano (plan.json) e fecha. Aqui: espera o app fechar, faz backup da versão atual, troca pelos arquivos
# novos, reabre o app e espera ele avisar que iniciou; se não iniciar, restaura o backup e reabre a versão antiga.
# Banco, configurações e chaves ficam em <dados do usuário>, fora da pasta do app: nada disso é tocado.
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File apply.ps1 -Plan plan.json
param([Parameter(Mandatory = $true)][string]$Plan)
$ErrorActionPreference = "Stop"
$p = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json

function Log([string]$msg) {
  $line = "{0} [atualizador {1}->{2}] {3}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $p.from, $p.version, $msg
  Add-Content -LiteralPath $p.log -Value $line -Encoding UTF8
}
function Result([string]$status) {
  $o = @{ status = $status; version = $p.version; from = $p.from; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
  ($o | ConvertTo-Json -Compress) | Set-Content -LiteralPath $p.result -Encoding UTF8
}
function Launch {
  $script:launched = Start-Process -FilePath $p.exe -PassThru
}
# Arquivos do app podem ficar presos por alguns segundos depois de fechar (antivírus, processos auxiliares)
function MoveWithRetry([string]$from, [string]$to) {
  for ($i = 0; $i -lt 60; $i++) {
    try { Move-Item -LiteralPath $from -Destination $to -Force; return $true } catch { Start-Sleep -Milliseconds 500 }
  }
  Log ("não foi possível mover {0} para {1}: {2}" -f $from, $to, $_)
  return $false
}

try {
  Log ("início (modo {0}, alvo {1})" -f $p.mode, $p.target)

  # 1) Espera o app fechar
  $proc = Get-Process -Id $p.pid -ErrorAction SilentlyContinue
  if ($proc) {
    if (-not $proc.WaitForExit([int]$p.waitExit * 1000)) {
      Log ("o app (pid {0}) não fechou em {1}s: atualização cancelada" -f $p.pid, $p.waitExit)
      Result "cancelled"; exit 1
    }
  }
  Start-Sleep -Seconds 2
  Log "app fechado"

  # 2) Backup da versão atual
  if (Test-Path -LiteralPath $p.backup) { Remove-Item -LiteralPath $p.backup -Recurse -Force }
  if (-not (MoveWithRetry $p.target $p.backup)) {
    Log "não foi possível fazer o backup: atualização cancelada"
    Result "cancelled"; Launch; exit 1
  }
  Log ("backup feito em {0}" -f $p.backup)

  function Restore {
    Log ("restaurando a versão {0}" -f $p.from)
    if (Test-Path -LiteralPath $p.target) { Remove-Item -LiteralPath $p.target -Recurse -Force -ErrorAction SilentlyContinue }
    if (MoveWithRetry $p.backup $p.target) { Log ("versão {0} restaurada" -f $p.from) } else { Log ("ERRO: não foi possível restaurar; o backup continua em {0}" -f $p.backup) }
    Result "rollback"
    Launch
  }

  # 3) Troca pelos arquivos novos (já extraídos e conferidos pelo app)
  if (-not (MoveWithRetry $p.staged $p.target)) { Log "falha ao copiar os arquivos novos"; Restore; exit 1 }
  Log ("arquivos da versão {0} no lugar" -f $p.version)
  # Instalação NSIS: o desinstalador fica na pasta do app e não vem no pacote; traz da versão anterior
  if ($p.mode -eq "dir") {
    Get-ChildItem -LiteralPath $p.backup -Filter "Uninstall*.exe" -File -ErrorAction SilentlyContinue | ForEach-Object {
      $dest = Join-Path $p.target $_.Name
      if (-not (Test-Path -LiteralPath $dest)) { Copy-Item -LiteralPath $_.FullName -Destination $dest; Log ("desinstalador mantido: {0}" -f $_.Name) }
    }
  }

  # 4) Reabre e espera o app avisar que iniciou
  if (Test-Path -LiteralPath $p.marker) { Remove-Item -LiteralPath $p.marker -Force }
  Launch
  Log ("app reaberto (pid {0}); esperando iniciar" -f $script:launched.Id)
  $deadline = (Get-Date).AddSeconds([int]$p.waitStart)
  while (-not (Test-Path -LiteralPath $p.marker)) {
    $failed = $null
    if ((Get-Date) -gt $deadline) { $failed = "não iniciou em $($p.waitStart)s" }
    elseif ($script:launched.HasExited) {
      Start-Sleep -Seconds 1
      if (Test-Path -LiteralPath $p.marker) { break }
      $failed = "fechou sozinha antes de iniciar"
    }
    if ($failed) {
      Log ("a versão {0} {1}" -f $p.version, $failed)
      if (-not $script:launched.HasExited) { Stop-Process -Id $script:launched.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
      Restore
      exit 1
    }
    Start-Sleep -Milliseconds 500
  }
  Log ("versão {0} iniciou: atualização concluída" -f $p.version)
  Result "ok"
  exit 0
} catch {
  Log ("erro inesperado: {0}" -f $_)
  exit 1
}
