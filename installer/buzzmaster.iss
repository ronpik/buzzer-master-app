; installer/buzzmaster.iss — Buzz Master Windows installer (Inno Setup 6.3+)
;
; Builds an .exe that installs the bundled payload produced by
; packaging/assemble.mjs (node.exe + server/ + dist/ + minimal node_modules +
; launcher.mjs). No Node, no admin dev environment required on the target.
;
; Compile (after `node packaging/assemble.mjs build\app`):
;   ISCC /DAppVersion=1.0.0 /DStageDir=PATH\TO\build\app installer\buzzmaster.iss
;
; The installer also:
;   • creates a Start Menu + (optional) Desktop shortcut that runs the launcher,
;   • opens TCP port 8080 in Windows Firewall so team tablets can connect,
;   • removes that firewall rule on uninstall.
; The launcher itself redirects the SQLite DB to %LOCALAPPDATA%\BuzzMaster
; (Program Files is read-only) and opens the Admin page in the browser.

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef StageDir
  #define StageDir "..\build\app"
#endif

[Setup]
AppId={{8F3B2A1C-4D5E-4F6A-9B8C-1D2E3F4A5B6C}
AppName=Buzz Master
AppVersion={#AppVersion}
AppPublisher=Buzz Master
DefaultDirName={autopf}\BuzzMaster
DefaultGroupName=Buzz Master
DisableProgramGroupPage=yes
UninstallDisplayName=Buzz Master
OutputBaseFilename=BuzzMaster-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Buzz Master"; Filename: "{app}\node.exe"; Parameters: """{app}\launcher.mjs"""; WorkingDir: "{app}"; Comment: "Start Buzz Master and open the Admin page"
Name: "{commondesktop}\Buzz Master"; Filename: "{app}\node.exe"; Parameters: """{app}\launcher.mjs"""; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{group}\Uninstall Buzz Master"; Filename: "{uninstallexe}"

[Run]
; Allow inbound connections from team tablets on the contest Wi-Fi.
Filename: "{sys}\netsh.exe"; \
  Parameters: "advfirewall firewall add rule name=""Buzz Master 8080"" dir=in action=allow protocol=TCP localport=8080 profile=any"; \
  Flags: runhidden; StatusMsg: "Allowing port 8080 through Windows Firewall..."
; Optionally start right after install.
Filename: "{app}\node.exe"; Parameters: """{app}\launcher.mjs"""; WorkingDir: "{app}"; \
  Description: "Launch Buzz Master now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\netsh.exe"; \
  Parameters: "advfirewall firewall delete rule name=""Buzz Master 8080"""; \
  Flags: runhidden; RunOnceId: "DeleteBuzzMasterFirewallRule"
