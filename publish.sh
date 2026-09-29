#!/bin/bash

./palui/build.sh && \
    [ "$1" = "push" ] && \
        ./palui/push.sh
