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
    echo "{ \"status\": \"error\", \"message\": \"[VMSTOP] ERROR - Missing argument VM_NAME\" }"
    exit 1
fi

# Check if VM exists
if ! virsh -c qemu:///system list --all | grep -q "$VM_NAME" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMSTOP] ERROR - Missing VM $VM_NAME\" }"
    exit 1
fi

# Check if VM is running
if ! virsh -c qemu:///system list --state-running | grep -q "$VM_NAME" ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMSTOP] ERROR - VM $VM_NAME is not running\" }"
    exit 1
fi

# Stop VM
virsh -c qemu:///system destroy "$VM_NAME" >&- 2>&-
if [[ $? -gt 0 ]] ; then
    echo "{ \"status\": \"error\", \"message\": \"[VMSTOP] ERROR - Unable to stop VM $VM_NAME\" }"
    exit 1
fi

echo "{ \"status\": \"success\", \"message\": \"[VMSTOP] VM stop script was executed successfuly in VM $VM_NAME\" }"
exit 0;