#!/bin/bash
set -e # Exit script immediately if a command exits with a non-zero status

# Parse arguments
for ARGUMENT in "$@"
do
   KEY=$(echo $ARGUMENT | cut -f1 -d=)

   KEY_LENGTH=${#KEY}
   VALUE="${ARGUMENT:$KEY_LENGTH+1}"

   export "$KEY"="$VALUE"
done

# Database parameters
#DB_HOST="192.168.122.1"
#DB_PORT="5432"
#DB_USER="myoraculum-user"
#DB_PASS="myoraculum-pwd"
#DB_NAME="myoraculum-db"

#VM parameters
#VM_NAME="w10tryd"

source ~/app/myoraculum/trydloader/.env

APP_DIR="${APP_DIR%/}" # Remove last /
TRYDLOADER_DIR="$APP_DIR/trydloader"
TRYDLOADER_DIR="${TRYDLOADER_DIR%/}" # Remove last /
SNAPSHOT_START="$VM_NAME-start"
VM_PATH_FILESYSTEM_XML="~/vms/$VM_NAME/fs.xml"


# Check if VM exists
if ! virsh list --all | grep -q "$VM_NAME" ; then
    echo "{ status: \"error\", message: \"[VMSTART] ERROR - Missing VM $VM_NAME\" }"
    exit 1
fi

# Check if VM is running
if virsh list --state-running | grep -q "$VM_NAME" ; then
    echo "{ status: \"error\", message: \"[VMSTART] ERROR - VM $VM_NAME is already running\" }"
    exit 1
fi

# Check if start SNAPSHOT exists in VM
if ! virsh snapshot-list "$VM_NAME" | grep -q "$SNAPSHOT_START" ; then
    echo "{ status: \"error\", message: \"[VMSTART] ERROR - Missing snapshot $SNAPSHOT_START in VM $VM_NAME\" }"
    exit 1
fi

# Check if FILESYSTEM fs.xml exists
if ! [ -f "$VM_PATH_FILESYSTEM_XML" ]; then
    echo "{ status: \"error\", message: \"[VMSTART] ERROR - Filesystem fs.xml does not exist: $VM_PATH_FILESYSTEM_XML\" }"
    exit 1
fi

# Restore startup snapshot
virsh snapshot-revert "$VM_NAME" "$SNAPSHOT_START" >&- 2>&-
if [[ $? -gt 0 ]] ; then
    echo "{ status: \"error\", message: \"[VMSTART] ERROR - Unable to restore snapshot $SNAPSHOT_START in VM $VM_NAME\" }"
    exit 1
fi

# Attach 
virsh attach-device "$VM_NAME" "$VM_PATH_FILESYSTEM_XML" --live >&- 2>&-
if [[ $? -gt 0 ]] ; then
    virsh destroy "$VM_NAME" >&- 2>&- # stop vm
    echo "{ status: \"error\", message: \"[VMSTART] ERROR - Unable to attach file system to VM $VM_NAME\" }"
    exit 1
fi

# Wait for OS to stabilize from snapshot recovery
sleep 10

# ---------------- STOP -----------------
echo "{ status: \"success\", message: \"[VMSTART] VM Start script was executed successfuly in VM $VM_NAME\" }"
exit 0;

# Start service in background
APP_PID=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" '{"execute": "guest-exec", "arguments": { "path": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "arg": [ "-ExecutionPolicy", "ByPass", "-Command", "cd Z:\\ ; npx cross-env NODE_ENV=PROD DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_NAME=$DB_NAME DB_USER=$DB_USER DB_PASS=$DB_PASS node ./deploy/app.js" ], "capture-output": true }}' | sed -e 's/{[ ]*"return"[ ]*:[ ]*{[ ]*"pid"[ ]*:[ ]*\([0-9]\+\)[ ]*}[ ]*}/\1/g')
if [[ $? -gt 0 ]] ; then
    echo "{ status: \"error\", message: \"[VMSTART] ERROR - Failed to start service in VM $VM_NAME\" }"
    exit 1
fi

APP_EXITCODE=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" '{"execute": "guest-exec-status", "arguments": { "pid": $APP_PID }}' | seed -e 's/{[ ]*"return"[ ]*:[ ]*{[ ]*"exitcode"[ ]*:[ ]*\([0-9]\+\)[ ]*,[ ]*"err-data"[ ]*:[ ]*".*",[ ]*"out-data"[ ]*:[ ]*".*"[ ]*,[ ]*"exited"[ ]*:[ ]*\(true\|false\)}[ ]*}/\1,\2/g')
if [[ $? -gt 0 ]] ; then
    echo "{ status: \"error\", message: \"[VMSTART] ERROR - Failed to run service in VM $VM_NAME \" }"
    exit 1
fi
echo "APP_EXITCODE=$APP_EXITCODE"
sleep 10 # wait for service to start

if [ $APP_EXITCODE == "1,true" ] ; then
    echo "{ status: \"error\", message: \"[VMSTART] ERROR - Failed to execute service script in VM $VM_NAME \" }"
    exit 1
fi

echo "{ status: \"success\", message: \"[VMSTART] VM Start script was executed successfuly in VM $VM_NAME\" }"
exit 0;