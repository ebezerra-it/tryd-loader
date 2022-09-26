#!/bin/bash
set -e # Exit script immediately if a command exits with a non-zero status

# Parse arguments
for ARGUMENT in "$@"
do
   KEY=$(echo $ARGUMENT | cut -f1 -d=)

   KEY_LENGTH=${#KEY}
   VALUE="${ARGUMENT:$KEY_LENGTH+1}"

   if [[ $VALUE == *"\$"* ]] ; then
      VALUE=$(echo "$VALUE" | sed "s/\\$/\\\\\\\\$/g")
      export "$KEY"="'$VALUE'"
   else
      export "$KEY"="$VALUE"
   fi
done

# Validate required arguments
if test -z "$VM_NAME" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing argument VM_NAME\" }"
    exit 1
fi
if test -z "$VM_HOST_NAME" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing argument VM_HOST_NAME\" }"
    exit 1
fi
if test -z "$VM_HOST_IP" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing argument VM_HOST_IP\" }"
    exit 1
fi
if test -z "$VM_USER" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing argument VM_USER\" }"
    exit 1
fi
if test -z "$VM_PASS" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing argument VM_PASS\" }"
    exit 1
fi
if test -z "$VM_SNAPSHOT_START" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing argument VM_SNAPSHOT_START\" }"
    exit 1
fi
if test -z "$VM_FILESYSTEM_XML_PATH" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing argument VM_FILESYSTEM_XML_PATH\" }"
    exit 1
fi
if test -z "$DB_PORT" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing argument DB_PORT\" }"
    exit 1
fi
if test -z "$DB_NAME" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing argument DB_NAME\" }"
    exit 1
fi
if test -z "$DB_USER" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing argument DB_USER\" }"
    exit 1
fi
if test -z "$DB_PASS" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing argument DB_PASS\" }"
    exit 1
fi
if test -z "$TELEGRAM_API_PORT" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing argument TELEGRAM_API_PORT\" }"
    exit 1
fi

# Check if VM exists
if ! virsh -c qemu:///system list --all | grep -q "$VM_NAME" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing VM $VM_NAME\" }"
    exit 1
fi

# Check if VM is running
if ! virsh -c qemu:///system list --state-running | grep -q "$VM_NAME" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - VM $VM_NAME is not running\" }"
    exit 1
fi

# Check if start SNAPSHOT exists in VM
if ! virsh -c qemu:///system snapshot-list "$VM_NAME" | grep -q "$VM_SNAPSHOT_START" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Missing snapshot $VM_SNAPSHOT_START in VM $VM_NAME\" }"
    exit 1
fi

# Check if FILESYSTEM fs.xml exists
if ! test -f "$VM_FILESYSTEM_XML_PATH" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Filesystem fs.xml does not exist: $VM_FILESYSTEM_XML_PATH\" }"
    exit 1
fi

# Restore startup snapshot
virsh -c qemu:///system snapshot-revert "$VM_NAME" "$VM_SNAPSHOT_START" >&- 2>&-
if [[ $? -gt 0 ]] ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Unable to restore snapshot $VM_SNAPSHOT_START in VM $VM_NAME\" }"
    exit 1
fi

# Attach filesystem
virsh -c qemu:///system attach-device "$VM_NAME" "$VM_FILESYSTEM_XML_PATH" --live >&- 2>&-
if [[ $? -gt 0 ]] ; then
    virsh -c qemu:///system destroy "$VM_NAME" >&- 2>&- # stop vm
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Unable to attach file system $VM_FILESYSTEM_XML_PATH to VM $VM_NAME\" }"
    exit 1
fi

# Send time sync command to VM
APP_PID=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" '{"execute": "guest-exec", "arguments": { "path": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "arg": [ "-ExecutionPolicy", "ByPass", "-Command", "Start-Process PowerShell -verb runas -ArgumentList \"-noexit\", \"-Command\", \"w32tm /resync /force\"" ], "capture-output": true }}' | sed -e 's/{[ ]*"return"[ ]*:[ ]*{[ ]*"pid"[ ]*:[ ]*\([0-9]\+\)[ ]*}[ ]*}/\1/g')
if [[ $? -gt 0 ]] ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Failed to send sync time command to VM $VM_NAME\" }"
    exit 1
fi

sleep 5 # wait for sync command to execute

CMD_RETURN_APP_EXITCODE=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" "{\"execute\": \"guest-exec-status\", \"arguments\": { \"pid\": $APP_PID }}")
if [[ $? -gt 0 ]] ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Failed to run sync time command in VM $VM_NAME\" }"
    exit 1
fi

if ! [[ $CMD_RETURN_APP_EXITCODE =~ .*\"exitcode\"\s*:\s*([0-9]+)\s*.*,\"exited\"\s*:\s*(true|false).* ]] ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Unknown sync time command return in VM $VM_NAME\", \"error\": $CMD_RETURN_APP_EXITCODE }"
    exit 1
fi

APP_EXITCODE=${BASH_REMATCH[1]}
APP_EXITED=${BASH_REMATCH[2]}

if [[ $APP_EXITCODE -ne 0 || $APP_EXITED != "true" ]] ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Wrong exitcode/exited return for start service script in VM $VM_NAME\", \"error\": $CMD_RETURN_APP_EXITCODE }"
    exit 1
fi

# Start service in background
set +H
APP_PID=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" "{\"execute\": \"guest-exec\", \"arguments\": { \"path\": \"C:\\\\Windows\\\\System32\\\\PsTools\\\\PsExec.exe\", \"arg\": [ \"-accepteula\", \"\\\\\\\\$VM_HOST_NAME\", \"-u\", \"$VM_USER\", \"-p\", \"$VM_PASS\", \"-i\", \"1\", \"powershell.exe\", \"-executionPolicy\", \"bypass\", \"-noexit\", \"-Command\", \"cd Z: ; npx cross-env NODE_ENV=PROD VM_HOST_IP=$VM_HOST_IP DB_PORT=$DB_PORT DB_NAME=$DB_NAME DB_USER=$DB_USER DB_PASS=$DB_PASS TELEGRAM_API_PORT=$TELEGRAM_API_PORT node .\\\\deploy\\\\app.js\" ], \"capture-output\": true }}" | sed -e 's/{[ ]*"return"[ ]*:[ ]*{[ ]*"pid"[ ]*:[ ]*\([0-9]\+\)[ ]*}[ ]*}/\1/g')
if [[ $? -gt 0 ]] ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Failed to send start service command to VM $VM_NAME\" }"
    exit 1
fi

sleep 5 # wait for service to start

CMD_RETURN_APP_EXITCODE=$(virsh -c qemu:///system qemu-agent-command "$VM_NAME" "{\"execute\": \"guest-exec-status\", \"arguments\": { \"pid\": $APP_PID }}")
if [[ $? -gt 0 ]] ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Failed to run service command in VM $VM_NAME\" }"
    exit 1
fi

if ! [[ $CMD_RETURN_APP_EXITCODE =~ .*\"exitcode\"\s*:\s*([0-9]+)\s*.*,\"exited\"\s*:\s*(true|false).* ]] ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Unknown service command return in VM $VM_NAME\", \"error\": $CMD_RETURN_APP_EXITCODE }"
    exit 1
fi

APP_EXITCODE=${BASH_REMATCH[1]}
APP_EXITED=${BASH_REMATCH[2]}

if [[ ! -z $APP_EXITCODE || $APP_EXITED == "true" ]] ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMRESTART] ERROR - Wrong exitcode/exited return for start service script in VM $VM_NAME\", \"error\": $CMD_RETURN_APP_EXITCODE }"
    exit 1
fi

echo "{ \"status\": \"success\", \"message\": \"[VMRESTART] VM restart script was executed successfuly in VM $VM_NAME\" }"
exit 0;
