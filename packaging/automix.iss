; Inno Setup script: wraps the PyInstaller onedir output (dist\Automix) into a
; Windows installer .exe with Start Menu + optional desktop shortcuts.
; Built in CI: ISCC.exe /DAppVer=<version> packaging\automix.iss
; SourceDir is the repo root (this script lives in packaging\).

#ifndef AppVer
  #define AppVer "0.0.0"
#endif

[Setup]
AppName=Automix
AppVersion={#AppVer}
AppPublisher=EDMPAPA
DefaultDirName={autopf}\Automix
DefaultGroupName=Automix
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\Automix.exe
SourceDir=..
OutputDir=.
OutputBaseFilename=Automix-windows-x64-setup
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
Source: "dist\Automix\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Automix"; Filename: "{app}\Automix.exe"
Name: "{group}\Uninstall Automix"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Automix"; Filename: "{app}\Automix.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Automix.exe"; Description: "Launch Automix now"; Flags: nowait postinstall skipifsilent
