#!/bin/sh
# Writes the checkout's commit into the built app's Info.plist as GitCommit, so
# the home screen can name the build you are looking at. Runs after Info.plist
# processing and before code signing, so the stamped plist is the signed one.
#
# A build with uncommitted changes is stamped "abc1234*" — the asterisk is how
# you tell a build off a clean commit from one off your working tree.
set -eu

plist="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"
if [ ! -f "$plist" ]; then
    echo "warning: no Info.plist at $plist to stamp with the commit"
    exit 0
fi

commit=$(git -C "${PROJECT_DIR}" rev-parse --short HEAD 2>/dev/null || true)
if [ -z "$commit" ]; then
    # Building from an export rather than a checkout: the build number stands in.
    echo "warning: not a git checkout, leaving GitCommit unset"
    exit 0
fi

if ! git -C "${PROJECT_DIR}" diff --quiet HEAD 2>/dev/null; then
    commit="${commit}*"
fi

/usr/libexec/PlistBuddy -c "Set :GitCommit ${commit}" "$plist" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Add :GitCommit string ${commit}" "$plist"
