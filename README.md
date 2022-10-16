# My Oraculum Tryd Loader

A tool for loading data from B3 Exchanges using Tryd Pro.

## VM requirements
- OS: Windows 10 21H2 x64 Tiny
- OS: Install disk drivers from virtio-win.iso
- OS: Install winfsp-1.11.22176.msi
- OS: Update driver for device "Mass Storage" from virtio-win.iso
- OS: Install agent drivers from virtio-win.iso
- Language setup: remove EN keyboard
- Language setup: change regional settings (date, time and number formats)
- Taskbar: hidde search box
- WIN: Policy Editor: Computer Configuration -> Administrative Templates -> Windows Components -> Search -> Do not allow locations on removable drives to be added to libraries -> Enable
- WIN: Services: Windows Search -> STOP / Startup type: DISABLED
- WIN: Services: Windows Update -> STOP / Startup type: DISABLED
- WIN: Services: Windows Modules Installer Worker -> STOP / Startup type: DISABLED
- WIN: Services: Windows Time -> START / Startup type: Automatic
- WIN: Regedit: HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System Add a new DWORD value: LocalAccountTokenFilterPolicy Set LocalAccountTokenFilterPolicy = 1 and reboot VM
- WIN: PSTools: Install PSTools on %SystemRoot%\PSTools folder and add folder to System PATH;
- Install: Autologon
- Install: Tryd
- Install: Node 14.3.0
- Install: cross-env GLOBAL (npm install -g cross-env)
- Install: TinyWall
- Tryd: import trydloader_config.zip
- Tryd: register DDE/RTD dll (run as administrator)
- Tryd: pin icon as 1 item in taskbar
- Tryd: set taskbar pinned icon property "RUN AS: MAXIMIZED"
- Tinywall: import tinywall_config.tws

## Authors
- [@Eduardo Bulhões](https://www.github.com/ebezerra-it)