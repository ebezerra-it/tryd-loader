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

# Validate arguments
if test -z "$VM_NAME" ; then
    echo "{ status: \"error\", message: \"[VMSTATUS] ERROR - Missing argument VM_NAME\" }"
    exit 1
fi

# Check if VM exists
if ! virsh list --all | grep -q "$VM_NAME" ; then
    echo "{ status: \"error\", message: \"[VMSTATUS] ERROR - Missing VM $VM_NAME\" }"
    exit 1
fi

CMD_INFO_RETURN=$(virsh dominfo "$VM_NAME")
if ! [[ $CMD_INFO_RETURN =~ .*State:[[:blank:]]*(running|idle|paused|in shutdown|shut off|crashed|pmsuspended).* ]] ; then
    echo "{ status: \"error\", message: \"[VMSTATUS] ERROR - Wrong status command return for VM $VM_NAME\", error: \"$CMD_INFO_RETURN\" }"
    exit 1
fi

VM_STATE=${BASH_REMATCH[1]}

if [ $VM_STATE == "running" ] ; then
    if ! [[ $CMD_INFO_RETURN =~ .*CPU[[:blank:]]time:[[:blank:]]*([0-9]+\.[0-9]+)s.* ]] ; then
        echo "{ status: \"error\", message: \"[VMSTATUS] ERROR - Wrong running state status command return for VM $VM_NAME\", error: \"$CMD_INFO_RETURN\" }"
        exit 1
    fi

    VM_UPSECONDS=${BASH_REMATCH[1]}
    echo "{ status: \"success\", message: \"[VMSTATUS] VM status script was executed successfuly in VM $VM_NAME\", status: { state: \"$VM_STATE\", upseconds: $VM_UPSECONDS } }"
    exit 0
else
    echo "{ status: \"success\", message: \"[VMSTATUS] VM status script was executed successfuly in VM $VM_NAME\", status: { state: \"$VM_STATE\" } }"
    exit 0
fi
