#!/bin/bash
set -e # Exit script immediately if a command exits with a non-zero status

# Build arguments
if [[ "$1" == "ALL" || "$1" == "APP" || $2 == "APP"]]; then BUILD_APP=1; else BUILD_APP=0; fi
if [[ "$1" == "ALL" || "$1" == "SCRIPTS" || $2 == "SCRIPTS" ]]; then BUILD_SCRIPTS=1; else BUILD_SCRIPTS=0; fi

if [[ $BUILD_APP -eq 0 && $BUILD_SCRIPTS -eq 0 ]]; then
    BUILD_APP=1;
fi

# Build parameters
#HOST="66.94.96.81"
#HOST_PORT=2222
HOST="154.12.237.3" 
HOST_PORT=22
APP_DIR="~/app/myoraculum"
APP_DIR="${APP_DIR%/}" # Remove last /
TRYDLOADER_DIR="${APP_DIR%/}/trydloader"
VMSCRIPTS_DIR="${APP_DIR%/}/vmscripts"
PATH_TO_PIPE="${APP_DIR%/}/pipe.host"
LOCAL_PATH_TO_DEPLOY="${PWD%/}/deploy"

# Check if deploy directory exists in local folder
if ! test -d "./deploy" && [[ $BUILD_APP -eq 1 ]] ; then
    echo "[VM_HOST_DEPLOY] ERROR - Missing local deploy/ directory: $LOCAL_PATH_TO_DEPLOY"
    exit 1
fi

read -p "[VM_HOST_DEPLOY] Check build in DEPLOY folder is correct and hit <ENTER>"

echo "[-------------- TRYDLOADER BUILD PROCESS STARTED ----------------]"

# Copy project files to host
if [[ $BUILD_APP -eq 1 ]] ; then
    echo "[VM_HOST_DEPLOY] Copying TrydLoader project files to host dir: ${TRYDLOADER_DIR%/}"
    rsync  --update --recursive --delete-excluded --force --mkpath -e "ssh -p $HOST_PORT" ./deploy ./node_modules ./ssl ./prod.env ./package.json ebezerra@$HOST:${TRYDLOADER_DIR%/}
fi

# Copy VM scritps to host
if [[ $BUILD_SCRIPTS -eq 1 ]] ; then
    echo "[VM_HOST_DEPLOY] Copying VM scripts files to host dir: ${VMSCRIPTS_DIR%/}"
    rsync --update --recursive --delete-excluded --mkpath -e "ssh -p $HOST_PORT" ./vmscripts/ ebezerra@$HOST:${VMSCRIPTS_DIR%/}
fi

ssh ebezerra@$HOST -p $HOST_PORT APP_DIR=$APP_DIR VMSCRIPTS_DIR=$VMSCRIPTS_DIR TRYDLOADER_DIR=$TRYDLOADER_DIR PATH_TO_PIPE=$PATH_TO_PIPE BUILD_SCRIPTS=$BUILD_SCRIPTS BUILD_APP=$BUILD_APP 'bash -s' << \ENDSSH
set -e # Exit script immediately if a command exits with a non-zero status

if [[ $BUILD_APP -eq 1 ]] ; then
    # Check if TRYDLOADER_DIR exists
    if ! test -d "$TRYDLOADER_DIR" ; then
        echo "[ERROR] Missing TRYDLOADER_DIR directory: $TRYDLOADER_DIR"
        exit 1
    fi

    # Create log directory in Tryd project root dir
    LOG_DIR=$(cat ${TRYDLOADER_DIR%/}/prod.env | grep LOG_FILES_DIRECTORY | tail -1 | sed 's/^LOG_FILES_DIRECTORY=\(.*\)/\1/')
    if ! test -d "${TRYDLOADER_DIR%/}/$LOG_DIR" ; then
        mkdir "${TRYDLOADER_DIR%/}/$LOG_DIR"
        chmod +w "${TRYDLOADER_DIR%/}/$LOG_DIR"
    fi
    echo "[VM_HOST_DEPLOY] TrydLoader project files were sucessfully deployed"
fi

if [[ $BUILD_SCRIPTS -eq 1 ]] ; then
    # Create pipe.host file if it doesn't exist
    if ! test -p "$PATH_TO_PIPE" ; then
        mkfifo "$PATH_TO_PIPE"
        chmod +w "$APP_DIR" # Allow writting permition to application directory
    else
        # STOPS PIPE LISTENER
        touch "${APP_DIR%/}/pipe.terminate"
        sleep 10
        rm -rf "${APP_DIR%/}/pipe.terminate"
    fi

    # Stop any existing pipelistener running process
    # pkill -f pipelistener.sh # ISSUE: FINISHES THIS BASH SCRIPT

    # Allow execution permition to scripts directory
    chmod +x "$VMSCRIPTS_DIR"

    # Start pipe listener in backgroud
    # eval "${VMSCRIPTS_DIR%/}/pipelistener.sh" &

    echo "[VM_HOST_DEPLOY] Scripts updated and pipe process restarted sucessfully"
    echo -e "\nREMINDER: pipelistener.sh MUST be added to crontab: @reboot ${VMSCRIPTS_DIR%/}/pipelistener.sh\n"
    # NOT WORKING: (crontab -l 2>/dev/null | sed '/pipelistener/d' | sed '${s/$/\n@reboot \/app\/myoraculum\/vmscripts\/pipelistener\.sh/}') | crontab -
fi
ENDSSH

echo "[-------------- TRYDLOADER BUILD PROCESS FINISHED ----------------]"
