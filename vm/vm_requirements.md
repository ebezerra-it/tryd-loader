# VM requirements

- OS: Windows 10 Tiny
- Language setup: remove EN keyboard
- Language setup: change regional settings (date, time and number formats)
- Taskbar: hidde search box
- RDP Setup: Windows Settings/ Local Group Policy Editor/ Computer Configuration/ Administrative Templates/ Windows Components/ Remote Desktop Services/ Remote Desktop Session Host/ Remote Session Environment [working vm_configure.ps1]
- RDP Setup: Limit maximum display resolution to 1024x768 [working vm_configure.ps1]
- RDP Setup: Limit number of monitors to 1 [working vm_configure.ps1]
- RDP Setup: Limit maximum color depth to 3 (16-bits) [working vm_configure.ps1]
- WIN: Policy Editor: Computer Configuration -> Administrative Templates -> Windows Components -> Search -> Do not allow locations on removable drives to be added to libraries -> Enable
- Install: Autologon
- Install: Tryd
- Install: Node 14.3.0
- Install: TinyWall
- Tryd: import trydloader_config.zip
- Tryd: register DDE/RTD dll (run as administrator)
- Tryd: pin icon as 1 item in taskbar
- Tryd: set taskbar pinned icon property "RUN AS: MAXIMIZED"
- Tinywall: import tinywall_config.tws
