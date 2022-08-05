if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) { Start-Process powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs; exit }
# Your script here
$RDP_REG_PATH="HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services"
Set-ItemProperty -Path $RDP_REG_PATH -Name MaxXResolution -Type DWord -Value 1024
Set-ItemProperty -Path $RDP_REG_PATH -Name MaxYResolution -Type DWord -Value 768
Set-ItemProperty -Path $RDP_REG_PATH -Name MaxMonitors -Type DWord -Value 1
Set-ItemProperty -Path $RDP_REG_PATH -Name ColorDepth -Type DWord -Value 3

echo "RDP configuration done!"
read-host “Press ENTER to continue...”