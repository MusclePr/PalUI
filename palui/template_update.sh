#!/bin/bash

set -e

cd $(dirname "$0")

mkdir -p server/defaults
cp -auv template/defaults/*.env server/defaults/
cp -auv template/*.env server/
