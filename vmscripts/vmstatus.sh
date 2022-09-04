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

#VM parameters
#VM_NAME="w10tryd"

# Check if VM exists
if ! virsh list --all | grep -q "$VM_NAME" ; then
    echo "{ status: \"error\", message: \"[VMSTART] ERROR - Missing VM $VM_NAME\" }"
    exit 1
fi

# 's/.*State:\s*\([a-z]*\).*CPU time:\s*\([0-9]\+\.[0-9]\).*/{ state: "\1", upseconds: \2 }/'
# Check if VM is running
if virsh list --state-running | grep -q "$VM_NAME" ; then
    UP_SECONDS=$(virsh dominfo "$VM_NAME" | grep "CPU time:" | sed -e 's/CPU time:\s*\([0-9]\+\.[0-9]\)/\1/')
    echo "{ status: \"success\", message: \"[VMSTATUS] VM status script was executed successfuly in VM $VM_NAME\", status: { state: \"running\", upseconds: ${UP_SECONDS} } }"
    exit 0
fi

STATUS=$(virsh domstate "$VM_NAME")
echo "{ status: \"success\", message: \"[VMSTATUS] VM status script was executed successfuly in VM $VM_NAME\", ${STATUS%$'\r'} }"
exit 0;