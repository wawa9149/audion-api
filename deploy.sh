#!/bin/bash
docker-compose -f ./docker/docker-compose.$1.yml --env-file ./env/.env.$1 up -d --build
