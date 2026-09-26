#!/usr/bin/env sh

set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$PUID" != "0" ]; then
  if getent group palui >/dev/null 2>&1; then
    current_gid="$(getent group palui | cut -d: -f3)"
    if [ "$current_gid" != "$PGID" ]; then
      groupmod -o -g "$PGID" palui
    fi
  else
    groupadd -o -g "$PGID" palui
  fi

  if id palui >/dev/null 2>&1; then
    current_uid="$(id -u palui)"
    if [ "$current_uid" != "$PUID" ]; then
      usermod -o -u "$PUID" palui
    fi
    usermod -g "$PGID" palui
  else
    useradd -o -u "$PUID" -g "$PGID" --create-home --shell /usr/sbin/nologin palui
  fi

  if [ -S /var/run/docker.sock ]; then
    socket_gid="$(stat -c '%g' /var/run/docker.sock)"
    docker_group="$(getent group "$socket_gid" | cut -d: -f1 || true)"
    if [ -z "$docker_group" ]; then
      docker_group="docker"
      if getent group "$docker_group" >/dev/null 2>&1; then
        groupmod -o -g "$socket_gid" "$docker_group" || true
      else
        groupadd -o -g "$socket_gid" "$docker_group" || true
      fi
    fi
    usermod -aG "$docker_group" palui || true
  fi

  exec gosu palui "$@"
fi

exec "$@"