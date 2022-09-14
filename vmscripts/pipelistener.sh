#!/bin/bash
set -e # Exit script immediately if a command exits with a non-zero status

# Commands:
# - VMSTATUS
# - VMSTART
# - VMSTOP
# - VMRESTART
# - VMSCREENSHOT

# Parse arguments
for ARGUMENT in "$@"
do
   KEY=$(echo $ARGUMENT | cut -f1 -d=)

   KEY_LENGTH=${#KEY}
   VALUE="${ARGUMENT:$KEY_LENGTH+1}"

   export "$KEY"="$VALUE"
done

if test -z "$VM_SCRIPTS_HOST_DIR" ; then
    echo "{ status: \"error\", message: \"[PIPE_LISTENER] ERROR - Missing argument VM_SCRIPTS_HOST_DIR\" }"
    exit 1
fi
if test -z "$VM_PIPE2HOST_HOST_DIR" ; then
    echo "{ status: \"error\", message: \"[PIPE_LISTENER] ERROR - Missing argument VM_PIPE2HOST_HOST_DIR\" }"
    exit 1
fi
if test -z "$VM_PIPE2HOST_FILENAME" ; then
    echo "{ status: \"error\", message: \"[PIPE_LISTENER] ERROR - Missing argument VM_PIPE2HOST_FILENAME\" }"
    exit 1
fi
if test -z "$VM_PIPE2HOST_COMMAND_RETURN_FILENAME" ; then
    echo "{ status: \"error\", message: \"[PIPE_LISTENER] ERROR - Missing argument VM_PIPE2HOST_COMMAND_RETURN_FILENAME\" }"
    exit 1
fi

PATH_TO_PIPE="${VM_PIPE2HOST_HOST_DIR%/}/$VM_PIPE2HOST_FILENAME"
PATH_TO_PIPE_OUT="${VM_PIPE2HOST_HOST_DIR%/}/$VM_PIPE2HOST_COMMAND_RETURN_FILENAME"

# Check for pipe.host file existance 
if ! test -p $PATH_TO_PIPE ; then
    echo "[PIPE_LISTENER] ERROR - Missing pipe file: $PATH_TO_PIPE"
    exit 1
fi

# Check for vm scripts directory
if ! test -d $VM_SCRIPTS_HOST_DIR ; then
    echo "[PIPE_LISTENER] ERROR - Missing vm scripts diretory: $VM_SCRIPTS_HOST_DIR"
    exit 1
fi

# Check for vm scripts files
if ! test -f "${VM_SCRIPTS_HOST_DIR%/}/vmstatus.sh"; then echo "[PIPE_LISTENER] ERROR - Missing SCRIPT: vmstatus.sh" ; exit 1; fi
if ! test -f "${VM_SCRIPTS_HOST_DIR%/}/vmstart.sh"; then echo "[PIPE_LISTENER] ERROR - Missing SCRIPT: vmstart.sh" ; exit 1; fi
if ! test -f "${VM_SCRIPTS_HOST_DIR%/}/vmstop.sh"; then echo "[PIPE_LISTENER] ERROR - Missing SCRIPT: vmstop.sh" ; exit 1; fi
if ! test -f "${VM_SCRIPTS_HOST_DIR%/}/vmrestart.sh"; then echo "[PIPE_LISTENER] ERROR - Missing SCRIPT: vmrestart.sh" ; exit 1; fi
if ! test -f "${VM_SCRIPTS_HOST_DIR%/}/vmscreenshot.sh"; then echo "[PIPE_LISTENER] ERROR - Missing SCRIPT: vmscreenshot.sh" ; exit 1; fi
if ! test -f "${VM_SCRIPTS_HOST_DIR%/}/vmwrongcmd.sh"; then echo "[PIPE_LISTENER] ERROR - Missing SCRIPT: vmwrongcmd.sh" ; exit 1; fi

# Remove previous non deleted pipe.out file
rm -rf $PATH_TO_PIPE_OUT

while true; do 
    # wait for invoker to read pipe.out file
    if test -f $PATH_TO_PIPE_OUT; then sleep 5; continue; fi

    PIPECMD=$(cat $PATH_TO_PIPE) # .trim().uppercase()
    re="(VMSTATUS|VMSTART|VMSTOP|VMRESTART|VMSCREENSHOT|TERMINATE)(\s.*)?"
    if ! [[ $PIPECMD =~ $re ]]; then
        CMD="WRONGCMD";
    else
        CMD=${BASH_REMATCH[1]}  | xargs | tr a-z A-Z ;
        ARGS=${BASH_REMATCH[2]} | xargs;
    fi

    case $CMD in
        VMSTATUS) SCRIPT="vmstatus.sh $ARGS";;
        VMSTART) SCRIPT="vmstart.sh $ARGS";;
        VMSTOP) SCRIPT="vmstop.sh $ARGS";;
        VMRESTART) SCRIPT="vmrestart.sh $ARGS";;
        VMSCREENSHOT) SCRIPT="vmscreenshot.sh $ARGS";;
        TERMINATE) break;;
        *) SCRIPT="vmwrongcmd.sh";;
    esac

    eval "$(${VM_SCRIPTS_HOST_DIR%/}/$SCRIPT)" > $PATH_TO_PIPE_OUT 2>&-;
    sleep 5;
done
