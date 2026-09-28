#!/bin/bash

docker compose --project-directory ./palui build && \
    [ "$1" = "push" ] && \
        docker compose --project-directory ./palui push
