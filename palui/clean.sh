#!/bin/bash

cd "$(dirname $0)"

docker compose down
rm -rf server/defaults server/*.sh server/*.yml

