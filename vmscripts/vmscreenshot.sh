
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
    echo "{ status: \"error\", message: \"[VMSCREENSHOT] ERROR - Missing argument VM_NAME\" }"
    exit 1
fi
if test -z "$VM_SCREENSHOTS_HOST_DIR" ; then
    echo "{ status: \"error\", message: \"[VMSCREENSHOT] ERROR - Missing argument VM_SCREENSHOTS_HOST_DIR\" }"
    exit 1
fi
VM_SCREENSHOTS_HOST_DIR=${VM_SCREENSHOTS_HOST_DIR%/} # removes last /

# Check if VM exists
if ! virsh list --all | grep -q "$VM_NAME" ; then
    echo "{ status: \"error\", message: \"[VMSCREENSHOT] ERROR - Missing VM $VM_NAME\" }"
    exit 1
fi

# Check if VM is running
if ! virsh list --state-running | grep -q "$VM_NAME" ; then
    echo "{ status: \"error\", message: \"[VMSCREENSHOT] ERROR - VM $VM_NAME is not running\" }"
    exit 1
fi

# Check if screenshot folder exists
if ! [ -d "${VM_SCREENSHOTS_HOST_DIR%/}" ]; then
    echo "{ status: \"error\", message: \"[VMSCREENSHOT] ERROR - Screenshot folder does not exist: ${VM_SCREENSHOTS_HOST_DIR%/}\" }"
    exit 1
fi

# Check if screenshot folder has write permission
if ! [ -w "${VM_SCREENSHOTS_HOST_DIR%/}" ]; then
    echo "{ status: \"error\", message: \"[VMSCREENSHOT] ERROR - Screenshot folder does not has write permission: ${VM_SCREENSHOTS_HOST_DIR%/}\" }"
    exit 1
fi

IMG_FILENAME="ss_$VM_NAME_$(date "+%Y%m%d%H%M%S").ppm"

virsh screenshot "$VM_NAME" --file ${VM_SCREENSHOTS_HOST_DIR%/}/$IMG_FILENAME >&- 2>&-
if [[ $? -gt 0 ]] ; then
    echo "{ status: \"error\", message: \"[VMSCREENSHOT] ERROR - Unable to take screenshot from VM $VM_NAME\" }"
    exit 1
fi

echo "{ status: \"success\", message: \"[VMSCREENSHOT] VM screenshot was taken successfuly for VM $VM_NAME\", filename: \"$IMG_FILENAME\" }"
exit 0
