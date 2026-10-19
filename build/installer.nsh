; AutumnFlow NSIS 定制：始终“仅为当前用户”安装，跳过“为谁安装”选择页。
; 目录页保留（allowToChangeInstallationDirectory），自动更新时 /S 静默并沿用 HKCU InstallLocation。
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
