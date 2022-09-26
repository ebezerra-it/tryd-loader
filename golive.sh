#!/bin/bash
set -e # Exit script immediately if a command exits with a non-zero status

PATH_TO_ENV=../botloader/prod.env
VM_APP_DIR=$(grep VM_APP_DIR $PATH_TO_ENV | cut -d "=" -f2)
VM_SCRIPTS_HOST_DIR=$(grep VM_SCRIPTS_HOST_DIR $PATH_TO_ENV | cut -d "=" -f2)
VM_TRYDLOADER_HOST_DIR=$(grep VM_TRYDLOADER_HOST_DIR $PATH_TO_ENV | cut -d "=" -f2)
VM_PIPE2HOST_HOST_DIR=$(grep VM_PIPE2HOST_HOST_DIR $PATH_TO_ENV | cut -d "=" -f2)
VM_PIPE2HOST_FILENAME=$(grep VM_PIPE2HOST_FILENAME $PATH_TO_ENV | cut -d "=" -f2)
VM_PIPE2HOST_COMMAND_RETURN_FILENAME=$(grep VM_PIPE2HOST_COMMAND_RETURN_FILENAME $PATH_TO_ENV | cut -d "=" -f2)

if test -z "$VM_APP_DIR" ; then
    echo "{ status: \"error\", message: \"[VM_HOST_DEPLOY] ERROR - Missing parameter in botloader/prod.ev: VM_APP_DIR\" }"
    exit 1
fi
if test -z "$VM_SCRIPTS_HOST_DIR" ; then
    echo "{ status: \"error\", message: \"[VM_HOST_DEPLOY] ERROR - Missing parameter in botloader/prod.ev: VM_SCRIPTS_HOST_DIR\" }"
    exit 1
fi
if test -z "$VM_TRYDLOADER_HOST_DIR" ; then
    echo "{ status: \"error\", message: \"[VM_HOST_DEPLOY] ERROR - Missing parameter in botloader/prod.ev: VM_TRYDLOADER_HOST_DIR\" }"
    exit 1
fi
if test -z "$VM_PIPE2HOST_HOST_DIR" ; then
    echo "{ status: \"error\", message: \"[VM_HOST_DEPLOY] ERROR - Missing parameter in botloader/prod.ev: VM_PIPE2HOST_HOST_DIR\" }"
    exit 1
fi
if test -z "$VM_PIPE2HOST_FILENAME" ; then
    echo "{ status: \"error\", message: \"[VM_HOST_DEPLOY] ERROR - Missing parameter in botloader/prod.ev: VM_PIPE2HOST_FILENAME\" }"
    exit 1
fi
if test -z "$VM_PIPE2HOST_COMMAND_RETURN_FILENAME" ; then
    echo "{ status: \"error\", message: \"[VM_HOST_DEPLOY] ERROR - Missing parameter in botloader/prod.ev: VM_PIPE2HOST_COMMAND_RETURN_FILENAME\" }"
    exit 1
fi

# Build arguments
if [[ "$1" == "ALL" || "$1" == "APP" || $2 == "APP" ]] ; then BUILD_APP=1; else BUILD_APP=0; fi
if [[ "$1" == "ALL" || "$1" == "SCRIPTS" || $2 == "SCRIPTS" ]] ; then BUILD_SCRIPTS=1; else BUILD_SCRIPTS=0; fi

if [[ $BUILD_APP -eq 0 && $BUILD_SCRIPTS -eq 0 ]] ; then
    BUILD_APP=1;
fi

# Build parameters
#HOST="66.94.96.81"
#HOST_PORT=2222
HOST="154.12.237.3" 
HOST_PORT=22
LOCAL_PATH_TO_DEPLOY="${PWD%/}/deploy"
PIPE_LISTENER_SCRIPT="pipelistener.sh"

# Check if deploy directory exists in local folder
if ! test -d "./deploy" && [[ $BUILD_APP -eq 1 ]] ; then
    echo "[VM_HOST_DEPLOY] ERROR - Missing local deploy/ directory: $LOCAL_PATH_TO_DEPLOY"
    exit 1
fi

read -p "[VM_HOST_DEPLOY] Check build in DEPLOY folder is correct and hit <ENTER>"

echo "[-------------- TRYDLOADER BUILD PROCESS STARTED ----------------]"

# Copy project files to host
if [[ $BUILD_APP -eq 1 ]] ; then
    echo "[VM_HOST_DEPLOY] Copying TrydLoader project files to host dir: ${VM_TRYDLOADER_HOST_DIR%/}"
    rsync --update --recursive --delete-excluded --force --mkpath -e "ssh -p $HOST_PORT" ./deploy ./node_modules ./ssl ./prod.env ./package.json ./package-lock.json ebezerra@$HOST:${VM_TRYDLOADER_HOST_DIR%/}
fi

# Copy VM scritps to host
if [[ $BUILD_SCRIPTS -eq 1 ]] ; then
    echo "[VM_HOST_DEPLOY] Copying VM scripts files to host dir: ${VM_SCRIPTS_HOST_DIR%/}"
    rsync --update --recursive --delete-excluded --force --mkpath -e "ssh -p $HOST_PORT" ./vmscripts/ ebezerra@$HOST:${VM_SCRIPTS_HOST_DIR%/}
fi

ssh ebezerra@$HOST -p $HOST_PORT BUILD_SCRIPTS=$BUILD_SCRIPTS BUILD_APP=$BUILD_APP VM_APP_DIR=$VM_APP_DIR VM_SCRIPTS_HOST_DIR=$VM_SCRIPTS_HOST_DIR VM_TRYDLOADER_HOST_DIR=$VM_TRYDLOADER_HOST_DIR VM_PIPE2HOST_HOST_DIR=$VM_PIPE2HOST_HOST_DIR VM_PIPE2HOST_FILENAME=$VM_PIPE2HOST_FILENAME VM_PIPE2HOST_COMMAND_RETURN_FILENAME=$VM_PIPE2HOST_COMMAND_RETURN_FILENAME PIPE_LISTENER_SCRIPT=$PIPE_LISTENER_SCRIPT 'bash -s' <<'ENDSSH'
set -e # Exit script immediately if a command exits with a non-zero status

if [[ $BUILD_APP -eq 1 ]] ; then
    # Check if VM_TRYDLOADER_HOST_DIR exists
    if ! test -d "$VM_TRYDLOADER_HOST_DIR" ; then
        echo "[VM_HOST_DEPLOY] ERROR - Missing VM_TRYDLOADER_HOST_DIR directory: $VM_TRYDLOADER_HOST_DIR"
        exit 1
    fi
    # Resolve WinFS filename case issue
    if ! test -f "${VM_TRYDLOADER_HOST_DIR%/}/node_modules/edge-js/lib/native/win32/x64/14.3.0/VCRUNTIME140.dll" ; then
        mv "${VM_TRYDLOADER_HOST_DIR%/}/node_modules/edge-js/lib/native/win32/x64/14.3.0/vcruntime140.dll" "${VM_TRYDLOADER_HOST_DIR%/}/node_modules/edge-js/lib/native/win32/x64/14.3.0/VCRUNTIME140.dll"
    fi

    # Create log directory in Tryd project root dir
    LOG_DIR=$(cat ${VM_TRYDLOADER_HOST_DIR%/}/prod.env | grep LOG_FILES_DIRECTORY | tail -1 | sed 's/^LOG_FILES_DIRECTORY=\(.*\)/\1/')
    if ! test -d "${VM_TRYDLOADER_HOST_DIR%/}/$LOG_DIR" ; then
        mkdir "${VM_TRYDLOADER_HOST_DIR%/}/$LOG_DIR"
        chmod 777 "${VM_TRYDLOADER_HOST_DIR%/}/$LOG_DIR"
    fi
    echo "[VM_HOST_DEPLOY] TrydLoader project files were sucessfully deployed"
fi

if [[ $BUILD_SCRIPTS -eq 1 ]] ; then
    # Check if VM_SCRIPTS_HOST_DIR exists
    if ! test -d "$VM_SCRIPTS_HOST_DIR" ; then
        echo "[VM_HOST_DEPLOY] ERROR - Missing VM_SCRIPTS_HOST_DIR directory: $VM_SCRIPTS_HOST_DIR"
        exit 1
    fi

    # Create VM_PIPE2HOST_HOST_DIR directory if it doesn't exist
    if ! test -d "$VM_PIPE2HOST_HOST_DIR" ; then
        mkdir "$VM_PIPE2HOST_HOST_DIR"
    fi

    # Create pipe.host file if it doesn't exist
    if ! test -p "${VM_PIPE2HOST_HOST_DIR%/}/$VM_PIPE2HOST_FILENAME" ; then
        mkfifo "${VM_PIPE2HOST_HOST_DIR%/}/$VM_PIPE2HOST_FILENAME"
        chmod +w "$VM_PIPE2HOST_HOST_DIR" # Allow writting permition to application directory
    fi

    # Stop any existing pipelistener running process
    ps -aux | grep $PIPE_LISTENER_SCRIPT | grep -v grep | awk '{ print $2 }' | xargs kill -9 2>/dev/null || true
    ps -aux | grep $VM_PIPE2HOST_FILENAME | grep -v grep | awk '{ print $2 }' | xargs kill -9 2>/dev/null || true
    echo "[VM_HOST_DEPLOY] Pipe listener script successfully stoped"

    # Allow execution permition to scripts directory
    chmod +x "$VM_SCRIPTS_HOST_DIR"

    # Start pipe listener in backgroud
    #pipelistener.sh VM_SCRIPTS_HOST_DIR=~/app/myoraculum/vmscripts VM_PIPE2HOST_HOST_DIR=~/app/myoraculum/pipe2host VM_PIPE2HOST_FILENAME=pipe.host VM_PIPE2HOST_COMMAND_RETURN_FILENAME=pipe.out
    CMD_LISTENER="${VM_SCRIPTS_HOST_DIR%/}/$PIPE_LISTENER_SCRIPT VM_SCRIPTS_HOST_DIR=$VM_SCRIPTS_HOST_DIR VM_PIPE2HOST_HOST_DIR=$VM_PIPE2HOST_HOST_DIR VM_PIPE2HOST_FILENAME=$VM_PIPE2HOST_FILENAME VM_PIPE2HOST_COMMAND_RETURN_FILENAME=$VM_PIPE2HOST_COMMAND_RETURN_FILENAME"
    nohup $CMD_LISTENER >/dev/null 2>&1 &
    sleep 5
    if [[ $? -gt 0 ]] ; then
        echo "{ status: \"error\", message: \"[VM_HOST_DEPLOY] ERROR - Unable to start $PIPE_LISTENER_SCRIPT due to error: $@\" }"
        exit 1
    fi
    echo "[VM_HOST_DEPLOY] Scripts updated and pipe process restarted successfully with PID: $!"

    ( crontab -l | grep -v -F "$CMD_LISTENER" || : ; echo "@reboot $CMD_LISTENER" ) | crontab -
    echo "[VM_HOST_DEPLOY] CRON @reboot updated successfully"
fi
exit 0
ENDSSH

echo "[-------------- TRYDLOADER BUILD PROCESS FINISHED ----------------]"
