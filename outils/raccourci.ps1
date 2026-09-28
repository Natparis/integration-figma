# Cree un raccourci « Site vers Figma » sur le Bureau.
#
# Un raccourci Windows (.lnk) ne peut pas s ecrire a la main : seul l objet COM
# WScript.Shell sait le produire. PowerShell est present sur tout Windows
# recent, aucune installation n est donc necessaire.

$ErrorActionPreference = "Stop"

$racine  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$cible   = Join-Path $racine "demarrer.bat"
$icone   = Join-Path $racine "outils\icone.ico"
$bureau  = [Environment]::GetFolderPath("Desktop")
$lien    = Join-Path $bureau "Site vers Figma.lnk"

if (-not (Test-Path $cible)) {
  Write-Host "  Fichier de demarrage introuvable : $cible"
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
$raccourci = $shell.CreateShortcut($lien)
$raccourci.TargetPath       = $cible
$raccourci.WorkingDirectory = $racine
$raccourci.Description      = "Transformer votre site en maquette Figma"
if (Test-Path $icone) { $raccourci.IconLocation = $icone }
$raccourci.Save()

Write-Host "  Raccourci cree sur le Bureau : Site vers Figma"
