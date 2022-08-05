
#RUN BUILD NODE PROJECT PROCEDURES
APP_VERSION=1.0
APP_DIR="/app/myoraculum-trydloader/"
APP_SERVICE="TrydDataLoader"
VM_NAME="WIN10Light"
VM_USER=
VM_PWD=
VRDE_PORT=3380

#REMOTE - STOP AND UNREGISTER VM ON REMOTE SERVER IF EXISTS
#plink ebezerra@66.94.96.81 -P 2222 -m vm_unregister.sh -i C:\\Users\\ebeze\\.ssh\\id_rsa.ppk -no-antispoof
#ssh ebezerra@66.94.96.81 APP_VERSION=$APP_VERSION 'bash -s' <<'ENDSSH'
ssh ebezerra@66.94.96.81 -p 2222 APP_VERSION=$APP_VERSION APP_DIR=$APP_DIR VM_NAME=$VM_NAME 'bash -s' << \ENDSSH
# VMBOX - CHECK IF VM EXISTS ON REMOTE SERVER
if VBoxManage list vms | grep $VM_NAME; then
    # VMBOX - STOP VM ON REMOTE SERVER IF RUNNING
    if VBoxManage showvminfo $VM_NAME | grep -c "running" -eq 1; then
        VBoxManage controlvm $VM_NAME poweroff
    fi
    # VMBOX - UNREGISTER VM AND DELETE VM FILES ON REMOTE SERVER
    VBoxManage unregistervm $VM_NAME --delete
fi
ENDSSH

#COPY BUILD NODE PROJECT FILES TO REMOTE SERVER
scp "./deploy" ebezerra@66.94.96.81:"${APP_DIR%%+(/)}/" -r -P 2222

#COPY VM APPLIANCE FILE (.OVA) TO REMOTE SERVER
scp "./vm/$VM_NAME.ova" ebezerra@66.94.96.81:"${APP_DIR%%+(/)}/vm/" -P 2222

#REMOTE - IMPORT AND START VM ON REMOTE SERVER
#ssh ebezerra@66.94.96.81 APP_VERSION=$APP_VERSION APP_DIR=$APP_DIR 'bash -s' <<'ENDSSH'
ssh ebezerra@66.94.96.81 -p 2222 APP_VERSION=$APP_VERSION APP_DIR=$APP_DIR VM_NAME=$VM_NAME 'bash -s' << \ENDSSH
# VMBOX - IMPORT VM APPIANCE FILE (.OVA)
echo 'Importing VM appliance file...'
VBoxManage import "${APP_DIR%%+(/)}/vm/$VM_NAME.ova"
VBoxManage setextradata "$VM_NAME" app_version $APP_VERSION
VBoxManage setextradata "$VM_NAME" deploy_date $(TZ=":America/Sao_Paulo" date '+%Y-%m-%d %H:%M:%S')

# VMBOX - RESTORE VM STARTUP SNAPSHOT
echo 'Restoring VM snapshot...'
VBoxManage snapshot "$VM_NAME" restore "$VM_NAME-startup"

echo 'Setting VM VRDE settings...'
VBoxManage modifyvm "$VM_NAME" --vrde on --vrdeport $VRDE_PORT --vrdeauthtype external

# VMBOX - START VM
echo 'Starting VM...'
VBoxManage modifyvm "$VM_NAME" --autostart-enabled on
VBoxManage modifyvm "$VM_NAME" --autostart-delay 60
VBoxManage startvm "$VM_NAME" --type headless

# VMBOX - SET VM SCREEN RESOLUTION
echo 'Setting VM screen resolution to 1024x762 16...'
VBoxManage controlvm "$VM_NAME" setvideomodehint 1024 768 16

# VMBOX - SET SHARED FOLDER POINTING TO NODE PROJECT FOLDER
echo 'Setting VM shared folder...'
VBoxManage sharedfolder remove "$VM_NAME" --name "app" || true 2> /dev/null
VBoxManage sharedfolder add "$VM_NAME" --name "app" --hostpath "${APP_DIR%%+(/)}" --automount  --auto-mount-point="Z:"

# VMBOX - START TRYD-LOAD SERVICE
VBoxManage guestcontrol "$VM_NAME" --username $VM_USER --password $VM_PWD run -- powershell -command "Restart-Service $APP_SERVICE -Force"

#DELETE VM APPLIANCE FILE (.OVA)
rm -f "${APP_DIR%%+(/)}/vm/$VM_NAME.ova"
ENDSSH

ECHO "[-------------- BUILD PROCESS FINISHED ----------------]"
# WINDOWS SERVICE POINTING TO NODE PROJECT FOLDER
