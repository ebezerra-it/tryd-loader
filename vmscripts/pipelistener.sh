#!/bin/bash
set -e # Exit script immediately if a command exits with a non-zero status

# Commands:
# - VMSTATUS
# - VMSTART
# - VMSTOP
# - VMRESTART
# - VMSCREENSHOT

APP_PATH="~/app/myoraculum"
PATH_TO_SCRIPTS="${APP_PATH%/}/vmscripts"
PATH_TO_PIPE="${APP_PATH%/}/pipe.host"
PATH_TO_PIPEOUT="${APP_PATH%/}/pipe.out"

# Check for pipe.host file existance 
if ! test -p $PATH_TO_PIPE ; then
    echo "[PIPE_LISTENER] ERROR - Missing pipe file: $PATH_TO_PIPE"
    exit 1
fi

# Check for vm scripts directory
if ! test -d $PATH_TO_SCRIPTS ; then
    echo "[PIPE_LISTENER] ERROR - Missing vm scripts diretory: $PATH_TO_SCRIPTS"
    exit 1
fi

# Check for vm scripts files
if ! test -f "${PATH_TO_SCRIPTS%/}/vmstatus.sh"; then echo "[PIPE_LISTENER] ERROR - Missing SCRIPT: vmstatus.sh" ; exit 1; fi
if ! test -f "${PATH_TO_SCRIPTS%/}/vmstart.sh"; then echo "[PIPE_LISTENER] ERROR - Missing SCRIPT: vmstart.sh" ; exit 1; fi
if ! test -f "${PATH_TO_SCRIPTS%/}/vmstop.sh"; then echo "[PIPE_LISTENER] ERROR - Missing SCRIPT: vmstop.sh" ; exit 1; fi
if ! test -f "${PATH_TO_SCRIPTS%/}/vmrestart.sh"; then echo "[PIPE_LISTENER] ERROR - Missing SCRIPT: vmrestart.sh" ; exit 1; fi
if ! test -f "${PATH_TO_SCRIPTS%/}/vmscreenshot.sh"; then echo "[PIPE_LISTENER] ERROR - Missing SCRIPT: vmscreenshot.sh" ; exit 1; fi
if ! test -f "${PATH_TO_SCRIPTS%/}/vmwrongcmd.sh"; then echo "[PIPE_LISTENER] ERROR - Missing SCRIPT: vmwrongcmd.sh" ; exit 1; fi

# Remove previous non deleted pipe.out file
rm -rf $PATH_TO_PIPEOUT

while true; do 
    # terminate procedure
    if test -f "${APP_PATH%/}/pipe.terminate"; then rm -rf "${APP_PATH%/}/pipe.terminate"; break; fi

    # wait for invoker to read pipe.out file
    if test -f $PATH_TO_PIPEOUT; then sleep 5; continue; fi

    PIPECMD=$(cat $PATH_TO_PIPE) # .trim().uppercase()
    re="(VMSTATUS|VMSTART|VMSTOP|VMRESTART|VMSCREENSHOT|TERMINATE)(\s.*)?"
    if ! [[ $PIPECMD =~ $re ]]; then
        CMD="WRONGCMD";
    else
        CMD=${BASH_REMATCH[1]}  | xargs | tr a-z A-Z ;
        ARGS=${BASH_REMATCH[2]} | xargs;
    fi

    echo "$CMD"
    case $CMD in
        VMSTATUS) SCRIPT="vmstatus.sh $ARGS";;
        VMSTART) SCRIPT="vmstart.sh $ARGS";;
        VMSTOP) SCRIPT="vmstop.sh $ARGS";;
        VMRESTART) SCRIPT="vmrestart.sh $ARGS";;
        VMSCREENSHOT) SCRIPT="vmscreenshot.sh $ARGS";;
        TERMINATE) break;;
        *) SCRIPT="vmwrongcmd.sh";;
    esac

    eval "$(${PATH_TO_SCRIPTS%/}/$SCRIPT)" > $PATH_TO_PIPEOUT 2>&-;
    sleep 5;
done
