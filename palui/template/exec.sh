#!/bin/bash
if [ ! -d /server ]; then
  printf '$(basename $0) can only be executed within the PalUI container.'
  exit 1
fi
docker compose --project-directory /server exec -itu steam pal "$@"

