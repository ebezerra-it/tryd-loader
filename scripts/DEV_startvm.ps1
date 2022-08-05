$ErrorActionPreference = "Stop"
$APP_DIR=$args[0]
#VM parameters
$VM_NAME="w10tryd"
$VM_USER="myoraculum"
$VM_PWD="jd1V7J@-g!q5Tzd#"
#VRDE parameters
$VRDE_PORT=3980
$VRDE_USR="myoraculum"
$VRDE_PWD="jd1V7J@-g!q5Tzd#"

#Check if APP_DIR directory exists
if (-not (Test-Path -Path $APP_DIR)) {
    throw "ERROR - Wrong APP_DIR parameter: $APP_DIR"
    exit(1)
}

#Check if VirtualBox service is running on host
if (-not ((gps) -match "VirtualBox")) {
    throw "ERROR - Couldnt lauch VBoxManage. Check VirtualBox service!"
    exit(1)
}

#Check if VM_NAME exists in HOST
if (-not ((VBoxManage list vms) -match "$VM_NAME")) {
    throw "ERROR - Missing VM: $VM_NAME"
    exit(2)
}

#If VM is running, power it off
if ((VBoxManage showvminfo "$VM_NAME") -match "running") {
    echo 'Powering off VM...'
    VBoxManage controlvm "$VM_NAME" poweroff
}

echo 'Restoring VM snapshot...'
#Check if VM-startup snapshot exists in HOST
if (-not ((VBoxManage snapshot "$VM_NAME" list) -match "$VM_NAME-startup")) {
    throw "ERROR - Missing VM snapshot: $VM_NAME-startup"
    exit(3)
}
#Restore VM-startup snapshot in HOST
VBoxManage snapshot "$VM_NAME" restore "$VM_NAME-startup"

#Set VRDP Settings
echo 'Setting VM VRDE settings...'
VBoxManage setproperty vrdeauthlibrary "VBoxAuthSimple"
if ((VBoxManage internalcommands passwordhash $VRDE_PWD) -match '^Password hash: (.+)$') {
    $pwd_hash = $matches[1]
} else {
    throw "ERROR - Cant generate VRDE password hash: $matches"
    exit(4)
}
VBoxManage setextradata w10tryd "VBoxAuthSimple/users/$VRDE_USR" $pwd_hash
VBoxManage modifyvm "$VM_NAME" --vrde off --vrdeport $VRDE_PORT --vrdeauthtype external --vrdemulticon off

#Start VM
echo 'Starting VM...'
VBoxManage startvm "$VM_NAME" --type headless 

echo 'Setting VM screen resolution to 1024x762 16'
VBoxManage controlvm "$VM_NAME" setvideomodehint 1024 768 16

echo 'Setting VM shared folder...'
#If sharedfolder "app" exists in HOST, remove it
try { VBoxManage sharedfolder remove "$VM_NAME" --name "app" 2>$null } catch {}
#Create sharedfolder "app"
VBoxManage sharedfolder add "$VM_NAME" --name "app" --hostpath "$APP_DIR" --automount --auto-mount-point="Z:\" --transient 

#RDP setup
#VBoxManage controlvm "$APP_DIR" vrde off

#Start TryLoad service in HOST
#VBoxManage guestcontrol "$VM_NAME" --username $VM_USER --password $VM_PWD run -- "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -command "node "
#VBoxManage guestcontrol "w10tryd" --username "myoraculum" --password "jd1V7J@-g!q5Tzd#" run -- "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -command gps
#Install Group 
#VBoxManage guestcontrol "w10tryd" --username "myoraculum" --password "jd1V7J@-g!q5Tzd#" run -- "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -command "Enable-WindowsOptionalFeature -Online -FeatureName ""RSAT: Group Policy Management Tools"" -All"

#Start-Sleep -Seconds 5
echo '-------------- VM STARTED! ---------------'
